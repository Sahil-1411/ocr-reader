"""
The lottery readers: an inventory sheet, a page of pack settlements, and a
weekly invoice read as label-and-amount lines.

Each rule is argued for where it is written, below. These readers were ported
from TypeScript, but this is now the only copy of them.

`columns.py` reads the wholesale invoices this project is mostly pointed at.
These readers are what `assemble.py` tries first, and what decides the kind of
a page that is not a column table.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Sequence

from .boxes import WordBox, group_into_lines, line_band, median

AMOUNT = re.compile(r"^\$?\d{1,3}(?:,\d{3})+(?:\.\d{2})?[A-Za-z]?$|^\$?\d+\.\d{2}[A-Za-z]?$")
DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")
TIME = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?$")
COUNT = re.compile(r"^\d{1,3}$")
#: Instant game numbers on these sheets are three digits, e.g. `815`.
GAME = re.compile(r"^\d{3}$")
LONG_ID = re.compile(r"^\d{4,8}$")
DECIMAL_TAIL = re.compile(r"^\.\d{2}[A-Za-z]?$")
CREDIT = re.compile(r"^[Cc]$")


@dataclass(slots=True)
class InventoryRow:
    game: str
    name: str
    int: str
    rec: str
    act: str
    set: str
    confidence: float


@dataclass(slots=True)
class SettlementRow:
    game_pack: str
    name: str
    date_settled: str
    confidence: float


@dataclass(slots=True)
class InvoiceField:
    label: str
    value: str
    confidence: float


def token_core(text: str) -> str:
    return re.sub(r"^[,:;]+|[,:;]+$", "", text.strip())


def strip_edges(text: str) -> str:
    """Strip punctuation off both ends, keeping the word or number inside."""
    return re.sub(r"^[^0-9A-Za-z]+|[^0-9A-Za-z]+$", "", token_core(text))


def count_value(text: str) -> str | None:
    """A count with whatever the reader hung off its ends removed."""
    token = re.sub(r"^\D+|\D+$", "", token_core(text))
    return token if COUNT.match(token) else None


def is_amount(token: str) -> bool:
    return bool(AMOUNT.match(token))


def is_date(token: str) -> bool:
    return bool(DATE.match(token))


def is_time(token: str) -> bool:
    return bool(TIME.match(token))


def is_count(token: str) -> bool:
    return bool(COUNT.match(token))


def is_decimal_tail(token: str) -> bool:
    return bool(DECIMAL_TAIL.match(token))


def is_credit_mark(token: str) -> bool:
    return bool(CREDIT.match(token))


def is_long_id(token: str) -> bool:
    return bool(LONG_ID.match(token))


def _text_at(words: Sequence[WordBox], index: int) -> str:
    return words[index].text if 0 <= index < len(words) else ""


def is_value_token(words: Sequence[WordBox], index: int) -> bool:
    """A token that can sit in a trailing value, judged with its neighbours."""
    token = token_core(_text_at(words, index))
    if is_amount(token) or is_date(token) or is_time(token) or is_count(token) or is_decimal_tail(token):
        return True
    if is_credit_mark(token) and index > 0 and is_amount(token_core(_text_at(words, index - 1))):
        return True
    if (
        is_long_id(token)
        and index + 1 < len(words)
        and is_decimal_tail(token_core(_text_at(words, index + 1)))
    ):
        return True
    return False


def gap_between(left: WordBox, right: WordBox) -> float:
    return right.x - left.right


def line_height(words: Sequence[WordBox]) -> float:
    return median([word.height for word in words]) or 1


def is_column_gap(gap: float, height: float, gaps: Sequence[float]) -> bool:
    """A gap wide enough to be the space between a label and its value."""
    if gap < max(14.0, height * 0.9):
        return False
    rest = [value for value in gaps if value != gap]
    typical = median(rest if rest else list(gaps))
    return gap >= typical * 2


def join_parts(words: Sequence[WordBox]) -> str:
    out = ""
    for word in words:
        text = word.text.strip()
        if not text:
            continue
        glue = bool(out) and not CREDIT.match(text) and not text.startswith(".")
        out = f"{out} {text}" if glue else f"{out}{text}"
    return out


def mean_confidence(words: Sequence[WordBox]) -> float:
    if not words:
        return 0.0
    return sum(word.confidence for word in words) / len(words)


def accept_suffix(
    words: Sequence[WordBox],
    start: int,
    gaps: Sequence[float],
    height: float,
) -> bool:
    suffix = words[start:]
    gap_before = gaps[start - 1] if start > 0 and start - 1 < len(gaps) else math.inf
    strong = False
    counts = 0
    for word in suffix:
        token = token_core(word.text)
        if is_amount(token) or is_date(token) or is_time(token) or is_decimal_tail(token):
            strong = True
        if is_count(token):
            counts += 1
    if strong:
        return True
    if counts >= 2:
        return True
    return counts == 1 and is_column_gap(gap_before, height, gaps)


def peel_trailing_id(
    words: Sequence[WordBox],
    gaps: Sequence[float],
    height: float,
) -> int | None:
    """A retailer id after a colon, or across a wide gap, is a value."""
    last = len(words) - 1
    token = token_core(_text_at(words, last))
    if not is_long_id(token) or last == 0:
        return None
    previous = _text_at(words, last - 1).strip()
    gap = gaps[last - 1] if last - 1 < len(gaps) else 0.0
    if previous.endswith(":") or is_column_gap(gap, height, gaps):
        return last
    return None


def dominant_gap(gaps: Sequence[float], height: float) -> int | None:
    """Split at a gap much wider than the spaces inside the line."""
    if not gaps:
        return None
    max_index = 0
    for index in range(1, len(gaps)):
        if gaps[index] > gaps[max_index]:
            max_index = index
    largest = gaps[max_index]
    rest = [gap for index, gap in enumerate(gaps) if index != max_index]
    typical = median(rest)
    if largest < max(16.0, height):
        return None
    if rest and largest < typical * 2.5:
        return None
    return max_index + 1


def split_label_value(words: Sequence[WordBox]) -> tuple[str, str]:
    """Split one baseline into a label and a value."""
    if not words:
        return "", ""
    if len(words) == 1:
        only = words[0].text.strip()
        return ("", only) if is_value_token(words, 0) else (only, "")

    gaps = [gap_between(words[index], words[index + 1]) for index in range(len(words) - 1)]
    height = line_height(words)

    start = len(words)
    while start > 0 and is_value_token(words, start - 1):
        start -= 1

    if start < len(words) and accept_suffix(words, start, gaps, height):
        return join_parts(words[:start]), join_parts(words[start:])

    peeled = peel_trailing_id(words, gaps, height)
    if peeled is not None:
        return join_parts(words[:peeled]), join_parts(words[peeled:])

    at_gap = dominant_gap(gaps, height)
    if at_gap is not None:
        return join_parts(words[:at_gap]), join_parts(words[at_gap:])

    return join_parts(words), ""


# --------------------------------------------------------------------------- #
# The inventory sheet                                                          #
# --------------------------------------------------------------------------- #

PACK = re.compile(r"^\d{3}-\d{5,8}$")


def is_totals(token: str) -> bool:
    return bool(re.fullmatch(r"totals", token, re.I))


def repair_money_token(token: str) -> str:
    """A dollar figure inside a game name, repaired to how the ticket prints it."""
    text = token
    if re.match(r"^S(?:\d{3,}|\d{1,3}[.,]\d{3})", text) and re.fullmatch(r"S[\dOo.,]+!?", text):
        text = "$" + text[1:]
    if not text.startswith("$"):
        return token
    bang = "!" if text.endswith("!") else ""
    body = text[1:-1] if bang else text[1:]
    if not re.fullmatch(r"\d[\dOo.,]*", body):
        return token
    body = body.replace("O", "0").replace("o", "0")
    grouped = re.fullmatch(r"(\d{1,3})((?:[.,]\d{3})+)", body)
    if grouped:
        body = grouped.group(1) + re.sub(r"[.,]", ",", grouped.group(2))
    elif not re.fullmatch(r"\d+(?:\.\d{2})?", body):
        return token
    return f"${body}{bang}"


def repair_game_name(name: str) -> str:
    """A game name with its dollar figures repaired, word by word."""
    tokens = [repair_money_token(token) for token in name.split(" ")]
    if not any(token.startswith("$") for token in tokens):
        return " ".join(tokens)
    return " ".join(
        ("$" + token[1:]) if re.fullmatch(r"S\d{1,2}!?", token) else token for token in tokens
    )


def expand_merged_counts(words: Sequence[WordBox]) -> list[WordBox]:
    """Split a run of counts the reader joined into a single token."""
    expanded: list[WordBox] = []
    for word in words:
        token = token_core(word.text)
        if is_count(token) or PACK.match(token) or not re.fullmatch(r"\d{3}(?:[.\s-]?\d{3})+", token):
            expanded.append(word)
            continue
        digits = re.sub(r"\D", "", token)
        parts = len(digits) / 3
        if parts != int(parts) or parts < 2 or parts > 4:
            expanded.append(word)
            continue
        parts = int(parts)
        span = word.width / parts
        for index in range(parts):
            expanded.append(
                WordBox(
                    text=digits[index * 3 : index * 3 + 3],
                    x=word.x + span * index,
                    y=word.y,
                    width=span,
                    height=word.height,
                    confidence=word.confidence,
                )
            )
    return expanded


def tight_count_run(words: Sequence[WordBox]) -> list[WordBox] | None:
    """The tightest group of four counts, rather than whatever ends the line."""
    counts = [word for word in expand_merged_counts(words) if count_value(word.text) is not None]
    if len(counts) < 4:
        return None
    best: list[WordBox] | None = None
    best_span = math.inf
    for index in range(len(counts) - 3):
        group = counts[index : index + 4]
        span = group[3].x - group[0].x
        if span < best_span:
            best = group
            best_span = span
    return best


def row_pitch(anchors: Sequence[WordBox]) -> float:
    centres = sorted(word.centre_y for word in anchors)
    gaps = [
        centres[index] - centres[index - 1]
        for index in range(1, len(centres))
        if centres[index] - centres[index - 1] > 4
    ]
    if not gaps:
        return max(24.0, line_height(anchors) * 1.6)
    return median(gaps)


def inventory_row_from_line(words: Sequence[WordBox]) -> InventoryRow | None:
    ordered = sorted(words, key=lambda w: (w.x, w.y))
    counts = tight_count_run(ordered)
    if counts is None:
        return None

    count_ids = {id(word) for word in counts}
    first_count = counts[0]
    label_words = [
        word for word in ordered if id(word) not in count_ids and word.x < first_count.x
    ]
    numbered = -1
    for index, word in enumerate(label_words):
        token = strip_edges(word.text)
        if GAME.match(token) or is_totals(token):
            numbered = index
            break
    start = 0 if numbered == -1 else numbered
    while numbered == -1 and start < len(label_words):
        token = strip_edges(label_words[start].text)
        if GAME.match(token) or is_totals(token):
            break
        # Three, not two: the margin watermark yields `|SE` as often as `iZ`.
        if len(token) <= 3:
            start += 1
            continue
        break
    body = label_words[start:]
    if not body:
        return None

    first = strip_edges(body[0].text)
    game = first if GAME.match(first) else ""
    name = repair_game_name(join_parts(body[1:] if game else body))
    if not game and not is_totals(name):
        return None

    values = [count_value(word.text) or token_core(word.text) for word in counts]
    values += [""] * (4 - len(values))
    return InventoryRow(
        game=game,
        name=name,
        int=values[0],
        rec=values[1],
        act=values[2],
        set=values[3],
        confidence=mean_confidence(ordered),
    )


#: The inventory table's printed header, left to right.
INVENTORY_HEADERS = ["Game", "Name", "Int", "Rec", "Act", "Set"]
COUNT_HEADERS = INVENTORY_HEADERS[2:]


@dataclass(slots=True)
class InventoryHeader:
    labels: list[str]
    #: The header's own words, by identity; they are not table content.
    word_ids: set[int]
    top: float
    bottom: float
    #: Horizontal centres of the Int, Rec, Act and Set labels.
    count_centres: list[float]


def looks_like(token: str, target: str) -> bool:
    """Within one letter of `target`: a short label misread by a glyph is still the label."""
    a, b = token.lower(), target.lower()
    if len(a) != len(b):
        return False
    return sum(1 for x, y in zip(a, b) if x != y) <= 1


def printed_label(word: WordBox | None, canonical: str) -> str:
    token = strip_edges(word.text) if word is not None else ""
    return token if token.lower() == canonical.lower() else canonical


def find_inventory_header(words: Sequence[WordBox]) -> InventoryHeader | None:
    """The `Game Name Int Rec Act Set` line, when the reader saw it."""
    usable = [w for w in words if w.text.strip() and w.width > 0 and w.height > 0]
    for line in group_into_lines(usable, 0.5):
        counts: list[WordBox] = []
        exact = 0
        for word in line:
            if len(counts) >= len(COUNT_HEADERS):
                break
            target = COUNT_HEADERS[len(counts)]
            token = strip_edges(word.text)
            if looks_like(token, target):
                counts.append(word)
                if token.lower() == target.lower():
                    exact += 1
        if len(counts) < 4 or exact < 2:
            continue

        first_count = counts[0]
        left = [word for word in line if word.x < first_count.x]
        game = next((w for w in left if looks_like(strip_edges(w.text), "Game")), None)
        name = next(
            (w for w in left if w is not game and looks_like(strip_edges(w.text), "Name")), None
        )
        own = list(counts) + ([game] if game else []) + ([name] if name else [])
        band = line_band(own)
        return InventoryHeader(
            labels=[printed_label(game, "Game"), printed_label(name, "Name")]
            + [printed_label(word, COUNT_HEADERS[index]) for index, word in enumerate(counts)],
            word_ids={id(word) for word in own},
            top=band.top,
            bottom=band.bottom,
            count_centres=[word.centre_x for word in counts],
        )
    return None


@dataclass(slots=True)
class CountLayout:
    centres: list[float]
    pitch: float


def count_layout(
    groups: Sequence[Sequence[WordBox]],
    header: InventoryHeader | None,
) -> CountLayout | None:
    """Where the four count columns actually are on this page."""
    slots: list[list[float]] = [[], [], [], []]
    for group in groups:
        run = tight_count_run(sorted(group, key=lambda w: (w.x, w.y)))
        if run is None:
            continue
        for index, word in enumerate(run):
            if index < 4:
                slots[index].append(word.centre_x)
    centres: list[float] | None = None
    if len(slots[0]) >= 3:
        centres = [median(values) for values in slots]
    elif header is not None:
        centres = list(header.count_centres)
    if not centres:
        return None
    pitch = (centres[3] - centres[0]) / 3
    return CountLayout(centres=centres, pitch=pitch) if pitch > 0 else None


def count_digits(text: str) -> str:
    """The digits in a count-column token."""
    token = text.strip()
    digits = len(re.sub(r"\D", "", token))
    alnum = len(re.sub(r"[^0-9A-Za-z]", "", token))
    if digits == 0 or digits * 2 < alnum:
        return ""
    repaired = re.sub(r"[OoQD]", "0", token)
    repaired = re.sub(r"[Il|]", "1", repaired)
    return re.sub(r"\D", "", repaired)


@dataclass(slots=True)
class _CountPiece:
    text: str
    centre: float
    short: bool


def read_counts(words: Sequence[WordBox], layout: CountLayout) -> list[str]:
    """Int, Rec, Act and Set from the words that fall in the count columns."""
    ordered = sorted(words, key=lambda w: (w.x, w.y))
    all_digits = "".join(count_digits(word.text) for word in ordered)
    if len(all_digits) == 12:
        return [all_digits[start : start + 3] for start in (0, 3, 6, 9)]

    pieces: list[_CountPiece] = []
    for word in ordered:
        digits = count_digits(word.text)
        if not digits:
            continue
        if len(digits) % 3 == 0:
            parts = len(digits) // 3
            for index in range(parts):
                pieces.append(
                    _CountPiece(
                        text=digits[index * 3 : index * 3 + 3],
                        centre=word.x + (word.width * (index + 0.5)) / parts,
                        short=False,
                    )
                )
        elif len(digits) < 3 and re.fullmatch(r"\d+", token_core(word.text)):
            pieces.append(_CountPiece(text=digits, centre=word.centre_x, short=True))
        else:
            text = word.text.strip()
            for index, char in enumerate(text):
                digit = count_digits(char)
                if not digit:
                    continue
                pieces.append(
                    _CountPiece(
                        text=digit,
                        centre=word.x + (word.width * (index + 0.5)) / len(text),
                        short=False,
                    )
                )

    columns: list[list[_CountPiece]] = [[], [], [], []]
    for piece in pieces:
        best = -1
        best_distance = layout.pitch * 0.75
        for index, centre in enumerate(layout.centres):
            distance = abs(piece.centre - centre)
            if distance <= best_distance:
                best = index
                best_distance = distance
        if best >= 0:
            columns[best].append(piece)

    out: list[str] = []
    for column in columns:
        text = "".join(piece.text for piece in column)
        if len(text) == 3:
            out.append(text)
        elif len(column) == 1 and column[0].short:
            out.append(text.rjust(3, "0"))
        else:
            out.append("")
    return out


def inventory_row_from_anchor(group: Sequence[WordBox], layout: CountLayout) -> InventoryRow:
    """One inventory row from the words grouped on its game number (or TOTALS)."""
    anchor = group[0] if group else None
    rest = group[1:]
    anchor_text = strip_edges(anchor.text) if anchor is not None else ""
    low = layout.centres[0] - layout.pitch * 0.8
    high = layout.centres[3] + layout.pitch * 0.8
    label_words: list[WordBox] = []
    count_words: list[WordBox] = []
    for word in rest:
        centre = word.centre_x
        if low <= centre <= high:
            count_words.append(word)
        # Left of the game number is the margin watermark, never the name.
        elif centre < low and anchor is not None and word.x >= anchor.x + anchor.width * 0.5:
            label_words.append(word)
    totals = is_totals(anchor_text)
    values = read_counts(count_words, layout)
    values += [""] * (4 - len(values))
    return InventoryRow(
        game="" if totals else anchor_text,
        name=anchor_text
        if totals
        else repair_game_name(join_parts(sorted(label_words, key=lambda w: (w.x, w.y)))),
        int=values[0],
        rec=values[1],
        act=values[2],
        set=values[3],
        confidence=mean_confidence(group),
    )


def assign_to_anchors(
    words: Sequence[WordBox],
    anchors: Sequence[WordBox],
    overlap_ratio: float,
    below_ratio: float,
) -> list[list[WordBox]]:
    """Group words onto anchors; a word between two rows stays with the row above."""
    if not anchors:
        return []
    pitch = row_pitch(anchors)
    below = pitch * below_ratio
    above = pitch * min(0.35, 0.1 + overlap_ratio * 0.4)
    anchor_ids = {id(anchor) for anchor in anchors}
    groups: dict[int, list[WordBox]] = {id(anchor): [anchor] for anchor in anchors}

    for word in words:
        if id(word) in anchor_ids:
            continue
        best: WordBox | None = None
        best_distance = math.inf
        cy = word.centre_y
        for anchor in anchors:
            delta = cy - anchor.centre_y
            if delta < -above or delta > below:
                continue
            distance = abs(delta) if delta >= -above * 0.5 else abs(delta) + pitch * 0.75
            if distance < best_distance:
                best = anchor
                best_distance = distance
        if best is not None:
            groups[id(best)].append(word)

    ordered = sorted(anchors, key=lambda a: (a.centre_y, a.x))
    return [groups.get(id(anchor), []) for anchor in ordered]


def drop_leading_strays(ordered: Sequence[WordBox]) -> list[WordBox]:
    """Drop stray tokens stranded in the left margin, before the label proper."""
    kept = list(ordered)
    while len(kept) >= 2:
        head = kept[0]
        # Only ever a fragment: a real first word this far out is a label.
        if len(head.text.strip()) > 3:
            break
        gaps = [kept[index].x - kept[index - 1].right for index in range(1, len(kept))]
        if not gaps:
            break
        leading = gaps[0]
        rest = sorted(gaps[1:])
        typical = rest[len(rest) // 2] if len(rest) >= 2 else None
        height = max((word.height for word in kept), default=0.0)
        threshold = max(height * 1.5, 0.0 if typical is None else typical * 3)
        if leading <= threshold:
            break
        kept = kept[1:]
    return kept


def is_spaced_word(ordered: Sequence[WordBox], index: int) -> bool:
    """A single letter set at ordinary word spacing from a neighbour."""
    if index < 0 or index >= len(ordered):
        return False
    word = ordered[index]
    if not re.fullmatch(r"[A-Za-z]", word.text.strip()):
        return False
    limit = word.height * 1.2

    def near(gap: float) -> bool:
        return 0 <= gap <= limit

    previous = ordered[index - 1] if index - 1 >= 0 else None
    nxt = ordered[index + 1] if index + 1 < len(ordered) else None
    return (previous is not None and near(gap_between(previous, word))) or (
        nxt is not None and near(gap_between(word, nxt))
    )


def drop_trailing_strays(ordered: Sequence[WordBox]) -> list[WordBox]:
    """The mirror of `drop_leading_strays` for the other end of a label."""
    kept = list(ordered)
    while len(kept) >= 2:
        tail, previous = kept[-1], kept[-2]
        if len(tail.text.strip()) > 3:
            break
        height = max(tail.height, previous.height)
        if gap_between(previous, tail) <= height * 1.5:
            break
        kept = kept[:-1]
    return kept


def clean_label(words: Sequence[WordBox]) -> str:
    sorted_words = sorted(
        (word for word in words if re.search(r"[A-Za-z0-9&$]", word.text)),
        key=lambda w: (w.x, w.y),
    )
    ordered = drop_trailing_strays(drop_leading_strays(sorted_words))
    xs = sorted(word.x for word in ordered)
    column = xs[len(xs) // 2] if xs else 0.0
    margin = column * 0.45
    kept: list[str] = []
    for index, word in enumerate(ordered):
        if len(ordered) >= 3 and word.right < margin:
            continue
        # `!` and `?` end printed names (`$50 OR $100!`), so they stay.
        token = re.sub(r"^[^A-Za-z0-9&$/]+|[^A-Za-z0-9&$/!?]+$", "", word.text.strip())
        if not token:
            continue
        if len(token) == 1 and not re.fullmatch(r"[0-9&]", token) and not is_spaced_word(ordered, index):
            continue
        if not re.search(r"[A-Za-z0-9&$]", token):
            continue
        kept.append(token)
    return " ".join(kept)


LOOKALIKE_DIGITS = {"S": "5", "O": "0", "o": "0", "B": "8", "I": "1", "l": "1"}


def pack_token(text: str) -> str:
    """A word's text as a pack code, with digit look-alikes put back."""
    token = token_core(text)
    if not re.fullmatch(r"[\dSOoBIl]{3}-[\dSOoBIl]{5,8}", token):
        return token
    if len(re.findall(r"\d", token)) < 6:
        return token
    return "".join(LOOKALIKE_DIGITS.get(char, char) for char in token)


def find_pack(words: Sequence[WordBox]) -> tuple[str, set[int]] | None:
    ordered = sorted(words, key=lambda w: (w.x, w.y))
    for index, word in enumerate(ordered):
        token = pack_token(word.text)
        if PACK.match(token):
            return token, {id(word)}
        bare = re.fullmatch(r"(\d{3})(\d{5,8})", token)
        if bare:
            return f"{bare.group(1)}-{bare.group(2)}", {id(word)}
        if index + 1 >= len(ordered):
            continue
        nxt = ordered[index + 1]
        if nxt.x - word.right > 24:
            continue
        joined = re.sub(r"\s+", "", f"{token}{token_core(nxt.text)}")
        normalized = re.sub(r"^(\d{3})(\d{5,8})$", r"\1-\2", joined)
        if PACK.match(normalized):
            return normalized, {id(word), id(nxt)}
    return None


def looks_like_pack(word: WordBox) -> bool:
    """A game-pack code, with or without its hyphen, as the anchor of a row."""
    return bool(re.fullmatch(r"\d{3}-?\d{5,8}", pack_token(word.text)))


def _vertical_overlap(word: WordBox, top: float, bottom: float) -> float:
    return max(0.0, min(word.bottom, bottom) - max(word.y, top))


def opens_split_pack(word: WordBox, words: Sequence[WordBox]) -> bool:
    """The game half of a pack code the reader split in two: `881` `023234`."""
    if not re.fullmatch(r"\d{3}-?", token_core(word.text)):
        return False
    return any(
        re.fullmatch(r"-?\d{5,8}", token_core(nxt.text))
        and nxt.x > word.x
        and nxt.x - word.right <= 24
        and _vertical_overlap(nxt, word.y, word.bottom) > word.height * 0.5
        for nxt in words
    )


def page_right(words: Sequence[WordBox]) -> float:
    return max((word.right for word in words), default=0.0)


def dates_without_pack(packs: Sequence[WordBox], dates: Sequence[WordBox]) -> list[WordBox]:
    """Dates that open a row of their own because no pack code was read beside them."""
    if len(packs) < 3:
        return []
    pitch = row_pitch(packs)
    top = min(word.centre_y for word in packs) - pitch * 1.5
    bottom = max(word.centre_y for word in packs) + pitch * 1.5
    paired = [
        date
        for date in dates
        if any(abs(pack.centre_y - date.centre_y) < pitch * 0.5 for pack in packs)
    ]
    if not paired:
        return []
    column = median([date.centre_x for date in paired])
    width = median([date.width for date in paired])
    paired_ids = {id(date) for date in paired}
    out: list[WordBox] = []
    for date in dates:
        if id(date) in paired_ids:
            continue
        band = line_band([date])
        if any(
            other is not date and _vertical_overlap(other, band.top, band.bottom) > 0
            for other in dates
        ):
            continue
        if not (top < date.centre_y < bottom):
            continue
        if abs(date.centre_x - column) >= width:
            continue
        if any(abs(pack.centre_y - date.centre_y) < pitch * 0.5 for pack in packs):
            continue
        out.append(date)
    return out


def settled_date(text: str) -> str | None:
    """A settled date, including the forms the watermark drives the reader into."""
    digits = re.sub(r"\D", "", token_core(text))
    arrangements: list[str] = []
    if len(digits) == 6:
        arrangements.append(digits)
    elif len(digits) == 7:
        # One separator dropped entirely, the other read as a digit.
        arrangements.append(digits[:2] + digits[3:])
        arrangements.append(digits[:4] + digits[5:])
    elif len(digits) == 8:
        arrangements.append(digits[:2] + digits[3:5] + digits[6:])
    for candidate in arrangements:
        month = int(candidate[:2])
        day = int(candidate[2:4])
        if month < 1 or month > 12 or day < 1 or day > 31:
            continue
        return f"{candidate[:2]}/{candidate[2:4]}/{candidate[4:]}"
    return None


def settlement_rows_from_words(
    words: Sequence[WordBox],
    overlap_ratio: float = 0.5,
) -> list[SettlementRow]:
    """Weekly pack settlements: a game-pack code and a name left, a date right."""
    usable = [w for w in words if w.text.strip() and w.width > 0 and w.height > 0]
    right = page_right(usable)
    packs = [
        word
        for word in usable
        if word.x < right * 0.4 and (looks_like_pack(word) or opens_split_pack(word, usable))
    ]
    dates = [
        word for word in usable if settled_date(word.text) is not None and word.x >= right * 0.4
    ]
    anchors = packs + dates_without_pack(packs, dates)

    rows: list[SettlementRow] = []
    for line in assign_to_anchors(usable, anchors, overlap_ratio, 0.42):
        ordered = sorted(line, key=lambda w: (w.x, w.y))
        date_word = next(
            (
                word
                for word in reversed(ordered)
                if word.x >= right * 0.4 and settled_date(word.text) is not None
            ),
            None,
        )
        pack = find_pack(ordered)
        if date_word is None and pack is None:
            continue
        used = set(pack[1]) if pack else set()
        if date_word is not None:
            used.add(id(date_word))
        name = repair_game_name(
            clean_label(
                [
                    word
                    for word in ordered
                    if id(word) not in used and (date_word is None or word.x < date_word.x)
                ]
            )
        )
        rows.append(
            SettlementRow(
                game_pack=pack[0] if pack else "",
                name=name,
                date_settled=(settled_date(date_word.text) or "") if date_word else "",
                confidence=mean_confidence(ordered),
            )
        )
    return rows


def is_money(token: str) -> bool:
    return bool(re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d{2})?", token)) or bool(
        re.fullmatch(r"\d+\.\d{2}", token)
    )


def invoice_amount(text: str) -> str | None:
    """An invoice amount, including the forms the reader mangles."""
    token = token_core(text)
    token = re.sub(r"[“”\"'‘’`]+", "", token)
    token = token.replace("€", "C")
    token = re.sub(r"[|\\™*%\[\](){}]+", "", token)
    token = re.sub(r"^(\d+\.\d{2})\d$", r"\1", token)

    split_thousands = re.fullmatch(r"(\d)\.(\d{3})\.(\d{2})([cC¢])?", token)
    if split_thousands:
        credit = "C" if split_thousands.group(4) else ""
        return f"{split_thousands.group(1)}{split_thousands.group(2)}.{split_thousands.group(3)}{credit}"
    comma_as_dot = re.fullmatch(r"(\d)\.(\d{2})(\d{2,})", token)
    if comma_as_dot:
        digits = comma_as_dot.group(1) + comma_as_dot.group(2) + comma_as_dot.group(3)
        return f"{digits[:-2]}.{digits[-2:]}"

    body = token
    credit = ""
    if re.search(r"[¢cC]$", body):
        credit = "C"
        body = body[:-1]
    if is_money(body):
        return f"{body}{credit}"
    if re.fullmatch(r"\d+,\d{2}", body):
        return f"{body.replace(',', '.')}{credit}"
    if re.fullmatch(r"[0oO]{2,3}", body):
        return f"0.00{credit}"
    if re.fullmatch(r"\d{4,7}", body):
        return f"{body[:-2]}.{body[-2:]}{credit}"
    return None


def invoice_rows_from_words(
    words: Sequence[WordBox],
    overlap_ratio: float = 0.5,
) -> list[InvoiceField]:
    """Weekly invoice: a description on the left and an amount on the right."""
    usable = [w for w in words if w.text.strip() and w.width > 0 and w.height > 0]
    right = page_right(usable)
    anchors: list[WordBox] = []
    for word in usable:
        if word.x < right * 0.5:
            continue
        if is_decimal_tail(token_core(word.text)):
            continue
        bare_digits = bool(re.fullmatch(r"\d{4,7}", token_core(word.text)))
        if bare_digits and word.x < right * 0.68:
            continue
        if invoice_amount(word.text) is not None:
            anchors.append(word)

    rows: list[InvoiceField] = []
    for line in assign_to_anchors(usable, anchors, overlap_ratio, 0.42):
        ordered = sorted(line, key=lambda w: (w.x, w.y))
        amount = next((w for w in reversed(ordered) if invoice_amount(w.text) is not None), None)
        if amount is None:
            continue
        value = invoice_amount(amount.text) or ""
        amount_index = next(i for i, w in enumerate(ordered) if w is amount)
        nxt = ordered[amount_index + 1] if amount_index + 1 < len(ordered) else None
        next_token = token_core(nxt.text) if nxt is not None else ""
        next_is_tail = (is_decimal_tail(next_token) and "." not in value) or (
            is_credit_mark(next_token) and not re.search(r"[A-Za-z]$", value)
        )
        if nxt is not None and is_decimal_tail(next_token) and "." not in value:
            value = f"{value}{next_token}"
        elif nxt is not None and is_credit_mark(next_token) and not re.search(r"[A-Za-z]$", value):
            value = f"{value}{next_token.upper()}"
        tail = nxt if next_is_tail else None
        label = clean_label(
            [
                word
                for word in ordered
                if word is not amount and word is not tail and word.right <= amount.x + 2
            ]
        )
        if not label:
            continue
        rows.append(InvoiceField(label=label, value=value, confidence=mean_confidence(ordered)))
    return rows


def inventory_rows_from_words(
    words: Sequence[WordBox],
    overlap_ratio: float = 0.5,
) -> list[InventoryRow]:
    """Inventory rows only, top to bottom. Header and footer text are left out."""
    header = find_inventory_header(words)
    usable = [
        word
        for word in words
        if word.text.strip()
        and word.width > 0
        and word.height > 0
        and (header is None or id(word) not in header.word_ids)
        and (header is None or word.bottom > header.top)
    ]
    right = max((word.right for word in usable), default=0.0)
    game_like = [
        word for word in usable if GAME.match(strip_edges(word.text)) and word.x <= right * 0.45
    ]
    column_x = median([word.x for word in game_like])
    column_height = line_height(game_like)
    slack_left = max(48.0, column_height * 3)
    slack_right = max(16.0, column_height)

    candidates: list[WordBox] = []
    for word in usable:
        if is_totals(strip_edges(word.text)):
            candidates.append(word)
            continue
        if not GAME.match(strip_edges(word.text)) or word.x > right * 0.45:
            continue
        offset = word.x - column_x
        if -slack_left <= offset <= slack_right:
            candidates.append(word)

    totals_y = max(
        (word.centre_y for word in candidates if is_totals(strip_edges(word.text))),
        default=-math.inf,
    )
    anchors = (
        candidates
        if totals_y == -math.inf
        else [word for word in candidates if word.centre_y <= totals_y]
    )
    if not anchors:
        rows: list[InventoryRow] = []
        for line in group_into_lines(usable, overlap_ratio):
            row = inventory_row_from_line(line)
            if row is not None:
                rows.append(row)
        return rows

    groups = assign_to_anchors(usable, anchors, overlap_ratio, 0.35 + overlap_ratio)
    layout = count_layout(groups, header)
    if layout is not None:
        return [inventory_row_from_anchor(group, layout) for group in groups]

    rows = []
    for line in groups:
        row = inventory_row_from_line(line)
        if row is not None:
            rows.append(row)
    return rows


def choose_receipt_kind(
    inventory: Sequence[InventoryRow],
    settlements: Sequence[SettlementRow],
    invoice: Sequence[InvoiceField],
) -> str:
    """Pick the table that this page actually is."""
    counted = [row for row in inventory if row.int or row.rec or row.act or row.set]
    inventory_score = len(counted) + (2 if any(is_totals(row.name) for row in counted) else 0)
    if inventory_score >= 3 and inventory_score >= len(settlements):
        return "inventory"
    if len(settlements) >= 3 and len(settlements) >= len(invoice):
        return "settlements"
    if invoice:
        return "invoice"
    if settlements:
        return "settlements"
    return "inventory"
