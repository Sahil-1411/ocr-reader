"""
What a line the table reader left out actually is.

A line that could not be placed in a column is logged `unplaced`, which the
export presents as "worth checking — this is the only kind that might be data".
On a real document most of those are nothing of the kind: a purchase-order
number printed at the top of all seven pages, a category band inside the item
list, a key saying what `*` means, the document's own totals. Reported as
possibly-missing data they bury the one line that might be, and a signal that
cries wolf on eight lines out of eight is not a signal.

Everything here reads the page's geometry rather than its wording, because a
word list only ever describes the documents it was written against:

* **It repeats.** A line printed verbatim on more than one page is a field of
  the page, not a row of the table. Two items never share an item number.
* **It is indented.** Where a document sets its annotations apart with their
  own left edge — every band and note at x=528 while every item starts at
  x=66 — that edge says in the document's own hand that these are not items.
* **It is outside.** A line starting left of the table's first column is in
  the margin, not in the table.

The two exceptions are about notation and arithmetic, not vocabulary: a line
that explains a symbol (`D = DRY`, `* DENOTES …`) is a legend, and a line of
`KEY: figure` pairs is the document restating its own totals.

Nothing here moves a line into or out of the table. Every line it sees was
already left out, and all it changes is what the log calls it, so a rule that
is wrong costs a wrong label and never a lost row. `pnpm corpus` shows each
change as a `skip` line that moved while the `row` lines stayed put.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Sequence

from .columns import SkippedLine

#: Reasons this pass may assign. `note` and `summary` already existed; the
#: rest are introduced here, and `export.SKIP_REASONS` describes each one.
PAGE_FIELD = "page-field"
ANNOTATION = "annotation"
LEGEND = "legend"
MARGIN = "margin"

#: Only a line the reader could not place is reclassified. A line it already
#: recognised — a note it cut, a total, a repeated header — is left alone.
OPEN = "unplaced"


@dataclass(slots=True)
class PageLines:
    """One page's leftovers, and what is needed to judge them."""

    number: int
    #: Rewritten in place.
    skipped: list[SkippedLine]
    #: Left edge of the table's first column, where the page has one.
    body_left: float | None


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().upper()


# A symbol being explained: `D = DRY`, `* - DENOTES A QUANTITY CHANGE`.
_EXPLAINS = re.compile(r"\b(?:denotes?|means?|indicates?|abbreviat\w*|legend|key)\b", re.I)
_DEFINES = re.compile(r"[A-Za-z0-9]\s*=\s*[A-Za-z0-9]")
#: `NET PRICE: $32,165.34`, `CUBE:  492.45` — a key and the figure it carries.
_KEYED_FIGURE = re.compile(r"[A-Za-z][A-Za-z.\s]*:\s*\$?-?[\d,]+(?:\.\d+)?")


def _is_legend(text: str) -> bool:
    """A line that explains the document's own notation rather than saying anything."""
    if _DEFINES.search(text):
        return True
    return bool(_EXPLAINS.search(text)) and bool(re.search(r"[*+#†‡]|\b[A-Z]\b", text))


def _is_document_total(text: str) -> bool:
    """`NET PRICE: $32,165.34 SHIP QTY: 981 WEIGHT: 6,341.11` — the page adding itself up."""
    return len(_KEYED_FIGURE.findall(text)) >= 2


def _annotation_indent(pages: Sequence[PageLines]) -> float | None:
    """
    The left edge a document reserves for the things that are not items.

    Taken across the whole document rather than one page, because a page may
    carry only one annotation while the document carries twenty at the same
    indent. It has to be shared — one line sitting on its own proves nothing —
    and it has to be clear of where the items start, or it is just an item
    whose first column did not read.
    """
    tally: Counter[int] = Counter()
    for page in pages:
        if page.body_left is None:
            continue
        for entry in page.skipped:
            if entry.reason != OPEN or entry.x <= page.body_left:
                continue
            tally[int(entry.x)] += 1
    shared = [x for x, seen in tally.items() if seen >= 2]
    return float(min(shared)) if shared else None


def refine(pages: Sequence[PageLines]) -> None:
    """
    Say what each unplaced line is, in place.

    The rules run in the order written, and the first one that recognises a
    line settles it. Repetition comes first because it is the one signal that
    cannot be a coincidence of layout: whatever a line looks like, if the
    document printed it on page after page it belongs to the page.
    """
    _repeated(pages)
    indent = _annotation_indent(pages)
    for page in pages:
        for entry in page.skipped:
            if entry.reason != OPEN:
                continue
            text = _normalise(entry.text)
            if page.body_left is not None and entry.x < page.body_left:
                entry.reason = MARGIN
            elif _is_document_total(text):
                entry.reason = "summary"
            elif _is_legend(text):
                entry.reason = LEGEND
            elif indent is not None and entry.x >= indent:
                entry.reason = ANNOTATION


def _repeated(pages: Sequence[PageLines]) -> None:
    """
    A line printed on more than one page is a field of the page.

    Counted by page and not by appearance: a note that is genuinely printed
    twice on one page is still only about that page, while the same words at
    the top of every page are the document's furniture. Both copies are
    relabelled, so the log never shows one line under two headings.
    """
    seen: dict[str, set[int]] = defaultdict(set)
    for page in pages:
        for entry in page.skipped:
            if entry.reason == OPEN:
                seen[_normalise(entry.text)].add(page.number)
    everywhere = {text for text, numbers in seen.items() if len(numbers) >= 2}
    if not everywhere:
        return
    for page in pages:
        for entry in page.skipped:
            if entry.reason == OPEN and _normalise(entry.text) in everywhere:
                entry.reason = PAGE_FIELD
