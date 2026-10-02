"""
The word box, and the two things every reader does with a page of them.

This is the bottom of the Python reader: `glyphs`, `table`, `columns` and
`rows` all stand on it, and none of them may import each other through it.

Change nothing here lightly. The thresholds in every reader above are tuned
against these exact definitions, so a line grouped a hair differently here
moves a column edge there, on documents this file never mentions. `pnpm
corpus` is what says whether it did.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Sequence


@dataclass(slots=True)
class WordBox:
    """One word as a reader placed it, in the rendered page's pixels."""

    text: str
    x: float
    y: float
    width: float
    height: float
    #: Recognition confidence in [0, 1].
    confidence: float = 1.0

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    @property
    def centre_x(self) -> float:
        return self.x + self.width / 2

    @property
    def centre_y(self) -> float:
        return self.y + self.height / 2

    def copy(self) -> "WordBox":
        return replace(self)


@dataclass(frozen=True, slots=True)
class Band:
    """The top and bottom of a printed line."""

    top: float
    bottom: float


def median(values: Sequence[float]) -> float:
    """The middle value, or the mean of the middle two. 0 for nothing."""
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def line_band(line: Iterable[WordBox]) -> Band:
    top = float("inf")
    bottom = float("-inf")
    for word in line:
        top = min(top, word.y)
        bottom = max(bottom, word.bottom)
    return Band(top, bottom)


def _vertical_overlap(word: WordBox, band: Band) -> float:
    return max(0.0, min(word.bottom, band.bottom) - max(word.y, band.top))


def group_into_lines(
    words: Sequence[WordBox],
    overlap_ratio: float = 0.5,
) -> list[list[WordBox]]:
    """
    Group words onto shared baselines.

    Words are considered in top-to-bottom order and join the line they overlap
    most, so a slightly raised count still stays on its row. Only the last few
    lines are considered, as in the TypeScript: a word cannot belong to a line
    the page left long ago, and the window is what keeps this linear.
    """
    ordered = sorted(words, key=lambda w: (w.centre_y, w.x))
    lines: list[list[WordBox]] = []

    for word in ordered:
        best: list[WordBox] | None = None
        best_overlap = 0.0
        start = max(0, len(lines) - 4)
        for index in range(len(lines) - 1, start - 1, -1):
            line = lines[index]
            band = line_band(line)
            overlap = _vertical_overlap(word, band)
            shorter = min(word.height, band.bottom - band.top)
            ratio = overlap / shorter if shorter > 0 else 0.0
            if ratio >= overlap_ratio and overlap > best_overlap:
                best = line
                best_overlap = overlap
        if best is not None:
            best.append(word)
        else:
            lines.append([word])

    for line in lines:
        line.sort(key=lambda w: w.x)
    lines.sort(key=lambda line: line_band(line).top)
    return lines


def character_width(words: Sequence[WordBox]) -> float:
    """Width of one character, from the words themselves."""
    widths = [
        word.width / len(word.text.strip())
        for word in words
        if word.text.strip() and word.width > 0
    ]
    return median(widths)
