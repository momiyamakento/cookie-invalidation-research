"""Render figures from preserved condition summaries; no raw observations removed."""
import csv
import pathlib
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = pathlib.Path(sys.argv[1])
for experiment in ("a", "b"):
    folder = root / f"experiment-{experiment}" / "charts"
    with (folder / "source.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    group = "loadProfile" if experiment == "a" else "serviceDelayMs"
    metrics = [("invalidationCompletionTimeMs", "Completion time (ms)")]
    if experiment == "a":
        metrics += [("cpuUserMs", "Management user CPU (ms)"), ("cpuSystemMs", "Management system CPU (ms)"), ("rssAfterBytes", "Management RSS after (bytes)"), ("heapUsedAfterBytes", "Management heap after (bytes)")]
    for metric, label in metrics:
        fig, ax = plt.subplots(figsize=(8, 5))
        plotted = False
        for value in sorted({row[group] for row in rows}):
            points = sorted([row for row in rows if row[group] == value and row.get(metric+"Mean")], key=lambda row: int(row["serviceCount"]))
            if points:
                ax.plot([int(row["serviceCount"]) for row in points], [float(row[metric+"Mean"]) for row in points], marker="o", label=value)
                plotted = True
        if plotted:
            ax.set(xlabel="Service count", ylabel=label, title=f"Experiment {experiment.upper()} (measurement trials, available observations)")
            ax.grid(alpha=.3)
            ax.legend(title=group)
            fig.tight_layout()
            fig.savefig(folder / f"{metric}.png", dpi=180)
        plt.close(fig)
