# Offline reader + scoring

A Python reader that uses PP-OCR instead of Tesseract, and a scorer that measures
either reader against what the receipts actually say.

## Why it is out here rather than in the app

The browser app reads with Tesseract. Its remaining mistakes are all
character-level and all in places the watermark has thinned the print — `/` read
as `1` in a settled date, `8` as `6` in an amount, `L/T` as `LIT`. A model
trained on photographs rather than scans is less prone to exactly that, which is
what makes PP-OCR worth trying.

Running PP-OCR in the browser was tried and removed: its ONNX stages need
OpenCV, and `@techstark/opencv-js` takes minutes to initialise its 10 MB
synchronous WASM build, wedging the main thread while it does. Outside the
browser there is no such issue, so the app posts the image to `serve.py` instead.

## Setup

Use a 3.12 virtualenv. Not the system Python, and on this machine not Homebrew's
either:

```sh
brew install uv
uv venv --python 3.12 .venv
uv pip install -r python/requirements.txt
```

Then run everything through `.venv/bin/python`.

`uv` is worth the extra install because it fetches its own standalone
interpreter, which avoids two separate problems with the Homebrew Python here:

- **3.14 is too new for the wheels.** `onnxruntime` and `opencv-python` do not
  publish cp314 builds, so pip falls through to compiling from source and fails.
- **The Homebrew 3.14 itself is broken.** Its `pyexpat` is linked against
  Homebrew's `expat` but resolves macOS's older `/usr/lib/libexpat.1.dylib` at
  runtime, which has no `_XML_SetAllocTrackerActivationThreshold`. `pip` cannot
  even import — every command dies in `xmlrpc.client`. `brew reinstall expat
  python@3.14` repairs that one, but leaves the wheel problem.

Without `uv`, `brew install python@3.12 && python3.12 -m venv .venv` works too.

`rapidocr-onnxruntime` runs the PP-OCR ONNX weights without pulling in PaddlePaddle — a ~100 MB framework a
read-one-image script has no use for. Swap it for `paddleocr` if the larger
*server* models turn out to be worth it; they are more accurate than the mobile
ones and too big to ship to a browser, which is part of the argument for reading
outside it.

## Use

```sh
mkdir -p frontend/tools/out

.venv/bin/python python/read_receipt.py frontend/public/samples/weekly-invoice.jpg \
  > frontend/tools/out/weekly-invoice.jpg.words.json

pnpm --dir frontend exec vitest run tools/score.test.ts
```

All three at once:

```sh
mkdir -p frontend/tools/out
for s in frontend/public/samples/*.jpg; do
  .venv/bin/python python/read_receipt.py "$s" --scales 1 2 \
    > "frontend/tools/out/$(basename "$s").words.json"
done
pnpm --dir frontend exec vitest run tools/score.test.ts
```

Useful flags:

| flag | what it is for |
| --- | --- |
| `--scales 2 3` | emit several passes; the scorer merges them by row. Measured on these receipts it is not worth it — 3 adds nothing and costs a settled date. |
| `--no-suppress` | skip the watermark pass, to see what it is actually worth |
| `--max-side N` | longest side before processing (default 2400) |

## Measured

Against `fixtures/ground-truth.json`, PP-OCR at the default 2× versus the
Tesseract reader in the app:

| | Tesseract | PP-OCR |
| --- | --- | --- |
| pack settlements | 25/25 rows, 25 dates exact | 25/25, **25 exact**, 25 names exact |
| inventory | 43/48 games, 40 count rows exact | **48/48**, **48 exact**, TOTALS exact, 47 names exact |
| weekly invoice | 45/45 rows, 38 fully exact | 45/45, **41 exact** |

The one inventory name still wrong is 815, whose name is printed under the logo
(`$1,000,000 JACKPOTLS8S`).

Inventory rows are read against the printed `Game Name Int Rec Act Set` header:
every number in the Game column opens a row, even when its counts are unreadable,
and counts are binned to the column they sit under. A count blob such as
`005000-000` or `000-00500000` + `1` is split at three digits a column.

PP-OCR's recogniser is unreliable about spaces, so `read_receipt.py` restores
them from the pixels: a column gap of at least 0.32 × cap height between inked
glyphs is a space. Lines in the inventory's Name column are also re-read at 3×
and 4×, and a character is only replaced when every re-read agrees.

Two things had to be fixed before PP-OCR could win, and both came from the same
property: its recogniser returns a whole line as one string and is unreliable
about spaces.

- `881-023234 DIAMONDS & GOLD` comes back as `881-023234DIAMONDS&GOLD`, so no
  token matches a pack code and the row is dropped. Settlements scored 11 of 25
  until the pack code was peeled off the front.
- `\d{3}-\d{5,8}` is greedy, so where the name starts with digits it swallowed
  them: `833-129986` glued to `200X THE CASH` matched entirely as
  `833-12998620` — still a *valid* pack code, so it passed silently with the
  wrong value. The cut length is taken from the codes the page got cleanly.

**Ensembling has to merge rows, not words.** Pooling two passes' words is the
obvious approach and destroys the result — every line appears twice at slightly
different coordinates and the builders pair a label from one pass with an amount
from the other. The invoice went from 40 correct rows to 3. `score.test.ts`
assembles each pass separately and merges the finished rows on their natural
key.

## Serving the reader to the app

`serve.py` puts the same reader behind an HTTP endpoint so the browser app
can use it. Set the app's reader to `python` (the default) and start it from
the repo root:

```sh
.venv/bin/python python/serve.py --warm
```

The page calls `/read` on its own host. Vite forwards that to `127.0.0.1:8756`.
`--warm` builds the models at startup rather than on the first read, which
otherwise costs about 25 seconds on the first receipt.

```
browser: image → PNG → POST /read
python:  decode → watermark suppression → PP-OCR → word boxes
browser: rows.ts → validation → JSON
```

Standard library only — no Flask, no FastAPI. It binds to `127.0.0.1` unless
you pass `--live`, which serves `frontend/dist` and `/read` on `0.0.0.0:8080`.
A browser `Origin` is accepted when it is a dev server, the same host as this
process, or listed with `--origin`. It writes nothing to disk.

To put the site on a server, see the root README.

Python does its own watermark suppression, so the app skips its pass when this
reader is in use rather than running every stroke through the ink ramp twice.

When the server is not running the app says so through `onFatal` and reads with
Tesseract instead of refusing the image. It reports the backend as
`tesseract (Python reader not running)` — the two readers do not produce the same
answer, so a silent downgrade would be indistinguishable from success.

Already running? It says so and exits 0 rather than throwing a bind traceback:

```sh
lsof -ti tcp:8756 | xargs kill   # stop it
```

## How the scoring works

`read_receipt.py` deliberately stops at word boxes. Row assembly stays in
`frontend/src/ocr/layout/rows.ts`, which is tested and which a second implementation would
only drift from. `score.test.ts` feeds the Python words through those same
builders, so both readers are scored through identical downstream code and a
difference in the score is a difference in *reading*.

`fixtures/ground-truth.json` is what the three sample receipts actually say,
transcribed by eye.

This scoring is not ceremony. Raising the ink ramp from `t²` to `t³` fixed
`FWD BALANCE` and `ON-LINE NET DUE`, looked like a clear win on the rows anyone
would check first, and scored 36 of the invoice's 45 rows against the square
ramp's 38. Without a score it would have shipped.

## Privacy

`fixtures/ground-truth.json` transcribes the receipts line by line — the
retailer's pack codes, settled dates and weekly figures. `frontend/public/samples/` is
gitignored for exactly that reason, so the fixture and `frontend/tools/out/` are ignored
too. Rebuild them from a redacted receipt before committing anything here.

## What this cannot do

It cannot reach 100%. Game 824's count columns are printed under the logo and
what survives in the pixels is `550/000 FEN`; 858's are `00 665 55000`. No
recogniser recovers information that is not there — a different one guesses
differently.

The way to no-failing-rows is not a better engine but not depending on the engine
alone:

- **Algebra.** The `TOTALS` row states each column's sum. With exactly one
  unreadable value in a column it is solved rather than guessed:
  `missing = total − sum(readable)`. `solveInventoryCounts` in
  `frontend/src/ocr/receipt/validate.ts` does this and reports each fill as
  `inventory-solved`; counts it cannot solve stay empty under `inventory-unread`.
- **Targeted re-read.** Crop a failing row at high resolution and read it again
  with a digits-only charset. Cheap: it is a handful of rows, not the page.
- **Ensemble**, as above.
- **Flag the remainder** rather than emitting a confident guess.

Every row present, and every row either verified against the receipt's own
arithmetic or marked — that is what "no failing row" has to mean for financial
data.
