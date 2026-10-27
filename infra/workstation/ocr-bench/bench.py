#!/usr/bin/env python3
"""OCR engine benchmark driver (Mission 20, item 3).

Runs one engine over a stratified corpus, one page at a time, and writes
results/<engine>.json. Pages with a usable text layer are never OCR'd —
that is the pipeline's first rule, enforced here.

Each engine is a runner script under engines/ executed inside `nix shell`,
so engine deps never touch the base interpreter. The runner speaks JSON
lines on stdout: {"page": n, "ms": float, "text": str, "confidence":
0..1|null, "cells": int|null}. bench.py times and measures the subprocess,
joins truth/<name>.json transcripts, and records CER, table-cell
exactness, escalation flags, ms/page and peak RSS.

Usage:
  python3 bench.py --engine rapidocr --corpus corpus --truth truth [--sample N] [--dpi 200]
"""

import argparse
import json
import os
import re
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Pages whose text layer extracts fewer characters than this are treated
# as image-only and sent to the engine.
TEXT_LAYER_MIN_CHARS = 50
# Mean line confidence below this flags the page for escalation.
CONFIDENCE_FLOOR = 0.75
# More than this many table cells in the truth marks a table-dense page.
TABLE_DENSE_CELLS = 20

# engine name -> (nix shell attrs, runner script)
ENGINES = {
    "tesseract": (["nixpkgs#tesseract"], "tesseract.py"),
    "rapidocr": (["nixpkgs#python312Packages.rapidocr"], "rapidocr.py"),
    "paddleocr": (["nixpkgs#python312Packages.paddleocr"], "paddleocr.py"),
    # pip engines run in the python layer's venv instead of nix shell.
    "indra": ([], "indra.py"),
    "lighton": ([], "lighton.py"),
}


def levenshtein(a: str, b: str) -> int:
    """Bounded edit distance; pages are small enough for O(len a * len b)."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(truth: str, ocr: str) -> float:
    norm = lambda s: re.sub(r"\s+", " ", s).strip()
    t, o = norm(truth), norm(ocr)
    return levenshtein(t, o) / max(len(t), 1)


def table_cells(text: str) -> list[str]:
    """`|`-delimited cells in a transcript line, for table exactness."""
    return [c.strip() for c in re.findall(r"\|([^|]+)\|", text) if c.strip()]


def cell_exactness(truth: str, ocr: str) -> float | None:
    cells = table_cells(truth)
    if not cells:
        return None
    flat = re.sub(r"\s+", " ", ocr)
    hits = sum(1 for c in cells if re.sub(r"\s+", " ", c) in flat)
    return hits / len(cells)


def page_count(pdf: Path) -> int:
    out = subprocess.run(
        ["pdfinfo", str(pdf)], capture_output=True, text=True, check=True
    ).stdout
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    return int(m.group(1))


def text_layer(pdf: Path, page: int) -> str:
    out = subprocess.run(
        ["pdftotext", "-f", str(page), "-l", str(page), str(pdf), "-"],
        capture_output=True,
        text=True,
    )
    return out.stdout if out.returncode == 0 else ""


def truth_for(truth_dir: Path, pdf: Path, page: int) -> dict | None:
    for cand in (truth_dir / f"{pdf.stem}.json",):
        if cand.exists():
            for row in json.loads(cand.read_text()):
                if row.get("page") == page:
                    return row
    return None


def rasterize(pdf: Path, page: int, dpi: int, out: Path) -> Path:
    subprocess.run(
        [
            "pdftoppm",
            "-f", str(page), "-l", str(page),
            "-r", str(dpi), "-png", "-singlefile",
            str(pdf), str(out),
        ],
        check=True,
        capture_output=True,
    )
    return out.with_suffix(".png")


def run_engine(engine: str, image: Path, env: dict[str, str]) -> dict:
    attrs, script = ENGINES[engine]
    runner = HERE / "engines" / script
    if engine in ("indra", "lighton"):
        cmd = [env["VENV_PYTHON"], str(runner), str(image)]
    else:
        cmd = ["nix", "shell", *attrs, "-c", "python3", str(runner), str(image)]
    start = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    ms = (time.perf_counter() - start) * 1000
    peak_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # Linux reports KiB, macOS bytes; normalise so results/ is comparable.
    if sys.platform == "darwin":
        peak_kb //= 1024
    # ru_maxrss is cumulative per-waited child: report the max so far as an
    # upper bound — good enough for the comparison this makes.
    try:
        line = proc.stdout.strip().splitlines()[-1]
        result = json.loads(line)
    except (IndexError, json.JSONDecodeError):
        return {
            "ok": False,
            "ms": ms,
            "peak_kb": peak_kb,
            "stderr": proc.stderr[-500:],
        }
    result.update(ok=True, ms=ms, peak_kb=peak_kb)
    return result


def iter_pages(corpus: Path, sample: int | None):
    rows = []
    for group in sorted(p for p in corpus.iterdir() if p.is_dir()):
        for pdf in sorted(group.glob("*.pdf")):
            for page in range(1, page_count(pdf) + 1):
                rows.append((group.name, pdf, page))
    if sample:
        # Stratified sample: round-robin across groups keeps the mix.
        rows = sorted(rows, key=lambda r: (hash(r[1].stem) % sample, r[1].name))[:sample]
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=ENGINES)
    ap.add_argument("--corpus", type=Path, default=HERE / "corpus")
    ap.add_argument("--truth", type=Path, default=HERE / "truth")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--sample", type=int, default=None)
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    out_path = args.out or HERE / "results" / f"{args.engine}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    if args.engine in ("indra", "lighton"):
        venv = os.environ.get("VENV_PYTHON", str(Path.home() / "venv/bin/python3"))
        env["VENV_PYTHON"] = venv

    rows = []
    stats = {"pages": 0, "text_layer": 0, "ocr": 0, "escalate": 0, "errors": 0,
             "ms_total": 0.0, "cers": [], "exactness": [], "peak_kb": 0}
    with tempfile.TemporaryDirectory() as tmp:
        for group, pdf, page in iter_pages(args.corpus, args.sample):
            rel = f"{group}/{pdf.name}"
            stats["pages"] += 1
            layer = text_layer(pdf, page)
            truth = truth_for(args.truth, pdf, page)
            row = {
                "group": group, "file": rel, "page": page,
                "path": "text-layer" if len(layer.strip()) >= TEXT_LAYER_MIN_CHARS else "ocr",
            }
            if row["path"] == "text-layer":
                stats["text_layer"] += 1
                row["text_chars"] = len(layer)
                if truth:
                    row["cer"] = cer(truth["text"], layer)
                    stats["cers"].append(row["cer"])
                rows.append(row)
                print(f"{rel} p{page}: text layer ({len(layer)} chars)", flush=True)
                continue

            stats["ocr"] += 1
            try:
                image = rasterize(pdf, page, args.dpi, Path(tmp) / f"p{stats['pages']}")
            except subprocess.CalledProcessError as e:
                row.update(ok=False, error=f"rasterize: {e.stderr[:200]}")
                stats["errors"] += 1
                rows.append(row)
                continue
            result = run_engine(args.engine, image, env)
            row.update(result)
            stats["ms_total"] += result["ms"]
            stats["peak_kb"] = max(stats["peak_kb"], result.get("peak_kb", 0))
            if not result.get("ok"):
                stats["errors"] += 1
                stats["escalate"] += 1
            else:
                conf = result.get("confidence")
                text = result.get("text", "")
                cells = result.get("cells") or 0
                if (
                    (conf is not None and conf < CONFIDENCE_FLOOR)
                    or (not text.strip())
                    or (truth and len(table_cells(truth["text"])) > TABLE_DENSE_CELLS)
                ):
                    row["escalate"] = True
                    stats["escalate"] += 1
                if truth:
                    row["cer"] = cer(truth["text"], text)
                    stats["cers"].append(row["cer"])
                    ex = cell_exactness(truth["text"], text)
                    if ex is not None:
                        row["cell_exactness"] = ex
                        stats["exactness"].append(ex)
            rows.append(row)
            print(
                f"{rel} p{page}: {result['ms']:.0f} ms"
                + (f", cer {row['cer']:.3f}" if "cer" in row else "")
                + (" [escalate]" if row.get("escalate") else ""),
                flush=True,
            )

    stats["escalation_rate"] = stats["escalate"] / max(stats["ocr"], 1)
    stats["ms_per_page"] = stats["ms_total"] / max(stats["ocr"], 1)
    stats["cer_mean"] = sum(stats["cers"]) / max(len(stats["cers"]), 1)
    stats["cell_exactness"] = (
        sum(stats["exactness"]) / max(len(stats["exactness"]), 1)
        if stats["exactness"] else None
    )
    stats.pop("cers")
    stats.pop("exactness")

    out_path.write_text(json.dumps({"engine": args.engine, "stats": stats, "pages": rows}, indent=2))
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
