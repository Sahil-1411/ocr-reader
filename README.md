# OCR reader

Reads lottery retailer receipts from a photo — the Instant Inventory Summary, the weekly
Pack Settlements list, and the Weekly Invoice — and returns their rows as JSON, keyed by the
column headers the ticket itself prints:

```json
{
  "kind": "inventory",
  "headers": ["Game", "Name", "Int", "Rec", "Act", "Set"],
  "rows": [
    { "Game": "815", "Name": "$1,000,000 JACKPOT", "Int": "000", "Rec": "002", "Act": "000", "Set": "001" }
  ]
}
```

Games rotate, so there is no game catalog: the printed header and the Game column are the
schema. Every printed game becomes a row. Counts are either read, solved from the TOTALS
row when exactly one in a column is unreadable, or left empty and flagged — never dropped.

## Quick start

```bash
pnpm install
# one-time Python setup: see tools/README.md
.venv/bin/python tools/serve.py --warm   # the PP-OCR reader, on 127.0.0.1:8756
pnpm dev                                 # the app, on http://localhost:5173
```

When `serve.py` is not running the app says so and reads with Tesseract instead, which is
less accurate. See [`tools/README.md`](tools/README.md) for the reader and its scores.

```bash
pnpm test        # unit tests + scoring against tools/fixtures/ground-truth.json
pnpm build       # typecheck + production build
```

## How it works

```
browser: image → PNG → POST 127.0.0.1:8756/read
python:  watermark suppression → PP-OCR → word boxes (spaces restored from ink gaps)
browser: layout/rows.ts → receipt/validate.ts → JSON
```

Python stops at word boxes. Rows are built in TypeScript, so the app and
`tools/score.test.ts` run the same code and a score change is a reading change.

- **`layout/rows.ts`** finds the printed `Game Name Int Rec Act Set` header and reads every
  row against its columns. Run-together count blobs such as `005000-000` are split three
  digits a column.
- **`receipt/validate.ts`** checks each receipt against its own arithmetic: inventory
  columns against TOTALS, the settlement count against `Packs Total Settled`, the invoice
  header lines against `TOTAL DUE`. Anything solved or unreadable is listed above the
  table and its row highlighted.

## Layout

```
src/
  App.tsx               upload, result table, JSON copy/download
  components/           React UI
  lib/                  image I/O, progress state
  ocr/
    types.ts            shared contract — depends on nothing
    client.ts           picks the reader, runs a read, assembles the result
    python/reader.ts    talks to tools/serve.py
    tesseract/          the fallback reader
    layout/rows.ts      word boxes → receipt rows
    receipt/            assembly, validation, watermark suppression
tools/
  serve.py              localhost PP-OCR server
  read_receipt.py       the reader itself
  score.test.ts         scores the rows against the hand-checked fixture
harness.html            dev page that runs the sample receipts through the app
```
