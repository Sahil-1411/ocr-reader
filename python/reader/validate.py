"""
Check a reading against the receipt's own arithmetic.

Why these checks exist at all: what matters for a
financial document is not a headline accuracy number but whether the reading
can say *which* rows it got wrong, and these receipts restate their own
contents — a totals row, a footer count, a section subtotal repeated in the
header — so a misread digit contradicts something else on the same page.

Nothing here corrects a value that was read. The one exception is a count that
was not read at all, which the TOTALS row can determine exactly.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from typing import Sequence

from .rows import InventoryRow, InvoiceField, SettlementRow


@dataclass(slots=True)
class ValidationIssue:
    code: str
    message: str
    rows: list[int]


def cents(text: str) -> int | None:
    """Money as an integer number of cents, or None when the text is not an amount."""
    token = re.sub(r"[$,\s]", "", text.strip())
    credit = bool(re.search(r"[cC]$", token))
    body = token[:-1] if credit else token
    if not re.fullmatch(r"\d+(?:\.\d{1,2})?", body):
        return None
    value = math.floor(float(body) * 100 + 0.5)
    if not math.isfinite(value):
        return None
    return -value if credit else value


def money(value: int) -> str:
    sign = "-" if value < 0 else ""
    magnitude = abs(value)
    return f"{sign}{magnitude // 100}.{magnitude % 100:02d}"


def count(text: str) -> int | None:
    """A count column, or None when the reader mangled it past use."""
    token = text.strip()
    if not re.fullmatch(r"\d{1,3}", token):
        return None
    return int(token)


COLUMNS = ("int", "rec", "act", "set")


def is_totals_row(row: InventoryRow) -> bool:
    return bool(re.fullmatch(r"totals", row.name.strip(), re.I))


def _column(row: InventoryRow, column: str) -> str:
    return getattr(row, column)


def validate_inventory(rows: Sequence[InventoryRow]) -> list[ValidationIssue]:
    """Inventory: the TOTALS row restates each column's sum."""
    totals = next((index for index, row in enumerate(rows) if is_totals_row(row)), -1)
    if totals == -1:
        return []
    totals_row = rows[totals]

    issues: list[ValidationIssue] = []
    for column in COLUMNS:
        stated = count(_column(totals_row, column))
        if stated is None:
            continue
        total = 0
        unreadable: list[int] = []
        for index, row in enumerate(rows):
            if index == totals:
                continue
            value = count(_column(row, column))
            if value is None:
                unreadable.append(index)
            else:
                total += value
        if total == stated:
            continue
        blame = (
            f" {len(unreadable)} row{'' if len(unreadable) == 1 else 's'} had no readable"
            f" {column} count."
            if unreadable
            else ""
        )
        issues.append(
            ValidationIssue(
                code="inventory-totals",
                message=(
                    f"The {column} column adds up to {total}, but the TOTALS row says"
                    f" {stated}.{blame}"
                ),
                rows=unreadable if unreadable else [totals],
            )
        )
    return issues


def solve_inventory_counts(
    rows: Sequence[InventoryRow],
) -> tuple[list[InventoryRow], list[ValidationIssue]]:
    """Fill counts the reader could not produce, where the TOTALS row allows it."""
    out = [replace(row) for row in rows]
    issues: list[ValidationIssue] = []
    totals = next((index for index, row in enumerate(out) if is_totals_row(row)), -1)
    totals_row = out[totals] if totals != -1 else None

    def label(row: InventoryRow) -> str:
        return f"game {row.game}" if row.game else (row.name or "a row")

    if totals_row is not None:
        for column in COLUMNS:
            stated = count(_column(totals_row, column))
            if stated is None:
                continue
            total = 0
            unknown: list[int] = []
            for index, row in enumerate(out):
                if index == totals:
                    continue
                value = count(_column(row, column))
                if value is None:
                    unknown.append(index)
                else:
                    total += value
            target = out[unknown[0]] if len(unknown) == 1 else None
            solved = stated - total
            if target is None or solved < 0 or solved > 999:
                continue
            read = _column(target, column)
            setattr(target, column, str(solved).rjust(3, "0"))
            issues.append(
                ValidationIssue(
                    code="inventory-solved",
                    message=(
                        f"The {column} count for {label(target)} was "
                        + (f'read as "{read}"' if read else "not read")
                        + f"; it is {_column(target, column)} from the TOTALS row."
                    ),
                    rows=[unknown[0]],
                )
            )

    unread = [
        (index, row)
        for index, row in enumerate(out)
        if any(count(_column(row, column)) is None for column in COLUMNS)
    ]
    if unread:
        issues.append(
            ValidationIssue(
                code="inventory-unread",
                message=(
                    "Counts could not be read for "
                    + ", ".join(label(row) for _, row in unread)
                    + ". Check these against the ticket before using the report."
                ),
                rows=[index for index, _ in unread],
            )
        )
    return out, issues


def validate_settlements(
    rows: Sequence[SettlementRow],
    stated_total: int | None,
) -> list[ValidationIssue]:
    """Settlements: the footer states how many packs were settled."""
    issues: list[ValidationIssue] = []
    if stated_total is not None and len(rows) != stated_total:
        missing = stated_total - len(rows)
        tail = (
            f" — {missing} row{' is' if missing == 1 else 's are'} missing" if missing > 0 else ""
        )
        issues.append(
            ValidationIssue(
                code="settlements-count",
                message=(
                    f"The receipt settles {stated_total} packs but {len(rows)} rows were read{tail}."
                ),
                rows=[],
            )
        )

    unread = [
        (index, row)
        for index, row in enumerate(rows)
        if not row.game_pack or not row.name or not row.date_settled
    ]
    if unread:
        labels = [row.game_pack or row.name or f"row {index + 1}" for index, row in unread]
        issues.append(
            ValidationIssue(
                code="settlements-unread",
                message=(
                    f"Part of {', '.join(labels)} could not be read. "
                    "Check these against the ticket before using the report."
                ),
                rows=[index for index, _ in unread],
            )
        )
    return issues


def _key(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


def find_field(fields: Sequence[InvoiceField], label: str) -> tuple[int, InvoiceField] | None:
    """Find a field by label, ignoring case, spacing and the reader's punctuation."""
    want = _key(label)
    for index, field in enumerate(fields):
        if _key(field.label) == want:
            return index, field
    return None


HEADER_PARTS = (
    "FWD BALANCE",
    "ON-LINE NET DUE",
    "INSTANT NET DUE",
    "NON-GAME ADJUSTMENTS",
    "SYSTEM FEE",
    "OTHER RETAILER INCENTIVES",
)


def validate_invoice(fields: Sequence[InvoiceField]) -> list[ValidationIssue]:
    """Invoice: the header block totals itself, and each section restates its figure."""
    issues: list[ValidationIssue] = []

    total = find_field(fields, "TOTAL DUE BY WED")
    if total is not None:
        found = [hit for hit in (find_field(fields, label) for label in HEADER_PARTS) if hit]
        stated = cents(total[1].value)
        addends = [cents(field.value) for _, field in found]
        # Only meaningful with the whole block read.
        if stated is not None and len(found) == len(HEADER_PARTS) and all(v is not None for v in addends):
            total_sum = sum(value or 0 for value in addends)
            if total_sum != stated:
                issues.append(
                    ValidationIssue(
                        code="invoice-total",
                        message=(
                            f"The header lines add up to {money(total_sum)}, but TOTAL DUE BY WED"
                            f" says {money(stated)}."
                        ),
                        rows=[index for index, _ in found] + [total[0]],
                    )
                )

    for header, footer in (
        ("ON-LINE NET DUE", "On-line Net Due"),
        ("INSTANT NET DUE", "Instant Net Due"),
    ):
        want = _key(header)
        keys = [_key(field.label) for field in fields]
        first = keys.index(want) if want in keys else -1
        last = len(keys) - 1 - keys[::-1].index(want) if want in keys else -1
        if first == -1 or last == -1 or first == last:
            continue
        top = cents(fields[first].value)
        bottom = cents(fields[last].value)
        if top is None or bottom is None or top == bottom:
            continue
        issues.append(
            ValidationIssue(
                code="invoice-section-total",
                message=(
                    f"{header} is {money(top)} at the top of the page but {footer} is"
                    f" {money(bottom)} at the foot of its section."
                ),
                rows=[first, last],
            )
        )
    return issues
