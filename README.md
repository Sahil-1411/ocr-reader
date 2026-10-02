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

## Layout

```
frontend/   the web app (Vite). Build output is frontend/dist
python/     the PP-OCR server (serve.py, read_receipt.py)
```

## Quick start

From the repo root:

```bash
pnpm --dir frontend install
# one-time Python setup: see python/README.md
.venv/bin/python python/serve.py --warm   # the PP-OCR reader, on 127.0.0.1:8756
pnpm --dir frontend dev                    # the app, on http://localhost:5173
```

The page calls `/read` on its own host. Vite forwards that to the Python server.
When `serve.py` is not running the app says so and reads with Tesseract instead, which is
less accurate. See [`python/README.md`](python/README.md) for the reader and its scores.

```bash
pnpm --dir frontend test     # unit tests + scoring against frontend/tools/fixtures/ground-truth.json
pnpm --dir frontend build    # typecheck + production build
```

### The regression corpus

The readers take the layout from the page rather than from a template, so a rule that
squares a column on one invoice decides a different column on the next. A change therefore
cannot be judged on the document that prompted it.

Put the documents you care about in `frontend/tools/corpus/` — it is excluded from the
repository, like `public/samples/`, because they are whole invoices — and
[`tools/corpus.test.ts`](frontend/tools/corpus.test.ts) records how each one reads. After
that, any change that moves a row on any of them fails the test and prints the rows that
moved, so an improvement on one form can be told apart from a regression on another.

```bash
pnpm --dir frontend exec vitest run tools/corpus.test.ts                 # what moved?
UPDATE_CORPUS=1 pnpm --dir frontend exec vitest run tools/corpus.test.ts # record it
```

It is a diff, not a verdict: a failure may be exactly the change you wanted. With no corpus
the test skips, so a fresh checkout still runs green.

## Put it on a server

The server needs Python 3.12 and Node (to build the frontend). Upload this repo, then:

```bash
pnpm --dir frontend install
pnpm --dir frontend build
# one-time: see python/README.md for the 3.12 virtualenv
uv pip install -r python/requirements.txt --excludes python/excludes.txt
.venv/bin/python python/serve.py --live --warm
```

`--live` listens on `0.0.0.0:8080` and serves `frontend/dist` together with `/read`.
Open `http://<server>:8080`. Receipts uploaded there are read on that machine.

Stop it with `lsof -ti tcp:8080 | xargs kill`. Pass `--port` to use another port.
If a reverse proxy terminates HTTPS, forward the `Host` header. If the page is
hosted on a different origin than the API, build the frontend with
`VITE_PYTHON_READER_URL=https://api.example.com` and start the reader with
`--origin https://app.example.com`.

## How it works

```
browser: image → PNG → POST /read
python:  watermark suppression → PP-OCR → word boxes (spaces restored from ink gaps)
browser: layout/rows.ts → receipt/validate.ts → JSON
```

Python stops at word boxes. Rows are built in TypeScript, so the app and
`frontend/tools/score.test.ts` run the same code and a score change is a reading change.

- **`layout/rows.ts`** finds the printed `Game Name Int Rec Act Set` header and reads every
  row against its columns. Run-together count blobs such as `005000-000` are split three
  digits a column.
- **`receipt/validate.ts`** checks each receipt against its own arithmetic: inventory
  columns against TOTALS, the settlement count against `Packs Total Settled`, the invoice
  header lines against `TOTAL DUE`. Anything solved or unreadable is listed above the
  table and its row highlighted.
- **Several tables on a page** are read as several tables. An invoice prints its items, and
  under them something like `Previous Balances` with titles of its own; reading the second
  under the first's columns filed its dates as descriptions. Each extra table is shown under
  the main one and downloads as its own CSV, and the document's JSON carries them in `tables`.
- **Skipped & Removed** is the second export, kept apart from the data one. It logs every
  printed line the reading left out — totals, page furniture, a line that belongs to no
  item, a note such as `OUT OF STOCK` cut out of an item's description — and any page that
  produced no rows, each with its page, reason and confidence.

## Where the code lives

```
frontend/src/
  App.tsx               upload, result table, JSON copy/download
  components/           React UI
  lib/                  image I/O, progress state
  ocr/
    types.ts            shared contract — depends on nothing
    client.ts           picks the reader, runs a read, assembles the result
    python/reader.ts    talks to python/serve.py
    tesseract/          the fallback reader
    layout/rows.ts      word boxes → receipt rows
    receipt/            assembly, validation, watermark suppression
frontend/tools/
  score.test.ts         scores the rows against the hand-checked fixture
python/
  serve.py              PP-OCR server (localhost, or --live)
  read_receipt.py       the reader itself
frontend/harness.html   dev page that runs the sample receipts through the app
```
