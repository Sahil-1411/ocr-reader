"""
A whole document in, the finished reading out.

This is what the browser used to do for itself: rasterise a PDF, read its text
layer, fall back to a recogniser where there is none, and assemble the rows.
It lives here now so that the app has one reader rather than two, and the page
decides nothing.

A page is read from the PDF's own text where it has one, because that text is
exact and a recogniser's is not. A scan, a photograph, or a PDF whose text
layer is a token has to be recognised, and only those pages pay for it.

The column edges a page settles are carried to the page after it, as they were
in the browser: a long invoice prints its titles once and the pages that
follow have only the rows.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from .assemble import OcrResult, assemble_receipt
from .boxes import WordBox
from .columns import ColumnGuide
from .glyphs import merge_glyph_runs
from .pdf_text import DPI, read_pdf, render_page, text_layer_is_usable

#: What a reader is: pixels in, word boxes out.
Recogniser = Callable[[Any], list[WordBox]]


@dataclass(slots=True)
class PageReading:
    number: int
    width: int
    height: int
    #: `pdf text` or the recogniser's name, so a caller can see which was used.
    reader: str
    result: OcrResult
    words: list[WordBox]


def looks_like_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _guide_from(result: OcrResult) -> ColumnGuide | None:
    if result.kind != "table" or result.column_bounds is None:
        return None
    if len(result.column_bounds) != len(result.headers):
        return None
    return ColumnGuide(headers=list(result.headers), bounds=list(result.column_bounds))


def read_document(
    data: bytes,
    recognise: Recogniser | None = None,
    dpi: int = DPI,
    row_overlap_ratio: float = 0.5,
) -> list[PageReading]:
    """
    Every page of `data`, read.

    `recognise` is called only for a page with no usable text layer. Without
    one such a page is still returned, with no rows and a warning saying so,
    rather than failing the whole document: the pages that could be read are
    worth having.
    """
    if looks_like_pdf(data):
        return _read_pdf_document(data, recognise, dpi, row_overlap_ratio)
    return _read_image(data, recognise, row_overlap_ratio)


def _read_pdf_document(
    data: bytes,
    recognise: Recogniser | None,
    dpi: int,
    row_overlap_ratio: float,
) -> list[PageReading]:
    readings: list[PageReading] = []
    guide: ColumnGuide | None = None
    for page in read_pdf(data, dpi):
        if text_layer_is_usable(page.words):
            words = page.words
            reader = "pdf text"
        elif recognise is not None:
            # The recogniser returns glyphs as often as words on this print.
            words = merge_glyph_runs(recognise(render_page(data, page.number, dpi)))
            reader = "recogniser"
        else:
            words = []
            reader = "none"
        result = assemble_receipt(words, row_overlap_ratio, guide)
        guide = _guide_from(result) or guide
        if reader == "none":
            result.warnings.append(
                "This page is a scan and no recogniser is available to read it."
            )
        readings.append(
            PageReading(
                number=page.number,
                width=page.width,
                height=page.height,
                reader=reader,
                result=result,
                words=list(words),
            )
        )
    return readings


def _read_image(
    data: bytes,
    recognise: Recogniser | None,
    row_overlap_ratio: float,
) -> list[PageReading]:
    import numpy as np
    from PIL import Image

    image = Image.open(io.BytesIO(data))
    # A page photographed or exported with transparency is a page on white,
    # not a page on black; flattening it here keeps the ink where it was.
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        white = Image.new("RGB", image.size, (255, 255, 255))
        white.paste(image, mask=image.split()[-1])
        image = white
    else:
        image = image.convert("RGB")
    pixels = np.asarray(image)

    words = merge_glyph_runs(recognise(pixels)) if recognise is not None else []
    result = assemble_receipt(words, row_overlap_ratio, None)
    if recognise is None:
        result.warnings.append("No recogniser is available to read this image.")
    return [
        PageReading(
            number=1,
            width=int(image.width),
            height=int(image.height),
            reader="recogniser" if recognise is not None else "none",
            result=result,
            words=list(words),
        )
    ]


# --------------------------------------------------------------------------- #
# The reading as JSON                                                          #
# --------------------------------------------------------------------------- #


def _row_confidences(result: OcrResult) -> list[float]:
    """Each row's mean word confidence, whichever kind of page this is."""
    if result.kind == "inventory":
        return [row.confidence for row in result.rows]
    if result.kind == "settlements":
        return [row.confidence for row in result.settlements]
    if result.kind == "invoice":
        return [field.confidence for field in result.fields]
    return [row.confidence for row in result.table_rows]


def _rows_json(result: OcrResult) -> list[dict]:
    """
    Every kind's rows in one shape: cells left to right, under `headers`.

    The page has no business knowing that an inventory row has a `game` and a
    settlement has a `gamePack`. It is given cells and the titles they sit
    under, which is all it draws.
    """
    from .assemble import row_cells

    cells = row_cells(result)
    confidences = _row_confidences(result)
    width = len(result.headers)
    out: list[dict] = []
    for index, row in enumerate(cells):
        # Padded, never cut: a page whose last column title was not read still
        # printed the cells under it, and the export titles those `Column 3`.
        padded = list(row) + [""] * max(0, width - len(row))
        out.append(
            {
                "cells": padded,
                "confidence": confidences[index] if index < len(confidences) else 1.0,
                **({"label": True} if result.kind == "table" and result.table_rows[index].label else {}),
            }
        )
    return out


def page_json(reading: PageReading) -> dict:
    """One page's reading, in the shape the app renders."""
    result = reading.result
    return {
        "page": reading.number,
        "kind": result.kind,
        "reader": reading.reader,
        "size": {"width": reading.width, "height": reading.height},
        **({"title": result.title} if result.title else {}),
        "headers": list(result.headers),
        "rows": _rows_json(result),
        **({"columnBounds": result.column_bounds} if result.column_bounds else {}),
        "tables": result.tables,
        "validation": [
            {"code": issue.code, "message": issue.message, "rows": issue.rows}
            for issue in result.validation
        ],
        "skipped": [
            {"reason": entry.reason, "text": entry.text, "confidence": entry.confidence, "y": entry.y}
            for entry in result.skipped
        ],
        "warnings": list(result.warnings),
        "wordCount": result.word_count,
        "words": [
            {
                "text": word.text,
                "x": round(word.x, 2),
                "y": round(word.y, 2),
                "width": round(word.width, 2),
                "height": round(word.height, 2),
                "confidence": round(word.confidence, 4),
            }
            for word in reading.words
        ],
    }


def document_json(readings: Sequence[PageReading]) -> dict:
    return {"pages": [page_json(reading) for reading in readings]}
