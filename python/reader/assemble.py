"""
Pair words into the receipt reading: which kind of page this is, its rows, its
headers and its checks.

A port of `frontend/src/ocr/receipt/assemble.ts`. No image work lives here, so
the same builders serve the text layer and the recogniser.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from .boxes import WordBox, group_into_lines
from .columns import ColumnGuide, ColumnTable, is_lottery_header, read_column_tables
from .rows import (
    INVENTORY_HEADERS,
    InventoryRow,
    InvoiceField,
    SettlementRow,
    choose_receipt_kind,
    find_inventory_header,
    inventory_rows_from_words,
    invoice_rows_from_words,
    settlement_rows_from_words,
)
from .validate import (
    ValidationIssue,
    solve_inventory_counts,
    validate_inventory,
    validate_invoice,
    validate_settlements,
)

#: The settlements table's printed header.
SETTLEMENT_HEADERS = ["Game-Pack", "Name", "Date Settled"]
#: The invoice prints no column header; these name its two sides.
INVOICE_HEADERS = ["label", "value"]


@dataclass(slots=True)
class OcrResult:
    kind: str
    title: str | None
    headers: list[str]
    rows: list[InventoryRow]
    settlements: list[SettlementRow]
    fields: list[InvoiceField]
    table_rows: list[Any]
    tables: list[dict]
    column_bounds: list[float] | None
    validation: list[ValidationIssue]
    skipped: list[Any]
    warnings: list[str] = field(default_factory=list)
    word_count: int = 0


def clean_title(raw: str) -> str:
    text = re.sub(r"WEEKLYINVOICE", "WEEKLY INVOICE", raw, count=1, flags=re.I)
    text = re.sub(r"PACKSETTLEMENTS?", "PACK SETTLEMENTS", text, count=1, flags=re.I)
    text = re.sub(r"INVENTORYSUMMARY", "INVENTORY SUMMARY", text, count=1, flags=re.I)
    text = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def invoice_heading(text: str) -> str | None:
    """A street address or a date range on the same line as the title is not the title."""
    if re.search(r"\bweekly\s+invoice\b", text, re.I):
        heading = "WEEKLY INVOICE"
        if len(text) > len(heading) + 4:
            return heading
    match = re.search(r"\binvoice\s*#?\s*:?\s*(\d{4,})", text, re.I)
    if not match:
        return None
    heading = f"Invoice # {match.group(1)}"
    if len(text) <= len(heading) + 4:
        return None
    return heading


KIND_KEYWORDS = {
    "settlements": re.compile(r"\bsettlements?\b", re.I),
    "inventory": re.compile(r"\binventory\b", re.I),
    "invoice": re.compile(r"\binvoice\b", re.I),
    "table": re.compile(r"\b(?:invoice|statement|bill|order)\b", re.I),
}

SECONDARY_KEYWORDS = re.compile(
    r"\b(?:pack\s+settlements?|weekly\s+pack|instant\s+inventory|inventory\s+summary"
    r"|weekly\s+invoice|settlement\s+report)\b",
    re.I,
)


def extract_receipt_title(words: Sequence[WordBox], kind: str) -> str | None:
    """Printed header/title text taken straight from the page's words."""
    if not words:
        return None
    lines = group_into_lines(words)
    scored: list[tuple[str, float]] = []

    for line in lines[:16]:
        raw_text = " ".join(word.text for word in line).strip()
        text = clean_title(raw_text)
        if not text or len(text) < 3:
            continue
        if re.match(r"^https?://|www\.|\\.com\b", text, re.I):
            continue
        if re.match(r"^retailer\b|^store\b|^terminal\b", text, re.I):
            continue
        if re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}", text):
            continue
        if re.match(r"^(?:game|name|int|rec|act|set|game-pack|date settled)", text, re.I):
            continue

        score = 0.0
        if KIND_KEYWORDS[kind].search(text):
            score += 50
        if SECONDARY_KEYWORDS.search(text):
            score += 40
        average_height = sum(word.height for word in line) / len(line)
        score += min(30.0, average_height)
        if text == text.upper() and re.search(r"[A-Z]", text):
            score += 15
        if re.search(r"scholarship|lottery", text, re.I) and not KIND_KEYWORDS[kind].search(text):
            score -= 20
        if score > 30:
            scored.append((text, score))

    if not scored:
        return None
    # Highest score first, keeping the printed order among equals as the
    # TypeScript's stable sort does.
    scored.sort(key=lambda pair: -pair[1])
    best = scored[0][0]
    return invoice_heading(best) or best


def stated_pack_total(words: Sequence[WordBox]) -> int | None:
    """The pack count the settlements receipt prints below its table."""
    ordered = sorted(words, key=lambda w: (w.y, w.x))
    text = " ".join(word.text for word in ordered)
    match = re.search(r"packs?\s*total\s*settled\s*:?\s*(\d{1,4})", text, re.I)
    if not match:
        return None
    return int(match.group(1))


WEEKLY_INVOICE_MARKS = [
    "fwdbalance",
    "onlinenetdue",
    "instantnetdue",
    "totalduebywed",
    "systemfee",
    "nongameadjustments",
]


def _flat(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


def looks_like_weekly_invoice(fields: Sequence[InvoiceField]) -> bool:
    labels = [_flat(f.label) for f in fields]
    return sum(1 for mark in WEEKLY_INVOICE_MARKS if any(mark in label for label in labels)) >= 2


def page_looks_like_weekly_invoice(words: Sequence[WordBox]) -> bool:
    """The same check on the raw words, for a photo whose amounts did not pair."""
    ordered = sorted(words, key=lambda w: (w.y, w.x))
    flat = "".join(_flat(word.text) for word in ordered)
    return sum(1 for mark in WEEKLY_INVOICE_MARKS if mark in flat) >= 2


# --------------------------------------------------------------------------- #
# Headers for a page whose own were not read                                   #
# --------------------------------------------------------------------------- #


def extract_label_tokens(line: Sequence[WordBox]) -> list[str]:
    """Collapse closely-spaced words of a header line into multi-word labels."""
    if not line:
        return []
    filtered = [word for word in sorted(line, key=lambda w: w.x) if word.text.strip()]
    if not filtered:
        return []
    gaps = [
        max(0.0, filtered[index].x - filtered[index - 1].right) for index in range(1, len(filtered))
    ]
    if not gaps:
        return [" ".join(word.text.strip() for word in filtered)]

    average_height = sum(word.height for word in filtered) / len(filtered)
    sorted_gaps = sorted(gaps)
    median_gap = sorted_gaps[len(sorted_gaps) // 2]
    threshold = max(median_gap * 1.8, average_height * 0.4)

    labels: list[str] = []
    current = filtered[0].text.strip()
    for index, gap in enumerate(gaps):
        nxt = filtered[index + 1].text.strip()
        if gap >= threshold:
            labels.append(current)
            current = nxt
        else:
            sep = "" if nxt.startswith("-") or current.endswith("-") else " "
            current = current + sep + nxt
    labels.append(current)
    return labels


def repeated_left_edges(lines: Sequence[Sequence[WordBox]]) -> list[float]:
    """Left edges that show up on at least half of the rows under the header."""
    usable = [line for line in lines if any(word.text.strip() for word in line)][:8]
    if len(usable) < 2:
        return []
    edges: list[float] = []
    height_sum = 0.0
    height_count = 0
    for line in usable:
        for word in line:
            if not word.text.strip():
                continue
            edges.append(word.x)
            height_sum += word.height
            height_count += 1
    if not edges:
        return []
    height = height_sum / height_count if height_count else 12
    tolerance = max(10.0, height * 0.8)
    edges.sort()
    clusters: list[list[float]] = []  # [sum, count]
    for x in edges:
        if clusters and x - clusters[-1][0] / clusters[-1][1] <= tolerance:
            clusters[-1][0] += x
            clusters[-1][1] += 1
            continue
        clusters.append([x, 1])
    minimum = max(2, math.ceil(len(usable) * 0.5))
    return [total / count for total, count in clusters if count >= minimum]


def column_start_index(x: float, starts: Sequence[float], slack: float) -> int:
    best = 0
    for index, start in enumerate(starts):
        if start <= x + slack:
            best = index
    return best


def join_header_words(words: Sequence[WordBox]) -> str:
    current = ""
    for word in words:
        nxt = word.text.strip()
        if not nxt:
            continue
        if not current:
            current = nxt
            continue
        sep = "" if nxt.startswith("-") or current.endswith("-") else " "
        current = f"{current}{sep}{nxt}"
    return current


def split_header_labels(
    line: Sequence[WordBox],
    following: Sequence[Sequence[WordBox]],
) -> list[str]:
    """Column titles from one header line, grouped on the edges the rows repeat."""
    starts = repeated_left_edges(following)
    filtered = sorted((word for word in line if word.text.strip()), key=lambda w: w.x)
    if not filtered:
        return []
    if len(starts) < 2:
        return extract_label_tokens(line)

    height = sum(word.height for word in filtered) / len(filtered) or 12
    slack = height * 0.5
    groups: list[list[WordBox]] = []
    for word in filtered:
        index = column_start_index(word.x, starts, slack)
        if groups and column_start_index(groups[-1][0].x, starts, slack) == index:
            groups[-1].append(word)
            continue
        groups.append([word])
    return [join_header_words(group) for group in groups]


def default_headers(kind: str) -> list[str]:
    if kind == "inventory":
        return list(INVENTORY_HEADERS)
    if kind == "settlements":
        return list(SETTLEMENT_HEADERS)
    if kind == "invoice":
        return list(INVOICE_HEADERS)
    return ["Column"]


HEADER_KEYWORDS = re.compile(
    r"\b(qty|quantity|description|name|unit|price|amount|total|date|item|code|no\.?|number"
    r"|size|pack|disc|cost|order|list|settled|game|credit|debit|balance|status|type|ref|id"
    r"|sku|upc)\b",
    re.I,
)


def extract_table_headers(words: Sequence[WordBox], kind: str) -> list[str]:
    if not words:
        return default_headers(kind)
    # Inventory has its own header finder; a weekly invoice prints no titles.
    if kind == "inventory":
        header = find_inventory_header(words)
        return list(header.labels) if header else default_headers(kind)
    if kind == "invoice":
        return default_headers(kind)

    lines = group_into_lines(words)
    if not lines:
        return default_headers(kind)

    candidates: list[tuple[int, float]] = []
    scan_limit = min(len(lines), max(20, math.floor(len(lines) * 0.4)))

    for line_index in range(scan_limit):
        line = lines[line_index]
        if len(line) < 2:
            continue
        raw_text = [word.text.strip() for word in line if word.text.strip()]
        if len(raw_text) < 2:
            continue
        joined = " ".join(raw_text)

        if all(re.fullmatch(r"\$?[\d.,]+%?", token) for token in raw_text):
            continue
        if re.search(r"https?://|www\.|\.com\b|@", joined):
            continue
        if re.match(r"^\d{2,5}\s+[A-Za-z]", joined) and len(raw_text) <= 4:
            continue
        if re.search(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b", joined):
            continue
        if re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}", joined):
            continue

        score = 0.0
        text_words = [
            token
            for token in raw_text
            if not re.fullmatch(r"\$?[\d.,]+%?", token) and re.search(r"[A-Za-z]", token)
        ]
        text_ratio = len(text_words) / len(raw_text)
        if text_ratio >= 0.5:
            score += 20 * text_ratio

        labels = extract_label_tokens(line)
        if len(labels) >= 4:
            score += 30
        elif len(labels) >= 3:
            score += 25
        elif len(labels) >= 2:
            score += 10

        upper_count = sum(
            1 for token in text_words if token == token.upper() and re.search(r"[A-Z]", token)
        )
        title_count = sum(1 for token in text_words if re.match(r"^[A-Z]", token))
        if text_words:
            if upper_count >= len(text_words) * 0.5:
                score += 15
            elif title_count >= len(text_words) * 0.5:
                score += 8

        keyword_matches = len(HEADER_KEYWORDS.findall(joined))
        if keyword_matches >= 3:
            score += 25
        elif keyword_matches >= 2:
            score += 18
        elif keyword_matches >= 1:
            score += 10

        if 2 <= line_index <= 20:
            score += 5
        if 4 <= line_index <= 14:
            score += 5

        if line_index + 1 < len(lines):
            next_text = [word.text.strip() for word in lines[line_index + 1] if word.text.strip()]
            next_numeric = sum(1 for token in next_text if re.fullmatch(r"\$?[\d.,]+%?", token))
            next_mixed = any(re.search(r"[A-Za-z]", token) for token in next_text) and next_numeric >= 1
            if next_mixed and len(next_text) >= 2:
                score += 20
            elif next_numeric >= 2:
                score += 15

        average_length = sum(len(token) for token in text_words) / max(1, len(text_words))
        if average_length <= 12:
            score += 5
        if average_length <= 8:
            score += 5

        if len(raw_text) <= 3 and re.search(
            r"\b(invoice|settlement|inventory|summary|report|receipt|statement|bill)\b", joined, re.I
        ):
            score -= 30
        if len(raw_text) <= 2 and len(labels) <= 1:
            score -= 20
        if len(joined) > 120 and len(labels) <= 2:
            score -= 15
        if len(labels) <= 1:
            score -= 25

        if score > 15:
            candidates.append((line_index, score))

    if candidates:
        candidates.sort(key=lambda pair: -pair[1])
        index = candidates[0][0]
        labels = split_header_labels(lines[index], lines[index + 1 :])
        if len(labels) >= 2:
            return labels

    return default_headers(kind)


# --------------------------------------------------------------------------- #
# The reading                                                                  #
# --------------------------------------------------------------------------- #


def assemble_receipt(
    words: Sequence[WordBox],
    row_overlap_ratio: float = 0.5,
    guide: ColumnGuide | None = None,
) -> OcrResult:
    rows = inventory_rows_from_words(words, row_overlap_ratio)
    settlements = settlement_rows_from_words(words, row_overlap_ratio)
    invoice = invoice_rows_from_words(words, row_overlap_ratio)
    tables = read_column_tables(words, row_overlap_ratio, guide)
    table: ColumnTable | None = tables[0] if tables else None

    # A wholesale invoice's item numbers look like game-pack codes, so the
    # lottery readers will claim the page. A real column header wins unless
    # this is actually a lottery ticket.
    weekly = looks_like_weekly_invoice(invoice) or page_looks_like_weekly_invoice(words)
    if (
        table is not None
        and not is_lottery_header(table.headers)
        and find_inventory_header(words) is None
        and not weekly
    ):
        kind = "table"
    else:
        kind = choose_receipt_kind(rows, settlements, invoice)

    fields = invoice if kind == "invoice" else []
    warnings: list[str] = []
    if not words:
        warnings.append("No words were read. The page may be blank after watermark removal.")

    if kind == "inventory":
        kept_rows, solved_issues = solve_inventory_counts(rows)
    else:
        kept_rows, solved_issues = [], []
    kept_settlements = settlements if kind == "settlements" else []
    table_rows = table.rows if (kind == "table" and table is not None) else []

    if kind == "inventory":
        validation = solved_issues + validate_inventory(kept_rows)
    elif kind == "settlements":
        validation = validate_settlements(kept_settlements, stated_pack_total(words))
    elif kind == "invoice":
        validation = validate_invoice(fields)
    else:
        validation = []
    warnings.extend(issue.message for issue in validation)

    headers = (
        list(table.headers)
        if (kind == "table" and table is not None)
        else extract_table_headers(words, kind)
    )

    return OcrResult(
        kind=kind,
        title=extract_receipt_title(words, kind),
        headers=headers,
        rows=kept_rows,
        settlements=kept_settlements,
        fields=fields,
        table_rows=table_rows,
        tables=[
            {
                **({"title": each.title} if each.title else {}),
                "headers": list(each.headers),
                "rows": [
                    {"cells": list(row.cells), "confidence": row.confidence, "label": row.label}
                    for row in each.rows
                ],
                "columnBounds": list(each.bounds),
            }
            for each in tables
        ]
        if kind == "table"
        else [],
        column_bounds=list(table.bounds) if (kind == "table" and table is not None) else None,
        validation=validation,
        # Only the column reader keeps a log.
        skipped=sorted(
            (entry for each in tables for entry in each.skipped), key=lambda entry: entry.y
        )
        if kind == "table"
        else [],
        warnings=warnings,
        word_count=len(words),
    )


def row_cells(result: OcrResult) -> list[list[str]]:
    """Each row's cells, left to right in the order the ticket prints its columns."""
    if result.kind == "inventory":
        return [[r.game, r.name, r.int, r.rec, r.act, r.set] for r in result.rows]
    if result.kind == "settlements":
        return [[r.game_pack, r.name, r.date_settled] for r in result.settlements]
    if result.kind == "invoice":
        return [[f.label, f.value] for f in result.fields]
    return [list(row.cells) for row in result.table_rows]
