"""Run-order and retry diagnostics. Execute after acquisition has completed."""
import json
import statistics
import sys
from pathlib import Path


def main(directory):
    root = Path(directory).resolve()
    assert (root/"completed.json").exists(), "Wait for acquisition to finish"
    trials = sorted((json.loads(p.read_text(encoding="utf-8")) for p in root.glob("b*-r*-n*-p*/trial.json")), key=lambda t: t["origin"])
    rows = []
    for i, t in enumerate(trials, 1):
        notifications = t["notifications"]
        records = [r for s in t["serviceRecords"] for r in s["records"]]
        rows.append(dict(order=i, trialId=t["trialId"], phase=t["phase"], block=t["block"], count=t["condition"]["count"], pollMs=t["condition"]["pollMs"],
                         meanResponseMs=statistics.mean(n["end"]-n["start"] for n in notifications),
                         extraAttempts=len(records)-len({(s["serviceId"],r["requestId"]) for s in t["serviceRecords"] for r in s["records"]}),
                         meanServiceHandlerMs=statistics.mean(r["durationMs"] for r in records) if records else None,
                         sendWidthMs=t["sendWidthMs"], clockUncertaintyMs=t["clockUncertaintyMs"],
                         loopDelayMaxMs=t["loopDelayMaxMs"]))
    (root/"run-order.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2,2,figsize=(12,8),constrained_layout=True)
    measured = [r for r in rows if r["phase"] == "measurement"]
    for n in sorted({r["count"] for r in measured}):
        for poll in [0,100]:
            selected=[r for r in measured if r["count"]==n and r["pollMs"]==poll]
            if not selected: continue
            ax=axes[0,0 if poll==0 else 1]
            ax.plot([r["order"] for r in selected], [r["meanResponseMs"] for r in selected], "o-", ms=3, lw=.8,label=f"N={n}")
    axes[0,0].set(title="No in-run probes", ylabel="Mean manager response (ms)")
    axes[0,1].set(title="100 ms probes", ylabel="Mean manager response (ms)")
    for poll in [0,100]:
        selected=[r for r in measured if r["pollMs"]==poll]
        axes[1,0].scatter([r["order"] for r in selected], [r["extraAttempts"] for r in selected],s=12,label=f"probe={poll}")
        axes[1,1].scatter([r["order"] for r in selected], [r["meanServiceHandlerMs"] for r in selected],s=12,label=f"probe={poll}")
    axes[1,0].set(title="Repeated requests received by services", ylabel="Extra receipts per burst")
    axes[1,1].set(title="SQLite handler elapsed time (queueing excluded)", ylabel="Mean handler time (ms)")
    for ax in axes.flat:
        ax.set_xlabel("Execution order (including warm-ups)"); ax.grid(alpha=.2); ax.legend(fontsize=8)
        for b in sorted({r["block"] for r in rows})[1:]:
            ax.axvline(min(r["order"] for r in rows if r["block"]==b)-.5,color="gray",ls=":",lw=.8)
    fig.savefig(root/"run-order.png",dpi=160); fig.savefig(root/"run-order.pdf"); plt.close(fig)
    print(root/"run-order.png")


if __name__ == "__main__":
    main(sys.argv[1])
