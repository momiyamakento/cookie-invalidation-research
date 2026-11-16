# 本実験評価ランナー 完了報告

2026-09-14。指定の縮小smoke testのみ実施。本番1260試行は未実行。

## 1. 実装内容

既存のbenchmark起動・登録・負荷・計測APIを使用する `evaluate:full` を追加した。A/B条件生成、順序制御、warm-up分離、試行単位保存、失敗保存、中断・再開、条件集計、グラフ生成に対応する。今回の操作入口はCLI。既存demo画面に本実験ランナーの操作は追加していない。

## 2. 新規ファイル

- `evaluation/src/full-types.ts`: 条件、試行、manifest、セッションの型。
- `evaluation/src/full-options.ts`: CLI引数検証、条件生成、seed付きシャッフル。
- `evaluation/src/full-session.ts`: 評価専用Management・benchmarkの起動、状態リセット、1試行の計測。
- `evaluation/src/full-statistics.ts`: サービス内分布、条件統計、CSVエスケープ。
- `evaluation/src/full-runner.ts`: 保存、ロック、preflight結果、環境情報、中断・再開、CSV。
- `evaluation/src/full-cli.ts`: CLI入口、停止シグナル、グラフ実行。
- `evaluation/src/full-graphs.py`: matplotlibによる本実験グラフ。
- `tests/full-evaluation.test.ts`: 本実験の条件・集計・失敗・再開テスト。
- 本報告書、smoke結果ディレクトリ、`evaluation/full-test-verification.log`。

## 3. 変更ファイル

`package.json` に `evaluate:full` を追加。`evaluation/src/benchmark-scale.ts` は既存の起動・計測ヘルパーにexportを付けただけで、既存CLIの処理は変更していない。READMEに利用案内を追加した。

Management Server、Site A/B/C/D、apps/demo、共通ライブラリ、負荷定義、Delay定義、囮Cookie、一括失効アルゴリズム、既存APIは変更していない。

## 4. Experiment A

サービス数1,5,10,20,50,100 × light,medium,heavy = 18条件。Service Delayは0ms固定。

## 5. Experiment B

サービス数1,5,10,20,50,100 × Delay 0,20,100ms = 18条件。Processing Loadはmedium固定。Aのmedium/0msとBのmedium/0msも別条件として保存する。

## 6. 1 trialの定義

状態リセット → Management資源値before取得 → 検知POST → Managementが並列失効を処理しJSON応答受信 → Management資源値after取得 → 結果検証 → 保存。

`invalidationCompletionTimeMs` は既存名称を維持。`performance.now()` を使い、検知POST呼び出し直前からfetch・レスポンスJSON取得終了までを測る。認証、通信、Managementの処理とDB処理、サービス失効、JSON受信を含む。リセット、before/after資源API取得、ファイル保存、cooldownはこの時間に含まない。

## 7. Warm-up

既定は条件ごとにwarm-up 5回、本計測30回。引数で変更可能。rawには両方残し、summaryは `phase=measurement` のみを使用する。再開で新しいプロセスを使う途中条件ではwarm-upを再実施し、`phase=rewarmup` とsegmentを記録する。追加warm-upも統計から除外する。

## 8. CPU / メモリ

Management別プロセスの既存 `/api/v1/evaluation/process-metrics` を使用する。

- `cpuUserMs`, `cpuSystemMs`: 累積CPU microsecondsのafter-beforeを1000で割った差分。既存方式どおり負値は0。CPU使用率ではない。
- `rssBeforeBytes`, `rssAfterBytes`: 失効前後のManagement RSSスナップショット。
- `heapUsedBeforeBytes`, `heapUsedAfterBytes`: 失効前後のManagement V8使用heapスナップショット。

資源値API自体と、その間にManagementで起きた処理・GCなどの影響を含み得る。CPU区間は壁時計のPOST区間と完全一致するわけではない。メモリはピーク値でも割当量でもない。benchmarkサービス・ランナーのCPU/メモリを合算していない。

## 9. サービス側時間

既存 `actualProcessingMs`, `measuredDelayMs`, `serviceProcessingMs` を使用する。各試行の各指標についてCount/Mean/Median/Min/Max/StdDev/P95をrawに保存。`serviceProcessingMs=actualProcessingMs+measuredDelayMs`。個別のrequestId/eventIdを含む元データは `service-timings.csv` と試行JSONにも残す。

条件summaryには、各試行のサービス平均の分布とサービス最大の分布を別々に保存する。例: `actualProcessingMsMeanMean` は「各trialのサービス平均をtrial間で平均」、`serviceProcessingMsMaxP95` は「各trialのサービス最大をtrial間でp95」。平均サービス時間を全体失効完了時間として扱わない。

取得されたhandler試行をすべて残す。期待サービス数とtiming数が異なる場合はTIMING_COUNTとして成功試行と区別する。既存Management内部の再送が発生した場合も観測を黙って削除しない。

## 10–11. 実行順とseed

sequentialはAのサービス数→負荷、続いてBのサービス数→Delay。randomizedは全選択条件をMulberry32とFisher–Yatesでシャッフルする。同じ条件リスト・並び・seedで同じ順序になる。既定seedは20260914。manifestのconditionsにexecutionOrderを保存し、試行にも転記する。再開は保存済みの順序を使用する。seedは実測時間そのものの再現を保証しない。

## 12. Cooldown

既定2000ms。条件のセッションを終了した後、次の条件へ進む前に待つ。温度やOS状態が一定になったことを保証する待機ではない。Service Delayと独立し、manifestのconfig.cooldownMsに保存する。最後の条件の後には待たない。

## 13. リセット範囲

各条件は新しいManagementプロセス・評価専用SQLite・benchmarkクラスタを使用する。各trialで以下をリセットする。

- lightのactive状態、medium/heavyのsessions/grantsのactive、users.revision、audit、サービスtiming配列。
- 今回のセッション専用SQLiteのinvalidation_jobs、detection_events。
- mappings/servicesはその条件用に一度だけ登録し、その後変更しない。

リセットは計測開始前。実験結果内のsessions以下にUUID付きで新規作成したDBだけを開く。研究本体のDB、既存結果、他の実験のDBは削除しない。通信タイムアウト等で前試行の完了が不明な場合は次のresetを行わず、プロセスを閉じて停止する。

## 14. Failure

応答が完了した部分失効失敗やtiming件数異常はraw/試行JSON/failures.csvに残し、次trialへ進む。環境・通信障害はfatalとして結果を保存して停止する。取得できなかった数値はnull（CSV空欄）で、架空の0を入れない。試行開始前の起動失敗等はmanifest.failureとrunner-failure.jsonに残す。

自動再試行で失敗を成功値に置換しない。summaryは全本計測の成功数・失敗数・成功率を示す。完全失効かつ計測エラーなしをsuccessfulTrialsとする。数値統計には失敗試行の取得可能な値も含め、指標別Countを併記する。外れ値は除去しない。母標準偏差（分母N）、nearest-rank p95（昇順ceil(0.95N)番目）を用いる。

## 15. Resume

trial前にmanifest.inflightを書き、終了後はrecords内の個別JSONを一時ファイル→sync→renameで保存する。その後manifestとCSVを更新する。個別JSONを正本として再開時に照合・CSV再構築する。

同じmeasurementのrecordIdは再実行しない。ハード中断でinflightだけが残った場合は結果不明のINTERRUPTED失敗を保存し、その測定枠を消費する。失敗も含め指定回数が保存された条件はcompleted扱い。再開時の追加warm-upは別IDになる。

Ctrl+C/SIGTERMは現在のtrialの保存後に停止する。OSによるプロセス強制終了などは次回resumeで復旧する。runner.lockで同一結果ディレクトリへの同時実行を拒否する。ロックの同一ホストPIDが消滅している場合だけ回収する。別結果ディレクトリの同時評価までは禁止していない。再開時の設定上書きは禁止し、条件・ID・loadModelVersionの整合性を検証する。

## 16–17. Manifest / environment

manifestにはschemaVersion、experimentId、全設定、具体的条件と順序、負荷モデル版、開始/終了時刻、status、segment、completedConditions、completedTrials、inflight、failureを記録する。

environmentにはOS/release/version、CPUモデル・論理数、総RAM、Node版、時刻、Git commit/branch/status、設定、負荷定義、シャッフル方式、測定範囲、統計定義を保存。resumeの環境は別environment-resume-N.json。取得不能値はnull。

今回の環境はWindows 10.0.26200、Intel Core i5-1135G7、論理8CPU、RAM 16,996,618,240 bytes、Node v24.14.0。branchはmaster、commitは取得できずnull。本番前にソースをcommitまたは別途保管し、環境情報と合わせて保存することを推奨する。

各条件開始時は引数・結果書き込み・Management起動/health/metrics・動的ポートbind・benchmark起動/登録を確認する。成功したpreflightは条件・segment・時刻とともに独立JSONに保存する。使用ポートはOS空きポートを選択するため、既存demo固定ポートに依存しない。

## 18. Raw CSV

基本列: experimentType, conditionId, executionOrder, serviceCount, loadProfile, serviceDelayMs, phase, trialNumber, recordId, segment, timestamp。

結果列: invalidationCompletionTimeMs, successCount, failureCount, allRevoked, cpuUserMs, cpuSystemMs, rssBeforeBytes, rssAfterBytes, heapUsedBeforeBytes, heapUsedAfterBytes, failureType, errorMessage, fatal, observedServiceAttempts。

サービス列: actualProcessingMs / measuredDelayMs / serviceProcessingMs に Count, Mean, Median, Min, Max, StdDev, P95 を付けた列。CSVの引用符、カンマ、改行をエスケープする。測定値は表示丸めを行わず保存する。

## 19. Summary CSV

条件列とtrialCount, successfulTrials, failedTrials, successRate（0〜1）。7つのシステム指標それぞれにCount, Mean, Median, Min, Max, StdDev, P95を付ける。サービス3指標は各trialのMean/Maxごとに同じ統計を付ける。未計測条件はtrialCount=0、数値統計は空欄。

## 20. 出力 / グラフ

各実験ディレクトリにmanifest/environment/records/sessionsを保存。experiment-a、experiment-bそれぞれにraw.csv、summary.csv、failures.csv、service-timings.csv、charts/source.csvを保存する。

Aのグラフは全体完了時間、CPU user、CPU system、RSS after、heap after（各負荷系列）。Bは全体完了時間（Delay系列）。横軸はサービス数、縦軸は条件平均。元summaryをcharts/source.csvとして残す。Python/matplotlib失敗時もCSV・JSONを保持しchart-status.jsonに記録する。

## 21. Smoke結果

結果: `evaluation/results/full-experiment-2026-09-14T00-30-39-357Z-7d00a041/`

randomized、seed=20260914、cooldown=2000ms。A:サービス1,5 × light,heavy。B:サービス1,5 × Delay0,20、medium固定。各warm-up1、本計測2。

| 実験 | 条件 | warm-up | 本計測 | 本計測成功 | 失敗 | PNG |
|---|---:|---:|---:|---:|---:|---:|
| A | 4 | 4 | 8 | 8 | 0 | 5 |
| B | 4 | 4 | 8 | 8 | 0 | 1 |

24試行すべて失効成功。CSV、summary、manifest、environment、サービス別記録、グラフ元CSV、6枚のPNGを確認。failure CSVはヘッダー付き空データ。失敗保存・継続・fatal停止・中断復旧はテストで障害を注入して検証した。実際のCLIで完了済み結果をresumeし、試行を追加せず再集計・グラフ再生成ができた。

この少数試行の時間値は動作確認用であり、卒論の本番値として採用しない。

## 22. 検証

`npm run typecheck` 成功（全workspace）。`npm run lint` 成功。全18ファイル・255テスト成功。既存benchmark引数・負荷・Management連携・demo dashboardも含む。実行ログは `evaluation/full-test-verification.log`。

条件A/B、sequential/randomized/seed、30試行の統計、warm-up除外、外れ値保持、失敗保存、fatal停止、中断/resume、重複防止、manifest/environment/raw/summary生成を検証した。

## 23–27. PowerShellコマンド

リポジトリルートで実行する。以下は利用者が本番実施を判断した後に使うコマンドであり、今回実行していない。

```powershell
Set-Location C:\Cookie_KEN\cookie-invalidation-research

# 23: Aのみ（18条件、630試行）
npm run evaluate:full -- --experiment processing --warmup 5 --trials 30 --order randomized --seed 20260914 --cooldown-ms 2000

# 24: Bのみ（18条件、630試行）
npm run evaluate:full -- --experiment delay --warmup 5 --trials 30 --order randomized --seed 20260914 --cooldown-ms 2000

# 25: 両方（36条件、1260試行。randomizedではA/Bも交互になり得る）
npm run evaluate:full -- --experiment all --warmup 5 --trials 30 --order randomized --seed 20260914 --cooldown-ms 2000

# 26: 計画だけを確認。サーバー起動・測定・結果作成はしない
npm run evaluate:full -- --experiment all --order randomized --seed 20260914 --dry-run

# 27: 実際の結果ディレクトリを指定して再開
npm run evaluate:full -- --resume "C:\Cookie_KEN\cookie-invalidation-research\evaluation\results\full-experiment-2026-09-14T00-30-39-357Z-7d00a041"
```

最後の例は完了済みsmoke結果なので本計測は増えない。本番では本番結果のディレクトリに置き換える。resume時はtrials等を追加指定しない。dry-runの回数表示は計画全体であり、resumeの残り回数ではない。

## 28. 本番前の注意

- 他のbenchmark、demoからの評価、重い処理を同時に走らせない。電源・省電力設定・バックグラウンド負荷を揃える。
- `npm run typecheck`、`npm run lint`、`npm test` とdry-runを確認し、Python/matplotlibを使用可能にする。Node v22以上・既存依存関係が必要。
- 結果ディレクトリ全体と評価ソースを保管する。途中で評価ソースや依存版を変更した状態でのresumeは避ける。loadModelVersion以外の全ソース差分までは自動拒否していない。
- benchmarkは複数の独立マシンではなく、ランナーの同一Nodeイベントループにある。同期DB処理は直列化され、非同期Delayは重なり得る。この構成を論文の実験条件に明記する。
- CPUはManagementのみ、RSS/heapは前後値、p95は30点のnearest-rank。成功率・各指標の有効Count・失敗内容も時間グラフと合わせて確認する。
- 中断後はfresh processで追加warm-upするためsegmentが異なる。割り込み試行は失敗枠として残り、必ず30成功を集める仕組みではない。
- `completed` は予定測定枠の保存完了を意味し、全試行成功を保証しない。グラフ失敗はchart-status.jsonを確認する。

本番は利用者の確認後に実施する。
