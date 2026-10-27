# OCR engine benchmark (Mission 20, item 3)

Chooses the OCR layer's engine by measurement on our own pages, per the
mission file: 200 pages stratified across digital text layer, clean scan,
degraded scan, dense tables, two columns and handwriting; ~40 pages
hand-transcribed as ground truth. Measures character error rate (CER),
table-cell exactness, ms/page, peak RSS and the escalation rate each engine
implies at a fixed quality floor. The engine that minimises total time at
CER ≤ 2% wins; the numbers ship with the layer.

## Corpus layout

```
corpus/
  digital/        *.pdf  pages with a real text layer
  clean/          *.pdf  clean scans
  degraded/       *.pdf  noisy/low-res scans
  tables/         *.pdf  table-dense pages
  columns/        *.pdf  two-column pages
  handwriting/    *.pdf  any handwritten pages
truth/
  <name>.json     hand transcript, one entry per measured page:
                  {"file": "clean/scan1.pdf", "page": 3, "text": "…"}
```

`pdftotext` decides whether a page has a usable text layer (>50 chars);
those pages are scored separately as `text-layer`, never OCR'd — that is
the pipeline's first rule and the harness enforces it.

## Run

On a workstation VM (layers land there) or any Linux box with nix:

```sh
# One engine at a time; each runs inside its own nix shell.
python3 bench.py --engine tesseract --corpus corpus --truth truth
python3 bench.py --engine rapidocr  --corpus corpus --truth truth
# Escalation candidate, heavyweight:
python3 bench.py --engine lighton   --corpus corpus --truth truth --sample 40

python3 report.py results/          # the markdown table the layer ships
```

Engines so far: `tesseract` (baseline, in nixpkgs), `rapidocr` (PP-OCR on
ONNX Runtime, in nixpkgs), `paddleocr` (in nixpkgs), `indra` (pip wheel —
licence unsettled; skipped unless `INDRA_WHEEL` points at it), `lighton`
(1B VLM escalation candidate; pip, `LIGHTON_MODEL`).

## Scoring

- **CER** per page against `truth/` where present; unlabelled pages still
  count toward latency/memory and escalation-rate stats.
- **Table-cell exactness** on `tables/` pages: share of `|`-delimited cells
  in the transcript found verbatim in the OCR text.
- **Escalation rate**: pages with mean line confidence < 0.75, no text
  where layout found blocks, or table density > 20 cells — over total
  OCR'd pages. Target ≤ 5%.
- **Peak RSS** of the engine subprocess (ru_maxrss), and wall ms/page.

Machine note: run on the target profile — 4 vCPU, ~5 GB, no GPU. Numbers
from a GPU box do not transfer. `bench.py` runs on macOS for smoke checks
(`ru_maxrss` is normalised to KiB), but Darwin binaries differ from the
VM's Linux ones — treat any mac number as a wiring check, not the result.
