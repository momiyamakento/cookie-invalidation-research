# サービス側失効負荷の評価：実装・検証報告

2026-09-13 JST。Node.js v24.14.0 / Windows。同一PCで条件を順次実行。

## 現状確認と今回の変更

開始時点で3負荷条件、SQLite負荷、環境変数とCLI、サービス別時間CSV、summary、並列失効テストは存在していた。既存実装を維持し、実処理と意図的待機の個別計測を補完した。LIGHTの未知ユーザー要求がセッションを失効する問題を修正し、全条件を404で統一した。

サービス生成は `startBenchmarkCluster` が連番ID benchmark-001～benchmark-100とExpressサーバーを作る。評価ランナーはOS割当ポートで起動し、Managementの `/api/v1/benchmark-services` にURLと同一principalへのmappingを登録する。失効APIは `/internal/v1/sessions/revoke`、認証は既存のサービス別導出Bearer token。レスポンス仕様は変更していない。

## ファイル一覧（今回の作業）

新規:
- `evaluation/LOAD-PROFILE-REPORT.md`（本報告）
- 後述の3結果ディレクトリ（CSV、summary、グラフ、評価DB）と `phase-load-*.log`（検証ログ）

変更:
- `evaluation/src/benchmark-load.ts`: SQLiteトランザクションと待機の個別計測。既存revoke戻り値は維持。
- `evaluation/src/benchmark-services.ts`: 内訳をサービス時間ログに追記。LIGHTの利用者確認。
- `evaluation/src/benchmark-scale.ts`: 実処理と実測待機のsummary統計を追加。
- `tests/benchmark-load.test.ts`: 内訳の整合性確認と未知利用者の回帰テスト3件。
- `README.md`: SQL回数・時間定義・利用者確認の説明。

開始時点からリポジトリのソース一式がgit上で未追跡だったため、git差分を今回の変更一覧として扱っていない。apps/demo、Site A/B/C/D、Management、共通ライブラリは今回編集していない。

## 負荷条件

| 項目 | LIGHT | MEDIUM | HEAVY |
|---|---|---|---|
| 対象確認・失効 | 利用者ID確認とメモリフラグ更新 | SQLite利用者・セッション検索と状態更新 | 同左 |
| DB SELECT | 0 | 4 | 34 |
| DB書き込み | 0 | 3 | 33 |
| 監査INSERT（書き込みに含む） | 0 | 1 | 16 |
| 監査・revision処理反復 | 0 | 1 | 16 |
| 意図的待機 | 0ms | 20ms | 100ms |
| 共通成功ログ | 1回 | 1回 | 1回 |

正常要求あたりの回数。BEGIN/COMMIT、初期化、試行前リセットはSQL回数から除外。
MEDIUMは利用者検索、セッション検索・更新後、監査保存、revision更新、利用者再検索、監査件数検索を実行する。HEAVYは後半4操作を16回実行する。各サービス独立のSQLite :memory: DBを使い、1要求をIMMEDIATEトランザクションで処理する。待機はcommit後の非同期タイマーで、乱数やbusy waitは使わない。

実処理の増加と固定待機で再現可能な合成条件を作る。実サービス全般を忠実に再現したものではない。差の大部分は固定待機に由来する。メモリDBのためディスク永続化I/Oは測らない。

## 実行方法（PowerShell）

```powershell
Set-Location C:\Cookie_KEN\cookie-invalidation-research
npm run evaluate:benchmark -- --service-counts 1 --load-profile light --warmup 2 --trials 5
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --warmup 2 --trials 5
npm run evaluate:benchmark -- --service-counts 1 --load-profile heavy --warmup 2 --trials 5
```

`SERVICE_LOAD_PROFILE` 環境変数も使用可能。CLIが優先、省略時はlight。既定のサービス数は1,5,10,20,50,100、warm-up 5回、本試行30回。Managementとbenchmarkの起動・登録・終了は自動。通常のstart:allは不要。

## 計測・出力

- `processingDurationMs`: 認証・入力検証後の失効ハンドラー開始から完了まで。DB処理と意図的待機を含む。HTTPレスポンス生成と共通ログ出力は含まない。
- `actualWorkMs`: SQLiteトランザクション開始直前から終了直後まで。LIGHTは利用者確認とフラグ処理。
- `intentionalDelayMs`: 設定待機時間。未知ユーザーは全条件0。
- `observedDelayMs`: commit完了からタイマー復帰までの実測。OS・イベントループの遅延を含む。
- `receivedAt`: Expressミドルウェア到達時の壁時計。他の相対時間はperformance.now()差分。
- `invalidationCompletionTimeMs`: ランナーがManagementへ検知POSTする直前から応答受信まで。ネットワーク・Management処理を含む全体時間。

サービス別値はservice-timings.csvの研究用ログに保存し、APIメタデータは追加しない。内訳3列は既存列の末尾に追加。raw.csvは既存のloadProfile列を含め維持。summaryにはserviceActualWorkMsとserviceObservedDelayMsを追加し、warm-upを除外して集計する。

CPU user/systemは別プロセスのManagementのprocess.cpuUsage()差分をmsに変換。RSSとheapUsedは失効前後のbyte値。benchmark側のCPUやメモリ使用量ではない。

## 実測結果

各負荷でサービス数1,5,10,20,50,100をwarm-up 2回＋測定5回で実行。1サービス時の結果（ms）:

| 負荷 | サービス平均 | 最小 | 最大 | 実処理平均 | 実測待機平均 | 全体時間平均 |
|---|---:|---:|---:|---:|---:|---:|
| LIGHT | 0.0062 | 0.0041 | 0.0086 | 0.0062 | 0 | 11.4960 |
| MEDIUM | 28.1590 | 23.2913 | 35.1424 | 0.1260 | 28.0135 | 38.8195 |
| HEAVY | 108.1285 | 105.1637 | 116.2074 | 0.2036 | 107.9131 | 116.0218 |

今回の5回では最小・最大の範囲も重ならず順序を確認。最終的な論文用評価ではなく実装確認である。

結果:
- LIGHT: `results/benchmark-scale-2026-09-13T04-20-42-665Z`
- MEDIUM: `results/benchmark-scale-2026-09-13T04-21-10-302Z`
- HEAVY: `results/benchmark-scale-2026-09-13T04-21-27-015Z`

## 検証結果・既存機能への影響

- npm test -- --reporter=dot: **16ファイル・238テスト成功**。初回はサンドボックスのspawn EPERMで未実行となり、権限を切り替えた再実行で成功。
- npm run typecheck、npm run lint: 成功。
- LIGHT起動、全条件の失効・計測、複数回の時間順序、全条件で5サービスのManagement並列失効をテスト。
- Site A/B/C/D、囮Cookie検知、共通ライブラリ、既存評価、デモの回帰テスト成功。デモには4サイトのログイン→検知→全失効→再実行も含む。ブラウザでの目視確認は今回実施していない。
- 全18条件×7試行＝126回の評価完了、全サービス失効成功。サービス要求合計3906件。
- 各条件ファイルのraw.csv 42行、service-timings.csv 1302行（いずれもヘッダー除外）を確認。HTTP 200、成功数、負荷ラベル、warm-up除外後の件数、サービス時間・実処理・実測待機の平均とsummaryの一致、各4グラフの生成を確認。

## 制約と次Phase

benchmarkとランナーは同じNodeプロセス・イベントループを共有する。同期SQLite処理は直列化され、非同期待機は重なる。サービス時間を全体時間から単純に引いてManagement単体時間とはみなせない。LIGHTへの計測・対象確認の追加により過去値との厳密比較は再測定が必要。

次Phaseでは既存CLIを呼ぶマトリクスランナーを追加する。1/5/10/20/50/100×3負荷×30回等を設定化し、実行順のバランス化、失敗・timeout記録、再開・再試行管理、条件別集約CSV・グラフ・信頼区間を実装する。サービス独立プロセスやファイルDBは別の実験条件として追加し、現在の条件と混在させない。
