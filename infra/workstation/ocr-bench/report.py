#!/usr/bin/env python3
"""Render results/*.json as the markdown table the layer ships (README)."""
import json
import sys
from pathlib import Path

def main() -> int:
    results = Path(sys.argv[1] if len(sys.argv) > 1 else "results")
    rows = []
    for f in sorted(results.glob("*.json")):
        r = json.loads(f.read_text())
        s = r["stats"]
        rows.append((r["engine"], s))
    if not rows:
        print("no results", file=sys.stderr)
        return 1

    print("| engine | pages | ocr'd | text-layer | ms/page | peak RSS | CER | cell exact | escalation |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, s in rows:
        peak = f"{s['peak_kb']/1024:.0f} MB" if s.get("peak_kb") else "—"
        cer = f"{s['cer_mean']:.3f}" if s.get("cer_mean") is not None else "—"
        ex = f"{s['cell_exactness']:.2f}" if s.get("cell_exactness") is not None else "—"
        esc = f"{s['escalation_rate']:.1%}"
        ms = f"{s['ms_per_page']:.0f}"
        print(f"| {name} | {s['pages']} | {s['ocr']} | {s['text_layer']} | {ms} | {peak} | {cer} | {ex} | {esc} |")
    return 0

if __name__ == "__main__":
    sys.exit(main())
