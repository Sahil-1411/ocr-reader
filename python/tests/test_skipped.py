"""
Saying what a leftover line is, case by case.

The case that matters most is the last one: a line that really might be data
has to stay flagged. A pass that explains everything away is no more use than
the one that explained nothing.

    .venv/bin/python -m pytest python/tests/test_skipped.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reader.columns import SkippedLine  # noqa: E402
from reader.skipped import PageLines, refine  # noqa: E402

#: Where the items start on every page of the imaginary document below.
BODY = 100.0


def line(text: str, x: float, y: float = 0.0, reason: str = "unplaced") -> SkippedLine:
    return SkippedLine(reason=reason, text=text, confidence=1.0, y=y, x=x)


def page(number: int, *lines: SkippedLine, body_left: float | None = BODY) -> PageLines:
    return PageLines(number=number, skipped=list(lines), body_left=body_left)


def reasons(*pages: PageLines) -> list[str]:
    refine(pages)
    return [entry.reason for p in pages for entry in p.skipped]


class TestRepeated:
    def test_a_line_on_more_than_one_page_is_a_field_of_the_page(self):
        assert reasons(
            page(1, line("P.O.: WEB6842382", BODY)),
            page(2, line("P.O.: WEB6842382", BODY)),
        ) == ["page-field", "page-field"]

    def test_a_line_on_one_page_only_is_not(self):
        assert reasons(
            page(1, line("SHORT SHIPPED 3 CASES", BODY)),
            page(2, line("P.O.: WEB6842382", BODY)),
        ) == ["unplaced", "unplaced"]

    def test_twice_on_the_same_page_is_still_about_that_page(self):
        # Counted by page, not by appearance: a note printed twice on one page
        # says something about that page. The same words on every page do not.
        assert reasons(
            page(1, line("CARRIED FORWARD", BODY), line("CARRIED FORWARD", BODY, y=9)),
        ) == ["unplaced", "unplaced"]

    def test_both_copies_are_relabelled_together(self):
        # Never the same words under two headings in one log.
        got = reasons(
            page(1, line("ARCHIVE COPY", 20.0)),
            page(2, line("ARCHIVE COPY", 400.0)),
            page(3, line("ARCHIVE COPY", 400.0)),
        )
        assert got == ["page-field"] * 3

    def test_spacing_and_case_do_not_make_two_lines(self):
        assert reasons(
            page(1, line("Archive  Copy", 400.0)),
            page(2, line("ARCHIVE COPY", 400.0)),
        ) == ["page-field", "page-field"]


class TestIndent:
    def test_an_indent_the_document_shares_marks_its_annotations(self):
        # Two lines at the same edge, well right of the items: the document's
        # own annotation column.
        assert reasons(
            page(1, line("JUUL", 520.0), line("SNUS", 520.0)),
        ) == ["annotation", "annotation"]

    def test_one_line_on_its_own_proves_no_indent(self):
        # A single indented line is as likely an item whose first columns did
        # not read, and that is exactly what wants checking.
        assert reasons(page(1, line("JUUL", 520.0))) == ["unplaced"]

    def test_a_line_right_of_the_indent_is_annotated_too(self):
        got = reasons(
            page(
                1,
                line("JUUL", 520.0),
                line("SNUS", 520.0),
                line("CUSTOMER'S OTP TAX PAID BY", 604.9),
            )
        )
        assert got == ["annotation"] * 3

    def test_the_indent_is_taken_across_the_whole_document(self):
        # One page carries a single annotation; the document carries three at
        # the same edge, which is what says the edge is real.
        assert reasons(
            page(1, line("JUUL", 520.0)),
            page(2, line("CIGARS", 520.0)),
        ) == ["annotation", "annotation"]

    def test_a_page_with_no_table_contributes_no_indent(self):
        assert reasons(
            page(1, line("JUUL", 520.0), body_left=None),
            page(2, line("CIGARS", 520.0), body_left=None),
        ) == ["unplaced", "unplaced"]


class TestMargin:
    def test_left_of_every_item_is_outside_the_table(self):
        assert reasons(
            page(1, line("PDF produced by PDFing v5.0 (c) David Fowle", 27.8))
        ) == ["margin"]

    def test_level_with_the_items_is_not_the_margin(self):
        assert reasons(page(1, line("P.O.: WEB6842382", BODY))) == ["unplaced"]


class TestLegend:
    def test_a_line_that_defines_a_symbol(self):
        assert reasons(
            page(1, line("*** TEMPERATURE ABBREVIATIONS: D = DRY, R = REFRIGERATED", BODY))
        ) == ["legend"]

    def test_a_line_that_says_what_a_mark_denotes(self):
        assert reasons(
            page(1, line("* - DENOTES A QUANTITY CHANGE FROM THE ORIGINAL ORDER", BODY))
        ) == ["legend"]

    def test_prose_that_merely_mentions_a_quantity_is_not_a_legend(self):
        assert reasons(page(1, line("QUANTITY ADJUSTED BY THE SUPPLIER", BODY))) == ["unplaced"]


class TestDocumentTotals:
    def test_keyed_figures_across_a_line_are_the_document_adding_itself_up(self):
        assert reasons(
            page(1, line("NET PRICE: $32,165.34 SHIP QTY: 981 WEIGHT: 6,341.11", BODY))
        ) == ["summary"]

    def test_one_keyed_figure_is_not_a_totals_line(self):
        # `P.O.: 12345` is a field, not a total.
        assert reasons(page(1, line("ORDER NUMBER: 4471", BODY))) == ["unplaced"]


class TestLeavesWellAlone:
    def test_a_reason_the_reader_already_worked_out_is_never_overwritten(self):
        pages = (
            page(
                1,
                line("OUT OF STOCK", 500.0, reason="note"),
                line("SUB TOTAL: 13,134.09", 500.0, reason="summary"),
                line("QTY  DESCRIPTION  PRICE", 500.0, reason="repeated-header"),
                line("Page 2 of 7", 500.0, reason="furniture"),
            ),
        )
        assert reasons(*pages) == ["note", "summary", "repeated-header", "furniture"]

    def test_a_line_printed_among_the_items_still_wants_checking(self):
        # The whole point. Level with the items, on one page only, not a key
        # and not a total: this is the kind that might be a row the reader
        # missed, and nothing here may explain it away.
        assert reasons(
            page(1, line("374256  18  JUUL POD 5% CLASSIC  23.99", BODY)),
        ) == ["unplaced"]

    def test_the_items_indent_itself_is_never_an_annotation(self):
        # Three lines level with the items share an edge, but it is the items'
        # own edge, so it says nothing about them.
        assert reasons(
            page(
                1,
                line("FIRST LOOSE LINE", BODY),
                line("SECOND LOOSE LINE", BODY),
                line("THIRD LOOSE LINE", BODY),
            )
        ) == ["unplaced"] * 3
