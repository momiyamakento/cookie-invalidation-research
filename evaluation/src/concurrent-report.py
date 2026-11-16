"""Independently recompute concurrent evaluation results from HTTP logs and SQLite.

Usage: python evaluation/src/concurrent-report.py RESULT_DIRECTORY
No third-party dependency for validation/CSV; matplotlib is used for figures.
"""
import csv
import json
import math
import sqlite3
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def stats(values):
    x = sorted(v for v in values if v is not None)
    return dict(n=len(x), mean=statistics.mean(x) if x else None,
                median=statistics.median(x) if x else None,
                p95=x[math.ceil(.95 * len(x)) - 1] if x else None,
                max=max(x) if x else None)


def sql(path, query):
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query)]


def close(a, b):
    return a is None and b is None or a is not None and b is not None and abs(a - b) < 1e-6


def validate_trial(path, config):
    t = json.loads(path.read_text(encoding="utf-8"))
    sessions = {s["sessionId"]: s for s in t["sessions"]}
    expected_size = config["population"] * config["serviceCount"] * 2
    assert len(sessions) == expected_size, "Session count mismatch"
    assert all("cookie" not in s for s in sessions.values()), "Raw cookie persisted"
    targets = set(t["targets"])
    notifications = {n["principalId"]: n for n in t["notifications"]}
    assert len(notifications) == t["condition"]["count"] == len(targets)
    assert set(notifications) == targets
    assert len({n["eventId"] for n in notifications.values()}) == len(targets)
    pre = {p["sessionId"]: p for p in t["preflight"]}
    final = {p["sessionId"]: p for p in t["final"]}
    assert set(pre) == set(final) == set(sessions)
    assert all(pre[sid]["status"] == 200 and pre[sid]["localUserId"] == s["localUserId"] for sid, s in sessions.items())
    events = sql(path.parent / "manager.sqlite", "SELECT * FROM detection_events")
    jobs = sql(path.parent / "manager.sqlite", "SELECT * FROM invalidation_jobs")
    assert sorted(events, key=lambda x: x["event_id"]) == sorted(t["events"], key=lambda x: x["event_id"])
    assert sorted(jobs, key=lambda x: x["id"]) == sorted(t["jobs"], key=lambda x: x["id"])
    grouped = defaultdict(list)
    for p in t["probes"]:
        assert p["sessionId"] in sessions
        assert p["end"] >= p["start"]
        grouped[p["sessionId"]].append(p)
    db_states = {}
    service_duration = []
    extra_attempts = 0
    for service in t["serviceRecords"]:
        rows = sql(path.parent / (service["serviceId"] + ".sqlite"), "SELECT id,user_id,status FROM sessions ORDER BY id")
        assert rows == service["sessions"]
        db_states.update({r["id"]: r["status"] for r in rows})
        actual_requests = sql(path.parent / (service["serviceId"] + ".sqlite"), "SELECT * FROM invalidation_requests")
        unique_success = {r["requestId"] for r in service["records"] if r["kind"] == "success"}
        assert unique_success == {r["request_id"] for r in actual_requests}
        assert sum(r["changed"] for r in service["records"]) == sum(r["revoked_count"] for r in actual_requests)
        assert sum(r["changed"] for r in service["records"]) == sum(r["status"] == "REVOKED" for r in rows)
        service_duration.extend(r["durationMs"] for r in service["records"])
        extra_attempts += len(service["records"]) - len({r["requestId"] for r in service["records"]})
    assert set(db_states) == set(sessions)
    target_final_denied = sum(final[sid]["status"] == 401 for sid, s in sessions.items() if s["principalId"] in targets)
    control_revoked = sum(db_states[sid] == "REVOKED" for sid, s in sessions.items() if s["principalId"] not in targets)
    control_denied = sum(final[sid]["status"] == 401 for sid, s in sessions.items() if s["principalId"] not in targets)
    control_errors = sum(final[sid]["status"] != 200 for sid, s in sessions.items() if s["principalId"] not in targets)
    wrong_identity = sum(p["status"] == 200 and p["localUserId"] != sessions[p["sessionId"]]["localUserId"] for p in t["probes"] + t["final"])
    final_correct = all(final[sid]["status"] == (401 if s["principalId"] in targets else 200) and
                        (s["principalId"] in targets or final[sid]["localUserId"] == s["localUserId"]) for sid, s in sessions.items())
    db_correct = all(db_states[sid] == ("REVOKED" if s["principalId"] in targets else "ACTIVE") for sid, s in sessions.items())
    assert final_correct == t["finalCorrect"] and db_correct == t["dbCorrect"]
    users = []
    observed_session_count = 0
    intervals = []
    for pid, n in notifications.items():
        own = [s for s in sessions.values() if s["principalId"] == pid]
        assert len(own) == config["serviceCount"] * 2
        bounds = []
        for s in own:
            rows = sorted((p for p in grouped[s["sessionId"]] if n["start"] <= p["end"] <= t["deadline"]), key=lambda p: p["start"])
            denied = next((p for p in rows if p["status"] == 401), None)
            success = [p for p in rows if p["status"] == 200 and (denied is None or p["start"] < denied["start"])]
            lower = max(n["start"], success[-1]["start"] if success else n["start"])
            upper = denied["end"] if denied else None
            observed_session_count += upper is not None
            bounds.append((lower, upper))
            intervals.extend(b["start"] - a["start"] for a, b in zip(rows, rows[1:]))
        complete = all(hi is not None for _, hi in bounds) and t["condition"]["pollMs"] > 0
        upper = max(hi for _, hi in bounds) - n["start"] if complete else None
        lower = max(0, max(lo for lo, _ in bounds) - n["start"] - t["clockUncertaintyMs"]) if complete else None
        ci_upper = upper + t["clockUncertaintyMs"] if complete else None
        original = next(u for u in t["users"] if u["principalId"] == pid)
        assert close(original["protectedMs"], upper) and close(original["lowerMs"], lower) and close(original["upperMs"], ci_upper)
        expected_pairs = {(s["serviceId"], s["localUserId"]) for s in own}
        ejobs = [j for j in jobs if j["event_id"] == n["eventId"]]
        eevent = next((e for e in events if e["event_id"] == n["eventId"]), None)
        pairs_ok = {(j["target_service_id"], j["target_local_user_id"]) for j in ejobs} == expected_pairs
        manager_ok = bool(eevent and eevent["principal_id"] == pid and eevent["status"] == "SUCCESS" and pairs_ok and len(ejobs) == config["serviceCount"]
                          and all(j["status"] == "SUCCESS" and j["revoked_count"] == 2 for j in ejobs))
        body = n["body"] if isinstance(n["body"], dict) else {}
        response_ok = n["status"] == 201 and body.get("eventId") == n["eventId"] and body.get("principalId") == pid and body.get("status") == "SUCCESS"
        response_ok = response_ok and {(x["serviceId"], x["localUserId"]) for x in body.get("targets", [])} == expected_pairs
        response_ok = response_ok and len(body.get("targets", [])) == config["serviceCount"] and all(x.get("status") == "SUCCESS" and x.get("revokedCount") == 2 for x in body.get("targets", []))
        users.append(dict(trialId=t["trialId"], block=t["block"], phase=t["phase"], count=t["condition"]["count"], pollMs=t["condition"]["pollMs"],
                          principalId=pid, protectedMs=upper, lowerMs=lower, upperMs=ci_upper, widthMs=ci_upper-lower if complete else None,
                          responseMs=n["end"]-n["start"], managerOK=manager_ok, responseOK=response_ok,
                          finalDenied=all(final[s["sessionId"]]["status"] == 401 for s in own)))
    return dict(trialId=t["trialId"], block=t["block"], repetition=t["repetition"], phase=t["phase"], **t["condition"], users=users,
                finalCorrect=final_correct, dbCorrect=db_correct, targetFinalDenied=target_final_denied,
                targetSessions=len(targets)*config["serviceCount"]*2, controlRevoked=control_revoked, controlDenied=control_denied,
                controlErrors=control_errors, wrongIdentity=wrong_identity, observedSessions=observed_session_count,
                observedControls=sum(sessions[p["sessionId"]]["principalId"] not in targets for p in t["probes"]),
                controlProbeDenials=sum(p["status"] == 401 and sessions[p["sessionId"]]["principalId"] not in targets for p in t["probes"]),
                sendWidthMs=max(n["start"] for n in notifications.values())-min(n["start"] for n in notifications.values()),
                clockUncertaintyMs=t["clockUncertaintyMs"], probeIntervals=stats(intervals),
                probeLag=stats([max(0,p["start"]-p["due"]) for p in t["probes"]]), extraAttempts=extra_attempts,
                cpuMs=(t["afterMetrics"]["cpuUserMicros"]+t["afterMetrics"]["cpuSystemMicros"]-t["beforeMetrics"]["cpuUserMicros"]-t["beforeMetrics"]["cpuSystemMicros"])/1000,
                serviceDuration=stats(service_duration), probeErrors=sum(p["status"] not in (200,401) for p in t["probes"]),
                reversedSessions=sum(any(p["status"]==401 for p in grouped[sid]) and final[sid]["status"]==200 for sid in sessions))


def main(directory):
    root = Path(directory).resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    config = manifest["config"]
    trials = [validate_trial(path, config) for path in sorted(root.glob("b*-r*-n*-p*/trial.json"))]
    expected = config["blocks"]*(config["repetitions"]+1)*len(config["counts"])*len(config["intervals"])
    complete = (root / "completed.json").exists() and len(trials) == expected
    measured = [t for t in trials if t["phase"] == "measurement"]
    groups = defaultdict(list)
    for t in measured:
        groups[t["count"], t["pollMs"]].append(t)
    conditions = []
    for (count, poll), rows in sorted(groups.items()):
        users = [u for t in rows for u in t["users"]]
        conditions.append(dict(count=count, pollMs=poll, trials=len(rows), users=len(users),
            observedComplete=sum(u["protectedMs"] is not None for u in users), finalComplete=sum(u["finalDenied"] for u in users),
            managerComplete=sum(u["managerOK"] for u in users), responseComplete=sum(u["responseOK"] for u in users),
            targetFinalDenied=sum(t["targetFinalDenied"] for t in rows), targetSessions=sum(t["targetSessions"] for t in rows),
            controlRevoked=sum(t["controlRevoked"] for t in rows), controlErrors=sum(t["controlErrors"] for t in rows),
            wrongIdentity=sum(t["wrongIdentity"] for t in rows), extraAttempts=sum(t["extraAttempts"] for t in rows),
            probeErrors=sum(t["probeErrors"] for t in rows), controlProbeDenials=sum(t["controlProbeDenials"] for t in rows),
            reversedSessions=sum(t["reversedSessions"] for t in rows),
            protection=stats([u["protectedMs"] for u in users]), response=stats([u["responseMs"] for u in users]),
            width=stats([u["widthMs"] for u in users]), sendWidth=stats([t["sendWidthMs"] for t in rows]),
            clock=stats([t["clockUncertaintyMs"] for t in rows]), cpu=stats([t["cpuMs"] for t in rows]),
            trialMedian=stats([stats([u["protectedMs"] for u in t["users"]])["median"] for t in rows]),
            trialMaximum=stats([stats([u["protectedMs"] for u in t["users"]])["max"] for t in rows]),
            blocks=[dict(block=b, protection=stats([u["protectedMs"] for t in rows if t["block"]==b for u in t["users"]]),
                         response=stats([u["responseMs"] for t in rows if t["block"]==b for u in t["users"]])) for b in sorted({t["block"] for t in rows})]))
    pairs = []
    for t in measured:
        if t["pollMs"] == 0: continue
        reference = next((r for r in measured if r["pollMs"]==0 and r["block"]==t["block"] and r["repetition"]==t["repetition"] and r["count"]==t["count"]), None)
        if reference:
            pairs.append(dict(block=t["block"], repetition=t["repetition"], count=t["count"], pollMs=t["pollMs"],
                              responseDeltaMs=statistics.mean(u["responseMs"] for u in t["users"])-statistics.mean(u["responseMs"] for u in reference["users"])))
    result = dict(complete=complete, verifiedTrials=len(trials), expectedTrials=expected, measuredTrials=len(measured), conditions=conditions, pairedResponses=pairs, trials=trials)
    (root/"summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    users = [u for t in measured for u in t["users"]]
    if users:
        with (root/"users.csv").open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=list(users[0])); writer.writeheader(); writer.writerows(users)
    lines = ["# 同時検知評価：独立再集計", "", f"検証済み試行：{len(trials)}/{expected}（本測定 {len(measured)}）。実行完了：{complete}", "",
             "時間はms。Cookieの拒否時間はHTTPで観測した上限値であり、実際の失効時刻そのものではない。p95は利用者データをまとめた経験分位点。", "",
             "|人数|観測間隔|試行数|観測完了/通知数|最終拒否/通知数|拒否観測平均|拒否観測p95|管理応答平均|区間幅平均|送信幅平均|",
             "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    def fmt(value): return "—" if value is None else f"{value:.1f}"
    for c in conditions:
        lines.append(f"|{c['count']}|{c['pollMs']}|{c['trials']}|{c['observedComplete']}/{c['users']}|{c['finalComplete']}/{c['users']}|{fmt(c['protection']['mean'])}|{fmt(c['protection']['p95'])}|{fmt(c['response']['mean'])}|{fmt(c['width']['mean'])}|{fmt(c['sendWidth']['mean'])}|")
    lines.extend(["", "観測間隔0は計測中のCookie観測なし。最終拒否は期限後の確認を含むので、期限内完了とは区別する。", "",
                  f"対象外DB失効：{sum(t['controlRevoked'] for t in measured)}、対象外最終確認エラー：{sum(t['controlErrors'] for t in measured)}、返却利用者の不一致：{sum(t['wrongIdentity'] for t in measured)}。",
                  f"追加の失効要求受付：{sum(t['extraAttempts'] for t in measured)}、観測エラー：{sum(t['probeErrors'] for t in measured)}。", "",
                  "試行を反復単位とする。ブロック別分布、各試行の中央値・最大値、時計誤差、実観測間隔はsummary.jsonに保存。ローカルPCの共有資源を含む結果で、継続到着負荷の最大処理能力ではない。"])
    (root/"REPORT.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.rcParams.update({"font.size": 10})
        if config["mode"] == "main":
            fig, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
            for c in conditions:
                own = [u for u in users if u["count"]==c["count"] and u["pollMs"]==c["pollMs"]]
                valid = [u for u in own if u["protectedMs"] is not None]
                if valid:
                    lo = statistics.mean(u["lowerMs"] for u in valid); hi=statistics.mean(u["upperMs"] for u in valid)
                    mid = (lo+hi)/2
                    axes[0,0].errorbar(c["count"], mid, yerr=[[mid-lo],[hi-mid]], fmt="o", color="#245e91", capsize=5)
                if c["pollMs"] > 0:
                    axes[1,0].bar(str(c["count"]), 100*c["observedComplete"]/c["users"], color="#245e91")
            for poll in sorted({c["pollMs"] for c in conditions}):
                rows = [c for c in conditions if c["pollMs"]==poll]
                label = "No in-run probes" if poll==0 else f"Probes: {poll} ms"
                axes[0,1].plot([c["count"] for c in rows], [c["response"]["mean"] for c in rows], "o-", label=label)
                axes[1,1].plot([c["count"] for c in rows], [c["sendWidth"]["mean"] for c in rows], "o-", label=label)
            axes[0,1].legend(); axes[1,1].legend()
            axes[0,0].set(title="Mean bounds on protection time (not confidence intervals)", ylabel="ms")
            axes[0,1].set(title="Mean management response time", ylabel="ms")
            axes[1,0].set(title="Observed user protection completion", ylabel="%", ylim=(0,105))
            axes[1,1].set(title="Mean notification launch spread", ylabel="ms")
            for ax in axes.flat: ax.set_xlabel("Users per burst"); ax.grid(alpha=.2)
        else:
            fig, axes = plt.subplots(1,2,figsize=(12,4), constrained_layout=True)
            for count in sorted({c["count"] for c in conditions}):
                rows = [c for c in conditions if c["count"]==count]
                axes[0].plot([c["pollMs"] for c in rows], [c["response"]["mean"] for c in rows], "o-", label=f"N={count}")
                timed=[c for c in rows if c["width"]["mean"] is not None]
                axes[1].plot([c["pollMs"] for c in timed], [c["width"]["mean"] for c in timed], "o-", label=f"N={count}")
            axes[0].set(title="Observer sensitivity", xlabel="Probe interval (0 = disabled)", ylabel="Mean management response (ms)")
            axes[1].set(title="Measurement resolution", xlabel="Probe interval (ms)", ylabel="Mean observation bracket width (ms)")
            for ax in axes: ax.legend(); ax.grid(alpha=.2)
        fig.savefig(root/"overview.png", dpi=160); fig.savefig(root/"overview.pdf"); plt.close(fig)
    except ImportError:
        print("matplotlib unavailable; data validation/CSV/report completed without figures")
    print(json.dumps({"complete": complete, "verifiedTrials": len(trials), "conditions": conditions}, ensure_ascii=False))
    if not complete: raise SystemExit("Run incomplete: partial summary retained")


if __name__ == "__main__":
    main(sys.argv[1])
