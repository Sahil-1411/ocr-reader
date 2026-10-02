# The recogniser

PP-OCR, which reads the pages a PDF has no text for. `serve.py` imports it;
`read_receipt.py` also runs from the command line to dump word boxes for one
image.

This is the recogniser only. Everything built on top of the words — columns,
rows, the receipt's own checks, the export — is `python/reader/`. See
[`docs/how-python-and-frontend-work.md`](../docs/how-python-and-frontend-work.md).

## Why a server rather than the browser

PP-OCR cannot run in the browser: its ONNX stages need OpenCV, and
`@techstark/opencv-js` takes minutes to initialise its 10 MB synchronous WASM
build, wedging the main thread while it does. Outside the browser there is no
such issue, so the app posts the file to `serve.py` instead.

Tesseract used to read in the browser as a fallback. It was removed when the
reader moved to Python: there is one reader now, and the app says so rather
than quietly reading less accurately.

## Setup

Use a 3.12 virtualenv. Not the system Python, and on this machine not Homebrew's
either:

```sh
brew install uv
uv venv --python 3.12 .venv
uv pip install -r python/requirements.txt --excludes python/excludes.txt
```

Then run everything through `.venv/bin/python`.

The exclude list keeps out `opencv-python`. `rapidocr-onnxruntime` asks for that
GUI build, while this installs the headless one, and the two unpack into the
same `cv2` folder: whichever went in last wins, and uninstalling either one
breaks the other. On a Linux server the GUI build also needs libGL. The reader
prints a warning at startup when more than one build is installed. Plain `pip`
has no exclude option; after `pip install -r python/requirements.txt`, run
`pip uninstall -y opencv-python opencv-python-headless` and then
`pip install "opencv-python-headless>=4.9,<5"`.

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
.venv/bin/python python/read_receipt.py frontend/public/samples/weekly-invoice.jpg \
  > /tmp/weekly-invoice.words.json
```

Word boxes on stdout, for looking at what the recogniser saw. To check a whole
reading rather than the words, put the document in `frontend/tools/corpus/` and
run `pnpm corpus`.

Useful flags:

| flag | what it is for |
| --- | --- |
| `--scales 2 3` | emit several passes; the scorer merges them by row. Measured on these receipts it is not worth it — 3 adds nothing and costs a settled date. |
| `--no-suppress` | skip the watermark pass, to see what it is actually worth |
| `--max-side N` | longest side before processing (default 2400) |

## Measured

PP-OCR at the default 2× versus the Tesseract reader the app used before the
reader moved to Python, scored against a transcription of the three sample
receipts. The scorer was `frontend/tools/score.test.ts` and it went with the
TypeScript readers, so these numbers cannot be reproduced from the repo as it
stands; they are kept because they are why PP-OCR is the recogniser. Its
fixture is gitignored (see **Privacy**), so it is not here either.

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
from the other. The invoice went from 40 correct rows to 3. The scorer
assembled each pass separately and merged the finished rows on their natural
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

Reads run one at a time. ONNX Runtime already spreads one read over every
core, so two at once would only make both slower and double the memory. Up to
8 reads wait in line (the one being read included); past that `/document`
answers 503 and the file can be sent again.

```
browser: the file → POST /document
python:  a PDF's text layer, or watermark suppression → PP-OCR → word boxes
         → glyphs joined → columns → rows → the receipt's own checks
browser: draws the rows
```

Standard library only — no Flask, no FastAPI. It binds to `127.0.0.1` unless
you pass `--live`, which serves `frontend/dist` and the reader's routes on
`0.0.0.0:8080`.
A browser `Origin` is accepted when it is a dev server, the same host as this
process, or listed with `--origin`. It writes nothing to disk.

To put the site on a server, see the root README.

When the server is not running the app says so and reads nothing. There is no
second reader to fall back to, and that is deliberate: two readers do not
produce the same answer, so a silent downgrade would be indistinguishable from
success.

Already running? It says so and exits 0 rather than throwing a bind traceback:

```sh
lsof -ti tcp:8756 | xargs kill   # stop it
```

## How the scoring worked

`read_receipt.py` stops at word boxes; everything above them is
`python/reader/`. While the readers were still TypeScript, `score.test.ts` fed
the Python words through the same row builders the browser used, so both
recognisers were scored through identical downstream code and a difference in
the score was a difference in *reading*.

That scorer went with the TypeScript readers. What replaced it is
`pnpm corpus`, which compares a whole document's reading against the last one
recorded — a wider net, since it covers the columns and the checks as well as
the words.

The scorer read `frontend/tools/fixtures/ground-truth.json`: what the three
sample receipts actually say, transcribed by eye. It is gitignored along with
the receipts themselves, so a clone has an empty file there and the path is a
note of what to put back rather than something to open.

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
  `missing = total − sum(readable)`. `solve_inventory_counts` in
  `python/reader/validate.py` does this and reports each fill as
  `inventory-solved`; counts it cannot solve stay empty under `inventory-unread`.
- **Targeted re-read.** Crop a failing row at high resolution and read it again
  with a digits-only charset. Cheap: it is a handful of rows, not the page.
- **Ensemble**, as above.
- **Flag the remainder** rather than emitting a confident guess.

Every row present, and every row either verified against the receipt's own
arithmetic or marked — that is what "no failing row" has to mean for financial
data.
