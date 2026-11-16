# 連携有無比較・実囮検知評価

## 再現手順

プロジェクトルート `C:/Cookie_KEN/cookie-invalidation-research` で実行する。

```powershell
npm run evaluate:coordination -- --dry-run
npm run evaluate:coordination -- --smoke
npm run evaluate:coordination -- --pilot
npm run evaluate:coordination -- --main
python evaluation/src/coordination-report.py <結果ディレクトリ>
python evaluation/src/coordination-writeup.py <結果ディレクトリ>
```

Node.jsと既存npm依存を使用する。図生成にはPythonのmatplotlibが必要。各実行は独立した新規結果ディレクトリを生成する。予備実験と本実験を同じ集計へ混ぜない。

## 構成

- coordination-cli.ts：比較条件、独立プロセス管理、実際のログイン・囮提示、固定予定アクセス、JSON保存。
- coordination-source-worker.ts：既存研究サイトアプリを使用する検知元。通知callbackに共通のローカル失効を追加し、連携群のみ既存通知クライアントを呼ぶ評価用adapter。
- coordination-core.ts：予定アクセス列と未到達を含む集計。
- coordination-report.py：HTTP行から集計を独立再計算し、SQLite・管理ジョブ・対応付け・ソースハッシュと照合する。
- coordination-writeup.py：検証済み結果の和文報告と補足図を作成。
- COORDINATION-PROTOCOL.md：実験設計。
- COORDINATION-MAIN-FROZEN.md：予備実験後・本測定前の条件固定。

研究本体の管理サーバー、検知URL、通知クライアント、失効handlerは編集していない。検知元の管理用URLを設定するため、新規実験DBのservices行のみを更新する。通常アプリのDBは開かない。制御・測定は127.0.0.1上で実行する。対外サービスや実際のCookie窃取は対象外。

## 記録の意味

主解析は検知元以外の9サービス、計18Cookie。各Cookie100ms周期、10秒窓なので通常1試行あたり1,800予定要求。

200：評価用保護ページへの認証済みアクセス成功。401：拒否。通信例外・未送信・その他応答は確認不能として残す。

allDeniedMsは各対象Cookieの最初の401受信時刻の最大値であり、実際のサーバー内部失効時刻ではない。窓内に401を確認できない対象があればnullとなる。非連携のnullを10,000msへ置き換えて平均しない。

検知元では同じ実際の/loginで各人2回ログインし、発行された囮を提示する。連携先は既存評価fixtureが発行したセッションを使う。ユーザーIDはサービスごとに異なる。2名は対象と対照であり、実参加者2名の実験ではない。

## 保存物

manifest.json（条件・環境・実行コードのハッシュ）、source-snapshot、試行別DB、trial.json（Cookie値を除くHTTP・状態記録）、trials.jsonl、completed.json、失敗時failure.json。

独立集計後：verification.json、summary.json、trials.csv、pairs.csv、comparison.png/svg。和文報告生成後：REPORT.md、window-sensitivity.csv、window-sensitivity.png/svg。

## 制約

途中結果を自動で成功として埋めるresumeはない。中断時は保存済み試行を残し、必要なら別バッチとして開始する。本評価の失敗を都合よく除いて置き換えない。性能測定中の他の重い処理を避ける。過去の異なる評価系の時間と直接比較しない。

検知を確実に発生させる合成条件であり、実攻撃の検知確率・誤検知率・実被害削減率は推定できない。非連携の他サービスを失効させない設計上、連携群の成功件数が減ること自体は予想される。科学的に確認するのは、その条件下の失効到達時間、移行中に残る成功、対象外の維持、実装経路の成立である。
