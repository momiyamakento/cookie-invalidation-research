# 保護到達時間評価の実行ガイド

評価設計は [PROTECTION-EVALUATION-PLAN.md](C:/Cookie_KEN/cookie-invalidation-research/evaluation/PROTECTION-EVALUATION-PLAN.md) を参照。

2026年10月7日の本測定は完了。[研究結果報告](C:/Cookie_KEN/cookie-invalidation-research/evaluation/PROTECTION-EVALUATION-REPORT.md) と [生データ・図・検証結果](C:/Cookie_KEN/cookie-invalidation-research/evaluation/results/protection-2026-10-07T00-55-33-655Z-0f9468) を保存している。210測定＋21ウォームアップ、全2,310サービス状態・84,298件のHTTP観測の独立検証が通過。新規評価および既存失効API・管理処理の関連テスト82件、全workspaceの型チェック、新規TypeScriptのESLintも通過した。

## 追加したファイル

| ファイル | 役割 |
|---|---|
| evaluation/src/protection-cli.ts | 条件順制御、管理サーバー起動、CookieのHTTP観測、生データ・集計の保存 |
| evaluation/src/protection-worker.ts | 各サービスを独立した子プロセスで起動 |
| evaluation/src/protection-fixture.ts | 評価用セッション、失効前／失効後の応答停止、状態と要求回数の確認 |
| evaluation/src/protection-report.py | 生データの独立検証、CSV・図・日本語研究結果報告の生成 |
| tests/protection-evaluation.test.ts | 認証、Cookie失効、再試行、状態変更回数、制御APIのテスト |

## 実行手順

`C:/Cookie_KEN/cookie-invalidation-research` で実行する。

```powershell
# 条件を表示するだけ。サーバー起動・実験データ作成はしない。
npm run evaluate:protection -- --dry-run

# 全7条件を各1回とウォームアップで確認。
npm run evaluate:protection -- --smoke

# 本測定。7条件×30回、3ブロック。追加ウォームアップ21回。
npm run evaluate:protection

# 完了ログに出たディレクトリを指定。
python evaluation/src/protection-report.py <結果ディレクトリ>
```

本測定中は別の評価・テスト・高負荷処理の同時実行を避ける。Node.jsの既存依存関係を使う。報告生成にはPythonのmatplotlibが必要。サーバーはすべて127.0.0.1のOS割当ポートで起動する。実験終了時に子プロセスを停止する。既存のデモサーバーや研究DBには接続しない。

## 結果の扱い

- 新規 `evaluation/results/protection-日時-識別子` に保存する。旧結果を上書きしない。
- `manifest.json` は開始時、`trials.jsonl` は試行ごとに保存する。
- `summary.json` と `summary.csv` は全測定終了後に作成する。summaryがないディレクトリは完遂していない。
- 報告スクリプトは測定数、順序、状態、統計値、ソースハッシュを検証する。不一致では停止する。
- 検証通過後に `verification.json`、サービス／試行別CSV、グラフPNG/PDF、日本語Markdown報告、主要ソースのコピーを生成する。
- `--smoke` は本測定ではない。予備測定と本測定を混合しない。
- 途中停止の自動再開機能はない。エラー時には原因を確認し、新しいディレクトリで実験をやり直す。

## 指標を読む際の注意

「正常サービス保護到達」は障害対象を除く。「全対象保護到達」は失効を観測できない対象があるとnullになる。管理応答のFAILEDは旧Cookieが使用可能という意味とは限らない。これらを混同しない。

時間原点は管理サーバーへの通知送信であり、囮の検知時間を含まない。Cookie拒否はHTTPによる観測値で、ポーリング間隔とHTTP往復の影響を受ける。既存の100サービス・medium/heavy評価とは処理負荷と構成が異なるため、その値と直接比較しない。
