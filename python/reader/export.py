"""
The whole document as one export: every page's rows, in page order.

A port of what used to be `frontend/src/lib/export.ts`. It is here rather than
in the browser so that the export is the reader's answer and not the page's
rendering of it: a script, another service and the app all ask for the same
CSV and get the same bytes.

A multi-page invoice is one table printed across pages, so its export is one
table too, with each row's page kept beside it. A single image or a one-page
PDF exports exactly as the page does.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from .assemble import OcrResult, row_cells

#: What each skip reason means, for somebody who did not write the reader.
#:
#: `what` names it, `detail` says why leaving it out was right, and `check`
#: marks the two that might not have been. The order is the order the groups
#: are shown in: what deserves a look first, the rest after it.
SKIP_REASONS: tuple[dict, ...] = (
    {
        "reason": "unplaced",
        "what": "Not placed in a column",
        "detail": (
            "Printed among the items but it did not read as one. Worth checking "
            "against the page — this is the only kind that might be data."
        ),
        "check": True,
    },
    {
        "reason": "page-error",
        "what": "Page produced no rows",
        "detail": "Nothing on this page could be read, so none of it is in the data.",
        "check": True,
    },
    {
        "reason": "note",
        "what": "Note cut from an item",
        "detail": (
            "Wording removed from an item's own line, such as OUT OF STOCK. "
            "The item itself was kept."
        ),
        "check": False,
    },
    {
        "reason": "summary",
        "what": "Total or subtotal",
        "detail": "A figure the document adds up. The lines it adds up are in the data.",
        "check": False,
    },
    {
        "reason": "repeated-header",
        "what": "Column titles printed again",
        "detail": "The table's own header, printed again further down.",
        "check": False,
    },
    {
        "reason": "furniture",
        "what": "Page furniture",
        "detail": "A header, footer, page number or banner.",
        "check": False,
    },
)

SKIP_REASON = {entry["reason"]: entry["what"] for entry in SKIP_REASONS}
_REASON_ORDER = {entry["reason"]: index for index, entry in enumerate(SKIP_REASONS)}


@dataclass(slots=True)
class ExportPage:
    """
    One read page of the document, numbered from 1.

    Flat rather than an `OcrResult`, because the export is asked for by two
    callers with different things in hand: the reader, which has just read the
    page, and the app, which has the same page with a cell or two typed into
    it. Both can say what the rows are; only one of them has a reading.
    """

    page: int
    kind: str
    headers: list[str]
    #: Cells left to right, under `headers`.
    rows: list[list[str]]
    tables: list[dict] = field(default_factory=list)
    #: `{reason, text, confidence}` per line the reader printed over.
    skipped: list[dict] = field(default_factory=list)
    title: str | None = None

    @classmethod
    def of(cls, page: int, result: OcrResult) -> "ExportPage":
        """The page as the reader just read it."""
        return cls(
            page=page,
            kind=result.kind,
            headers=list(result.headers),
            rows=row_cells(result),
            tables=list(result.tables),
            skipped=[
                {"reason": entry.reason, "text": entry.text, "confidence": entry.confidence}
                for entry in result.skipped
            ],
            title=result.title,
        )

    @classmethod
    def from_json(cls, page: dict) -> "ExportPage":
        """The page as the app holds it, edits and all."""
        return cls(
            page=int(page["page"]),
            kind=page.get("kind", "table"),
            headers=list(page.get("headers") or []),
            rows=[list(row.get("cells") or []) for row in page.get("rows") or []],
            tables=list(page.get("tables") or []),
            skipped=list(page.get("skipped") or []),
            title=page.get("title") or None,
        )


@dataclass(slots=True)
class PageFailure:
    """A page the reader never produced rows for, and why."""

    page: int
    message: str


# --------------------------------------------------------------------------- #
# The document's columns                                                       #
# --------------------------------------------------------------------------- #


def headers_of(page: "ExportPage") -> list[str]:
    """
    A page's headers, one per cell.

    A row can carry more cells than the page printed titles for, and those
    cells are data too.
    """
    width = max([len(page.headers)] + [len(row) for row in page.rows])
    return [
        page.headers[index] if index < len(page.headers) else f"Column {index + 1}"
        for index in range(width)
    ]


def _occurrence(headers: Sequence[str], index: int) -> int:
    """How many times `headers[index]` has already appeared before `index`."""
    return sum(1 for header in headers[:index] if header == headers[index])


def _nth(headers: Sequence[str], header: str, count: int) -> int:
    """Where the `count`-th (from 0) `header` sits in `headers`, or -1."""
    seen = -1
    for index, candidate in enumerate(headers):
        if candidate == header:
            seen += 1
            if seen == count:
                return index
    return -1


@dataclass(slots=True)
class DocumentLayout:
    kind: str
    headers: list[str]
    keys: list[str]
    page_title: str
    page_key: str

    def columns_of(self, page: "ExportPage") -> list[int]:
        own = headers_of(page)
        return [
            _nth(self.headers, header, _occurrence(own, index))
            for index, header in enumerate(own)
        ]


def document_layout(pages: Sequence[ExportPage]) -> DocumentLayout:
    """
    The columns of the whole document, and where each page's cells go.

    Taken from the pages that have rows: a blank page reads as some kind with
    some headers, and neither says anything about the table. Each cell lands
    under the column of its own title, the n-th `PRICE` of a page under the
    document's n-th `PRICE`.
    """
    filled = [page for page in pages if page.rows]
    source = filled or list(pages)
    kinds = {page.kind for page in source}

    headers: list[str] = []
    for page in source:
        own = headers_of(page)
        for index, header in enumerate(own):
            if _nth(headers, header, _occurrence(own, index)) < 0:
                headers.append(header)

    # JSON keys must be unique where printed titles need not be.
    keys = []
    for index, header in enumerate(headers):
        count = _occurrence(headers, index)
        keys.append(header if count == 0 else f"{header} ({count + 1})")

    return DocumentLayout(
        kind=next(iter(kinds)) if len(kinds) == 1 else "mixed",
        headers=headers,
        keys=keys,
        page_title="PDF Page" if "Page" in headers else "Page",
        page_key="pdfPage" if "page" in keys else "page",
    )


def _missing_pages(pages: Sequence[ExportPage], total: int) -> list[int]:
    read = {page.page for page in pages}
    return [number for number in range(1, total + 1) if number not in read]


# --------------------------------------------------------------------------- #
# CSV                                                                          #
# --------------------------------------------------------------------------- #


def csv_lines(lines: Sequence[Sequence[str]]) -> str:
    """
    Rows as CSV, with the line endings a spreadsheet expects.

    Written through the standard library's writer so quoting is the dialect's
    and not this file's idea of it.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    for line in lines:
        writer.writerow(list(line))
    return buffer.getvalue().rstrip("\r\n")


def to_csv(pages: Sequence[ExportPage], total: int) -> str:
    """
    The document's rows as CSV.

    Cells go by position under each page's own headers rather than by name, so
    a table that prints two columns with the same title loses neither. A longer
    document gets a `Page` column first.
    """
    if not pages:
        return ""
    if total <= 1:
        first = pages[0]
        return csv_lines([headers_of(first), *first.rows])

    layout = document_layout(pages)
    lines: list[list[str]] = [[layout.page_title, *layout.headers]]
    for page in pages:
        columns = layout.columns_of(page)
        for cells in page.rows:
            row = [""] * len(layout.headers)
            for index, column in enumerate(columns):
                if 0 <= column < len(row):
                    row[column] = cells[index] if index < len(cells) else ""
            lines.append([str(page.page), *row])
    return csv_lines(lines)


# --------------------------------------------------------------------------- #
# JSON                                                                         #
# --------------------------------------------------------------------------- #


def to_public_json(page: ExportPage) -> dict:
    """One page's rows, keyed by the column header exactly as it is printed."""
    headers = list(page.headers)
    return {
        "kind": page.kind,
        **({"title": page.title} if page.title else {}),
        "headers": headers,
        "rows": [
            {header: (cells[index] if index < len(cells) else "") for index, header in enumerate(headers)}
            for cells in page.rows
        ],
    }


def to_document_json(
    pages: Sequence[ExportPage],
    total: int,
    dropped: set[str] | None = None,
) -> dict | None:
    """
    The document's rows as JSON: the page's own shape for a one-page document,
    one table for a longer one — however many of its pages were read.

    `dropped` leaves out extra tables by key. A page can print a recap or a tax
    summary under its own table, and whether that belongs in the export is the
    reader's judgement, not something the geometry can settle.
    """
    if not pages:
        return None
    extras = [table for table in extra_tables(pages) if not dropped or table.key not in dropped]
    tables = {"tables": [to_table_json(table, total) for table in extras]} if extras else {}

    if total <= 1:
        return {**to_public_json(pages[0]), **tables}

    layout = document_layout(pages)
    title = next((page.title for page in pages if page.title), None)
    missing = _missing_pages(pages, total)

    rows: list[dict] = []
    for page in pages:
        columns = layout.columns_of(page)
        for cells in page.rows:
            row: dict[str, Any] = {layout.page_key: page.page}
            for key in layout.keys:
                row[key] = ""
            for index, column in enumerate(columns):
                if 0 <= column < len(layout.keys):
                    row[layout.keys[column]] = cells[index] if index < len(cells) else ""
            rows.append(row)

    return {
        "kind": layout.kind,
        **({"title": title} if title else {}),
        "pages": total,
        **({"missingPages": missing} if missing else {}),
        "headers": layout.keys,
        "rows": rows,
        **tables,
    }


# --------------------------------------------------------------------------- #
# Skipped & removed                                                            #
# --------------------------------------------------------------------------- #


def to_skipped_log(
    pages: Sequence[ExportPage],
    total: int,
    failures: Sequence[PageFailure] = (),
) -> dict:
    """
    Everything the read left out, in page order: the lines each page's reader
    printed over, and the pages that produced nothing at all.

    Kept apart from the data export so the rows a caller imports stay exactly
    the rows the document prints, while the account of the rest is still there
    to check a reading against the page.
    """
    rows: list[dict] = []
    for page in pages:
        for line in page.skipped:
            reason = line["reason"]
            rows.append(
                {
                    "page": page.page,
                    "reason": reason,
                    "what": SKIP_REASON.get(reason, reason),
                    "check": _REASON_ORDER.get(reason, 99) < 2,
                    "text": line["text"],
                    "confidence": round(float(line["confidence"]), 2),
                }
            )
    for failure in failures:
        rows.append(
            {
                "page": failure.page,
                "reason": "page-error",
                "what": SKIP_REASON["page-error"],
                "check": True,
                "text": failure.message,
            }
        )
    rows.sort(key=lambda row: row["page"])
    failed = sorted(failure.page for failure in failures)
    return {
        "pages": total,
        "skipped": len(rows),
        **({"failedPages": failed} if failed else {}),
        # Counted in lines, not in times: `CONFIRM` printed at the foot of
        # seven pages is one thing to look at, not seven.
        "needsChecking": sum(
            group["lines"] for group in _group(rows) if group["check"]
        ),
        "groups": _group(rows),
        "rows": rows,
    }


def page_range(pages: Sequence[int]) -> str:
    """
    `1-7`, `1-3, 5`, `4`: the pages a line was printed on, as a person writes
    them. A line a long document repeats on every page is one line, not forty.
    """
    ordered = sorted(set(pages))
    if not ordered:
        return ""
    spans: list[list[int]] = [[ordered[0], ordered[0]]]
    for page in ordered[1:]:
        if page == spans[-1][1] + 1:
            spans[-1][1] = page
        else:
            spans.append([page, page])
    return ", ".join(
        str(start) if start == end else f"{start}-{end}" for start, end in spans
    )


def _group(rows: Sequence[dict]) -> list[dict]:
    """
    The log by kind, and within a kind one entry per printed line.

    A flat list of every line on every page is what the reader saw, not what a
    person needs: the same `P.O.: WEB6842382` on seven pages is one line the
    reader left out seven times, and saying so once with its pages beside it is
    both shorter and clearer than saying it seven times. What matters most —
    the lines that might have been data — is put first.
    """
    by_reason: dict[str, dict[str, dict]] = {}
    for row in rows:
        lines = by_reason.setdefault(row["reason"], {})
        entry = lines.get(row["text"])
        if entry is None:
            lines[row["text"]] = {
                "text": row["text"],
                "pages": [row["page"]],
                **({"confidence": row["confidence"]} if "confidence" in row else {}),
            }
        else:
            entry["pages"].append(row["page"])
            if "confidence" in row:
                entry["confidence"] = min(entry.get("confidence", 1.0), row["confidence"])

    groups: list[dict] = []
    for meta in SKIP_REASONS:
        lines = by_reason.get(meta["reason"])
        if not lines:
            continue
        entries = []
        for entry in lines.values():
            pages = sorted(set(entry["pages"]))
            entries.append(
                {
                    **entry,
                    "pages": pages,
                    "pageRange": page_range(pages),
                    "times": len(entry["pages"]),
                }
            )
        groups.append(
            {
                "reason": meta["reason"],
                "what": meta["what"],
                "detail": meta["detail"],
                "check": meta["check"],
                "lines": len(entries),
                "times": sum(entry["times"] for entry in entries),
                "entries": entries,
            }
        )
    return groups


def to_skipped_csv(
    pages: Sequence[ExportPage],
    total: int,
    failures: Sequence[PageFailure] = (),
) -> str:
    """
    The log as a spreadsheet: one row per printed line, not per sighting.

    `Check` first, because a spreadsheet is sorted and filtered, and the one
    question to ask of this file is "is any of it data?". Everything under
    `no` is something the document prints that is not an item.
    """
    log = to_skipped_log(pages, total, failures)
    lines: list[list[str]] = [["Check", "Kind", "Pages", "Times", "Printed text", "Confidence"]]
    for group in log["groups"]:
        for entry in group["entries"]:
            confidence = entry.get("confidence")
            lines.append(
                [
                    "yes" if group["check"] else "no",
                    group["what"],
                    entry["pageRange"],
                    str(entry["times"]),
                    entry["text"],
                    "" if confidence is None else f"{confidence:.2f}",
                ]
            )
    return csv_lines(lines)


# --------------------------------------------------------------------------- #
# Tables printed under the main one                                            #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class ExtraTable:
    """A table printed under the page's own, gathered across its pages."""

    title: str
    #: That title as a file name's tail: `previous-balances`.
    slug: str
    #: Its heading and its columns, which is what makes it itself across pages.
    key: str
    headers: list[str]
    #: Its rows, each with the page it was printed on.
    rows: list[tuple[int, list[str]]] = field(default_factory=list)


def slugify(title: str) -> str:
    """`Previous Balances` → `previous-balances`, for a file name."""
    slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", title.lower()))[:48]
    return slug or "table"


def extra_tables(pages: Sequence[ExportPage]) -> list[ExtraTable]:
    """
    Every table printed under the pages' own, in the order they appear.

    The same table printed on several pages is one table here, so a balance
    list repeated per page downloads once with a `Page` column.
    """
    found: dict[str, ExtraTable] = {}
    for page in pages:
        for index, table in enumerate(page.tables[1:]):
            headers = list(table.get("headers") or [])
            # A table with no heading of its own is named for its first column,
            # which is what it is a table of — `Category Description`, `Date`.
            title = (table.get("title") or "").strip() or (
                headers[0].strip() if headers else ""
            ) or f"Table {index + 2}"
            key = "\0".join([title, *headers])
            rows = [(page.page, list(row["cells"])) for row in table.get("rows") or []]
            existing = found.get(key)
            if existing is not None:
                existing.rows.extend(rows)
            else:
                found[key] = ExtraTable(
                    title=title, slug=slugify(title), key=key, headers=headers, rows=rows
                )
    return list(found.values())


def to_table_json(table: ExtraTable, total: int) -> dict:
    """One extra table as JSON, with the page each row was printed on."""
    paged = total > 1
    return {
        "title": table.title,
        "headers": list(table.headers),
        "rows": [
            {
                **({"page": page} if paged else {}),
                **{
                    header: (cells[index] if index < len(cells) else "")
                    for index, header in enumerate(table.headers)
                },
            }
            for page, cells in table.rows
        ],
    }


def to_table_csv(table: ExtraTable, total: int) -> str:
    """One extra table as CSV, with a `Page` column when the document has pages."""
    paged = total > 1
    page_title = "PDF Page" if "Page" in table.headers else "Page"
    lines: list[list[str]] = [[page_title, *table.headers] if paged else list(table.headers)]
    for page, cells in table.rows:
        row = [cells[index] if index < len(cells) else "" for index in range(len(table.headers))]
        lines.append([str(page), *row] if paged else row)
    return csv_lines(lines)
