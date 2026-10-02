# How the Python reader and the frontend work together

What happens when you upload a receipt, which side does what, and how the
server differs from the command-line script.

## Short summary

- **All the reading is Python.** `python/reader/` opens the PDF, recognises
  the pages that need it, finds the columns, builds the rows and runs the
  receipt's own arithmetic checks. The browser does none of it.
- The app posts the file to **`POST /document`** — the bytes as they are, not
  a multipart form, and not a third-party cloud service. The server tells a
  PDF from an image by looking at the first five bytes.
- The server is **`python/serve.py`** (default **127.0.0.1:8756**). In dev,
  Vite proxies `/document`, `/export`, `/page` and `/health` to that port.
- **There is no fallback.** Without the reader the app says so and reads
  nothing: the browser has no reader of its own any more.
- **`read_receipt.py`** is the PP-OCR engine. `serve.py` imports it; it also
  runs from the command line to dump word boxes for a single image.

---

## The three routes

| Route            | What it is for                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /document` | A PDF or an image in; every page's reading out. `?format=csv` or `?format=json` returns the finished export instead, for a caller with nothing to edit. |
| `POST /export`   | The pages a caller holds, back as one CSV or JSON.                                                                                                      |
| `GET /page`      | The picture of one page of a PDF just read, at the width asked for.                                                                                     |

`GET /health` says whether the reader is up, which the app asks on start-up so
it can warn before a file is chosen. It also reports `keyNeeded` and
`authorised`, so "no reader" and "no key" do not look the same from outside.

### The key

On localhost there is none: the only callers are on this machine. `--live`
binds every interface, so it asks for one and generates it if you did not give
it one (`--token`, `OCR_READER_TOKEN`, or `--open` to serve without). A caller
presents it as `Authorization: Bearer <key>`; a browser opens the app once as
`/?key=<key>` and the reader moves it into an HttpOnly cookie and redirects to
the clean URL. The cookie is what makes the viewer work — `<img src="/page…">`
cannot carry a header. `/health` is the one route that never asks.

### Why `/export` is a POST that carries the rows

The export is of what is **on screen**, not of what was read. Somebody may have
typed into a cell or taken an extra table out of the export, and those live in
the browser. A `GET` that re-read the file would quietly hand back the original
reading and lose the corrections, so the app posts its pages back and the
reader shapes them.

A caller that has nothing to change skips the middle step:

```bash
curl -s --data-binary @invoice.pdf 'http://127.0.0.1:8756/document?format=csv'
```

### Why `/page` exists

The browser never opens the PDF, so it has no pixels to show. The viewer's
picture, the thumbnail strip, the text overlay drawn over it, the zoom and the
download all need a rendered page, and only the reader can produce one. An
uploaded **image** is its own picture and is never asked for back.

---

## What reads what

```
browser: the file → POST /document
python:  a PDF's text layer, or watermark suppression → PP-OCR → word boxes
         → glyphs joined → columns → rows → the receipt's own checks
browser: draws the rows, and GET /page for the picture of each PDF page
         → POST /export for the CSV or JSON, shaped by the reader
```

A page is read from the PDF's own text where it has one, because that text is
exact and a recogniser's is not. A scan, a photograph, or a PDF whose text
layer is a token has to be recognised, and only those pages pay for it.

### Inside the reader

| Module               | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| `reader/boxes.py`    | The word box, and grouping words into printed lines.         |
| `reader/pdf_text.py` | A PDF's own text, and rendering its pages to pixels.         |
| `reader/glyphs.py`   | Joins the glyphs a recogniser returns one at a time.         |
| `reader/columns.py`  | A multi-column table, read off its printed titles.           |
| `reader/rows.py`     | The lottery readers: inventory, settlements, weekly invoice. |
| `reader/validate.py` | Each receipt against its own arithmetic.                     |
| `reader/assemble.py` | Which kind of page this is, and its reading.                 |
| `reader/document.py` | A whole file in, every page's reading out.                   |
| `reader/export.py`   | Every page as one CSV or JSON, tables and log beside it.     |
| `reader/skipped.py`  | What a line the table reader left out actually is.           |

---

## Two Python entry points

| Script                                             | Purpose                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `python/serve.py`                                  | The HTTP server the app talks to.                                                       |
| `python/read_receipt.py`                           | The PP-OCR engine. Also a command-line tool: an image path in, word-box JSON on stdout. |

They share the watermark suppression and the recogniser; `serve.py` adds
everything in `reader/` on top of the words.

---

## What the browser still does

Rendering, and the two things that are the person's rather than the reader's:

- **Edits.** A cell you type into is held in the page and sent back with the
  export.
- **Dropped tables.** An extra table you remove is remembered by key and left
  out of the export's `tables`.

Everything else it draws — rows, headers, the validation notes, the log of what
was left out — arrives from the reader already shaped.

---

## Checking a change

The reader takes a table's layout from the page rather than from a template, so
a rule that squares a column on one invoice decides a different column on the
next. A change cannot be judged on the document that prompted it:

```bash
pnpm test      # the app's tests and the reader's
pnpm corpus    # every document in frontend/tools/corpus/, against how it last read
```

`pnpm corpus` prints the rows that moved, so an improvement on one form can be
told apart from a regression on another. `UPDATE_CORPUS=1` records a new
reading once it has been judged.

A Python change needs the reader restarted — Vite only hot-reloads the
frontend.
