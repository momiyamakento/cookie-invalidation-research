"""Read CSV only; write plots exclusively into the new verification directory."""
import csv
import pathlib
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = pathlib.Path(sys.argv[1])
for filename, output in [("graph-source.csv", "overall-completion.png"), ("comparison-source.csv", "comparison.png")]:
    with (root / filename).open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    fig, ax = plt.subplots(figsize=(9, 5))
    for series in sorted({r.get("series", "Zero Delay Verification") for r in rows}):
        points = sorted([r for r in rows if r.get("series", "Zero Delay Verification") == series and r.get("invalidationCompletionTimeMsMean")], key=lambda r: int(r["serviceCount"]))
        if points:
            ax.plot([int(r["serviceCount"]) for r in points], [float(r["invalidationCompletionTimeMsMean"]) for r in points], marker="o", label=series)
    ax.set(xlabel="Service Count", ylabel="Overall completion time (ms)", title="MEDIUM / Delay 0 ms (measurement means)")
    ax.set_xticks(sorted({int(r["serviceCount"]) for r in rows}))
    ax.grid(alpha=.3)
    if ax.lines:
        ax.legend()
    fig.tight_layout()
    fig.savefig(root / "charts" / output, dpi=180)
    plt.close(fig)
