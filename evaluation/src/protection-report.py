"""Independently validate protection-evaluation raw records and produce a report.

Usage: python evaluation/src/protection-report.py <completed-result-directory>
Only completed runs are accepted. Old research outputs are never overwritten.
"""
from pathlib import Path
import csv
import hashlib
import json
import math
import statistics
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone


def stats(values):
    values = sorted(values)
    if not values:
        return dict(n=0, mean=None, median=None, p95=None, min=None, max=None)
    return dict(n=len(values), mean=statistics.mean(values), median=statistics.median(values),
                p95=values[math.ceil(len(values) * .95) - 1], min=values[0], max=values[-1])


def check_stats(actual, expected):
    assert set(actual) == set(expected)
    for key, value in expected.items():
        assert actual[key] is None if value is None else math.isclose(actual[key], value, rel_tol=1e-10, abs_tol=1e-8), (key, actual, expected)


def main():
    directory = Path(sys.argv[1]).resolve()
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest["smoke"]:
        raise ValueError("Research report requires a full run; smoke data must not be reported as 30-trial evidence.")
    saved = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    trials = [json.loads(line) for line in (directory / "trials.jsonl").read_text(encoding="utf-8").splitlines()]
    config = manifest["config"]
    assert config == saved["config"]
    count = config["serviceCount"]
    conditions = config["conditions"]
    measured = [t for t in trials if t["phase"] == "measurement"]
    expected_measured = config["blocks"] * config["measuredPerConditionPerBlock"] * len(conditions)
    assert len(measured) == expected_measured
    assert len(trials) == expected_measured + config["blocks"] * len(conditions)
    assert len({t["eventId"] for t in trials}) == len(trials)
    group_counts = Counter((t["block"], t["repetition"], t["condition"]["name"]) for t in trials)
    expected_keys = {(b, r, c["name"]) for b in range(1, config["blocks"] + 1)
                     for r in range(config["measuredPerConditionPerBlock"] + 1) for c in conditions}
    assert set(group_counts) == expected_keys and all(n == 1 for n in group_counts.values())
    # Reconstruct the preregistered shuffle and verify the exact condition order.
    rng = config["seed"]
    expected_order = []
    for _block in range(config["blocks"]):
        for _repetition in range(config["measuredPerConditionPerBlock"] + 1):
            order = [c["name"] for c in conditions]
            for i in range(len(order) - 1, 0, -1):
                rng = (rng * 1664525 + 1013904223) & 0xffffffff
                j = int(rng / 2**32 * (i + 1))
                order[i], order[j] = order[j], order[i]
            expected_order.extend(order)
    assert [t["condition"]["name"] for t in trials] == expected_order
    rows = []
    for t in trials:
        assert t["phase"] == ("warmup" if t["repetition"] == 0 else "measurement")
        assert t["expected"] and t["condition"] in conditions
        assert len(t["services"]) == count
        assert len({s["serviceId"] for s in t["services"]}) == count
        assert math.isfinite(t["completionMs"]) and t["completionMs"] > 0
        for index, s in enumerate(t["services"], 1):
            mode = t["condition"]["faultMode"] if index in t["condition"]["faulty"] else "healthy"
            assert s["serviceId"] == f"benchmark-{index:03}"
            assert s["faulty"] == (index in t["condition"]["faulty"])
            assert s["mode"] == mode and s["state"]["mode"] == mode
            expected_revoked = mode != "before"
            assert s["state"]["active"] == (not expected_revoked)
            assert s["state"]["attempts"] == (1 if mode == "healthy" else 3)
            assert s["state"]["mutations"] == int(expected_revoked)
            assert s["state"]["uniqueRequests"] == int(expected_revoked)
            assert s["target"]["serviceId"] == s["serviceId"]
            assert s["target"]["status"] == ("SUCCESS" if mode == "healthy" else "FAILED")
            assert s["target"]["httpStatus"] == (200 if mode == "healthy" else None)
            assert s["target"]["revokedCount"] == (1 if mode == "healthy" else None)
            assert s["finalStatus"] == (401 if expected_revoked else 200)
            probes = s["probes"]
            assert probes[-1]["status"] == s["finalStatus"]
            assert probes[-1]["startMs"] >= t["completionMs"]
            previous_end = 0
            seen_denied = False
            for p in probes:
                assert p["status"] in (200, 401)
                assert 0 <= previous_end <= p["startMs"] <= p["endMs"]
                assert math.isfinite(p["endMs"])
                previous_end = p["endMs"]
                if seen_denied:
                    assert p["status"] == 401, "Session became usable again"
                seen_denied |= p["status"] == 401
            first = next((p for p in probes if p["status"] == 401), None)
            assert s["deniedMs"] == (first["endMs"] if first else None)
            earlier = [p for p in probes if p["status"] == 200 and (not first or p["startMs"] < first["startMs"])]
            lower = earlier[-1]["startMs"] if earlier else 0
            assert s["bracketLowerMs"] == lower
            assert s["bracketWidthMs"] == (first["endMs"] - lower if first else None)
            rows.append(dict(block=t["block"], repetition=t["repetition"], phase=t["phase"],
                             condition=t["condition"]["name"], eventId=t["eventId"], serviceId=s["serviceId"],
                             mode=mode, deniedMs=s["deniedMs"], bracketLowerMs=lower, bracketWidthMs=s["bracketWidthMs"],
                             managerStatus=s["target"]["status"], finalHttpStatus=s["finalStatus"],
                             attempts=s["state"]["attempts"], mutations=s["state"]["mutations"]))
        healthy = [s["deniedMs"] for s in t["services"] if not s["faulty"]]
        all_values = [s["deniedMs"] for s in t["services"]]
        assert t["healthyProtectedMs"] == max(healthy)
        assert t["allProtectedMs"] == (None if None in all_values else max(all_values))
    summary = {}
    for entry in saved["summary"]:
        name = entry["condition"]["name"]
        sample = [t for t in measured if t["condition"]["name"] == name]
        assert entry["trials"] == entry["expectedTrials"] == len(sample)
        for key in ("completionMs", "healthyProtectedMs", "allProtectedMs"):
            check_stats(entry[key], stats([t[key] for t in sample if t[key] is not None]))
        check_stats(entry["probeBracketMs"], stats([s["bracketWidthMs"] for t in sample for s in t["services"] if s["bracketWidthMs"] is not None]))
        assert entry["managerFailures"] == sum(s["target"]["status"] == "FAILED" for t in sample for s in t["services"])
        assert entry["failedButRevoked"] == sum(s["target"]["status"] == "FAILED" and s["finalStatus"] == 401 for t in sample for s in t["services"])
        assert entry["stillUsable"] == sum(s["finalStatus"] == 200 for t in sample for s in t["services"])
        for block in entry["blocks"]:
            for key in ("completionMs", "healthyProtectedMs"):
                check_stats(block[key], stats([t[key] for t in sample if t["block"] == block["block"] and t[key] is not None]))
        summary[name] = entry
    assert set(summary) == {c["name"] for c in conditions}
    # Keep the exact implementation associated with the manifest, without copying runtime secrets.
    repo = Path(__file__).resolve().parents[2]
    for source, expected_hash in manifest["hashes"].items():
        content = (repo / source).read_bytes()
        assert hashlib.sha256(content).hexdigest() == expected_hash, f"Source changed: {source}"
        destination = directory / "source-snapshot" / f"{source}.txt"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    with (directory / "service-observations.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    with (directory / "trial-summary.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=["block", "repetition", "phase", "condition", "completionMs", "healthyProtectedMs", "allProtectedMs"])
        writer.writeheader()
        writer.writerows({**{k: t[k] for k in ["block", "repetition", "phase", "completionMs", "healthyProtectedMs", "allProtectedMs"]}, "condition": t["condition"]["name"]} for t in trials)
    validation = dict(passed=True, totalTrials=len(trials), measuredTrials=len(measured),
                      serviceChecks=len(rows), probeResponses=sum(len(s["probes"]) for t in trials for s in t["services"]),
                      checks=["sample counts and seeded execution order", "cookie state versus manager classification",
                              "retry counts and idempotent mutation", "monotonic HTTP probe traces and denial bounds",
                              "independent recomputation of every condition/block statistic", "source SHA-256"],
                      rawSha256=hashlib.sha256((directory / "trials.jsonl").read_bytes()).hexdigest())
    (directory / "verification.json").write_text(json.dumps(validation, indent=2), encoding="utf-8")
    plot(directory, measured, conditions)
    report(directory, manifest, summary, validation, measured)
    print(json.dumps(validation, indent=2))
    print(directory / "研究結果_障害下の保護到達時間.md")


def plot(directory, measured, conditions):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    names = [c["name"] for c in conditions]
    labels = ["Healthy / parallel", "Healthy / sequential", "Pre-revoke stall: first / parallel",
              "Pre-revoke stall: first / sequential", "Pre-revoke stall: last / sequential",
              "Pre-revoke stalls: 3 / parallel", "Post-revoke stall: first / parallel"]
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.3), sharey=True)
    for ax, key, title in zip(axes, ["healthyProtectedMs", "completionMs"],
                              ["Healthy-service protection (observed)", "Manager response completion"]):
        for i, name in enumerate(names):
            values = [t[key] for t in measured if t["condition"]["name"] == name]
            ys = [i + ((j % 10) - 4.5) * .035 for j in range(len(values))]
            ax.scatter(values, ys, s=14, alpha=.55, color="#2468a0")
            ax.plot([statistics.median(values)], [i], marker="|", color="#c44832", markersize=18, markeredgewidth=2)
        ax.set_xscale("log")
        ax.set_xlim(8, 9000)
        ax.set_xlabel("Elapsed time from detection POST (ms, log scale)")
        ax.set_title(title)
        ax.grid(axis="x", alpha=.2, which="both")
    axes[0].set_yticks(range(len(labels)), labels)
    axes[0].invert_yaxis()
    fig.suptitle("10 independent service processes | 30 measurements per condition", fontsize=13)
    fig.text(.5, .015, "Each dot is one trial; red tick = median. Warm-ups excluded. Protection times are polling upper observations.", ha="center", fontsize=9)
    fig.tight_layout(rect=(0, .04, 1, .95))
    fig.savefig(directory / "protection-times.png", dpi=180)
    fig.savefig(directory / "protection-times.pdf")
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(11, 5.2))
    categories = [("SUCCESS + denied", "#24856a", lambda s: s["target"]["status"] == "SUCCESS" and s["finalStatus"] == 401),
                  ("FAILED + denied", "#d89526", lambda s: s["target"]["status"] == "FAILED" and s["finalStatus"] == 401),
                  ("FAILED + still usable", "#be4d50", lambda s: s["target"]["status"] == "FAILED" and s["finalStatus"] == 200)]
    left = [0.] * len(names)
    for label, color, predicate in categories:
        values = []
        for name in names:
            sample = [t for t in measured if t["condition"]["name"] == name]
            values.append(sum(predicate(s) for t in sample for s in t["services"]) / len(sample))
        ax.barh(range(len(names)), values, left=left, label=label, color=color)
        left = [a + b for a, b in zip(left, values)]
    ax.set_yticks(range(len(labels)), labels)
    ax.invert_yaxis()
    ax.set_xlim(0, 10)
    ax.set_xlabel("Services per trial (mean; observed counts identical across 30 trials)")
    ax.set_title("Manager classification versus actual old-cookie access")
    ax.legend(loc="upper center", bbox_to_anchor=(.5, -.15), ncol=3, frameon=False)
    fig.tight_layout()
    fig.savefig(directory / "outcome-consistency.png", dpi=180, bbox_inches="tight")
    fig.savefig(directory / "outcome-consistency.pdf", bbox_inches="tight")
    plt.close(fig)


def report(directory, manifest, summary, validation, measured):
    experiment_date = datetime.fromisoformat(manifest["startedAt"].replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=9)))
    japanese_date = f"{experiment_date.year}年{experiment_date.month}月{experiment_date.day}日"
    def link(name):
        return f"[{name}]({(directory / name).as_posix()})"
    def fmt(value):
        return "—" if value is None else f"{value:,.1f}"
    labels = {"healthy-parallel": "正常・並列", "healthy-sequential": "正常・逐次",
              "before-first-parallel": "失効前停止1件・先頭・並列", "before-first-sequential": "失効前停止1件・先頭・逐次",
              "before-last-sequential": "失効前停止1件・末尾・逐次", "before-three-parallel": "失効前停止3件・並列",
              "after-first-parallel": "失効後応答停止1件・並列"}
    hp = summary["healthy-parallel"]
    bp = summary["before-first-parallel"]
    bs = summary["before-first-sequential"]
    bl = summary["before-last-sequential"]
    bt = summary["before-three-parallel"]
    ap = summary["after-first-parallel"]
    ratio = bs["healthyProtectedMs"]["mean"] / bp["healthyProtectedMs"]["mean"]
    time_table = "\n".join(f"| {labels[name]} | {fmt(s['healthyProtectedMs']['mean'])} | {fmt(s['healthyProtectedMs']['median'])} | {fmt(s['healthyProtectedMs']['p95'])} | {fmt(s['completionMs']['mean'])} | {fmt(s['completionMs']['p95'])} |" for name, s in summary.items())
    outcomes = "\n".join(f"| {labels[name]} | {s['trials']} | {s['managerFailures']} | {s['failedButRevoked']} | {s['stillUsable']} |" for name, s in summary.items())
    blocks = "\n".join(f"| {labels[name]} | " + " | ".join(fmt(b['healthyProtectedMs']['mean']) for b in s['blocks']) + " |" for name, s in summary.items())
    widths = "\n".join(f"| {labels[name]} | {fmt(s['probeBracketMs']['median'])} | {fmt(s['probeBracketMs']['p95'])} | {fmt(s['probeBracketMs']['max'])} |" for name, s in summary.items())
    after_all = ap["allProtectedMs"]
    early = sum(t["healthyProtectedMs"] < t["completionMs"] for t in measured if t["condition"]["name"] == "before-first-parallel")
    env = manifest["environment"]
    text = f"""# 障害下における複数サービスの保護到達時間と応答整合性の評価

実施日：{japanese_date}（日本時間）。既存の研究システムに追加した評価機構によるローカル実験。

## 1. 結論

**正常サービスが旧Cookieを拒否するまでの時間と、管理サーバーが全体の処理結果を返すまでの時間は、障害時には大きく異なる。** 失効前に1サービスが応答しない条件で、並列方式の正常サービス保護到達時間は平均{fmt(bp['healthyProtectedMs']['mean'])} ms、管理応答完了は平均{fmt(bp['completionMs']['mean'])} msだった。正常サービスの保護到達が管理応答に先行した試行は{early}/30回だった。

同じ先頭障害を逐次方式で処理すると、正常サービスの保護到達は平均{fmt(bs['healthyProtectedMs']['mean'])} msになった。並列方式との平均値の比は約{ratio:.1f}倍だった。ただし、障害対象が末尾なら逐次方式でも平均{fmt(bl['healthyProtectedMs']['mean'])} msであり、**逐次方式の影響は対象の処理順序にも依存する。**

さらに、失効後に応答だけを停止した対象は、全30試行で管理側がFAILEDと判断した一方、保存済みCookieへのアクセスは401になった。**管理側の失敗判定は、実際にセッションが未失効であることと同義ではない。**

## 2. 今回追加した研究成果

既存研究の「全体失効処理の応答時間」「単一404障害」の評価に対し、次を追加した。

1. 正常サービスの保護到達時間と管理応答完了時間を分ける評価法。
2. 失効前停止と失効後の確認応答欠落を区別する障害注入機構。
3. サービスごとに独立したプロセスで、保存済みCookieのHTTPアクセス可否を測る評価システム。
4. 複数障害、方式比較、逐次処理の障害位置比較、再試行と冪等性の整合性確認。
5. 条件順のランダム化、ブロック反復、生データ保存、独立再集計による再現可能な結果。

これは本研究内の評価範囲の拡張である。手法一般の学術的新規性や、他研究に対する優位性を網羅的文献比較で確認したものではない。

## 3. 評価環境と条件

- OS：{env['platform']} {env['release']}、Node.js：{env['node']}。
- CPU：{env['cpu']}、論理CPU数：{env['logicalCpus']}、メモリ：{env['memoryBytes'] / 1024**3:.1f} GiB。
- 10サービス、各1利用者・1セッション。サービスは1プロセスずつ、管理サーバーも別プロセス。同一PCのlocalhost通信。
- サービスのセッション状態は評価用メモリ実装。管理サーバー・認証付きAPI・対応付け・失効クライアント・service-kitの要求検証は既存実装を使用した。
- 管理クライアントはタイムアウト1,500 ms、最大3回、再試行待ち300 ms。障害時の設定上の待ち時間は約5,100 ms。
- 7条件×30測定＝210測定。3ブロック×10回、各ブロック各条件1回のウォームアップを別途実施。全231試行。
- 各反復で7条件をseed 20261007で並べ替えた。試行間100 ms。外れ値除外なし。
- ブロックごとに管理プロセスとDBを更新し、サービス群は全ブロックで再利用した。各試行でCookieとセッション状態を初期化した。

失効前停止は認証済み要求に対してセッション状態を変更せず応答しない。失効後停止は状態を変更した後、再試行にも応答しない。保護ページへのアクセスはどちらでも継続可能とした。したがってホスト全停止やネットワーク分断そのものの実験ではない。

## 4. 測定指標

時刻原点は管理サーバーへ検知通知POSTを送る直前。**囮Cookieの使用・検知そのものは測定に含まない。**

- **正常サービス保護到達 T_healthy**：障害対象を除く全サービスで、旧Cookieに対する401を観測し終えるまでの時間。
- **全対象保護到達 T_all**：全サービスで401を観測し終えるまでの時間。拒否されない対象があれば欠測（null）。
- **管理応答完了 T_complete**：管理サーバーの最終応答JSONを受信し終えるまでの時間。
- **判定不一致**：管理側FAILEDだが、旧Cookieの最終アクセスが401である対象数。

各サービスへの観測はHTTP応答後20 ms待って繰り返す。T_healthy等はサーバー内の失効瞬間ではなく、HTTP観測による上側の値である。正常な場合にも観測の待ちによりT_healthyがT_completeより後になることがある。実際の観測間隔・区間幅を生データに記録した。

## 5. 処理時間の結果

単位：ms。p95はnearest-rank。各行30測定。

| 条件 | 保護到達・平均 | 保護到達・中央値 | 保護到達・p95 | 管理完了・平均 | 管理完了・p95 |
|---|---:|---:|---:|---:|---:|
{time_table}

![保護到達と管理応答完了の分布]({(directory / 'protection-times.png').as_posix()})

並列方式では失効前停止が1件の場合も3件の場合も、障害のない対象で401を確認できた。3件停止時の正常7サービスの保護到達は平均{fmt(bt['healthyProtectedMs']['mean'])} ms、管理応答完了は平均{fmt(bt['completionMs']['mean'])} msだった。この条件では複数のタイムアウト待ちが重なって進んでおり、正常サービスは全障害対象の終了を待たずに失効した。

正常・並列の保護到達は平均{fmt(hp['healthyProtectedMs']['mean'])} ms。障害条件との差は表のとおりだが、小さなミリ秒差を性能向上や悪化の一般則とは解釈しない。今回の主要な比較は、先頭障害を持つ逐次方式の秒単位の待ちと、正常サービスの早期失効の有無である。

## 6. 管理結果と実際のCookieの状態

件数は各条件30試行×10サービス＝300サービス観測の合計。

| 条件 | 試行数 | 管理FAILED | FAILEDだが401 | 最終アクセス200 |
|---|---:|---:|---:|---:|
{outcomes}

![管理結果とアクセス可否の対応]({(directory / 'outcome-consistency.png').as_posix()})

失効前停止の対象は観測終了時点でも旧Cookieが使用可能だった。そのため、障害対象を含むT_allは未到達としてnullを保存した。正常対象だけのT_healthyを「全サービス失効時間」と呼んではいけない。

失効後応答停止では、全対象の保護到達T_allは平均{fmt(after_all['mean'])} ms、p95 {fmt(after_all['p95'])} msだった。しかし管理サーバーは約5秒間再試行し、障害対象をFAILEDとして返した。各試行で障害対象の要求受信は3回、実際の状態変更は1回、一意のrequestIdは1件であることを検証した。

この結果は、管理側のFAILEDを利用者向けに「未失効」と断定して表示する際の注意点を示す。将来の状態照会や復旧後の確認の必要性を検討する根拠になるが、今回はその解決機構を実装・評価したわけではない。

## 7. 反復と測定の不確かさ

ブロック別の正常サービス保護到達時間の平均（各10試行、ms）。

| 条件 | ブロック1 | ブロック2 | ブロック3 |
|---|---:|---:|---:|
{blocks}

失効時刻の保守的区間は、最後に200となった要求の送信開始から、最初の401の受信完了までとした。最初から401なら下限はt0である。拒否を観測したサービスの区間幅（ms）は次のとおり。

| 条件 | 区間幅・中央値 | 区間幅・p95 | 区間幅・最大 |
|---|---:|---:|---:|
{widths}

区間幅は20 msに固定されない。HTTP往復・OSスケジューリング・観測処理を含む。数msの差の厳密な順位付けには適さない。ブロックは同一PC・同一実験セッション内の反復であり、異なる環境を独立にサンプリングしたものではない。統計的有意差は主張しない。

## 8. 検証

全{validation['totalTrials']}試行、{validation['serviceChecks']}サービス状態、{validation['probeResponses']:,}件のプローブ応答を独立したPythonスクリプトで検証した。測定数・seed付き実行順・状態遷移・再試行回数・冪等性・HTTP時刻順序・観測区間を確認し、全条件・全ブロックの統計値を生データから再計算してsummaryと照合した。主要ソースのSHA-256も照合した。

検証結果：{link('verification.json')}。予備実験は別ディレクトリで、本結果には含めない。

## 9. 限界と主張できる範囲

本実験から主張できるのは、**このローカル環境・10サービス・単一検知において、並列一括失効が応答停止対象の待ちと正常対象の保護到達を分離できたこと、および管理結果と実セッション状態が一致しないケースを実測したこと**である。

対象はメモリ上の単純な評価用セッションであり、既存のmedium/heavyのDB負荷や100サービス評価とは条件が異なる。実サービスのログイン実装、インターネット遅延、複数同時検知、通常アクセス負荷、障害復旧、自動再整合、囮の検知精度、実被害削減量は評価していない。観測HTTP自身が負荷を与えるため、観測のない処理速度とは同一視できない。401観測後に定期アクセスを停止するため、観測負荷の継続時間は条件ごとに異なる。またT_healthyの対象数は正常条件10、1件障害条件9、3件障害条件7であり、小さな最大値の差を同一対象数の比較として解釈してはいけない。障害対象の保護エンドポイントは稼働しており、サービス全体の停止とは異なる。

失効前に停止した対象をこの機構だけで強制失効できることは示していない。また、並列方式が全条件で逐次方式より速いという主張でもない。逐次方式の末尾障害という対照条件を含めたことで、処理順序への依存を確認した。

## 10. 論文に使える結果の記述案

> 提案機構の障害時特性を評価するため、失効処理前の応答停止と失効処理後の応答停止を注入し、管理サーバーの応答完了時間に加えて、保存済みCookieによるアクセス拒否をサービスごとに観測した。10サービス、7条件、各30試行の評価において、先頭の1サービスが失効前に応答を停止した場合、並列方式の正常サービス保護到達時間は平均{fmt(bp['healthyProtectedMs']['mean'])} ms、逐次方式では平均{fmt(bs['healthyProtectedMs']['mean'])} msであった。一方、並列方式の管理応答完了には平均{fmt(bp['completionMs']['mean'])} msを要した。この結果から、管理応答完了時間だけでは正常サービスの保護到達時点を表せないことを確認した。また、失効後に応答を停止した対象では、全30試行で管理側の失敗判定と実際のCookie拒否が併存し、失効状態と応答確認の成否を区別する必要性を示した。これらはローカルの評価用サービスにおける結果である。

## 11. 成果物と再実行

- {link('manifest.json')}：固定条件、実行環境、ソースハッシュ。
- {link('trials.jsonl')}：ウォームアップを含む全試行・全HTTP観測。
- {link('summary.csv')} / {link('summary.json')}：条件別集計。
- {link('trial-summary.csv')}：試行単位の時刻。
- {link('service-observations.csv')}：サービス単位の状態・時刻・再試行。
- {link('protection-times.pdf')} / {link('outcome-consistency.pdf')}：論文等に利用できる図。
- source-snapshot：実行時の主要ソースの検証済みコピー。型チェックの対象に混入しないようファイル名に.txtを付加している。

```powershell
npm run evaluate:protection -- --dry-run
npm run evaluate:protection -- --smoke
npm run evaluate:protection
python evaluation/src/protection-report.py <生成された結果ディレクトリ>
```

依存環境は既存プロジェクトのNode.jsとnpm依存、図生成にはPythonとmatplotlibを使う。研究本体や既存の結果ファイルは変更せず、新しい結果ディレクトリを生成する。
"""
    (directory / "研究結果_障害下の保護到達時間.md").write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
