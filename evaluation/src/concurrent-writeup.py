"""Build the Japanese research write-up from an independently verified summary."""
import csv
import json
import sys
from pathlib import Path


def main(directory):
    root = Path(directory).resolve()
    data = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert data["complete"] and manifest["config"]["mode"] == "main", "Complete main results required"
    conditions = data["conditions"]
    measured = [t for t in data["trials"] if t["phase"] == "measurement"]
    counts = sorted({c["count"] for c in conditions})
    users = sum(c["users"] for c in conditions)
    observed = [c for c in conditions if c["pollMs"] > 0]
    reference = [c for c in conditions if c["pollMs"] == 0]
    def f(n): return "未到達" if n is None else f"{n:,.1f}"
    rows = []
    for c in conditions:
        flat = {k: v for k, v in c.items() if not isinstance(v, (list, dict))}
        for key, value in c.items():
            if isinstance(value, dict): flat.update({f"{key}_{k}": v for k, v in value.items()})
        rows.append(flat)
    with (root / "conditions.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    lines = [
        "# 複数利用者の同時検知に対する一括失効の評価結果", "",
        "実施日：2026-10-08（日本時間）", "",
        "## 結果の要点", "",
        f"本測定{data['measuredTrials']}バースト・{users:,}通知を評価した。確認あり条件の期限内の全対象Cookie拒否観測は{sum(c['observedComplete'] for c in observed):,}/{sum(c['users'] for c in observed):,}利用者試行、対象外DBの誤失効は{sum(c['controlRevoked'] for c in conditions)}件だった。終了時HTTP確認が期待どおりに完了しなかった試行は{sum(not t['finalCorrect'] for t in measured)}件で、詳細は例外の節に記載する。",
        "同時通知人数が増えるにつれて所要時間が増加した。50人条件では再試行が発生し、確認通信なしと確認ありで管理応答時間も異なった。観測通信の影響、実行順による変動、観測区間の幅を含めて解釈する必要がある。", "",
        "## 1. 評価の目的", "",
        "囮Cookieの使用が検知されたことを前提として、複数利用者の検知通知が集中した場合の一括失効の正確性と処理時間を評価した。通知された利用者の全既存セッションが利用できなくなることと、通知されていない利用者のセッションが維持されることを確認した。囮の使用確率・検知精度・実被害の削減量は評価していない。", "",
        "## 2. 実装と条件", "",
        "管理サーバーの既存の利用者対応付け・検知通知・並列失効処理を使用した。評価用サービスには既存のSQLiteスキーマ、セッションのハッシュ照合、利用者単位の失効ハンドラを使用し、1サービスにつき独立した子プロセスを起動した。管理サーバー、通知送信、Cookie観測もサービスとは別のプロセスで動作する。ただし、すべて同じPCのCPU・メモリ等を共有する。", "",
        "- 登録60人（通知対象候補50人＋固定対照10人）、各人10サービス、各サービス2セッション、計1,200セッションを毎試行準備。",
        "- 同時通知人数は1・5・10・20・50人。サービスごとに異なるlocalUserIdを使用。",
        "- Cookie確認あり（設定100 ms、同時確認上限32）と確認なしを比較。各条件30反復、3ブロック。",
        f"- 本測定{data['measuredTrials']}バースト、{users:,}件の検知通知。ウォームアップ{data['verifiedTrials']-data['measuredTrials']}バーストは別集計。",
        "- 管理サーバーは試行ごとに新規起動・新規DB。初回の失効通信・処理を含み、長時間稼働後の定常性能ではない。",
        "- 同一ブロック・反復・人数では両観測条件の対象者を揃え、条件順をランダム化。通知は応答を待たずに連続発行するバーストであり、完全な同時送信ではない。",
        "- サービスへのタイムアウト1,500 ms、最大3回、再試行間隔300 msは既存設定を維持。人工遅延・障害注入・新規ログインはなし。", "",
        f"環境：Node {manifest['environment']['node']}、OS {manifest['environment']['os']}、CPU {manifest['environment']['cpu']}。詳細な環境・ソースハッシュはmanifest.jsonに保存。", "",
        "## 3. 測定方法", "",
        "保護到達は、利用者ごとの通知送信から、その利用者の全20CookieがHTTPで401を返したことを観測するまでとした。最後の200リクエスト開始と最初の401応答完了から区間を求め、プロセス間のIPC時計校正の不確かさを加えた。表の『拒否観測時間』はその観測上限の点推定であり、実際の失効処理時刻そのものではない。", "",
        "管理応答時間は検知通知の送信から管理APIの応答読取完了まで。確認なし条件では終了後に全Cookieを確認するが、その時間から実際の保護到達時刻を推定しない。失効対象外を含む全セッションについて、直前・終了後のHTTP結果とDBを照合した。", "",
        "独立反復の単位はバースト。全利用者をまとめたp95は経験分位点（nearest rank）の記述統計であり、それぞれを独立試行とは扱わない。観測期限は共通開始予定から30秒。未到達は時間を補完しない。", "",
        "## 4. 正確性と完了率", "",
        "|指標|結果|", "|---|---:|",
        f"|期限内の利用者保護完了（確認あり）|{sum(c['observedComplete'] for c in observed):,}/{sum(c['users'] for c in observed):,}|",
        f"|終了後の全Cookie拒否確認（両条件）|{sum(c['finalComplete'] for c in conditions):,}/{users:,} 利用者|",
        f"|対象セッションの終了後拒否|{sum(c['targetFinalDenied'] for c in conditions):,}/{sum(c['targetSessions'] for c in conditions):,}|",
        f"|管理DBで全ジョブ成功・対象対応一致|{sum(c['managerComplete'] for c in conditions):,}/{users:,} 通知|",
        f"|管理HTTP応答の成功・対象対応一致|{sum(c['responseComplete'] for c in conditions):,}/{users:,} 通知|",
        f"|対象外DBの誤失効|{sum(c['controlRevoked'] for c in conditions):,}|",
        f"|対象外の終了後HTTP確認エラー|{sum(c['controlErrors'] for c in conditions):,}|",
        f"|認証時の返却利用者の不一致|{sum(c['wrongIdentity'] for c in conditions):,}|",
        f"|拒否観測後に終了確認で200へ戻ったセッション|{sum(c['reversedSessions'] for c in conditions):,}|", "",
        "対象外への影響は直前・終了後の確認とDBの状態から判定している。処理中の対象外確認は1秒周期なので、短い試行を含め、瞬間的にも常に利用可能だったとまでは主張しない。", "",
        "## 5. 時間の結果", "",
        "単位はms。全利用者の記述統計。『管理応答・確認なし』と『拒否観測・確認あり』は異なる測定条件なので、差を直接処理時間の内訳とみなさない。", "",
        "|同時通知人数|管理応答平均・確認なし|管理応答p95・確認なし|拒否観測平均・確認あり|拒否観測p95・確認あり|観測区間幅平均|",
        "|---:|---:|---:|---:|---:|---:|",
    ]
    for n in counts:
        a = next(c for c in reference if c["count"]==n)
        b = next(c for c in observed if c["count"]==n)
        lines.append(f"|{n}|{f(a['response']['mean'])}|{f(a['response']['p95'])}|{f(b['protection']['mean'])}|{f(b['protection']['p95'])}|{f(b['width']['mean'])}|")
    lines += ["", "![評価の概要](overview.png)", "",
              "図左上の縦線は平均観測区間であり、信頼区間ではない。点はその区間の中心で、表の拒否観測平均（上限側）とは異なる。設定100 msでも、多数のCookieを限られた並列数で巡回するため、実際の観測間隔や区間幅は100 msを超える。", "",
              "## 6. 観測負荷と再試行", "",
              "予備実験で確認通信が管理応答に影響する可能性が見つかったため、本測定に確認なし条件を追加した。確認ありの結果から一定値を引く補正は行っていない。", "",
              "|人数|管理応答平均・確認なし|管理応答平均・確認あり|追加受付数・確認なし|追加受付数・確認あり|",
              "|---:|---:|---:|---:|---:|"]
    for n in counts:
        a = next(c for c in reference if c["count"]==n); b = next(c for c in observed if c["count"]==n)
        lines.append(f"|{n}|{f(a['response']['mean'])}|{f(b['response']['mean'])}|{a['extraAttempts']}|{b['extraAttempts']}|")
    lines += ["", "追加受付数は、各サービスで観測された要求受付数からユニークrequestId数を引いた値である。管理側で試みたがサービスに到達しなかった再送は含まない。要求ログの変更件数とDBのREVOKED件数を照合し、再送の受付と実際の状態変更を区別した。", "",
              "再試行と長い管理応答が同時に観測されても、遅延の根本原因をCPU・DB・ソケット等の特定箇所に断定することはできない。現在のログが測るサービス処理時間には、ハンドラに到達する前の待ち時間が含まれないためである。", "",
              "## 7. ブロック間の変動", "",
              "各ブロック各条件10バースト。表は利用者データの平均で、確認ありの拒否観測時間を示す。", "",
              "|人数|ブロック1|ブロック2|ブロック3|", "|---:|---:|---:|---:|"]
    for c in observed:
        values = [f(b["protection"]["mean"]) for b in c["blocks"]]
        lines.append(f"|{c['count']}|"+"|".join(values)+"|")
    lines += ["", "![測定順と再試行](run-order.png)", "",
              "実行順による変動があるため、全体平均だけでは環境変動を表せない。サービスハンドラの所要時間にも変動があるが、その原因をCPU周波数・ディスク・キャッシュ等に特定する計測は行っていない。", "",
              "## 終了時HTTP確認の例外", ""]
    anomalies = []
    for t in measured:
        if t["finalCorrect"] and t["dbCorrect"]: continue
        raw = json.loads((root/t["trialId"]/"trial.json").read_text(encoding="utf-8"))
        ss = {s["sessionId"]: s for s in raw["sessions"]}; targets=set(raw["targets"])
        errors = [p for p in raw["final"] if p["status"] not in (200,401)]
        target_errors = sum(ss[p["sessionId"]]["principalId"] in targets for p in errors)
        affected = len({ss[p["sessionId"]]["principalId"] for p in errors if ss[p["sessionId"]]["principalId"] in targets})
        anomalies.append(dict(trialId=t["trialId"], targetErrors=target_errors, controlErrors=len(errors)-target_errors,
                              affectedTargetUsers=affected, errorNames=sorted({p["error"] for p in errors}), dbCorrect=t["dbCorrect"]))
        lines.append(f"- `{t['trialId']}`：終了時の再確認で対象Cookie {target_errors}件（{affected}人分）、対象外Cookie {len(errors)-target_errors}件の応答取得・読取が完了しなかった。保存されたエラー名は{sorted({p['error'] for p in errors})}。DB状態の一致は{t['dbCorrect']}。")
        lines.append(f"  計測中に401を観測した対象セッションは{t['observedSessions']}/{t['targetSessions']}。管理DBで対象対応と成功を確認した通知は{sum(u['managerOK'] for u in t['users'])}/{len(t['users'])}。拒否観測後に終了確認で200へ戻ったセッションは{t['reversedSessions']}件。")
    (root/"anomalies.json").write_text(json.dumps(anomalies, ensure_ascii=False, indent=2),encoding="utf-8")
    lines += ["", "管理DBとCookieのHTTP確認は分けて評価した。再確認で応答が得られなかったCookieの終了時HTTP状態は、DBの値で代用せず、未確認として残した。",
              "エラーの詳細なcauseやソケット情報は記録していないため、通信失敗の根本原因は特定できない。この試行を除外したり、再実行した結果で置き換えたりしていない。", ""]
    lines += ["", "## 8. 研究としての位置付けと限界", "",
              "今回の評価は、失効先のサービス数を増やす従来の評価に加え、検知通知を発生させる利用者数の増加を扱ったものである。固定の60利用者を登録したまま対象人数を変え、登録DBの大きさとバースト負荷を分離した。", "",
              "- 評価環境で観測した完了率・時間・誤失効の有無を示すもので、任意の実サービスへの一般的な保証ではない。",
              "- 50人は試した最大人数であり、システムの処理上限と確定した値ではない。継続到着負荷の最大スループットも測っていない。",
              "- 全プロセスが同じPCにある。性能低下を管理サーバー単独の限界とは呼ばない。",
              "- 確認ありの拒否観測時間には、確認通信自体の影響と確認待ちが含まれる。確認なし条件の実際の拒否時刻は未測定。",
              "- 新規起動の管理プロセスを用いる条件であり、定常状態への一般化はできない。",
              "- 単一利用者の検知重複、障害復旧、実際の囮使用からの時間、囮検知率は別課題。",
              "- 前回の単一セッション・メモリfixtureの結果と直接比較しない。", "",
              "## 9. 再現・生データ", "",
              "各試行ディレクトリのtrial.jsonに通知・Cookie確認・時計校正・管理結果・サービス処理の生記録を保存。各SQLiteファイルに終了時の状態を保存。Pythonの別実装が時間を再計算し、DB・管理API・Cookie拒否を照合した。", "",
              "- `manifest.json`：環境、条件、ソースハッシュ。`source-snapshot/`：測定時ソース。",
              "- `summary.json`：独立再集計、ブロック別集計、各試行、対応する参照試行との差。",
              "- `users.csv`、`conditions.csv`：利用者・条件別集計。",
              "- `overview.png`、`overview.pdf`：図。",
              "- `completed.json`：ランナーの正常終了記録。", "",
              "再実行方法・設計変更の詳細は evaluation/CONCURRENT-EVALUATION-README.md、条件確定記録は evaluation/CONCURRENT-MAIN-PROTOCOL.md を参照。"]
    text = "\n".join(lines)+"\n"
    (root / "RESEARCH-REPORT.md").write_text(text, encoding="utf-8")
    print(root / "RESEARCH-REPORT.md")
    print(json.dumps({"measuredTrials": len(measured), "notifications": users,
                      "observedProtected": sum(c["observedComplete"] for c in observed),
                      "targetFinalDenied": sum(c["targetFinalDenied"] for c in conditions)}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
