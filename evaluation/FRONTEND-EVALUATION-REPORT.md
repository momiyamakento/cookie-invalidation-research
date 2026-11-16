# 性能評価フロントエンド 完了報告

2026-09-14。前回作成したExpress/EJS/Vanilla JavaScriptの実装を引き継ぎ、残っていた検証を実施。

## 再開時の確認と今回の作業

git statusではソース一式が未追跡で、git diffは空。前回のファイルを直接確認し、作り直していない。TODO/FIXMEなし。前回ログの型チェックは成功、全248テストは成功していたが、テストfinally内のthrowがlintに抵触していたため、安全なパス確認を残して修正した。

追加した確認は、不正パラメータ29ケースのHTTP拒否、固定結果ディレクトリ外の拒否、実在しない許可ファイルの404、パストラバーサル拒否、競合後の正常完了。既存テストは削除・無効化していない。

## 最終的なファイル一覧（前回からの機能追加全体）

新規:
- apps/demo/src/evaluation.ts — 条件検証、専用ワーカー、ジョブ状態とダウンロードAPI
- apps/demo/src/views/evaluation.ejs — 性能評価画面
- apps/demo/public/evaluation.js — 実行、状態表示、統計、履歴、比較、CSV保存
- apps/demo/public/evaluation.css — 性能評価画面のスタイル
- evaluation/src/demo-worker.ts — 既存runBenchmarkScaleを呼ぶ固定エントリーポイント
- tests/demo-evaluation.test.ts — 画面/API/競合/ファイル安全性のテスト
- evaluation/FRONTEND-EVALUATION-REPORT.md — 本報告
- evaluation/results内の実測出力と検証用JSON、frontend-*.log — 検証結果

変更:
- apps/demo/src/app.ts — 性能評価ルートと認証付きAPIを追加
- apps/demo/src/views/dashboard.ejs — 上部にモード切り替えを追加
- apps/demo/public/demo.css — モード切り替えスタイルのみ追加
- README.md — 起動、操作、API、制約の説明

今回の再開後はテスト補完と説明文書を編集。Management Server、Site A/B/C/D、共通ライブラリ、Cookie、benchmark失効ロジック、負荷・遅延の定義は編集していない。

## URLと学校での操作手順

- システムデモ: http://localhost:4200/demo
- 性能評価: http://localhost:4200/demo/evaluation

```powershell
Set-Location C:\Cookie_KEN\cookie-invalidation-research
npm run start:demo:all
```

起動後、システムデモを表示し、①初期状態に戻す → ②全サービスにログイン → ③4サイトのログインを確認 → ④囮Cookieを使用 → ⑤4/4失効を見せる。上部の「性能評価」を選び、条件を設定して「評価を開始」。完了後のカード・詳細統計・CSV保存を見せる。戻る場合は「システムデモ」を選ぶ。

学校ではLIGHT/1とLIGHT/10でサービス数比較を示し、次にMEDIUM/1＋20ms、HEAVY/1＋100msで実処理と待機が別の指標であることを示す。最後の2条件は負荷と遅延の両方が違うため、実処理量だけの比較には用いない。公平に負荷を比較する場合は3負荷ともdelay=0に揃える。

## 評価条件とAPI

受け付けるのはserviceCount、loadProfile、serviceDelayMs、warmup、trialsの5項目のみ。サービス数1/5/10/20/50/100、負荷light/medium/heavy、遅延0/20/100、warm-up整数0〜20、測定整数1〜100。余分な項目・文字列型数値・小数・範囲外・コマンド文字列・パス文字列を拒否。

- POST /demo/api/evaluations: 開始202、不正400、実行中409
- GET /demo/api/evaluations: 状態と最新30件の履歴
- GET /demo/api/evaluations/:id/files/:name: 完了したジョブのraw.csv/service-timings.csv/summary.jsonのみ

既存のX-Demo-Tokenを全APIで要求し、cross-siteも拒否。任意コマンド・任意パスは受け付けず、shellを介さない固定NodeワーカーからrunBenchmarkScaleを呼ぶ。既存npm run evaluate:benchmarkは引き続き利用可能。

## ブラウザからの実測（各1サービス、warm-up 2、測定10）

| 条件 | 実処理平均 | 実測待機平均 | サービス内合計平均 | 全体失効平均 | 成功/失敗 |
|---|---:|---:|---:|---:|---:|
| MEDIUM + 20ms | 0.1350 | 25.7037 | 25.8387 | 31.9384 | 10/0 |
| HEAVY + 100ms | 2.5917 | 108.6399 | 111.2316 | 122.8386 | 10/0 |

単位ms。成功数は測定サービス要求の合計であり、各試行では1/1成功。

MEDIUM結果: results/benchmark-scale-2026-09-14T00-06-04-022Z
HEAVY結果: results/benchmark-scale-2026-09-14T00-07-31-861Z

LIGHT/1、LIGHT/10は前回ブラウザで成功済み（平均全体6.0905ms、14.0623ms）。今回も競合確認後の再実行と比較確認に使用。

actualProcessingMsはハンドラーの実処理部分、measuredDelayMsは実処理後のタイマー待機。両者の和がserviceProcessingMs。全体失効時間はランナーの検知POST開始からManagement応答受信までで、計測範囲が異なる。タイマーにはOS等の超過が含まれる。平均・中央値・最小・最大・母標準偏差を表示し、warm-upは除外。画面表示は小数4桁に丸める。

## CSV保存と安全性

ブラウザの「CSVを保存」からMEDIUMのraw.csv、HEAVYのservice-timings.csvを保存。Downloads内の保存ファイルと元ファイルのSHA-256が一致した。APIのsummaryとディスクsummary、サービスCSVから再計算した平均も一致。ブラウザで確認した表示値はその小数4桁丸めと一致。

前回のdownloadイベント待ちtimeoutは自動操作ツールの通知捕捉の問題で、実際には保存されていた。今回も保存済みファイルで検証し、保存ロジック自体を不要に変更していない。

取得はサーバーが保持する完了ジョブIDと3種類のファイル名のみ。realpathで評価結果ルート内に限定。未完了・未知ID・非許可ファイル・../を含む名前・存在しないファイルは404。結果ルート外を返すワーカー結果は失敗として公開しない。

## 二重実行

実APIへ連続要求して202と409を確認。1件目は成功10/失敗0で完了し、2件目は開始されなかった。完了後にブラウザからLIGHT/10を開始できた。別タブの操作にもサーバーの同期ロックが適用される。

## UIと比較グラフ

1366×768と1920×1080で目視確認。横スクロールなしで条件入力と主要3指標を表示。詳細統計とCSV・履歴は下部へ配置。既存フォント・青/白/グレー・カード・余白を維持。

グラフはloadProfile、serviceDelayMs、warmup、trials、loadModelVersionが一致する完了結果のみ。同じサービス数は最新を採用。異なる負荷を一本の線で結ばない。1条件だけでは点で示す。

## 制約

履歴は同一demoプロセスの最新30件で再起動時に消えるがCSV/summaryは残る。進捗は実行中/完了/失敗のみで試行ごとの進捗・キャンセルは未実装。失敗時の部分統計は既存ランナーが返さないため表示しない。別途起動したCLIとの競合は防がない。Python/matplotlibも必要。共有イベントループ・メモリSQLiteの合成評価であり独立Webホストの完全な再現ではない。

## 最終検証結果・完成判断

- npm run typecheck: 成功
- npm run lint: 成功（前回のfinally内throwを修正）
- npm test -- --reporter=dot: 17ファイル・250テスト成功
- demo/benchmarkを個別指定: 5ファイル・36テスト成功（全250件の部分集合）
- npm run evaluate:benchmark -- --service-counts 1 --load-profile light --service-delay-ms 0 --warmup 0 --trials 1: 成功。結果はresults/benchmark-scale-2026-09-14T00-15-19-447Z。

ブラウザ回帰では初期化→Site A/B/C/Dのログイン中表示→囮Cookie使用を実施。TimelineにSite A検知09:12:07.904、Management受信09:12:07.919、SUCCESS完了09:12:08.230を確認。4サイトとも元のセッションで401、失効済み表示、4/4完了、全体311msを確認した。

比較確認ではLIGHT/1とLIGHT/10の2点・1本の線のみを確認（今回の平均5.8456ms、19.6045ms）。MEDIUM/HEAVYの履歴が存在してもLIGHTの線に混入しない。HEAVYの選択時は該当条件だけの1点になる。

**完成判断: 今回要求された性能評価フロントエンドは完成・検証済み。** 上記の履歴永続化、細かい進捗、キャンセル等は将来改善項目であり、今回の必須機能に未完了項目はない。
