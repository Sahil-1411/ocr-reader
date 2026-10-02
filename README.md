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
python/reader/   the reader: PDFs, recognised pages, columns, rows, checks
python/          the server (serve.py) and the PP-OCR engine (read_receipt.py)
frontend/        the web app (Vite). Build output is frontend/dist
```

**All the reading happens in `python/reader/`.** The browser posts a file to
`/document` and draws what comes back; it does not parse PDFs, recognise text, or build
rows. There is one implementation of every rule, so a fix lands once.

## Quick start

From the repo root:

```bash
pnpm --dir frontend install
# one-time Python setup: see python/README.md
.venv/bin/python python/serve.py --warm   # the PP-OCR reader, on 127.0.0.1:8756
pnpm --dir frontend dev                    # the app, on http://localhost:5173
```

The page calls `/document`, `/export` and `/page` on its own host. Vite forwards those to the Python server.
`serve.py` is the reader: without it the app says so and reads nothing, because there is no
second reader to fall back to. See [`python/README.md`](python/README.md) for the engine and
its scores.

```bash
pnpm test                    # the app's tests and the reader's
pnpm --dir frontend build    # typecheck + production build
pnpm corpus                  # the reader, against every document you keep
```

The reader must be running for the app to read anything: `pnpm reader` starts it. Without
it the app says so instead of falling back to a less accurate reader, because there is no
longer a second one.

### The regression corpus

The reader takes the layout from the page rather than from a template, so a rule that
squares a column on one invoice decides a different column on the next. A change therefore
cannot be judged on the document that prompted it.

Put the documents you care about in `frontend/tools/corpus/` — it is excluded from the
repository, like `public/samples/`, because they are whole invoices — and
[`python/check_corpus.py`](python/check_corpus.py) records how each one reads. After that,
any change that moves a row on any of them is reported with the rows that moved, so an
improvement on one form can be told apart from a regression on another.

```bash
.venv/bin/python python/check_corpus.py                 # what moved?
UPDATE_CORPUS=1 .venv/bin/python python/check_corpus.py # record it
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
browser: the file → POST /document
python:  PDF text layer, or watermark suppression → PP-OCR → word boxes
         → glyphs joined → columns → rows → the receipt's own checks
browser: draws the rows, and GET /page for the picture of each PDF page
         → POST /export for the CSV or JSON, shaped by the reader
```

A caller with nothing to edit can skip the middle step entirely:

```bash
curl -s --data-binary @invoice.pdf 'http://127.0.0.1:8756/document?format=csv'
curl -s --data-binary @invoice.pdf 'http://127.0.0.1:8756/document?format=json'
```

A page is read from the PDF's own text where it has one, because that text is exact and a
recogniser's is not; a scan or a photograph is recognised, and only those pages pay for it.

- **`reader/columns.py`** takes a table's layout from the page: the printed titles say
  which column is which, and the rows say where one ends and the next begins.
- **`reader/rows.py`** finds the printed `Game Name Int Rec Act Set` header and reads every
  row against its columns. Run-together count blobs such as `005000-000` are split three
  digits a column.
- **`reader/glyphs.py`** joins the glyphs a recogniser returns one at a time. On a
  line-printer face `144732` comes back as `1 4 4 7 3 2`, and every column rule reads the
  layout from where words start.
- **`reader/validate.py`** checks each receipt against its own arithmetic: inventory
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
python/
  reader/
    boxes.py            the word box, and grouping words into lines
    pdf_text.py         a PDF's own text, and rendering its pages
    glyphs.py           joining the glyphs a recogniser splits
    columns.py          a multi-column table, read off its printed titles
    rows.py             the lottery readers: inventory, settlements, invoice
    validate.py         each receipt against its own arithmetic
    assemble.py         which kind of page this is, and its reading
    document.py         a whole file in, every page's reading out
    export.py           every page as one CSV or JSON, tables and log beside it
  tests/                the export, case by case
  serve.py              the server: POST /document, POST /export, GET /page
  read_receipt.py       the PP-OCR engine
  check_corpus.py       every document you keep, against how it last read
frontend/src/
  App.tsx               upload, result table, JSON copy/download
  components/           React UI
  lib/                  downloads, theme, progress state
  components/row-status.ts  which rows still want a look
  ocr/
    types.ts            what the reader returns — depends on nothing
    api.ts              /document, /page, /export
    result.ts           listing a page's cells and editing one
```
