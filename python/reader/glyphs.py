"""
Join the glyphs a recogniser returned one at a time.

A port of `frontend/src/ocr/layout/glyphs.ts`; the reasoning is written out
there and not repeated here. In short: a reader is free to box each glyph
separately, and on a line-printer face it usually does — `144732` comes back
as `1 4 4 7 3 2`. Everything downstream reads the layout from where words
start and the gaps between them, so a word cut into six pieces is six column
starts and five spaces that were never printed.

The three gaps on a printed line are an order apart — no gap within a word,
about a character between words, several between columns — so glyphs are
joined below a fraction of a character and a word space survives.
"""

from __future__ import annotations

from typing import Sequence

from .boxes import WordBox, character_width, group_into_lines

#: How much of a character may sit between two boxes that are one word.
GLYPH_GAP_CHARS = 0.35

#: How far two boxes' centres may differ and still be the same printed line.
BASELINE_RATIO = 0.35


def merge_glyph_runs(words: Sequence[WordBox]) -> list[WordBox]:
    """`words` with the glyphs of each word joined back together."""
    if len(words) < 2:
        return [word.copy() for word in words]
    page_character = character_width(words)
    if page_character <= 0:
        return [word.copy() for word in words]

    merged: list[WordBox] = []
    for line in group_into_lines(words, 0.45):
        # The line's own character, not the page's: a page is not set in one
        # size, and measured over the page a character is the items' one,
        # which on a line of larger type is narrower than that line's word
        # space. A line of two or three boxes says too little.
        character = (character_width(line) or page_character) if len(line) >= 4 else page_character
        reach = character * GLYPH_GAP_CHARS

        current: WordBox | None = None
        for word in sorted(line, key=lambda w: w.x):
            if current is None:
                current = word.copy()
                continue
            gap = word.x - current.right
            height = max(current.height, word.height, 1.0)
            centre_delta = abs(current.centre_y - word.centre_y)
            if centre_delta <= height * BASELINE_RATIO and gap <= reach:
                top = min(current.y, word.y)
                bottom = max(current.bottom, word.bottom)
                current = WordBox(
                    text=current.text + word.text,
                    x=current.x,
                    y=top,
                    # A box that overlaps the one before it must not shorten
                    # the pair.
                    width=max(current.width, word.right - current.x, 1.0),
                    height=max(1.0, bottom - top),
                    confidence=min(current.confidence, word.confidence),
                )
                continue
            merged.append(current)
            current = word.copy()
        if current is not None:
            merged.append(current)
    return merged
