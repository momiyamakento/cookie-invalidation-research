# Delay 0ms 再現性検証

## 実装内容

`npm run evaluate:zero-delay` を追加した。既存 `runFull` / `createFullSession` / 統計処理を使用し、測定区間、負荷、Delay、リセット、ManagementのCPU・メモリ取得方法を変えていない。追加実験には `experimentKind=zero-delay-verification`、`experimentType=Z`、独立したconditionIdを付ける。

| 設定 | 本番値 |
|---|---|
| Processing Load | medium固定 |
| Service Delay | 0ms固定 |
| Service Count | 1,5,10,20,50,100 |
| Warm-up / measurement | 条件ごと5 / 30 |
| 条件数 / warm-up数 / measurement数 / 合計 | 6 / 30 / 180 / 210 |
| Order / seed | randomized / 2026091402 |
| Cooldown / timeout | 2000ms / 15000ms（既存本実験の既定値） |

固定seedによる本番実行順は **1 → 50 → 100 → 20 → 10 → 5**。既存A/Bのseed 20260914とは異なる。負荷やseedなどの任意上書き引数は受け付けない。`--smoke` だけ明示的に1・5サービス、warm-up1、本計測2へ縮小する。

## 変更ファイル

新規:

- `evaluation/src/zero-delay-verification.ts`: 固定設定、引数、読み取り専用A/B比較、CSV読込。
- `evaluation/src/zero-delay-cli.ts`: dry-run、実行、停止、グラフ呼出し。
- `evaluation/src/zero-delay-graphs.py`: 平均全体時間と3系列比較のグラフ。
- `evaluation/src/safe-result-write.ts`: Windowsの一時的なファイル置換エラーへの対応。
- `tests/zero-delay-verification.test.ts`: 条件数、固定seed、EPERM、保存、失敗、再開、比較テスト。
- 本書と `evaluation/zero-verification-checks/` の検証記録。

変更:

- `package.json`: `evaluate:zero-delay` コマンド。
- `evaluation/src/full-types.ts`: Z識別子と追加実験種別。
- `evaluation/src/full-runner.ts`: 独立した結果配置、Z条件、保存処理の共通化、異なる実験種別のresume拒否。
- `README.md`: 利用案内。

Management、benchmark負荷/Delay、失効アルゴリズム、demo frontendは変更していない。既存の結果フォルダを再実行・再集計・書き換えする処理は実行していない。

## CLI

PowerShellでリポジトリルートから実行する。

```powershell
Set-Location C:\Cookie_KEN\cookie-invalidation-research

# 計画のみ。サーバー・測定は実行しない
npm run evaluate:zero-delay -- --dry-run

# ごく小さい確認: 2条件、warm-up2、本計測4、計6試行
npm run evaluate:zero-delay -- --smoke

# 本番: 利用者確認後に実行する210試行
npm run evaluate:zero-delay
```

既存A/Bを指定して3系列比較を生成する場合:

```powershell
$experimentA = 'C:\Cookie_KEN\cookie-invalidation-research\evaluation\results\full-experiment-2026-09-14T00-44-11-397Z-aaa3ffaf'
$experimentB = 'C:\Cookie_KEN\cookie-invalidation-research\evaluation\results\full-experiment-2026-09-14T00-59-39-662Z-b299e3e8'

# 比較元を含むdry-run
npm run evaluate:zero-delay -- --dry-run --compare-a $experimentA --compare-b $experimentB

# 本番210試行と比較出力（今回は未実行）
npm run evaluate:zero-delay -- --compare-a $experimentA --compare-b $experimentB
```

比較元には `full-experiment-*` の親フォルダを指定する。Aではexperiment-a/summary.csv、Bではexperiment-b/summary.csvからMEDIUM/0msだけを読む。元フォルダへは書き込まない。元CSVのSHA256とパス、実行状態、seedを追加実験のcomparison-inputs.jsonへ残す。条件行の欠落や未計測値を0に置き換えない。

中断した追加実験の再開:

```powershell
$verification = 'C:\Cookie_KEN\cookie-invalidation-research\evaluation\results\zero-delay-verification-実際の日時とID'
npm run evaluate:zero-delay -- --resume $verification --compare-a $experimentA --compare-b $experimentB
```

`--resume` にA/Bフォルダを渡すと、書き込み前に拒否する。追加実験の完了済みtrialは再実行しない。再開条件には集計対象外のrewarmupが入る。結果不明の中断trialは失敗として保存し、成功値へ置換しない。比較も必要ならresume時にも比較元を指定する。dry-runの件数は計画全体を示す。

## 保存先と指標

毎回、新規の `evaluation/results/zero-delay-verification-<UTC timestamp>-<id>/` を作成する。

```text
manifest.json
environment.json
raw.csv
summary.csv
failures.csv
service-timings.csv
graph-source.csv
comparison-source.csv
comparison-inputs.json
chart-status.json
records/                 # 試行ごとの正本JSON
sessions/                # この実験専用DB
charts/
  source.csv
  overall-completion.png
  comparison.png
```

raw.csvはwarm-upも含め全試行を保存する。本番ではmeasurementが各サービス数30行、合計180行。warm-up込み210行。summaryはmeasurementだけを使用し、trialCount / successfulTrials / failedTrials / successRateを出す。失敗・外れ値を削除せず、取得できない値は空欄とする。継続可能な失敗は次へ進み、通信や環境が壊れた場合は記録して停止する。

指標は既存名称を維持する:

- `invalidationCompletionTimeMs`: 検知POST直前から応答JSON取得まで。保存処理・cooldownは含まない。
- `cpuUserMs`, `cpuSystemMs`: Management別プロセスの累積CPU差分。利用率ではない。
- `rssBeforeBytes`, `rssAfterBytes`, `heapUsedBeforeBytes`, `heapUsedAfterBytes`: Managementの前後値。ピークではない。
- `actualProcessingMs`, `measuredDelayMs`, `serviceProcessingMs`: サービス内計測を再利用。

システム各指標にはCount/Mean/Median/Min/Max/StdDev/P95を出す。母標準偏差、nearest-rank p95を使用する。サービス指標はtrialごとのサービス分布をrawに保存し、summaryでは各trialのMean/Maxの分布を集計する。例: `actualProcessingMsMeanMean` はtrial内サービス平均をtrial間で平均した値。個別サービス時間もservice-timings.csvに残す。

グラフは横軸Service Count、縦軸Overall completion time (ms)、measurement平均。比較CSVには各系列の試行数・成功率・統計・出典も残す。少数smokeと本番30試行は同等の証拠ではないので、smokeグラフから再現性を判定しない。

## Windows保存

今回確認した作業ツリーでは、既存の安全保存ヘルパーは存在せず、JSON/CSVが直接renameしていた。そのため `safe-result-write.ts` を共通化し、manifest・試行JSON・environment・CSV・summary・グラフ元CSVに使用した。

一意なtmpに書き込み→sync→close後にrenameする。EPERM/EACCES/EBUSYでは最大6回試行し、置換renameができない場合はcopyFileで内容を保存する。copy側も同様に再試行する。宛先を先に削除する方式は使わない。再試行対象はファイル操作だけであり、測定trialは繰り返さない。

rename正常時はatomic置換。copy代替経路はatomic置換ではない。永続的なアクセス禁止・容量不足等まで無条件に成功を保証しない。代替保存も失敗した場合はtmpを残し、エラーを通知する。測定値を黙って破棄して継続しない。

テストではmanifest/raw/summaryの各renameに連続6回のEPERMを注入し、代替保存を経て正常終了、試行数不変、失敗記録保持、summaryのwarm-up除外を確認した。永続障害時にtmp削除をせずエラーを返すことも検証した。

## 検証結果

- 全workspace typecheck成功。
- lint成功。
- 関連4ファイル・31テスト成功。
- 全19ファイル・259テスト成功（既存demo等を含む）。
- dry-run: conditionCount=6、warmupCount=30、measurementCount=180、totalTrials=210。
- smoke: 1・5サービス、warm-up各1、本計測各2。合計6試行すべて成功、失敗0。raw6行、summary2行、比較CSV14行（A6/B6/今回2）、PNG2枚の生成を確認。
- smoke保存先: `evaluation/results/zero-delay-verification-2026-09-14T02-42-45-242Z-6043d8a9/`。
- 作業前から存在したresults内の1,847ファイルについてSHA256を照合し、変更・削除0件を確認。`existing-results-integrity.json` に結果を記録。
- 検証ログ: `evaluation/zero-verification-checks/`。
- 本番210試行は未実行。50・100サービスでどちらの傾向が再現するかは、本番検証後に判断する。
