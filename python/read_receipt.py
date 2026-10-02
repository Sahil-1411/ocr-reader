#!/usr/bin/env python3
"""
Read a receipt with PP-OCR and emit word boxes as JSON.

Why this exists outside the browser app
---------------------------------------
The app reads these receipts with Tesseract. Its remaining errors are all
character-level and all where the watermark has thinned the print: `/` read as
`1` in a settled date, `8` as `6` in an amount, `L/T` as `LIT`. That is the
failure mode a model trained on photographs is least prone to, so PP-OCR is
worth trying — but wiring it into the browser is blocked on OpenCV.js, which
wedges the main thread for minutes on a 10 MB synchronous WASM init and never
recovers. There is no such problem here.

What this deliberately does NOT do
----------------------------------
Assemble rows. It stops at word boxes; `python/reader/` takes them from there —
glyphs joined, columns found, rows built, the receipt's own checks run. Keeping
the recogniser at the boundary means a PDF's own text and a scan's words enter
the same builders, and only the recognising is paid for when a page needs it.

Usage
-----
    .venv/bin/python python/read_receipt.py frontend/public/samples/weekly-invoice.jpg > words.json
    .venv/bin/python python/read_receipt.py --no-suppress IMAGE   # skip the watermark pass
    .venv/bin/python python/read_receipt.py --scales 1 2          # ensemble over upscales
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

import numpy as np

# --------------------------------------------------------------------------- #
# Watermark suppression                                                        #
# --------------------------------------------------------------------------- #
#
# These constants were tuned against these exact receipts and measured against
# ground truth, not derived from anything. The numbers in `## Measured` in
# python/README.md were read with these; change one and those stop describing
# this reader.

PAPER = 128
RED_CHROMA = 45
BAR_RUN = 0.03
BAR_RUN_MIN = 36
# The exponent is 2 on purpose. Cubing preserves more of a covered stroke and
# reads like an improvement, but scored over the whole invoice it is worse: it
# darkens the watermark's own strokes too, and the reader starts preferring
# them. See the note on `inkLevel` in color-watermark.ts.
INK_EXPONENT = 2


def _ink_level(stroke: np.ndarray) -> np.ndarray:
    """Push mid-grey overlay toward paper, leave a dark stroke dark."""
    out = stroke.astype(np.float32)
    t = np.clip((out - 48.0) / (PAPER - 48.0), 0.0, None)
    ramped = 48.0 + np.power(t, INK_EXPONENT) * (255.0 - 48.0)
    return np.where(out <= 48.0, out, ramped)


def _vertical_run_stats(red: np.ndarray, stroke: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Length and median stroke of the vertical red run each pixel belongs to.

    A tall run of red is a bar or the body of a stamp; a pixel much darker than
    the rest of its run is the letter the colour crosses. Done per column
    because that is what the TypeScript does, and the two must agree.
    """
    height, width = red.shape
    run_len = np.zeros((height, width), dtype=np.int32)
    run_med = np.zeros((height, width), dtype=np.float32)

    for x in range(width):
        column = red[:, x]
        if not column.any():
            continue
        # Run boundaries: where the mask flips.
        padded = np.concatenate(([False], column, [False]))
        edges = np.flatnonzero(padded[1:] != padded[:-1])
        for start, end in zip(edges[0::2], edges[1::2]):
            values = stroke[start:end, x]
            run_len[start:end, x] = end - start
            run_med[start:end, x] = float(np.median(values))

    return run_len, run_med


def suppress_colored_watermark(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    """
    Lift the coloured overlay off the page.

    Printed ink is dark in every channel; a red stamp is dark only in red, so
    green and blue still carry the page underneath it. Returns a greyscale image
    and the fraction of pixels painted out.
    """
    height, width = rgb.shape[:2]
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)

    chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    red = (r > g) & (r > b) & (chroma >= RED_CHROMA)

    stroke = np.minimum(g, b).astype(np.float32)
    run_len, run_med = _vertical_run_stats(red, stroke)

    bar_run = max(BAR_RUN_MIN, round(height * BAR_RUN))
    is_bar = (run_len >= bar_run) & (stroke >= run_med - 20)

    level = _ink_level(stroke)
    whiten = red & (is_bar | (stroke >= PAPER))
    level = np.where(whiten, 255.0, level)

    # Pixels that were never red keep their own luminance rather than the
    # green/blue minimum, which would darken neutral print for no reason.
    grey = np.round(0.299 * r + 0.587 * g + 0.114 * b).astype(np.float32)
    out = np.where(red, level, grey)

    ratio = float(whiten.sum()) / float(height * width) if height * width else 0.0
    return np.clip(out, 0, 255).astype(np.uint8), ratio


# --------------------------------------------------------------------------- #
# Line -> words                                                                #
# --------------------------------------------------------------------------- #


# A game-pack code, and a settled date. Both have a shape nothing else on these
# receipts shares, which is what makes peeling them off a glued token safe.
PACK_PREFIX = re.compile(r"^\d{3}-\d{5,8}")
PACK_STANDALONE = re.compile(r"\d{3}-(\d{5,8})")
DATE_ANYWHERE = re.compile(r"\d{2}/\d{2}/\d{2,4}")


def _structural_cuts(token: str, pack_digits: int | None) -> list[int]:
    """
    Where a token has to be cut because the recogniser dropped a space.

    PP-OCR's recogniser emits a line as one string and is unreliable about
    spaces: `881-023234 DIAMONDS & GOLD` comes back as
    `881-023234DIAMONDS&GOLD`. Whitespace splitting alone then yields one token,
    `findPack` cannot match a pack code inside it, and the whole settlement row
    is dropped — 14 of the 25 rows on the sample receipt.

    Only shapes that cannot occur inside another field are cut on. A pack code
    is three digits, a hyphen and five to eight more; a date is two-two-two
    around slashes. Neither appears inside a game name or an amount, so peeling
    them is unambiguous. Digit-to-letter transitions in general are not — they
    occur inside `200X THE CASH`, `X-TRA` and `$1.000`, and cutting there would
    shred the names this is trying to recover.
    """
    cuts: set[int] = set()

    pack = PACK_PREFIX.match(token)
    if pack:
        # `\d{5,8}` is greedy, and where the name that follows starts with
        # digits it eats them: `833-129986` glued to `200X THE CASH` matches
        # entirely as `833-12998620`, which is still a *valid* pack code and so
        # passes downstream silently with two extra digits. Cutting at the
        # length the rest of the page uses recovers the real code.
        end = pack.end()
        if pack_digits is not None:
            fixed = 4 + pack_digits  # `NNN-` plus the suffix
            if fixed < end:
                end = fixed
        if end < len(token):
            cuts.add(end)

    for match in DATE_ANYWHERE.finditer(token):
        if match.start() > 0:
            cuts.add(match.start())
        if match.end() < len(token):
            cuts.add(match.end())

    return sorted(cuts)


def modal_pack_digits(texts: list[str]) -> int | None:
    """
    How many digits follow the hyphen in this page's pack codes.

    Taken from the codes the recogniser got cleanly — one per line, nothing
    glued on — because those are unambiguous. Every code on a given receipt is
    the same shape, so the most common length among them is the page's, and it
    can be trusted to cut the glued ones. Returns None when too few clean codes
    were read to be sure, in which case nothing is assumed.
    """
    lengths: dict[int, int] = {}
    for text in texts:
        for token in text.split():
            match = PACK_STANDALONE.fullmatch(token)
            if match:
                length = len(match.group(1))
                lengths[length] = lengths.get(length, 0) + 1
    if not lengths:
        return None
    best, count = max(lengths.items(), key=lambda kv: kv[1])
    return best if count >= 3 else None


def _cut_token(token: str, pack_digits: int | None) -> list[str]:
    cuts = _structural_cuts(token, pack_digits)
    if not cuts:
        return [token]
    pieces: list[str] = []
    previous = 0
    for cut in [*cuts, len(token)]:
        piece = token[previous:cut]
        if piece:
            pieces.append(piece)
        previous = cut
    return pieces


# --------------------------------------------------------------------------- #
# Spaces the recogniser dropped                                                #
# --------------------------------------------------------------------------- #

# Anything darker than this in the cleaned page is print.
INK_LEVEL = 140
# A blank run at least this fraction of the cap height is a word space. Measured
# over all three sample receipts: spaces between words and between count columns
# run 0.33-0.71 of the cap height, gaps between letters and inside amounts 0.29
# at most — except where the watermark pass has thinned a stroke, which widens a
# letter gap to 0.31 (`TH E` in `100X THE CASH`). The cut sits between the two.
SPACE_GAP = 0.32


def ink_gaps(
    page: np.ndarray, x0: int, y0: int, x1: int, y1: int
) -> tuple[list[float], list[int]]:
    """
    Word-sized blank runs inside a line box, and the glyphs between them.

    Returns the page x of the centre of each run, and for each stretch of ink
    between runs how many separate glyphs it holds (blank columns apart). Read
    off the pixels rather than off the recogniser, because the recogniser is
    what lost the spaces: `RED WHITE & BLUE 7S` comes back as one string, but
    the print still has clean white columns where the spaces are.
    """
    height, width = page.shape[:2]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return [], []
    ink = page[y0:y1, x0:x1] < INK_LEVEL
    inked = ink.any(axis=0)
    on = np.flatnonzero(inked)
    if len(on) < 2:
        return [], []

    # Cap height from the tall strokes, so a watermark speck above the line
    # does not inflate it and a dot or comma does not shrink it.
    top = ink.argmax(axis=0)
    bottom = ink.shape[0] - 1 - ink[::-1].argmax(axis=0)
    cap = float(np.percentile((bottom - top + 1)[inked], 90))
    if cap <= 0:
        return [], []

    gaps: list[float] = []
    glyphs: list[int] = [0]
    run_start: int | None = int(on[0])
    for column in range(int(on[0]), int(on[-1]) + 1):
        if not inked[column]:
            if run_start is None:
                run_start = column
            continue
        if run_start is not None:
            if column - run_start >= SPACE_GAP * cap:
                gaps.append(x0 + (run_start + column) / 2)
                glyphs.append(0)
            glyphs[-1] += 1
            run_start = None
    return gaps, glyphs


def restore_spaces(
    text: str,
    spans: list[tuple[float, float]],
    gaps: list[float],
    glyphs: list[int] | None = None,
) -> tuple[str, list[tuple[float, float]]]:
    """
    Put a space into `text` at each blank run the print shows.

    When the glyphs counted between the runs add up to the characters read,
    each word's length is known exactly and the text is cut by those lengths.
    That is the usual case; it fails where two letters touch or the watermark
    pass broke one in two.

    Otherwise `spans` — the recogniser's x-range per character — says which two
    characters a run falls between. Those ranges come from CTC timesteps and are
    too loose to find spaces by themselves, and can be a letter out on a
    proportional font, which is why they are the fallback.
    """
    if len(spans) != len(text) or len(text) < 2 or not gaps:
        return text, spans

    kept = [index for index, char in enumerate(text) if not char.isspace()]
    if glyphs and len(glyphs) == len(gaps) + 1 and all(glyphs) and sum(glyphs) == len(kept):
        out_text: list[str] = []
        out_spans: list[tuple[float, float]] = []
        cursor = 0
        for word, count in enumerate(glyphs):
            if word > 0:
                left = spans[kept[cursor - 1]][1]
                right = spans[kept[cursor]][0]
                out_text.append(" ")
                out_spans.append((min(left, right), max(left, right)))
            for index in kept[cursor : cursor + count]:
                out_text.append(text[index])
                out_spans.append(spans[index])
            cursor += count
        return "".join(out_text), out_spans

    centres = [(left + right) / 2 for left, right in spans]
    after: set[int] = set()
    for gap in gaps:
        best, best_distance = None, float("inf")
        for index in range(len(text) - 1):
            if text[index].isspace() or text[index + 1].isspace():
                continue
            if not centres[index] <= gap <= centres[index + 1]:
                continue
            distance = abs(gap - (centres[index] + centres[index + 1]) / 2)
            if distance < best_distance:
                best, best_distance = index, distance
        if best is not None:
            after.add(best)
    if not after:
        return text, spans

    out_text = []
    out_spans = []
    for index, char in enumerate(text):
        out_text.append(char)
        out_spans.append(spans[index])
        if index in after:
            left = spans[index][1]
            right = spans[index + 1][0]
            out_text.append(" ")
            out_spans.append((min(left, right), max(left, right)))
    return "".join(out_text), out_spans


# --------------------------------------------------------------------------- #
# Re-reading text lines                                                        #
# --------------------------------------------------------------------------- #

# Upscales a text line is recognised again at. Each alone gets characters wrong
# that the page pass got right (`10X` as `10x`, `$10,000` as `510,000`); what
# they agree on, against the page pass, is where the page pass was wrong
# (`SOX THE CASH` for `50X`, `FIERY SS` for `5S`, `S200` for `$200`).
REREAD_VARIANTS = ((3.0, "cubic"), (3.0, "nearest"), (4.0, "cubic"))


def vote_characters(original: str, readings: list[str]) -> str:
    """
    Replace a page-pass character only where every re-read agrees on another.

    Only readings with the same number of non-space characters take part —
    one that gained or lost a character cannot be lined up without guessing —
    and all of them must take part. A simple majority was measured and is not
    enough: on the invoice's smaller print two re-reads agreeing on `On-tine`
    and `Promd` outvoted a correct page pass. A winner that differs only in case
    keeps the page pass's case, so `10X` is never turned into `10x`. Spaces are
    not voted on; they come from the pixels (`restore_spaces`).
    """
    import unicodedata

    base = [(index, char) for index, char in enumerate(original) if not char.isspace()]
    target = len(base)
    aligned = []
    for reading in readings:
        chars = [c for c in unicodedata.normalize("NFKC", reading) if not c.isspace()]
        if len(chars) == target:
            aligned.append(chars)
    if not aligned or len(aligned) < len(readings):
        return original

    out = list(original)
    for position, (index, char) in enumerate(base):
        choices = {chars[position] for chars in aligned}
        if len(choices) != 1:
            continue
        winner = choices.pop()
        if winner.lower() != char.lower():
            out[index] = winner
    return "".join(out)


def name_column(result: list) -> tuple[float, float, float] | None:
    """
    Left edge, right edge and top of the inventory's Name column, in page pixels.

    Taken from the printed `Game Name` and `Int Rec Act Set` header lines. None
    when the page has no such header, which keeps the re-read off every other
    receipt: measured on the invoice's smaller print, re-reads agree with each
    other on errors (`On-tine`, `Promd`) as readily as on fixes.
    """
    game = counts = None
    for entry in result:
        key = re.sub(r"\s", "", str(entry[1])).lower()
        points = np.asarray(entry[0], dtype=np.float32)
        if key.startswith("gamename"):
            game = points
        elif key.startswith("intrec"):
            counts = points
    if game is None or counts is None:
        return None
    # `Name` starts five characters into the nine of `Game Name`; a little short
    # of that, so a name printed a hair left of its label still qualifies.
    left = game[:, 0].min() + (game[:, 0].max() - game[:, 0].min()) * 0.45
    right = counts[:, 0].min()
    top = max(game[:, 1].max(), counts[:, 1].max())
    return float(left), float(right), float(top)


def reread_lines(
    engine, source: np.ndarray, boxes: list[tuple[float, float, float, float]]
) -> list[list[str]]:
    """Recognise each box of `source` again at every `REREAD_VARIANTS` upscale."""
    import cv2

    interpolation = {"cubic": cv2.INTER_CUBIC, "nearest": cv2.INTER_NEAREST}
    height, width = source.shape[:2]
    readings: list[list[str]] = [[] for _ in boxes]
    for upscale, mode in REREAD_VARIANTS:
        crops = []
        for x0, y0, x1, y1 in boxes:
            pad = 3
            crop = source[
                max(0, int(y0) - pad) : min(height, int(np.ceil(y1)) + pad),
                max(0, int(x0) - pad) : min(width, int(np.ceil(x1)) + pad),
            ]
            crop = cv2.resize(crop, None, fx=upscale, fy=upscale, interpolation=interpolation[mode])
            crop = cv2.copyMakeBorder(crop, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
            crops.append(cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR) if crop.ndim == 2 else crop)
        if not crops:
            continue
        results, _ = engine.text_rec(crops)
        for index, result in enumerate(results):
            readings[index].append(str(result[0]))
    return readings


def split_line_into_words(
    x: float,
    y: float,
    w: float,
    h: float,
    text: str,
    score: float,
    pack_digits: int | None = None,
    spans: list[tuple[float, float]] | None = None,
) -> list[dict[str, Any]]:
    """
    Cut a recognised line into words, spaced across its box.

    PP-OCR detects lines: `SYSTEM FEE 5.00` arrives as one box and one string.
    The row builders need the pieces separately because they tell a label from
    an amount by where it sits across the page. Each token gets the share of the
    box its characters occupy, spaces included — exact for the monospaced print
    on these receipts, and close enough elsewhere, since what the builders
    compare is which side of the page a token is on.

    With `spans` — the recogniser's x-range per character, in the same
    coordinates as `x` — each piece is placed where its own characters were read
    instead of by its share of the string, which matters on a proportional font
    where `W` is three times `I`.
    """
    line = text.strip()
    if not line or w <= 0 or h <= 0:
        return []
    if spans is not None and len(spans) != len(text):
        spans = None
    if spans is not None:
        lead = len(text) - len(text.lstrip())
        spans = spans[lead : lead + len(line)]

    def place(offset: int, length: int) -> tuple[float, float]:
        if spans is None:
            return x + (w * offset) / span, (w * length) / span
        left = spans[offset][0]
        right = spans[offset + length - 1][1]
        return left, max(right - left, 1e-3)

    span = len(line)
    words: list[dict[str, Any]] = []
    index = 0
    while index < span:
        if line[index].isspace():
            index += 1
            continue
        start = index
        while index < span and not line[index].isspace():
            index += 1
        token = line[start:index]
        # Each piece keeps the share of the box its own characters occupy, so a
        # peeled pack code lands on the left and the name it was glued to stays
        # where the name is printed.
        offset = start
        for piece in _cut_token(token, pack_digits):
            left, piece_width = place(offset, len(piece))
            words.append(
                {
                    "text": piece,
                    "x": left,
                    "y": y,
                    "width": piece_width,
                    "height": h,
                    "confidence": score,
                }
            )
            offset += len(piece)
    return words


# --------------------------------------------------------------------------- #
# Driver                                                                       #
# --------------------------------------------------------------------------- #


def load_engine():
    """
    RapidOCR runs the PP-OCR ONNX models without pulling in PaddlePaddle.

    Same PP-OCR weights, minus a ~100 MB framework that a read-one-image script
    has no use for.
    """
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as error:  # pragma: no cover - environment problem
        raise SystemExit(
            "rapidocr-onnxruntime is not installed.\n"
            "    uv pip install -r python/requirements.txt --excludes python/excludes.txt\n"
            f"({error})"
        ) from error
    builds = opencv_builds()
    if len(builds) > 1:
        print(
            f"warning: {len(builds)} OpenCV builds are installed ({', '.join(builds)}).\n"
            "They share one cv2 folder, so which loads depends on install order.\n"
            "Keep only the headless one:\n"
            f"    uv pip uninstall {' '.join(builds)}\n"
            "    uv pip install -r python/requirements.txt --excludes python/excludes.txt",
            file=sys.stderr,
        )
    return RapidOCR()


def opencv_builds() -> list[str]:
    """The OpenCV wheels installed. Every one of them unpacks into `cv2`."""
    from importlib import metadata

    found = []
    for name in (
        "opencv-python",
        "opencv-python-headless",
        "opencv-contrib-python",
        "opencv-contrib-python-headless",
    ):
        try:
            metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
        found.append(name)
    return found


def read_words(
    engine, page: np.ndarray, scale: float, restore: bool = True
) -> list[dict[str, Any]]:
    import cv2

    source = page if page.ndim == 2 else cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    if scale != 1:
        page = cv2.resize(
            page, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST
        )

    # The detector wants three channels.
    rgb = cv2.cvtColor(page, cv2.COLOR_GRAY2BGR) if page.ndim == 2 else page
    grey = page if page.ndim == 2 else cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    result, _ = engine(rgb, return_word_box=True)
    if not result:
        return []

    # Game names in the inventory's Name column are read again and settled by
    # vote. Figures are left alone: their errors are what the row builders and
    # the receipt's own totals already catch.
    column = name_column(result) if restore else None
    worded = []
    if column is not None:
        left, right, top = column
        for index, entry in enumerate(result):
            points = np.asarray(entry[0], dtype=np.float32)
            if points[:, 0].min() >= left and points[:, 0].max() <= right and points[:, 1].min() >= top:
                worded.append(index)
    boxes = []
    for index in worded:
        points = np.asarray(result[index][0], dtype=np.float32) / scale
        boxes.append((*points.min(axis=0), *points.max(axis=0)))
    rereads = dict(zip(worded, reread_lines(engine, source, boxes)))

    lines: list[tuple[float, float, float, float, str, float, list | None]] = []
    for position, entry in enumerate(result):
        box, text, score = entry[0], str(entry[1]), float(entry[2])
        if position in rereads:
            text = vote_characters(text, rereads[position])
        char_boxes = entry[3] if len(entry) > 3 else None
        points = np.asarray(box, dtype=np.float32)
        x0, y0 = points[:, 0].min(), points[:, 1].min()
        x1, y1 = points[:, 0].max(), points[:, 1].max()
        spans = None
        if restore and char_boxes and len(char_boxes) == len(text):
            spans = []
            for char_box in char_boxes:
                xs = np.asarray(char_box, dtype=np.float32)[:, 0]
                spans.append((float(xs.min()), float(xs.max())))
            gaps, glyphs = ink_gaps(grey, int(x0), int(y0), int(np.ceil(x1)), int(np.ceil(y1)))
            text, spans = restore_spaces(text, spans, gaps, glyphs)
            spans = [(left / scale, right / scale) for left, right in spans]
        lines.append((x0, y0, x1, y1, text, score, spans))

    # Two phases: the pack-code length has to be known from the whole page
    # before any line can be cut, because the glued lines are exactly the ones
    # that cannot tell you what it is.
    pack_digits = modal_pack_digits([text for *_, text, _, _ in lines])

    words: list[dict[str, Any]] = []
    for x0, y0, x1, y1, text, score, spans in lines:
        words.extend(
            split_line_into_words(
                float(x0) / scale,
                float(y0) / scale,
                float(x1 - x0) / scale,
                float(y1 - y0) / scale,
                text,
                score,
                pack_digits,
                spans,
            )
        )
    return words


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="path to the receipt image")
    parser.add_argument(
        "--no-suppress",
        action="store_true",
        help="skip the watermark pass, to see what it is worth",
    )
    parser.add_argument(
        "--scales",
        nargs="+",
        type=float,
        default=[2.0],
        help="upscales to read at. 2 is measured best on these receipts; passing\n"
        "several emits several passes, which the scorer merges by row",
    )
    parser.add_argument("--max-side", type=int, default=2400, help="downscale longest side to this")
    args = parser.parse_args()

    import cv2

    bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"could not read {args.image}")

    height, width = bgr.shape[:2]
    longest = max(height, width)
    if longest > args.max_side:
        factor = args.max_side / longest
        bgr = cv2.resize(bgr, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    if args.no_suppress:
        page = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        ratio = 0.0
    else:
        page, ratio = suppress_colored_watermark(rgb)

    engine = load_engine()
    passes = [
        {"scale": scale, "words": read_words(engine, page, scale)} for scale in args.scales
    ]

    json.dump(
        {
            "image": args.image,
            "size": {"width": page.shape[1], "height": page.shape[0]},
            "watermarkPixelRatio": round(ratio, 4),
            "passes": passes,
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
