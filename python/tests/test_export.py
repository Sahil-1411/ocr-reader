"""
The document export, case by case.

Carried over from `frontend/src/lib/export.test.ts` when the export moved into
the reader. The cases are the ones a corpus cannot reach: two columns sharing
a title, a page set out differently from the one before it, a printed `Page`
column colliding with the page number, a blank page, a document only part of
which was read.

    .venv/bin/python -m pytest python/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reader.assemble import OcrResult  # noqa: E402
from reader.columns import SkippedLine, TableRow  # noqa: E402
from reader.rows import InventoryRow, InvoiceField, SettlementRow  # noqa: E402
from reader.export import (  # noqa: E402
    ExportPage,
    PageFailure,
    page_range,
    extra_tables,
    to_csv,
    to_document_json,
    to_skipped_csv,
    to_skipped_log,
    to_table_csv,
    to_table_json,
)

HEADERS = ["QTY", "DESCRIPTION", "PRICE"]


def table(headers, rows, *, kind="table", title=None, tables=None, skipped=None) -> OcrResult:
    """
    A reading of `kind`, with `rows` in whichever array that kind keeps them in.

    `row_cells` reads the kind's own array — an inventory row has a `game`, a
    settlement a `game_pack` — so a fixture that only filled `table_rows` would
    export nothing for any other kind.
    """
    built = [TableRow(cells=list(cells), confidence=1.0) for cells in rows]
    pad = lambda cells, n: list(cells) + [""] * max(0, n - len(cells))  # noqa: E731
    return OcrResult(
        kind=kind,
        title=title,
        headers=list(headers),
        rows=[InventoryRow(*pad(cells, 6), 1.0) for cells in rows] if kind == "inventory" else [],
        settlements=[SettlementRow(*pad(cells, 3), 1.0) for cells in rows]
        if kind == "settlements"
        else [],
        fields=[InvoiceField(*pad(cells, 2), 1.0) for cells in rows] if kind == "invoice" else [],
        table_rows=built,
        tables=tables
        if tables is not None
        else [{"headers": list(headers), "rows": [{"cells": r.cells, "confidence": 1.0} for r in built]}],
        column_bounds=None,
        validation=[],
        skipped=skipped or [],
    )


def page(number: int, result: OcrResult) -> ExportPage:
    return ExportPage.of(number, result)


class TestDocumentJson:
    def test_one_page_exports_as_the_page_reads(self):
        one = page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]], title="Invoice # 1001"))
        assert to_document_json([one], 1) == {
            "kind": "table",
            "title": "Invoice # 1001",
            "headers": HEADERS,
            "rows": [{"QTY": "1", "DESCRIPTION": "MINT SNUFF", "PRICE": "31.20"}],
        }

    def test_every_page_as_one_table_each_row_with_its_page(self):
        pages = [
            page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"], ["2", "LEAF BAG", "17.35"]], title="Invoice # 1001")),
            page(2, table(HEADERS, [["1", "HERB CAN", "52.40"]])),
        ]
        assert to_document_json(pages, 2) == {
            "kind": "table",
            "title": "Invoice # 1001",
            "pages": 2,
            "headers": HEADERS,
            "rows": [
                {"page": 1, "QTY": "1", "DESCRIPTION": "MINT SNUFF", "PRICE": "31.20"},
                {"page": 1, "QTY": "2", "DESCRIPTION": "LEAF BAG", "PRICE": "17.35"},
                {"page": 2, "QTY": "1", "DESCRIPTION": "HERB CAN", "PRICE": "52.40"},
            ],
        }

    def test_says_so_when_the_pages_are_different_kinds(self):
        invoice = table(["label", "value"], [["TOTAL DUE", "31.20"]], kind="invoice")
        json = to_document_json(
            [page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]])), page(2, invoice)], 2
        )
        assert json["kind"] == "mixed"
        assert json["headers"] == [*HEADERS, "label", "value"]

    def test_nothing_to_export_before_any_page_is_read(self):
        assert to_document_json([], 3) is None

    def test_keeps_the_shape_when_only_one_page_was_read(self):
        read = [page(3, table(HEADERS, [["1", "HERB CAN", "52.40"]]))]
        assert to_document_json(read, 5) == {
            "kind": "table",
            "pages": 5,
            "missingPages": [1, 2, 4, 5],
            "headers": HEADERS,
            "rows": [{"page": 3, "QTY": "1", "DESCRIPTION": "HERB CAN", "PRICE": "52.40"}],
        }
        assert to_csv(read, 5).split("\r\n") == [
            "Page,QTY,DESCRIPTION,PRICE",
            "3,1,HERB CAN,52.40",
        ]

    def test_a_blank_page_says_nothing_about_the_kind_or_columns(self):
        blank = table(["Game", "Name", "Int", "Rec", "Act", "Set"], [], kind="inventory")
        pages = [page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]])), page(2, blank)]
        json = to_document_json(pages, 2)
        assert json["kind"] == "table"
        assert json["headers"] == HEADERS
        assert to_csv(pages, 2).split("\r\n")[0] == "Page,QTY,DESCRIPTION,PRICE"


class TestCsv:
    def test_one_page_has_no_page_column(self):
        csv = to_csv([page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]]))], 1)
        assert csv.split("\r\n") == ["QTY,DESCRIPTION,PRICE", "1,MINT SNUFF,31.20"]

    def test_every_page_under_one_header_with_the_page_first(self):
        csv = to_csv(
            [
                page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]])),
                page(2, table(HEADERS, [["1", "HERB CAN", "52.40"]])),
            ],
            2,
        )
        assert csv.split("\r\n") == [
            "Page,QTY,DESCRIPTION,PRICE",
            "1,1,MINT SNUFF,31.20",
            "2,1,HERB CAN,52.40",
        ]

    def test_keeps_two_columns_that_share_a_title(self):
        headers = ["QTY", "DESCRIPTION", "PRICE", "PRICE"]
        csv = to_csv(
            [
                page(1, table(headers, [["2", "LEAF BAG", "17.35", "34.70"]])),
                page(2, table(headers, [["1", "HERB CAN", "52.40", "52.40"]])),
            ],
            2,
        )
        assert csv.split("\r\n") == [
            "Page,QTY,DESCRIPTION,PRICE,PRICE",
            "1,2,LEAF BAG,17.35,34.70",
            "2,1,HERB CAN,52.40,52.40",
        ]

    def test_each_cell_under_its_own_title_when_a_page_is_set_out_differently(self):
        csv = to_csv(
            [
                page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]])),
                page(2, table(["DESCRIPTION", "QTY", "AMOUNT"], [["HERB CAN", "1", "52.40"]])),
            ],
            2,
        )
        assert csv.split("\r\n") == [
            "Page,QTY,DESCRIPTION,PRICE,AMOUNT",
            "1,1,MINT SNUFF,31.20,",
            "2,1,HERB CAN,,52.40",
        ]

    def test_names_the_page_column_apart_from_a_printed_one(self):
        headers = ["Page", "DESCRIPTION"]
        csv = to_csv(
            [
                page(1, table(headers, [["A1", "MINT SNUFF"]])),
                page(2, table(headers, [["A2", "HERB CAN"]])),
            ],
            2,
        )
        assert csv.split("\r\n")[0] == "PDF Page,Page,DESCRIPTION"

    def test_keeps_a_cell_the_page_printed_no_title_for(self):
        # A settlements page whose `Date Settled` title was not read still has dates.
        def settled(game_pack, name, date):
            return table(["Game-Pack", "Name"], [[game_pack, name, date]], kind="settlements")

        csv = to_csv(
            [
                page(1, settled("875-010840", "STACKED", "02/28/26")),
                page(2, settled("833-129990", "CASH", "02/27/26")),
            ],
            2,
        )
        assert csv.split("\r\n") == [
            "Page,Game-Pack,Name,Column 3",
            "1,875-010840,STACKED,02/28/26",
            "2,833-129990,CASH,02/27/26",
        ]


class TestCollidingColumns:
    def test_keeps_both_columns_of_a_repeated_title_in_json(self):
        headers = ["QTY", "PRICE", "PRICE"]
        json = to_document_json(
            [
                page(1, table(headers, [["2", "17.35", "34.70"]])),
                page(2, table(headers, [["1", "52.40", "52.40"]])),
            ],
            2,
        )
        assert json["headers"] == ["QTY", "PRICE", "PRICE (2)"]
        assert json["rows"][0] == {"page": 1, "QTY": "2", "PRICE": "17.35", "PRICE (2)": "34.70"}

    def test_a_printed_page_column_does_not_overwrite_the_page_number(self):
        headers = ["page", "DESCRIPTION"]
        json = to_document_json(
            [
                page(1, table(headers, [["A1", "MINT SNUFF"]])),
                page(2, table(headers, [["A2", "HERB CAN"]])),
            ],
            2,
        )
        assert json["rows"] == [
            {"pdfPage": 1, "page": "A1", "DESCRIPTION": "MINT SNUFF"},
            {"pdfPage": 2, "page": "A2", "DESCRIPTION": "HERB CAN"},
        ]


def with_extra(number: int, rows):
    own = [{"cells": ["1", "WIDGET", "2.00"], "confidence": 1.0}]
    extra = {
        "title": "Previous Balances",
        "headers": ["Date", "Invoice", "Balance"],
        "rows": [{"cells": list(cells), "confidence": 1.0} for cells in rows],
    }
    result = table(HEADERS, [["1", "WIDGET", "2.00"]])
    result.tables = [{"headers": HEADERS, "rows": own}, extra]
    return page(number, result)


class TestExtraTables:
    def test_gathers_the_same_table_across_pages(self):
        tables = extra_tables(
            [
                with_extra(1, [["08/06/2026", "93354", "$52.65"]]),
                with_extra(2, [["08/13/2026", "93363", "$35.90"]]),
            ]
        )
        assert len(tables) == 1
        assert tables[0].title == "Previous Balances"
        assert tables[0].slug == "previous-balances"
        assert tables[0].rows == [
            (1, ["08/06/2026", "93354", "$52.65"]),
            (2, ["08/13/2026", "93363", "$35.90"]),
        ]

    def test_its_own_csv_with_a_page_column_only_when_there_are_pages(self):
        [many] = extra_tables([with_extra(1, [["08/06/2026", "93354", "$52.65"]])])
        assert to_table_csv(many, 2).split("\r\n") == [
            "Page,Date,Invoice,Balance",
            "1,08/06/2026,93354,$52.65",
        ]
        assert to_table_csv(many, 1).split("\r\n") == [
            "Date,Invoice,Balance",
            "08/06/2026,93354,$52.65",
        ]

    def test_its_own_json_in_the_shape_the_document_carries_it_in(self):
        [many] = extra_tables([with_extra(1, [["08/06/2026", "93354", "$52.65"]])])
        assert to_table_json(many, 2) == {
            "title": "Previous Balances",
            "headers": ["Date", "Invoice", "Balance"],
            "rows": [{"page": 1, "Date": "08/06/2026", "Invoice": "93354", "Balance": "$52.65"}],
        }
        assert to_table_json(many, 1)["rows"] == [
            {"Date": "08/06/2026", "Invoice": "93354", "Balance": "$52.65"}
        ]

    def test_leaves_out_a_table_the_reader_dropped(self):
        pages = [with_extra(1, [["08/06/2026", "93354", "$52.65"]])]
        [balances] = extra_tables(pages)
        json = to_document_json(pages, 1, {balances.key})
        assert json["rows"] == [{"QTY": "1", "DESCRIPTION": "WIDGET", "PRICE": "2.00"}]
        assert "tables" not in json
        kept = to_document_json(pages, 1, {"not-a-table"})
        assert len(kept["tables"]) == 1

    def test_keys_a_table_by_its_heading_and_columns(self):
        tables = extra_tables(
            [
                with_extra(1, [["08/06/2026", "93354", "$52.65"]]),
                with_extra(2, [["08/13/2026", "93363", "$35.90"]]),
            ]
        )
        assert len(tables) == 1
        assert "Previous Balances" in tables[0].key

    def test_keeps_the_document_export_to_the_documents_own_table(self):
        json = to_document_json([with_extra(1, [["08/06/2026", "93354", "$52.65"]])], 1)
        # The rows are the invoice's; the balances are beside them, not among them.
        assert json["rows"] == [{"QTY": "1", "DESCRIPTION": "WIDGET", "PRICE": "2.00"}]
        assert json["tables"] == [
            {
                "title": "Previous Balances",
                "headers": ["Date", "Invoice", "Balance"],
                "rows": [{"Date": "08/06/2026", "Invoice": "93354", "Balance": "$52.65"}],
            }
        ]


def skipped_page(number: int, entries) -> ExportPage:
    return page(number, table(HEADERS, [], skipped=entries))


def test_a_page_the_app_sends_back_reads_the_same_as_one_just_read():
    """An edited page arrives as JSON; the export must not care which it got."""
    read = page(1, table(HEADERS, [["1", "MINT SNUFF", "31.20"]]))
    posted = ExportPage.from_json(
        {
            "page": 1,
            "kind": "table",
            "headers": HEADERS,
            "rows": [{"cells": ["1", "MINT SNUFF", "31.20"]}],
            "tables": [],
            "skipped": [],
        }
    )
    assert to_csv([read], 1) == to_csv([posted], 1)
    assert to_document_json([read], 1) == to_document_json([posted], 1)


class TestSkippedLog:
    def test_gathers_every_pages_skipped_lines_and_the_pages_with_none(self):
        log = to_skipped_log(
            [
                skipped_page(1, [SkippedLine("summary", "TOTAL 173.53", 0.9, 10)]),
                skipped_page(2, [SkippedLine("note", "OUT OF STOCK", 0.8, 20)]),
            ],
            3,
            [PageFailure(3, "Reading stopped before this page.")],
        )
        assert log["pages"] == 3
        assert log["skipped"] == 3
        assert log["failedPages"] == [3]
        assert [row["text"] for row in log["rows"]] == [
            "TOTAL 173.53",
            "OUT OF STOCK",
            "Reading stopped before this page.",
        ]
        assert [row["what"] for row in log["rows"]] == [
            "Total or subtotal",
            "Note cut from an item",
            "Page produced no rows",
        ]

    def test_says_nothing_was_skipped_when_every_line_was_kept(self):
        log = to_skipped_log([skipped_page(1, [])], 1)
        assert log["skipped"] == 0
        assert "failedPages" not in log
        assert log["rows"] == []
        assert log["groups"] == []
        assert log["needsChecking"] == 0

    def test_writes_the_log_as_csv_quoting_a_line_with_a_comma(self):
        csv = to_skipped_csv(
            [skipped_page(1, [SkippedLine("unplaced", "TERMS: NET 30, THEN 1.5%", 0.5, 10)])],
            2,
            [PageFailure(2, "Reading stopped before this page.")],
        )
        assert csv.split("\r\n") == [
            "Check,Kind,Pages,Times,Printed text,Confidence",
            'yes,Not placed in a column,1,1,"TERMS: NET 30, THEN 1.5%",0.50',
            "yes,Page produced no rows,2,1,Reading stopped before this page.,",
        ]


class TestSkippedGroups:
    """What the log looks like to somebody who did not write the reader."""

    def test_one_line_printed_on_many_pages_is_one_entry(self):
        # A footer on every page is one thing to judge, not seven.
        pages = [
            skipped_page(number, [SkippedLine("furniture", "CONFIRM", 1.0, 900)])
            for number in range(1, 8)
        ]
        log = to_skipped_log(pages, 7)
        assert log["skipped"] == 7
        [group] = log["groups"]
        [entry] = group["entries"]
        assert entry["text"] == "CONFIRM"
        assert entry["pageRange"] == "1-7"
        assert entry["times"] == 7
        assert group["lines"] == 1

    def test_pages_read_as_a_person_writes_them(self):
        assert page_range([4]) == "4"
        assert page_range([1, 2, 3]) == "1-3"
        assert page_range([1, 2, 3, 5]) == "1-3, 5"
        assert page_range([5, 1, 2]) == "1-2, 5"
        assert page_range([]) == ""

    def test_the_kind_that_might_be_data_comes_first_and_is_marked(self):
        log = to_skipped_log(
            [
                skipped_page(
                    1,
                    [
                        SkippedLine("furniture", "Page 1 of 2", 1.0, 10),
                        SkippedLine("summary", "TOTAL 173.53", 1.0, 20),
                        SkippedLine("unplaced", "SOME STRAY LINE", 1.0, 30),
                    ],
                )
            ],
            1,
        )
        assert [group["what"] for group in log["groups"]] == [
            "Not placed in a column",
            "Total or subtotal",
            "Page furniture",
        ]
        assert [group["check"] for group in log["groups"]] == [True, False, False]

    def test_counts_what_wants_a_look_in_lines_not_in_sightings(self):
        pages = [
            skipped_page(number, [SkippedLine("unplaced", "A STRAY LINE", 1.0, 10)])
            for number in range(1, 6)
        ]
        log = to_skipped_log(pages, 5)
        assert log["skipped"] == 5
        # One line, printed five times, is one thing to check.
        assert log["needsChecking"] == 1

    def test_a_page_that_produced_nothing_is_one_to_check(self):
        log = to_skipped_log([], 2, [PageFailure(2, "Reading stopped before this page.")])
        [group] = log["groups"]
        assert group["what"] == "Page produced no rows"
        assert group["check"] is True
        assert log["needsChecking"] == 1
