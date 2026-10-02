"""
A PDF's own text, in the pixels of the page as rendered.

This replaces what pdf.js did in the browser. The app rasterises a page at
200 dpi and reads the text layer in that same pixel space, so that a word box
from the text layer and a word box from the recogniser mean the same thing and
the readers above need not know which one they were given.

PyMuPDF reports a word's ink box where pdf.js reported its advance, so a box
here is a pixel or two narrower than the one the browser produced. Nothing
downstream measures a single box against an absolute size — every rule is a
ratio against the page's own character or line — so the readings agree; the
corpus harness is what says so.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import pymupdf

from .boxes import WordBox, group_into_lines

#: The resolution the page is read at, matching the browser's raster.
DPI = 200


@dataclass(frozen=True, slots=True)
class Page:
    """One page of a document: its words, and the size they were placed in."""

    number: int
    width: int
    height: int
    words: list[WordBox]


def text_layer_is_usable(words: Sequence[WordBox]) -> bool:
    """
    Enough real characters that the page is a digital document rather than a
    scan with an empty or token text layer.
    """
    characters = sum(sum(c.isalnum() for c in word.text) for word in words)
    return len(words) >= 8 and characters >= 40


def _rotated(span_dir: tuple[float, float]) -> bool:
    """A run set down the margin is not a table cell; the app drops those."""
    return abs(span_dir[1]) > 0.35


def _without_overprints(words: Sequence[WordBox]) -> list[WordBox]:
    """
    Drop a word drawn a second time on top of the first.

    A PDF may set the same text repeatedly in the same place to embolden or
    shade it — this invoice draws `INVOICE` twenty-six times in its letterhead
    — and every copy is a word of its own to an extractor. Left in, they are
    the largest group of header-looking words on the page, and the reader
    takes the letterhead for the column titles.

    Two real instances of a word stand side by side, so only a box sitting on
    top of the one before it counts as a repeat. The same test `mergeGlyphs`
    makes in `frontend/src/lib/pdf-text.ts`, for the same reason.
    """
    kept: list[WordBox] = []
    for line in group_into_lines(words, 0.45):
        current: WordBox | None = None
        for word in sorted(line, key=lambda w: w.x):
            if current is not None and (
                word.text == current.text
                and abs(word.x - current.x) <= min(current.width, word.width) * 0.35
                and abs(word.y - current.y) <= max(current.height, word.height) * 0.35
            ):
                continue
            kept.append(word)
            current = word
    return kept


def page_words(page: pymupdf.Page, dpi: int = DPI) -> list[WordBox]:
    """Positioned words from the page's text layer, in rendered pixels."""
    scale = dpi / 72
    words: list[WordBox] = []
    for x0, y0, x1, y1, text, *_ in page.get_text("words"):
        stripped = text.strip()
        if not stripped:
            continue
        width = (x1 - x0) * scale
        height = (y1 - y0) * scale
        words.append(
            WordBox(
                text=stripped,
                x=x0 * scale,
                y=y0 * scale,
                width=max(width, 1.0),
                height=max(height, 1.0),
                confidence=1.0,
            )
        )
    return _without_overprints(words)


def read_pdf(data: bytes, dpi: int = DPI) -> list[Page]:
    """Every page of `data`, with the words its text layer carries."""
    scale = dpi / 72
    pages: list[Page] = []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        for number, page in enumerate(document, start=1):
            box = page.rect
            pages.append(
                Page(
                    number=number,
                    width=round(box.width * scale),
                    height=round(box.height * scale),
                    words=page_words(page, dpi),
                )
            )
    return pages


def render_page(data: bytes, number: int, dpi: int = DPI):
    """One page as an RGB image, for the pages that have to be recognised."""
    import numpy as np

    with pymupdf.open(stream=data, filetype="pdf") as document:
        pixmap = document[number - 1].get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72))
        buffer = np.frombuffer(pixmap.samples, dtype=np.uint8)
        return buffer.reshape(pixmap.height, pixmap.width, pixmap.n)
