"""
Read every document in `frontend/tools/corpus/` and compare it with the
reading recorded beside it.

The reader takes the layout from the page rather than from a template, so a
rule that squares a column on one invoice decides a different column on the
next. That is not a fault to be designed out — a page of words carries no
other evidence — but it does mean a change cannot be judged on the document
that prompted it. The only way to know what a change did is to read every
document that has ever been read and look at what moved.

So this is not a pass/fail gate on correctness. It is a diff. A failure means
"this document reads differently than it did", which may be the whole point of
the change; it prints what moved so the change can be judged, and
`UPDATE_CORPUS=1` records the new reading once it has been.

    .venv/bin/python python/check_corpus.py
    UPDATE_CORPUS=1 .venv/bin/python python/check_corpus.py

The documents are invoices with live account numbers and figures on them, so
`frontend/tools/corpus/` is excluded from the repository exactly as
`frontend/public/samples/` is. Drop PDFs or images in, and the snapshots are
written next to them. With no corpus this says so and stops.
"""

from __future__ import annotations

import os
import sys
from difflib import unified_diff
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reader.assemble import row_cells  # noqa: E402
from reader.document import read_document  # noqa: E402

CORPUS = Path(__file__).resolve().parents[1] / "frontend" / "tools" / "corpus"
SUFFIXES = (".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff")

#: How many changed lines to print before saying how many more there are.
MOST = 40


def snapshot(path: Path) -> list[str]:
    """
    The reading as lines of text, one row per line.

    Text rather than JSON because this is read by a person deciding whether a
    change was an improvement, and a row that moved one cell should show as one
    changed line. No row numbers: one row dropped at the top of a page would
    renumber every row under it, and the diff would be the whole page rather
    than the one line that changed.
    """
    out: list[str] = []
    for reading in read_document(path.read_bytes()):
        result = reading.result
        out.append(f"# page {reading.number}  {result.kind}  {reading.reader}")
        out.append("headers  " + " | ".join(result.headers))
        for cells in row_cells(result):
            out.append("row  " + " | ".join(cell.strip() for cell in cells))
        for entry in result.skipped:
            out.append(f"skip  {entry.reason}  {entry.text}")
        for issue in result.validation:
            out.append(f"check  {issue.code}  {issue.message}")
    return out


def main() -> int:
    if not CORPUS.exists():
        print(f"no corpus at {CORPUS} — nothing to check")
        return 0
    documents = sorted(p for p in CORPUS.iterdir() if p.suffix.lower() in SUFFIXES)
    if not documents:
        print(f"no documents in {CORPUS} — drop some in and run this again")
        return 0

    update = bool(os.environ.get("UPDATE_CORPUS"))
    moved = 0
    for document in documents:
        taken = snapshot(document)
        recorded = CORPUS / f"{document.name}.snap.txt"
        if update or not recorded.exists():
            recorded.write_text("\n".join(taken) + "\n")
            print(f"{document.name}: recorded {len(taken)} lines")
            continue
        want = recorded.read_text().splitlines()
        if want == taken:
            print(f"{document.name}: unchanged ({len(taken)} lines)")
            continue
        moved += 1
        # The whole new reading as well as the diff: the diff says what moved,
        # and the file is there to be opened and read in full.
        (CORPUS / f"{document.name}.actual.txt").write_text("\n".join(taken) + "\n")
        print(f"\n{document.name} reads differently (UPDATE_CORPUS=1 to record it):")
        shown = 0
        for line in unified_diff(want, taken, "recorded", "now", lineterm="", n=0):
            if line.startswith(("---", "+++", "@@")):
                continue
            print("  " + line[:150])
            shown += 1
            if shown >= MOST:
                print("  …")
                break
    return 1 if moved else 0


if __name__ == "__main__":
    raise SystemExit(main())
