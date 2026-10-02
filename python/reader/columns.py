"""
Read a multi-column table (a wholesale invoice, a price list) by lining words
up under the printed header.

Every rule here is argued for at the rule itself, below. This file is the only
reader: nothing defers to a second copy, and a threshold changed here changes
what the app, a script and the export all see.

It started as a port of a TypeScript reader, and two differences between the
languages are still worth naming, because either would change a reading if it
were let through:

* `Math.min()` over nothing is `Infinity` in JavaScript and an error in
  Python, so the spreads here say what they mean with an explicit default.
* `Math.round` rounds a half upwards; Python's `round` rounds a half to even.
  `js_round` keeps the JavaScript behaviour where a rounded value decides
  something.
"""

from __future__ import annotations

import math
import re
from functools import cmp_to_key
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from .boxes import WordBox, group_into_lines, line_band, median

# --------------------------------------------------------------------------- #
# Shapes                                                                       #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class TableRow:
    cells: list[str]
    confidence: float
    #: A line kept for what it says rather than for what it is worth.
    label: bool = False


@dataclass(slots=True)
class SkippedLine:
    reason: str
    text: str
    confidence: float
    y: float
    #: Left edge of the printed line, in the same pixel space as the words.
    #: Where a document sets its annotations apart by indenting them, this is
    #: what says so — see `skipped.refine`.
    x: float = 0.0


@dataclass(slots=True)
class ColumnTable:
    headers: list[str]
    rows: list[TableRow]
    #: Left edge of each column, in the same pixel space as the words.
    bounds: list[float]
    #: Printed lines the reader left out, and notes it cut, in printed order.
    skipped: list[SkippedLine]
    #: Left edge of the lines that became rows. `bounds[0]` is the page's own
    #: edge, so it cannot say where the items start; this can, and `skipped`
    #: is judged against it.
    body_left: float = 0.0
    #: The heading printed over this table, when it has one of its own.
    title: str | None = None


@dataclass(slots=True)
class ColumnGuide:
    """Column edges learned from an earlier page of the same document."""

    headers: list[str]
    bounds: list[float]


@dataclass(slots=True)
class HeaderColumn:
    label: str
    x: float
    right: float


@dataclass(slots=True)
class _Header:
    columns: list[HeaderColumn]
    words: list[WordBox]
    top: float
    bottom: float


def js_round(value: float) -> int:
    """`Math.round`: a half goes upwards, not to even."""
    return math.floor(value + 0.5)


def _min(values: Iterable[float], default: float = math.inf) -> float:
    return min(values, default=default)


def _max(values: Iterable[float], default: float = -math.inf) -> float:
    return max(values, default=default)


# --------------------------------------------------------------------------- #
# Telling this page from a lottery ticket                                      #
# --------------------------------------------------------------------------- #


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def is_lottery_header(headers: Sequence[str]) -> bool:
    """A printed header this page is not a lottery ticket."""
    norm = [normalize(header) for header in headers]

    def has(pattern: str) -> bool:
        return any(re.search(pattern, header) for header in norm)

    inventory = (
        has(r"^games?$")
        and has(r"^name$")
        and has(r"^int")
        and has(r"^rec")
        and has(r"^act")
        and has(r"^set")
    )
    settlements = (has(r"gamepack") or (has(r"^game$") and has(r"pack"))) and (
        has(r"datesettled") or has(r"settled") or has(r"^date$")
    )
    return inventory or settlements


# --------------------------------------------------------------------------- #
# Finding the printed header                                                   #
# --------------------------------------------------------------------------- #

HEADER_WORD = re.compile(
    r"^(?:qty|quantity|case|unt|unit|item#?|items?|part#?|upc|sku|description|pack|prc"
    r"|price|extended|amount|total|ordered|shipped|customer|tax|per|oos|qos|sub-?|code"
    r"|date|dated|invoice#?|balance|charge|credit|debit|category|lines?|units?|cost)$",
    re.I,
)


def clean_label(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def span_of(words: Sequence[WordBox]) -> tuple[float, float]:
    """The left and right edge of a stack of header words."""
    return _min(w.x for w in words), _max(w.right for w in words)


def sits_under(word: WordBox, span: tuple[float, float]) -> bool:
    """Whether a printed word sits under a title, rather than merely near it."""
    x, right = span
    overlap = min(word.right, right) - max(word.x, x)
    if overlap <= 0:
        return False
    return overlap >= min(word.width, right - x) * 0.3


def both_carry_values(
    left: Sequence[WordBox],
    right: Sequence[WordBox],
    below: Sequence[WordBox],
    height: float,
) -> bool:
    """Whether the rows under the header fill both of two neighbouring titles."""
    if not below:
        return False
    left_span = span_of(left)
    right_span = span_of(right)
    gutter = (left_span[1] + right_span[0]) / 2
    straddles = sum(
        1
        for word in below
        if word.text.strip() and word.x < gutter - 1 and word.right > gutter + 1
    )
    if straddles > 0:
        return False

    lines: dict[int, list[WordBox]] = {}
    for word in below:
        if not word.text.strip():
            continue
        key = js_round(word.centre_y / max(height * 0.8, 1))
        lines.setdefault(key, []).append(word)

    filled = 0
    for line in lines.values():
        under_left = [word for word in line if sits_under(word, left_span)]
        under_right = [word for word in line if sits_under(word, right_span)]
        # The same word reaching under both titles is one value, not two.
        if any(word not in under_right for word in under_left) and any(
            word not in under_left for word in under_right
        ):
            filled += 1
            if filled >= 2:
                return True
    return False


def split_by_body(
    stacks: Sequence[list[WordBox]],
    below: Sequence[WordBox],
    height: float,
) -> list[list[list[WordBox]]]:
    """Part a run of titles wherever the rows beneath fill both sides of it."""
    if len(stacks) < 2:
        return [list(stacks)]
    candidates = [
        (
            index,
            _min(w.x for w in stacks[index])
            - _max(w.right for stack in stacks[:index] for w in stack),
        )
        for index in range(1, len(stacks))
    ]
    candidates.sort(key=lambda pair: -pair[1])

    for index, _gap in candidates:
        left = list(stacks[:index])
        right = list(stacks[index:])
        flat_left = [w for stack in left for w in stack]
        flat_right = [w for stack in right for w in stack]
        if both_carry_values(flat_left, flat_right, below, height):
            return split_by_body(left, below, height) + split_by_body(right, below, height)
    return [list(stacks)]


def one_baseline(words: Sequence[WordBox], height: float) -> bool:
    centres = [word.centre_y for word in words]
    return (_max(centres) - _min(centres)) <= height * 0.4


def join_label(words: Sequence[WordBox]) -> str:
    # Line by line, and left to right within a line: a recogniser can set the
    # second word of `UNIT PRICE` a pixel or two higher than the first.
    by_top = sorted(words, key=lambda w: (w.y, w.x))
    rows: list[list[WordBox]] = []
    for word in by_top:
        row = rows[-1] if rows else None
        above = row[0] if row else None
        if row is not None and above is not None and abs(word.centre_y - above.centre_y) <= above.height * 0.4:
            row.append(word)
        else:
            rows.append([word])
    ordered = [word for row in rows for word in sorted(row, key=lambda w: w.x)]
    out = ""
    for word in ordered:
        text = clean_label(word.text)
        if not text or text in out.split(" "):
            continue
        if not out:
            out = text
            continue
        glue = out.endswith("-") or out.endswith("/") or text.startswith("-")
        out = f"{out}{text}" if glue else f"{out} {text}"
    return out


def group_header_columns(
    line: Sequence[WordBox],
    below: Sequence[WordBox] = (),
) -> list[HeaderColumn]:
    """Split header words into columns."""
    filtered = sorted(
        (word for word in line if word.text.strip()),
        key=lambda w: (w.x, w.y),
    )
    if not filtered:
        return []

    height = median([word.height for word in filtered]) or 12

    # A wrapped title is centred on the line above (`Qty` under `Ordered`).
    # Join those by overlap; words that only share a left edge overlap too.
    parent = list(range(len(filtered)))

    def find(index: int) -> int:
        cursor = index
        while parent[cursor] != cursor:
            parent[cursor] = parent[parent[cursor]]
            cursor = parent[cursor]
        return cursor

    def union(left: int, right: int) -> None:
        a, b = find(left), find(right)
        if a != b:
            parent[b] = a

    for i in range(len(filtered)):
        for j in range(i + 1, len(filtered)):
            a, b = filtered[i], filtered[j]
            if abs(a.centre_y - b.centre_y) <= height * 0.4:
                continue
            overlap = min(a.right, b.right) - max(a.x, b.x)
            narrower = min(a.width, b.width)
            if overlap > 0 and overlap >= narrower * 0.35:
                union(i, j)

    buckets: dict[int, list[WordBox]] = {}
    for index, word in enumerate(filtered):
        buckets.setdefault(find(index), []).append(word)
    stacked = sorted(buckets.values(), key=lambda stack: _min(w.x for w in stack))

    # `CASE QTY` is two words on one baseline. A title that already wrapped
    # does not absorb the next title, even when the boxes nearly touch.
    groups: list[list[list[WordBox]]] = []
    for stack in stacked:
        previous = groups[-1] if groups else None
        previous_words = [w for s in previous for w in s] if previous else []
        if (
            previous is not None
            and one_baseline(previous_words, height)
            and one_baseline(stack, height)
        ):
            previous_right = _max(w.right for w in previous_words)
            gap = _min(w.x for w in stack) - previous_right
            if 0 < gap <= height * 0.7:
                previous.append(stack)
                continue
        groups.append([list(stack)])

    columns: list[HeaderColumn] = []
    for group in groups:
        for stacks in split_by_body(group, below, height):
            words = [w for stack in stacks for w in stack]
            label = join_label(words)
            if not label:
                continue
            columns.append(
                HeaderColumn(label=label, x=_min(w.x for w in words), right=_max(w.right for w in words))
            )
    return columns


_KEYWORDS = re.compile(
    r"\b(qty|quantity|description|name|unit|price|amount|total|date|item|code|number"
    r"|pack|cost|order|upc|sku|part|extended|prc|case)\b",
    re.I,
)


def score_header(
    columns: Sequence[HeaderColumn],
    next_line: Sequence[WordBox] | None,
    line_index: int,
) -> float:
    labels = [column.label for column in columns]
    joined = " ".join(labels)
    if labels and all(re.fullmatch(r"\$?[\d.,]+%?", label) for label in labels):
        return 0
    if re.search(r"https?://|www\.|\.com\b|@", joined):
        return 0
    if re.search(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b", joined):
        return 0

    textual = [label for label in labels if re.search(r"[A-Za-z]", label) and not re.match(r"^\d", label)]
    if len(textual) < len(labels) * 0.6:
        return 0

    score = 0.0
    score += 18 * (len(textual) / len(labels))
    if len(labels) >= 6:
        score += 34
    elif len(labels) >= 4:
        score += 28
    else:
        score += 16

    upper = sum(1 for label in textual if label == label.upper() and re.search(r"[A-Z]", label))
    if upper >= len(textual) * 0.5:
        score += 12

    keyword_count = len(_KEYWORDS.findall(joined))
    if keyword_count >= 3:
        score += 26
    elif keyword_count >= 2:
        score += 16
    elif keyword_count >= 1:
        score += 8

    if 2 <= line_index <= 24:
        score += 4

    if next_line and len(next_line) >= 2:
        next_text = [word.text.strip() for word in next_line if word.text.strip()]
        numeric = sum(1 for text in next_text if re.search(r"\d", text))
        if numeric >= 2 and any(re.search(r"[A-Za-z]", text) for text in next_text):
            score += 18
        elif numeric >= 2:
            score += 12

    if len(labels) <= 3 and re.search(r"\b(invoice|statement|receipt|summary|report)\b", joined, re.I):
        score -= 24
    if len(joined) > 140 and len(labels) <= 3:
        score -= 12
    long_ids = sum(1 for label in labels if re.search(r"\d{3,}[-/]\d{3,}", label))
    if long_ids >= 1:
        score -= 30

    return score


def find_header(words: Sequence[WordBox], topmost: bool = False) -> _Header | None:
    """The printed column titles, including a header stacked on two baselines."""
    hits = [
        word
        for word in words
        if HEADER_WORD.match(word.text.strip()) or re.search(r"upc|part#|description", word.text, re.I)
    ]
    if len(hits) < 3:
        return None

    height = median([word.height for word in hits]) or 12
    reach = height * 1.3

    def band_of(group: Sequence[WordBox]) -> tuple[float, list[WordBox]]:
        top = _min(w.y for w in group)
        bottom = _max(w.bottom for w in group)
        low, high = top - height * 0.35, bottom + height * 0.35
        in_band = [
            word for word in words if low <= word.centre_y <= high and word.text.strip()
        ]
        return bottom, in_band

    def line_above(top: float) -> list[WordBox]:
        """The printed line directly above `top`, by the nearest baseline."""
        above = [word for word in words if word.text.strip() and word.centre_y < top]
        if not above:
            return []
        nearest = _max(w.centre_y for w in above)
        return [word for word in above if abs(word.centre_y - nearest) <= height * 0.5]

    def stacks_over(line: Sequence[WordBox], columns: Sequence[HeaderColumn]) -> bool:
        """Whether `line` is the top of titles stacked over `columns`."""
        if not line or len(line) > len(columns):
            return False
        taken: set[int] = set()
        for word in line:
            over = [
                index
                for index, column in enumerate(columns)
                if (min(word.right, column.right) - max(word.x, column.x)) > 0
                and (min(word.right, column.right) - max(word.x, column.x))
                >= min(word.width, column.right - column.x) * 0.35
            ]
            if len(over) != 1 or over[0] in taken:
                return False
            taken.add(over[0])
        return True

    groups: list[list[WordBox]] = []
    for anchor in hits:
        centre = anchor.centre_y
        groups.append([word for word in hits if abs(word.centre_y - centre) <= reach])
    groups.sort(key=lambda group: -len(group))

    def titles(group: Sequence[WordBox]) -> _Header | None:
        if len(group) < 3:
            return None
        bottom, banded = band_of(group)
        if any(re.fullmatch(r"\$?[\d,]*\d\.\d{2}", word.text.strip()) for word in banded):
            return None
        body = [word for word in words if bottom < word.y < bottom + height * 14]
        header_words = list(banded)
        columns = group_header_columns(header_words, body)
        # Titles stacked on a line the hits did not reach; see the TypeScript.
        for _ in range(2):
            if len(columns) < 3:
                break
            above = line_above(_min(w.y for w in header_words))
            if not stacks_over(above, columns):
                break
            header_words = header_words + above
            columns = group_header_columns(header_words, body)
        if len(columns) < 3:
            return None
        next_line = [word for word in words if bottom < word.y < bottom + height * 3]
        if score_header(columns, next_line, 4) < 28:
            return None
        return _Header(
            columns=columns,
            words=header_words,
            top=_min(w.y for w in header_words),
            bottom=bottom,
        )

    if not topmost:
        for group in groups:
            found = titles(group)
            if found is not None:
                return found
        return None

    down = sorted(groups, key=lambda group: (_min(w.y for w in group), -len(group)))
    for group in down:
        found = titles(group)
        if found is not None:
            return found
    return None


def title_above(
    top: float,
    lines: Sequence[Sequence[WordBox]],
    line_height: float,
) -> str | None:
    """The heading a table is printed under: `Previous Balances`."""
    best: str | None = None
    for line in lines:
        band = line_band(line)
        if band.bottom > top - 1 or band.bottom < top - line_height * 3:
            continue
        text = " ".join(word.text.strip() for word in line if word.text.strip())
        if not re.search(r"[A-Za-z]", text) or len(text.split()) > 5:
            continue
        if re.search(r"\d[.,]\d{2}|[$€£]", text):
            continue
        best = text
    return best


def usable_guide(guide: ColumnGuide | None) -> tuple[list[HeaderColumn], list[float]] | None:
    if guide is None or len(guide.headers) < 3 or len(guide.bounds) != len(guide.headers):
        return None
    columns = []
    for index, label in enumerate(guide.headers):
        x = guide.bounds[index]
        right = guide.bounds[index + 1] if index + 1 < len(guide.bounds) else x
        columns.append(HeaderColumn(label=label, x=x, right=right))
    return columns, list(guide.bounds)


def column_bounds(columns: Sequence[HeaderColumn]) -> list[float]:
    if not columns:
        return [0.0]
    bounds = [min(0.0, columns[0].x - 4)]
    for index in range(len(columns) - 1):
        current, nxt = columns[index], columns[index + 1]
        # A trailing space can make this title's box reach into the next column.
        right = min(current.right, nxt.x - 1)
        label_width = max(1.0, current.right - current.x)
        gap = nxt.x - right
        roomy = gap > label_width * 1.5
        shoulder = right + min(gap * 0.22, label_width * 0.45)
        bounds.append(shoulder if roomy else nxt.x - 1)
    return bounds


# --------------------------------------------------------------------------- #
# Placing a line's words in the columns                                        #
# --------------------------------------------------------------------------- #


def is_inked(word: WordBox) -> bool:
    """A word with a letter or digit in it; a lone speck of punctuation is not."""
    return bool(re.search(r"[A-Za-z0-9]", word.text))


def join_words(words: Sequence[WordBox]) -> str:
    ordered = sorted(words, key=lambda w: (w.x, w.y))
    out = ""
    previous: WordBox | None = None
    for word in ordered:
        text = word.text.strip()
        if not text:
            continue
        if not out or previous is None:
            out = text
            previous = word
            continue
        # A reader can break `849-1706888` at the hyphen, or `3.45` at the
        # point, and the halves are only a glyph's own margin apart.
        gap = word.x - previous.right
        glyph = max(
            previous.width / max(len(previous.text.strip()), 1),
            word.width / max(len(text), 1),
        )
        prev = out[-1]
        decimals = bool(re.match(r"^\.\d", text)) and bool(re.search(r"\d$", out)) and gap < glyph
        lone = previous.text.strip() == "-"
        runs_on = prev in "-/" and not lone and gap < glyph * 0.6
        joiner = text.startswith("-") or text.startswith(".") or (lone and bool(re.match(r"^\d", text)))
        out = f"{out}{text}" if (decimals or runs_on or (joiner and gap <= glyph * 0.35)) else f"{out} {text}"
        previous = word
    return out


def mean_confidence(words: Sequence[WordBox]) -> float:
    if not words:
        return 0.0
    return sum(word.confidence for word in words) / len(words)


def fields_on_line(line: Sequence[WordBox], line_height: float) -> list[list[WordBox]]:
    """Words separated by a real space stay one field. A column gap starts the next."""
    ordered = sorted(line, key=lambda w: (w.x, w.y))
    fields: list[list[WordBox]] = []
    for word in ordered:
        current = fields[-1] if fields else None
        previous = current[-1] if current else None
        gap = (word.x - previous.right) if previous is not None else 0.0
        sign = current is not None and len(current) == 1 and bool(
            re.fullmatch(r"[$€£]", previous.text.strip() if previous else "")
        )
        if current is not None and (gap <= line_height * 0.8 or sign):
            current.append(word)
        else:
            fields.append([word])
    return fields


def column_index(word: WordBox, bounds: Sequence[float]) -> int:
    anchor = word.centre_x
    index = 0
    for cursor, bound in enumerate(bounds):
        if anchor >= bound:
            index = cursor
    # The taxable flag is a one-letter mark on the unit-price column.
    boundary = bounds[index] if index < len(bounds) else 0.0
    if index > 0 and word.text == "T" and word.x < boundary + word.height * 0.5:
        index -= 1
    # A price-change star sits in the gap just left of the price column.
    if (
        word.text == "*"
        and index + 1 < len(bounds)
        and bounds[index + 1] - word.right <= word.height * 0.6
    ):
        index += 1
    return index


def horizontal_overlap(fields: Sequence[WordBox], column: HeaderColumn) -> float:
    x = _min(w.x for w in fields)
    right = _max(w.right for w in fields)
    return min(right, column.right) - max(x, column.x)


def title_of(part: Sequence[WordBox], columns: Sequence[HeaderColumn]) -> int:
    """The one title `part` is set under, or -1."""
    x = _min(w.x for w in part)
    right = _max(w.right for w in part)
    hits = []
    for index, column in enumerate(columns):
        overlap = min(right, column.right) - max(x, column.x)
        narrower = min(right - x, column.right - column.x)
        if overlap > 0 and overlap >= narrower * 0.5:
            hits.append(index)
    return hits[0] if len(hits) == 1 else -1


def starts_in_column(
    fields: Sequence[WordBox],
    bounds: Sequence[float],
    index: int,
    slack: float,
) -> bool:
    """Whether a field begins in the column it overlaps, rather than merely reaching it."""
    start = _min(w.x for w in fields)
    low = (bounds[index] if index < len(bounds) else -math.inf) - slack
    high = bounds[index + 1] if index + 1 < len(bounds) else math.inf
    return start >= low and start < high


def parts_across_titles(
    fields: Sequence[WordBox],
    columns: Sequence[HeaderColumn],
) -> list[tuple[int, list[WordBox]]]:
    """A field set across two titles, cut at its widest gap when each half is one column's own."""
    if len(fields) < 2:
        return []
    at = -1
    widest = 0.0
    runner_up = 0.0
    for index in range(1, len(fields)):
        gap = fields[index].x - fields[index - 1].right
        if gap > widest:
            runner_up = widest
            widest = gap
            at = index
        elif gap > runner_up:
            runner_up = gap
    if at < 0 or widest <= 0:
        return []
    # The cut has to be at a gap, not merely at the largest of several word
    # spaces; see the TypeScript for the invoice that forced this.
    if len(fields) > 2 and widest < runner_up * 1.5:
        return []
    found: list[tuple[int, list[WordBox]]] = []
    for half in (list(fields[:at]), list(fields[at:])):
        index = title_of(half, columns)
        if index < 0:
            return []
        found.append((index, half))
    return [] if found[0][0] == found[1][0] else found


def union_spans(spans: Sequence[tuple[float, float]]) -> list[list[float]]:
    """The stretches covered by any of `spans`, merged and in order."""
    merged: list[list[float]] = []
    for start, end in sorted(spans, key=lambda pair: pair[0]):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def character_width_of(words: Sequence[WordBox]) -> float:
    return median(
        [w.width / len(w.text.strip()) for w in words if w.text.strip() and w.width > 0]
    )


# --------------------------------------------------------------------------- #
# Learning the columns from the rows                                           #
# --------------------------------------------------------------------------- #

CODE_TITLE = re.compile(r"#|\b(?:item|code|sku|part|upc|ean|ref|style|model|no|number)\b", re.I)
QUANTITY_TITLE = re.compile(r"\b(?:qty|quantity|count|units?|ord(?:ered)?|ship(?:ped)?)\b", re.I)
#: `Item Price`, `Item Subtotal`: the item's money, not its code.
MONEY_TITLE = re.compile(
    r"\b(?:price|prc|cost|amount|amt|total|subtotal|ext(?:ended)?|value|charge)\b", re.I
)


def is_quantity(text: str) -> bool:
    """A count of items: `2`, `1,000`, `-2`, `(2)`, `2-`. Six digits and more are a code."""
    return bool(
        re.fullmatch(r"(?:-?(?:\d{1,5}|\d{1,3}(?:,\d{3})+)|\(\d{1,5}\)|\d{1,5}-)", text.strip())
    )


def is_figure(text: str) -> bool:
    """A quantity or an amount, with the marks printed beside them."""
    core = re.sub(r"\s+[A-Z*]$", "", re.sub(r"^[*\s]+", "", text.strip()))
    return is_quantity(core) or bool(
        re.fullmatch(r"[(-]?\$?\s?-?[\d,]*\d\.\d{1,4}\)?-?", core)
    )


@dataclass(slots=True)
class ColumnProfile:
    """What the item rows say about one column."""

    left: float
    right: float
    aligned: bool
    kind: str  # 'text' | 'code' | 'figure'
    money: bool


@dataclass(slots=True)
class TableLayout:
    bounds: list[float]
    #: Per column; None where no item row filled it, so nothing is known.
    profiles: list[ColumnProfile | None]
    char_width: float
    #: The lines recognised as item rows, by identity.
    items: list[list[WordBox]] = field(default_factory=list)

    def is_item(self, line: Sequence[WordBox]) -> bool:
        return any(line is each for each in self.items)


def kind_of(cells: Sequence[str], label: str) -> str:
    """The kind most of a column's cells are."""
    if not cells:
        return "code"

    def share(test) -> float:
        return sum(1 for cell in cells if test(cell)) / max(1, len(cells))

    coded = bool(CODE_TITLE.search(label)) and not QUANTITY_TITLE.search(label) and not MONEY_TITLE.search(label)
    if coded:
        def figure(cell: str) -> bool:
            return is_figure(cell) and bool(re.search(r"\d\.\d", cell))
    else:
        figure = is_figure
    if share(figure) >= 0.5:
        return "figure"
    if share(lambda cell: bool(re.search(r"[A-Za-z]{2,}", cell))) >= 0.5:
        return "text"
    return "code"


def buckets_for_line(
    line: Sequence[WordBox],
    columns: Sequence[HeaderColumn],
    bounds: Sequence[float],
    line_height: float,
    titled: bool,
    continuing: TableLayout | None = None,
) -> list[list[WordBox]]:
    """The words of one line, sorted into the columns they are printed in."""
    buckets: list[list[WordBox]] = [[] for _ in columns]
    for fields in fields_on_line(line, line_height):
        anchor = next((w for w in fields if is_inked(w)), fields[0])
        start = column_index(anchor, bounds)
        if continuing is not None:
            profile = continuing.profiles[start] if start < len(continuing.profiles) else None
            if profile is not None and profile.kind == "text":
                if start < len(buckets):
                    buckets[start].extend(fields)
                continue
        hits = (
            [index for index, column in enumerate(columns) if horizontal_overlap(fields, column) > 0]
            if titled
            else []
        )
        # A name that starts under its title stays there, even when the words
        # run into the gap. A phrase that crosses two titles is split per word,
        # and so is one that merely reaches a title it did not start under.
        if len(hits) == 1 and starts_in_column(fields, bounds, hits[0], line_height * 0.5):
            buckets[hits[0]].extend(fields)
            continue
        for word in fields:
            index = column_index(word, bounds)
            if index < len(buckets):
                buckets[index].append(word)
    return buckets


def settle_overflow(buckets: Sequence[list[WordBox]], layout: TableLayout) -> list[list[WordBox]]:
    """Give words that run short of their column back to the words before them."""
    settled = [list(bucket) for bucket in buckets]
    owner = -1
    for index, bucket in enumerate(settled):
        inked = [word for word in bucket if is_inked(word)]
        if not inked:
            continue
        profile = layout.profiles[index] if index < len(layout.profiles) else None
        short = profile is not None and _min(w.x for w in inked) < profile.left - layout.char_width
        if owner >= 0 and short and profile.kind != "figure" and re.search(r"[A-Za-z]", join_words(inked)):
            settled[owner].extend(bucket)
            settled[index] = []
            continue
        owner = index if (profile is None or profile.kind != "figure") else -1
    return settled


def gutter_bounds(
    body: Sequence[Sequence[WordBox]],
    columns: Sequence[HeaderColumn],
    printed: Sequence[float],
    line_height: float,
) -> list[float]:
    """Column edges taken from the body's own ink: the widest clear gutter."""
    inked = union_spans([(w.x, w.right) for line in body for w in line])
    bounds = list(printed)
    for index in range(1, len(columns)):
        frm = columns[index - 1].x if index - 1 < len(columns) else -math.inf
        to = columns[index].right if index < len(columns) else math.inf
        widest: tuple[float, float] | None = None
        for gap in range(1, len(inked)):
            start = max(inked[gap - 1][1], frm)
            end = min(inked[gap][0], to)
            if end <= start:
                continue
            if widest is None or end - start > widest[1] - widest[0]:
                widest = (start, end)
        if widest is not None and widest[1] - widest[0] >= line_height * 0.5:
            bounds[index] = (widest[0] + widest[1]) / 2
    return bounds


def refine_bounds(
    printed: Sequence[float],
    columns: Sequence[HeaderColumn],
    items: Sequence[Sequence[WordBox]],
    char_width: float,
    line_height: float,
) -> list[float]:
    """Move an edge when the item rows show it on the wrong side of what a column owns."""
    owned: list[list[list[WordBox]]] = [[] for _ in columns]
    strays: list[list[WordBox]] = []
    for line in items:
        for fields in fields_on_line(line, line_height):
            hits = [i for i, column in enumerate(columns) if horizontal_overlap(fields, column) > 0]
            # A field that only reaches a title says nothing about where that
            # column's own ink starts, and owning it would hide the gutter.
            if len(hits) == 1:
                if starts_in_column(fields, printed, hits[0], char_width):
                    owned[hits[0]].append(fields)
                else:
                    strays.append(fields)
            elif len(hits) == 0:
                strays.append(fields)
            else:
                for index, part in parts_across_titles(fields, columns):
                    owned[index].append(part)

    def title_before(fields: Sequence[WordBox]) -> int:
        start = _min(w.x for w in fields)
        found = -1
        for at, column in enumerate(columns):
            if column.x <= start:
                found = at
        return found

    def kinds_of() -> list[str | None]:
        out: list[str | None] = []
        for index, fields_list in enumerate(owned):
            if fields_list:
                label = columns[index].label if index < len(columns) else ""
                out.append(kind_of([join_words(f) for f in fields_list], label))
            else:
                out.append(None)
        return out

    kinds = kinds_of()
    # A short figure under a centred or left-set title can clear the title.
    for fields in strays:
        if not is_figure(join_words(fields)):
            continue
        index = title_before(fields)
        if index >= 0 and (kinds[index] or "figure") == "figure":
            owned[index].append(fields)
    kinds = kinds_of()
    # A lettered stray after a column of words is the end of those words.
    next_starts = [_min((w.x for f in fields_list for w in f), math.inf) for fields_list in owned]
    for fields in strays:
        if not re.search(r"[A-Za-z#]", join_words(fields)):
            continue
        index = title_before(fields)
        if index < 0 or kinds[index] != "text":
            continue
        end = _max(w.right for w in fields)
        after = next_starts[index + 1] if index + 1 < len(next_starts) else math.inf
        short = end < after - char_width
        nxt = kinds[index + 1] if index + 1 < len(kinds) else None
        if nxt == "figure" or (nxt is not None and short):
            owned[index].append(fields)

    owned_words = {id(w) for fields_list in owned for f in fields_list for w in f}
    ends = [_max((w.right for f in fields_list for w in f), -math.inf) for fields_list in owned]
    starts = [_min((w.x for f in fields_list for w in f), math.inf) for fields_list in owned]

    # How many item rows have ink over each stretch of x, as a sweep over word
    # edges rather than a counter per pixel.
    edges: list[tuple[float, int]] = []
    for line in items:
        for start, end in union_spans([(w.x, w.right) for w in line]):
            edges.append((start, 1))
            edges.append((end, -1))
    edges.sort(key=lambda pair: (pair[0], pair[1]))
    coverage: list[tuple[float, float, int]] = []
    rows = 0
    for index, (x, step) in enumerate(edges):
        rows += step
        nxt = edges[index + 1] if index + 1 < len(edges) else None
        if nxt is not None and nxt[0] > x:
            coverage.append((x, nxt[0], rows))

    min_gap = max(2.0, char_width * 1.5)

    def gutters(frm: float, to: float, allowed: int, narrowest: float = min_gap):
        """Clear runs inside [frm, to) with ink on both sides, widest first."""
        covered = union_spans(
            [
                (max(start, frm), min(end, to))
                for start, end, count in coverage
                if count > allowed and end > frm and start < to
            ]
        )
        found = [
            (covered[index - 1][1], covered[index][0]) for index in range(1, len(covered))
        ]
        found = [run for run in found if run[1] - run[0] >= narrowest]

        # Widest first; within a pixel, the one nearer the right column's ink.
        # Written as the TypeScript's own comparator rather than as a key,
        # because "within a pixel" is not an ordering a key can express.
        def wider_first(a: tuple[float, float], b: tuple[float, float]) -> float:
            wider = (b[1] - b[0]) - (a[1] - a[0])
            return (b[1] - a[1]) if abs(wider) < 1 else wider

        return sorted(found, key=cmp_to_key(wider_first))

    tolerance = max(math.floor(len(items) * 0.1), 1 if len(items) >= 3 else 0)
    bounds = list(printed)
    for index in range(1, len(bounds)):
        edge = bounds[index]
        # Words are never a figure column's.
        if kinds[index] == "figure":
            limit = printed[index + 1] if index + 1 < len(printed) else math.inf
            intruders = [
                w
                for line in items
                for w in line
                if id(w) not in owned_words
                and re.search(r"[A-Za-z]{2,}", w.text)
                and edge <= w.centre_x < limit
            ]
        else:
            intruders = []
        sorted_sides = (
            not intruders
            and all(w.centre_x < edge for f in owned[index - 1] for w in f)
            and all(w.centre_x >= edge for f in owned[index] for w in f)
        )
        in_ink = any(count > 0 and start < edge < end for start, end, count in coverage)
        nudge = (
            sorted_sides
            and (in_ink or kinds[index - 1] == "text")
            and bool(owned[index - 1])
            and bool(owned[index])
        )
        if sorted_sides and not nudge:
            continue

        frm = max(bounds[index - 1] + 1, columns[index - 1].x if index - 1 < len(columns) else -math.inf)
        reach_right = starts[index] + char_width if math.isfinite(starts[index]) else -math.inf
        to = min(
            printed[index + 1] if index + 1 < len(printed) else math.inf,
            max(columns[index].right if index < len(columns) else math.inf, reach_right),
        )
        if not math.isfinite(frm) or not math.isfinite(to) or not frm < to:
            continue

        after = max(ends[index - 1], _max((w.right for w in intruders), -math.inf)) - 1
        before = starts[index] + 1

        def distance(run: tuple[float, float]) -> float:
            if edge < run[0]:
                return run[0] - edge
            if edge > run[1]:
                return edge - run[1]
            return 0.0

        def place(start: float, end: float) -> None:
            bounds[index] = (
                end - min((end - start) / 2, char_width * 3)
                if kinds[index - 1] == "text"
                else (start + end) / 2
            )

        searches = (
            [(0, char_width), (0, 1.0)]
            if nudge
            else [(0, min_gap), (0, 1.0), (tolerance, min_gap)]
        )
        placed = False
        for allowed, narrowest in searches:
            admissible = [
                run for run in gutters(frm, to, allowed, narrowest)
                if run[0] >= after and run[1] <= before
            ]
            if nudge:
                near = [run for run in admissible if distance(run) <= char_width * 3]
                near.sort(key=distance)
                gutter = near[0] if near else None
            else:
                gutter = admissible[0] if admissible else None
            if gutter is None:
                continue
            place(gutter[0], gutter[1])
            placed = True
            break
        if placed:
            continue

        # Nothing to search for, and nothing that needs searching: the two
        # columns' own ink is already apart, and anything between them parts
        # the page correctly. See the TypeScript for the invoice behind this.
        last, nxt = ends[index - 1], starts[index]
        if not math.isfinite(last) or not math.isfinite(nxt) or last >= nxt:
            continue
        if nxt <= bounds[index - 1] or last >= (printed[index + 1] if index + 1 < len(printed) else math.inf):
            continue
        place(last, nxt)
    return bounds


def learn_layout(
    body: Sequence[Sequence[WordBox]],
    columns: Sequence[HeaderColumn],
    printed: Sequence[float],
    line_height: float,
    titled: bool,
) -> TableLayout:
    """Settle the column edges against the rows, and learn what each column holds."""

    def items_under(edges: Sequence[float]) -> list[Sequence[WordBox]]:
        found = []
        for line in body:
            cells = [join_words(b) for b in buckets_for_line(line, columns, edges, line_height, titled)]
            if is_line_item(cells) and not is_summary(cells, True):
                found.append(line)
        return found

    anchors = list(printed)
    items = items_under(anchors)
    # A table that sets its values right of their titles puts two columns in
    # one cell, and then no row reads as a row.
    if not items and titled:
        guessed = gutter_bounds(body, columns, printed, line_height)
        retry = items_under(guessed)
        if retry:
            anchors = guessed
            items = retry

    char_width = character_width_of([w for line in items for w in line]) or line_height * 0.5
    if not items:
        return TableLayout(bounds=list(anchors), profiles=[], char_width=char_width, items=[])

    bounds = (
        refine_bounds(anchors, columns, items, char_width, line_height) if titled else list(anchors)
    )
    filled: list[list[list[WordBox]]] = [[] for _ in columns]
    for line in items:
        for index, bucket in enumerate(buckets_for_line(line, columns, bounds, line_height, titled)):
            if bucket:
                filled[index].append(bucket)

    profiles: list[ColumnProfile | None] = []
    for index, cells in enumerate(filled):
        if not cells:
            profiles.append(None)
            continue
        lefts = [_min(w.x for w in cell) for cell in cells]
        left = _min(lefts)
        label = columns[index].label if index < len(columns) else ""
        profiles.append(
            ColumnProfile(
                left=left,
                right=_max(w.right for cell in cells for w in cell),
                # Most rows, not all; nor does a flag in the first position.
                aligned=sum(1 for x in lefts if x - left <= char_width * 1.5) >= len(lefts) * 0.75,
                kind=kind_of([join_words(cell) for cell in cells], label),
                money=sum(1 for cell in cells if re.search(r"\d\.\d{2}", join_words(cell)))
                >= len(cells) * 0.5,
            )
        )
    return TableLayout(bounds=bounds, profiles=profiles, char_width=char_width, items=list(items))


def typical_gap(
    lines: Sequence[Sequence[WordBox]],
    layout: TableLayout,
    line_height: float,
) -> float:
    """The usual space below an item row, from the page itself."""
    ordered = sorted(lines, key=lambda line: line_band(line).top)
    gaps: list[float] = []
    for index in range(1, len(ordered)):
        if not layout.is_item(ordered[index - 1]):
            continue
        gap = line_band(ordered[index]).top - line_band(ordered[index - 1]).bottom
        # Lines that overlap are one printed line set on two baselines.
        if gap > -line_height * 0.5:
            gaps.append(max(0.0, gap))
    if not gaps:
        return line_height
    # The tighter gaps, not the middle one.
    gaps.sort()
    return gaps[math.floor(len(gaps) * 0.25)]


def place_line(buckets: Sequence[Sequence[WordBox]], layout: TableLayout) -> str | None:
    """Where a line that is not an item sits among the columns."""
    slack = layout.char_width
    worded = False
    figures = False
    filled = 0
    for index, bucket in enumerate(buckets):
        inked = [word for word in bucket if is_inked(word)]
        if not inked:
            continue
        filled += 1
        profile = layout.profiles[index] if index < len(layout.profiles) else None
        text = join_words(inked)
        if profile is not None and profile.kind == "figure" and not profile.money and is_figure(text):
            continue
        if (profile is not None and profile.kind == "figure") or (profile is None and is_figure(text)):
            if not worded or not is_figure(text):
                return None
            figures = True
            continue
        if figures:
            return None
        # A column of codes carries codes, and a second line of one is a code
        # too; `P.O.:` is a field label, and a label has no number in it.
        if profile is not None and profile.kind == "code" and not re.search(r"\d", text):
            return None
        if profile is not None:
            start = _min(w.x for w in inked)
            end = _max(w.right for w in inked)
            # How far into a column a line may start and still be the rest of
            # the line above it; see the TypeScript for the whole argument.
            if profile.aligned:
                fits = (
                    abs(start - profile.left) <= slack
                    if profile.kind == "code"
                    else profile.left - slack <= start <= profile.left + slack * 4
                )
            else:
                fits = (
                    profile.left - slack <= start <= profile.right + slack
                    if profile.kind == "code"
                    else end >= profile.left - slack and start <= profile.right + slack
                )
            if not fits:
                return None
        worded = True
    # A continuation is a line or two of a name with its sizes, not a row of
    # its own: past three filled columns it is something else.
    if not worded or filled > 3:
        return None
    return "figures" if figures else "text"


# --------------------------------------------------------------------------- #
# What a line is                                                               #
# --------------------------------------------------------------------------- #


def combine_cells(above: Sequence[str], below: Sequence[str]) -> list[str]:
    out = []
    for index, cell in enumerate(below):
        lead = above[index].strip() if index < len(above) else ""
        base = cell.strip()
        if not lead:
            out.append(cell)
        elif not base:
            out.append(lead)
        else:
            out.append(f"{lead} {base}")
    return out


def is_lead_in(cells: Sequence[str]) -> bool:
    """An item name printed on its own line, above or below the quantities."""
    filled = [(cell.strip(), index) for index, cell in enumerate(cells) if cell.strip()]
    if not filled or len(filled) > 2:
        return False
    if any(re.fullmatch(r"\d{1,5}", text) for text, _ in filled):
        return False
    if any(re.match(r"^\$?[\d,]+\.\d{2}\b", text) for text, _ in filled):
        return False
    return all(index <= 1 for _, index in filled)


def is_line_item(cells: Sequence[str]) -> bool:
    # Stars flag an item (`*10234` backordered); they do not make it another thing.
    filled = [
        re.sub(r"^\*+|\*+$", "", cell.strip()).strip()
        for cell in cells
    ]
    filled = [cell for cell in filled if cell]
    if len(filled) < 2:
        return False
    has_qty = any(is_quantity(cell) for cell in filled)
    has_money = any(
        not re.search(r"[A-Za-z]{2,}", cell) and re.search(r"\d\.\d{2}", cell) for cell in filled
    )
    has_code = any(
        re.fullmatch(r"[A-Za-z0-9-]{4,24}", cell) and re.search(r"\d", cell) for cell in filled
    )
    return (has_qty and (has_money or has_code)) or (has_money and has_code)


def is_repeated_header(cells: Sequence[str], columns: Sequence[HeaderColumn]) -> bool:
    got = [c for c in (normalize(cell) for cell in cells) if c]
    want = [c for c in (normalize(column.label) for column in columns) if c]
    if len(got) < 3 or len(want) < 3:
        return False
    hits = sum(1 for cell in got if cell in want)
    return hits >= 3 and hits >= min(len(got), len(want)) * 0.6


def is_starred(cells: Sequence[str]) -> bool:
    """A line set off with stars: `***SHORT PRODUCT***`, `* PRICE CHANGE`."""
    text = " ".join(cell.strip() for cell in cells if cell.strip())
    return bool(re.fullmatch(r"\*+[^*]+\*+", text)) or bool(re.match(r"^\*+\s", text))


SUMMARY_WORD = re.compile(
    r"^(?:sub|sub-?totals?|totals?|tax(?:es|able)?|sales|shipping|ship|freight|handling"
    r"|discounts?|disc|balance|due|amount|amt|grand|net|payments?|paid|credits?|deposits?"
    r"|pieces|pcs|cases|items|qty|quantity|units|merchandise|invoice|order|of|and|the)$",
    re.I,
)
SUMMARY_KEY = re.compile(
    r"^(?:sub-?totals?|totals?|tax(?:es)?|balance|freight|shipping|handling|payments?|paid"
    r"|grand|due)$",
    re.I,
)
SUMMARY_TOTAL = re.compile(r"^(?:sub-?totals?|totals?|grand|balance|due)$", re.I)


def is_summary(cells: Sequence[str], item: bool) -> bool:
    """A line of the totals block, or a category's subtotal within the table."""
    words = [
        stripped
        for stripped in (
            re.sub(r"^-+|-+$", "", part) for part in re.split(r"[^A-Za-z-]+", " ".join(cells))
        )
        if re.search(r"[A-Za-z]", stripped)
    ]
    if not words:
        return False
    figured = any(any(is_figure(token) for token in cell.split()) for cell in cells)
    if not item:
        return figured and any(SUMMARY_KEY.match(word) for word in words)
    if not any(SUMMARY_TOTAL.match(word) for word in words):
        return False
    if all(SUMMARY_WORD.match(word) for word in words):
        return True
    amounts = sum(
        1 for cell in cells if re.search(r"\d\.\d{2}", cell) and not re.search(r"[A-Za-z]{2,}", cell)
    )
    coded = any(
        re.fullmatch(r"[A-Za-z0-9-]{4,24}", cell.strip()) and re.search(r"\d", cell) for cell in cells
    )
    return len(words) <= 3 and amounts == 1 and not coded


STOCK_NOTE = re.compile(r"\bout\s*of\s*stock\b|\bno\s*stock\b", re.I)


def without_stock_note(cells: Sequence[str]) -> tuple[list[str], list[str]]:
    """`cells` without any stock note, beside the notes that were cut out."""
    if not any(STOCK_NOTE.search(cell) for cell in cells):
        return list(cells), []
    notes: list[str] = []
    kept: list[str] = []
    for cell in cells:
        if not STOCK_NOTE.search(cell):
            kept.append(cell)
            continue
        notes.extend(match.group(0) for match in STOCK_NOTE.finditer(cell))
        cut = re.sub(r"\s+", " ", STOCK_NOTE.sub(" ", cell)).strip()
        kept.append(cut if re.search(r"[A-Za-z0-9]", cut) else "")
    return kept, notes


def is_rule(cells: Sequence[str]) -> bool:
    text = re.sub(r"\s", "", "".join(cells))
    return len(text) >= 4 and bool(re.fullmatch(r"[-_=.*]+", text))


PAGE_REFERENCE = re.compile(
    r"(?:continu(?:e|es|ed|ing)|contd|cont)(?:on|to|from)?(?:the)?"
    r"(?:next|following|previous|prior|last)?page"
    r"|(?:on|to|from)(?:the)?(?:next|following|previous|prior)page"
)


def is_page_continuation(text: str) -> bool:
    """`Continued on next page` and its kin, however it is set."""
    letters = ""
    starts_word: list[bool] = []
    for index, char in enumerate(text):
        if not char.isalpha() or not char.isascii():
            continue
        starts_word.append(index == 0 or not (text[index - 1].isalpha() and text[index - 1].isascii()))
        letters += char.lower()
    for match in PAGE_REFERENCE.finditer(letters):
        if match.start() < len(starts_word) and starts_word[match.start()]:
            return True
    return False


def is_furniture(cells: Sequence[str]) -> bool:
    text = re.sub(r"\s+", " ", " ".join(cells)).strip()
    if not text:
        return True
    bare = re.sub(r"\s+", " ", re.sub(r"[*=_~]+", " ", text)).strip()
    if re.fullmatch(r"page\s*:?\s*\d+(?:\s*(?:of|/)\s*\d+)?", bare, re.I):
        return True
    if re.fullmatch(r"pg\.?\s*:?\s*\d+\s*(?:of|/)\s*\d+|pg\.\s*\d+", bare, re.I):
        return True
    letters = re.sub(r"[^A-Za-z]", "", text).lower()
    if re.fullmatch(r"continued|continues|contd", letters) and re.search(r"[*=-]", text):
        return True
    return is_page_continuation(text)


def append_wrap(row: TableRow, cells: Sequence[str]) -> TableRow:
    joined = []
    for index, cell in enumerate(row.cells):
        extra = cells[index].strip() if index < len(cells) else ""
        if not extra:
            joined.append(cell)
        else:
            joined.append(f"{cell} {extra}" if cell.strip() else extra)
    return TableRow(cells=joined, confidence=row.confidence, label=row.label)


# --------------------------------------------------------------------------- #
# The tables on a page                                                         #
# --------------------------------------------------------------------------- #


def read_column_tables(
    words: Sequence[WordBox],
    overlap_ratio: float = 0.5,
    guide: ColumnGuide | None = None,
) -> list[ColumnTable]:
    """Every column table printed on the page, in printed order."""
    usable = [
        word
        for word in words
        if word.text.strip()
        and word.width > 0
        and word.height > 0
        and math.isfinite(word.x + word.y + word.width + word.height)
    ]
    if len(usable) < 4:
        return []

    lines = group_into_lines(usable, overlap_ratio)
    header = find_header(usable)
    guided = None if header is not None else usable_guide(guide)
    if header is None and guided is None:
        return []

    line_height = median([word.height for word in usable]) or 12

    def read_under(
        columns: Sequence[HeaderColumn],
        title_words: Sequence[WordBox],
        below: float,
        titled: bool,
        until: float = math.inf,
    ) -> ColumnTable:
        header_ids = {id(word) for word in title_words}
        body = [
            line
            for line in lines
            if not any(id(word) in header_ids for word in line)
            and line_band(line).top >= below - 2
            and line_band(line).top < until
        ]
        printed = column_bounds(columns) if titled else (list(guided[1]) if guided else [])
        layout = learn_layout(body, columns, printed, line_height, titled)
        bounds = layout.bounds
        # One printed line below the last, and no further.
        reach = min(line_height * 1.5, typical_gap(body, layout, line_height) + line_height * 0.75)

        rows: list[TableRow] = []
        skipped: list[SkippedLine] = []
        row_lefts: list[float] = []

        def log(
            reason: str, cells: Sequence[str], confidence: float, y: float, x: float = 0.0
        ) -> None:
            text = "  ".join(cell.strip() for cell in cells if cell.strip())
            if not text:
                return
            skipped.append(
                SkippedLine(reason=reason, text=text, confidence=confidence, y=y, x=x)
            )

        previous_band = None
        lead_in: dict | None = None

        def drop_lead_in() -> None:
            nonlocal lead_in
            if lead_in is not None:
                log(
                    "unplaced",
                    lead_in["cells"],
                    lead_in["confidence"],
                    lead_in["band"].top,
                    lead_in["x"],
                )
            lead_in = None

        for line in body:
            read_cells, notes = without_stock_note(
                [join_words(bucket) for bucket in buckets_for_line(line, columns, bounds, line_height, titled)]
            )
            cells = read_cells
            confidence = mean_confidence(line)
            top = line_band(line).top
            left = min((word.x for word in line), default=0.0)
            for note in notes:
                log("note", [note], confidence, top, left)
            item = is_line_item(cells)
            if not item and is_furniture(cells):
                log("furniture", cells, confidence, top, left)
                continue
            if is_rule(cells):
                continue
            if is_repeated_header(cells, columns):
                log("repeated-header", cells, confidence, top, left)
                continue
            if not any(cell.strip() for cell in cells):
                continue
            if is_summary(cells, item):
                log("summary", cells, confidence, top, left)
                previous_band = None
                drop_lead_in()
                continue

            band = line_band(line)
            if not item:
                loose = settle_overflow(
                    buckets_for_line(line, columns, bounds, line_height, titled, layout), layout
                )
                text_cells = [
                    join_words(bucket) if any(is_inked(w) for w in bucket) else "" for bucket in loose
                ]
                placed = place_line(loose, layout)
                previous = rows[-1] if rows else None
                follows = (
                    previous is not None
                    and previous_band is not None
                    and band.top - previous_band.bottom <= reach
                )
                # A starred line is never the rest of an item.
                if is_starred(text_cells):
                    if placed == "text" and any(re.search(r"[A-Za-z]", c) for c in text_cells):
                        rows.append(TableRow(cells=text_cells, confidence=confidence, label=True))
                    else:
                        log("unplaced", text_cells, confidence, top, left)
                    drop_lead_in()
                    previous_band = None
                    continue
                if follows and previous is not None and previous_band is not None and placed == "text":
                    rows[-1] = append_wrap(previous, text_cells)
                    previous_band = type(band)(previous_band.top, max(previous_band.bottom, band.bottom))
                    continue
                # A coupon or a deposit printed under an item carries its own amount.
                if follows and placed == "figures":
                    rows.append(TableRow(cells=text_cells, confidence=confidence))
                    previous_band = band
                    continue
                if placed == "text" and is_lead_in(text_cells):
                    close = lead_in is not None and band.top - lead_in["band"].bottom <= reach
                    if close and lead_in is not None:
                        lead_in = {
                            "cells": combine_cells(lead_in["cells"], text_cells),
                            "band": type(band)(lead_in["band"].top, band.bottom),
                            "confidence": min(lead_in["confidence"], confidence),
                            "x": min(lead_in["x"], left),
                        }
                    else:
                        drop_lead_in()
                        lead_in = {
                            "cells": text_cells,
                            "band": band,
                            "confidence": confidence,
                            "x": left,
                        }
                    continue
                # The legal footer, a notes block, a banner.
                log("unplaced", text_cells, confidence, top, left)
                drop_lead_in()
                continue

            # A heading one blank line above the item is not its name.
            if lead_in is not None and band.top - lead_in["band"].bottom <= reach:
                cells = combine_cells(lead_in["cells"], cells)
                lead_in = None
            drop_lead_in()
            rows.append(TableRow(cells=cells, confidence=confidence))
            row_lefts.append(left)
            previous_band = band

        drop_lead_in()
        skipped.sort(key=lambda entry: entry.y)
        return ColumnTable(
            headers=[column.label for column in columns],
            rows=rows,
            bounds=list(bounds),
            skipped=skipped,
            # The median, not the smallest: one row whose first column was
            # misread to the left would otherwise move the whole edge.
            body_left=median(row_lefts) if row_lefts else 0.0,
        )

    def priced(table: ColumnTable) -> bool:
        # One item is enough when the columns are known. Labels do not count.
        return any(not row.label for row in table.rows)

    if header is None:
        columns = guided[0] if guided else []
        if len(columns) < 3:
            return []
        table = read_under(columns, [], -math.inf, False)
        return [table] if priced(table) else []

    if len(header.columns) < 3:
        return []

    headers = [header]
    found = header
    while len(headers) < 8:
        rest = [word for word in usable if word.y > found.bottom + line_height * 0.5]
        nxt = find_header(rest, True)
        if nxt is None or len(nxt.columns) < 3 or nxt.top <= found.top:
            break
        headers.append(nxt)
        found = nxt

    tables: list[ColumnTable] = []
    for index, printed_header in enumerate(headers):
        until = headers[index + 1].top if index + 1 < len(headers) else math.inf
        table = read_under(printed_header.columns, printed_header.words, printed_header.bottom, True, until)
        if index > 0:
            table.title = title_above(printed_header.top, lines, line_height)
        tables.append(table)

    # Titles with nothing priced under them are not a table of their own.
    kept: list[ColumnTable] = []
    orphaned: list[SkippedLine] = []
    for index, table in enumerate(tables):
        if index == 0 or priced(table):
            kept.append(table)
            continue
        printed_header = headers[index]
        orphaned.append(
            SkippedLine(
                reason="unplaced",
                text="  ".join(column.label for column in printed_header.columns),
                confidence=mean_confidence(printed_header.words),
                y=printed_header.top,
            )
        )
        for row in table.rows:
            orphaned.append(
                SkippedLine(
                    reason="unplaced",
                    text="  ".join(cell for cell in row.cells if cell.strip()),
                    confidence=row.confidence,
                    y=printed_header.top,
                )
            )
        orphaned.extend(table.skipped)

    if not kept:
        return []
    if orphaned:
        kept[0].skipped = sorted(kept[0].skipped + orphaned, key=lambda entry: entry.y)
    return kept
