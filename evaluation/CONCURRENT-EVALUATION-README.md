# 同時検知評価の実装と再実行

2026-10-08。設計の本体は [CONCURRENT-DETECTION-DESIGN.md](CONCURRENT-DETECTION-DESIGN.md)。評価結果は別報告書に記載する。

## 実行

リポジトリのルートで実行する。

```powershell
npm run evaluate:concurrent -- --dry-run
npm run evaluate:concurrent -- --smoke
npm run evaluate:concurrent -- --pilot
npm run evaluate:concurrent -- --main --interval=100 --paired
python evaluation/src/concurrent-report.py evaluation/results/<実行ディレクトリ>
python evaluation/src/concurrent-diagnostics.py evaluation/results/<実行ディレクトリ>
python evaluation/src/concurrent-writeup.py evaluation/results/<実行ディレクトリ>
```

本評価のintervalは予備実験後の選定記録に従う。50/100/200に対応。結果ディレクトリはタイムスタンプとUUIDで毎回新規作成し、以前の結果を上書きしない。reportの再実行は同ディレクトリの派生集計・図だけを更新する。

smokeは2対象者・1対照者・2サービス・各2セッション、ウォームアップ1回＋本測定1回。pilotは登録60人・10サービス、人数1/10/50と観測間隔0/50/100/200の12条件、ウォームアップ各1回＋測定各3回で計48バースト。mainは確認あり5条件×各30回＝150バーストに、`--paired`で確認なしの同数の比較条件を追加し、本測定300バースト＋ウォームアップ30回を実施する。両条件の同一ブロック・反復・人数では同じ対象利用者集合を使い、実行順はランダム化する。

## 設計から具体化した点

- 通知送信はコーディネータープロセスが担当する。計測中にDB照会・ファイル保存・初期化を行わず、負荷発行に専念する。Cookie観測は独立子プロセスなので、通知と観測のイベントループを分離するという目的は維持している。別のload-workerファイルは作成しない。
- 各サービスの初期化・スナップショットは子プロセスのIPCで行う。外部向けcontrol APIを追加しない。失効と認証確認は既存HTTPプロトコルを使用する。
- サービスはSQLiteファイルを使用し、既存のresearch-siteスキーマ・ハッシュ照合リポジトリ・失効ハンドラを再利用する。前回の単一セッションのメモリfixtureとは条件が異なる。
- 観測期限は共通開始予定時刻から30秒。通知ごとの発行時刻と送信幅を保存し、各人の所要時間の起点はその通知発行時刻とする。
- 対象外の固定対照者は全セッションを1秒間隔で巡回対象にする。処理が短ければ計測中の対象外観測は0件になる。全員について直前・終了後のHTTPと終了時DBを照合する。
- HTTP観測間隔は前回応答完了から次の予定時刻まで。リクエスト開始間隔はRTTと待ち行列を含むため、設定値と同じではない。遅れを埋める追い付き送信はしない。
- 生ログは関連付けの確実性のため、試行ごとのtrial.jsonにまとめる。通知・観測・時計同期・前後確認・サービス記録・管理スナップショットを含む。生Cookieは保存しない。
- managerは毎試行新規起動し、新規DBで評価する。サービスはブロック単位で再起動する。health等の接続準備はするが、管理から各サービスへの失効通信や初回失効処理のウォームアップはしていない。したがって「新規起動管理サーバーに対する初回の検知バースト」を評価しており、長時間稼働後の性能とは区別する。
- コード内のウォームアップ区分は、評価系・サービスの慣らしを本集計から除外するためのもの。試行ごとに管理プロセスを再起動するので管理のcold startは除去されない。

## 指標と解釈

管理応答時間は通知発行からレスポンス読取完了まで。保護到達時間は全対象Cookieの401を確認するまでの観測上限。最後の200の要求開始と最初の401の応答終了から、保守的な区間を作る。時計の変換誤差を外側に加える。

時計変換は、観測子プロセスとのIPCを試行前後に各20往復し、最小RTTサンプルからオフセットを推定する。区間には前後の半RTTとオフセット差の合計を加える。これは測定手順に基づく不確かさで、OS全体の時刻同期を保証するものではない。

CPU時間は計測前後のプロセス累積値の差で、待機・観測中の活動を含む。RSS/heapは前後の標本であり、ピーク値でもサービス群を含む総量でもない。

観測間隔0の条件は計測中のCookie確認なし。終了後に拒否を確認しても、その時刻を保護到達時間として補わない。管理が成功でも観測期限内に401を確認できなければ保護到達時間はnull。

利用者の測定値は同一バースト内で相関する。条件内の全利用者をまとめた平均・p95は記述統計としてのみ使い、独立反復数はバースト数で報告する。

## 検証

```powershell
npx tsc --noEmit -p tsconfig.json
npx eslint evaluation/src/concurrent-*.ts tests/concurrent-evaluation.test.ts
npx vitest run tests/concurrent-evaluation.test.ts tests/invalidation-orchestration-phase9.test.ts tests/session-revocation-phase8.test.ts tests/detection-notification-phase7.test.ts tests/mapping-registration-phase6.test.ts --maxWorkers=1
```

Python集計は保存されたHTTP生ログとSQLiteファイルを読み、計測値を再計算する。対象・対象外の状態、管理ジョブの利用者対応、要求記録と変更件数、ランナーの集計値との整合を照合する。予期しない失敗は削除せず、完了率やエラーとして結果に残す。実行が完了していない場合は部分集計を保存して非ゼロ終了する。

サンドボックス内の実行でファイルrealpathや子プロセスの起動に失敗した場合、研究用データを書き換えて回避せず、実行権限を持つローカル環境で再実行する。最初の起動失敗ディレクトリは未完了記録として残す。

## 2026-10-08の実行結果

[研究結果の要約](CONCURRENT-EVALUATION-REPORT.md)と
[詳細報告](results/concurrent-main-2026-10-07T21-19-58-377Z-cf5fa4/RESEARCH-REPORT.md)を参照。
本測定300回＋ウォームアップ30回の独立照合は完了。終了時のCookie確認に通信・読取エラーが22件あった1試行を含め、すべて保存・集計している。
現行のエラーログは例外名のみなので、その22件の根本原因は特定できない。今後この現象を調べる場合はcauseやソケット情報の記録を追加する必要がある。
