# Processing LoadとService Delayの分離：実装・検証報告

2026-09-13 JST。現行モデル: related-sessions-v2。

## 現状確認と変更範囲

前PhaseではMEDIUMの監査反復1回＋20ms、HEAVYの反復16回＋100msがSQLite commit後に実行されていた。実処理・待機の内訳は記録できたが、負荷と遅延が結び付いていた。

今回、関連状態量の異なる処理モデルに変更し、非同期待機をサービスハンドラー側へ移動した。全profileで待機の既定値は0ms。CLIの --service-delay-ms だけで追加できる。データ件数は固定し、試行前に状態をリセットする。時間を目標値へ合わせる較正や無意味な反復は行わない。

変更ファイル:
- evaluation/src/benchmark-load.ts
- evaluation/src/benchmark-services.ts
- evaluation/src/benchmark-scale-options.ts
- evaluation/src/benchmark-scale.ts
- tests/benchmark-load.test.ts
- tests/benchmark-management-phase13.test.ts
- README.md

新規ファイル: 本報告 evaluation/PROCESSING-LOAD-REPORT.md、後述の評価結果とprocessing-*.log。前Phaseの報告は履歴として維持。
Management Server、Site A/B/C/D、apps/demo、共通ライブラリは編集していない。動的登録・サービス別トークン・Cookie・失効API形式は維持した。

## 処理モデルとデータ件数

| 項目 | LIGHT | MEDIUM | HEAVY |
|---|---:|---:|---:|
| 対象利用者 | 1 | 1 | 1 |
| セッション | メモリ上1 | SQLite 8 | SQLite 128 |
| 関連認可情報 | 0 | 32（各4件） | 1024（各8件） |
| 失効時の監査INSERT | 0 | 8 | 128 |
| SELECT文実行 | 0 | 3 | 3 |
| 書込文実行 | 0 | 11 | 131 |
| 変更する行数 | メモリ状態1 | 49 | 1281 |
| 既定待機 | 0ms | 0ms | 0ms |

正常な初回失効1要求あたり。書込は認可一括UPDATE・セッション一括UPDATE・セッション別監査INSERT・利用者revision UPDATE。行数は認可＋セッション＋監査＋利用者。BEGIN/COMMIT、初期化、計測外リセット、SQL内サブクエリは文の実行回数に加算していない。

LIGHTは利用者確認とフラグ変更。MEDIUM/HEAVYは利用者を確認し、有効セッション一覧とセッション別の認可件数を取得する。認可・セッションを一括失効し、各セッションについて何件の認可を取り消したか監査に保存する。最後に利用者の失効revisionを更新する。3つの読込SQLが扱う行数と更新・監査の対象数がHEAVYで増える。

セッションは独立したIDを持ち、認可も別々のレコード。監査INSERTは同じ意味のない処理の反復ではなく、失効した個別セッションの履歴を残すもの。初回revokedCountは1／8／128、再失効は0。存在しない利用者は404で状態変更も待機もしない。

## PowerShell

```powershell
Set-Location C:\Cookie_KEN\cookie-invalidation-research
npm run evaluate:benchmark -- --service-counts 1 --load-profile light --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile heavy --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 20 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 100 --warmup 2 --trials 10
```

--service-delay-msを省略しても0ms。Managementとbenchmarkはランナーが自動起動・登録・終了する。負荷のみSERVICE_LOAD_PROFILE環境変数も利用できる（CLI優先）。今回の検証では上記のservice-countsを1,5,10,20,50,100にして各条件を順次実行した。

## 計測とCSV・summary

認証・入力検証を通過した失効ハンドラーで、処理開始時刻t0、実処理完了t1、タイマー復帰t2をperformance.now()で取得する。0ms設定ではタイマーを実行せずt2=t1とする。

- actualProcessingMs = t1 - t0
- measuredDelayMs = t2 - t1
- serviceProcessingMs = actualProcessingMs + measuredDelayMs
- serviceDelayMs = 設定遅延

失効DBの初期化とリセットは計測外。HTTP応答生成、共通ルーターの成功ログはサービス処理時間の外。タイマー復帰までの時間はOS・イベントループによる超過を含む。全体失効時間は従来どおりランナーのManagement検知POST開始から応答受信まで。

service-timings.csvに各要求の新4列を末尾追加。旧actualWorkMs／observedDelayMsは新内訳と同じ値、intentionalDelayMsは適用した遅延（未知ユーザー時は0）。旧processingDurationMsも維持。
raw.csvは既存列を維持し、新4列を追加。rawの3時間は各試行のサービス間平均。summaryは新3時間の分布統計、設定遅延、モデルバージョン、状態件数を保存する。summaryのサービス分布は全サービス×測定試行をまとめたもので、warm-upは除外する。旧統計キーも残す。

## 検証

全テスト16ファイル・243件成功。型チェック・lint成功。SQLiteの状態件数、認可失効、監査件数・監査内の認可総数、再失効、リセットを確認。全profileで遅延0／20／100msと加法関係、不正遅延値拒否を確認。Management経由の並列失効テストは明示的な20ms待機を指定して待機が重なることを確認する。

既存Site A/B/C/D、囮Cookie検知、一括失効、共通ライブラリ、既存評価、デモの回帰テストも成功。デモのブラウザ目視確認は今回実施していない。

## 制約・研究での扱い

このデータ件数は小規模／多数関連状態を持つ合成条件。128セッションを一般的な個人利用の端末数とは主張しない。SQLiteはメモリ上なのでディスクI/Oを模擬しない。短時間処理はJIT、GC、OSスケジューリング、PC負荷の影響を受け、どの測定でも順序が成立する保証はない。

benchmarkとランナーは同一イベントループを共有し、同期SQLite処理はサービス間で直列化する。非同期待機は重なるが独立ホストの処理並列性は再現しない。ManagementのCPU・RSS・heapUsedは別プロセスの値で、benchmarkの資源消費を含まない。

Service Delayは応答待ちを模擬し、ネットワークの帯域・損失・実通信往復を再現しない。Managementの既存1.5秒timeoutとリトライは変更していない。大きい待機や同期処理の累積はtimeoutに影響する。旧固定待機モデルの測定とはloadModelVersionで区別する。

## 簡易実測（同一PC、各条件warm-up 2回＋測定10回）

1サービス時の実処理時間。単位ms。

| 負荷 | 遅延設定 | 実処理平均 | 中央値 | 最小 | 最大 | 実測待機平均 | サービス総時間平均 |
|---|---:|---:|---:|---:|---:|---:|---:|
| light | 0 | 0.0031 | 0.0034 | 0.0017 | 0.0041 | 0.0000 | 0.0031 |
| medium | 0 | 0.3856 | 0.4068 | 0.2457 | 0.4769 | 0.0000 | 0.3856 |
| heavy | 0 | 2.3794 | 2.3655 | 2.2189 | 2.6251 | 0.0000 | 2.3794 |
| medium | 20 | 0.2028 | 0.1874 | 0.1582 | 0.2648 | 23.8671 | 24.0700 |
| medium | 100 | 0.1514 | 0.1371 | 0.1229 | 0.2237 | 106.0631 | 106.2145 |

遅延なしでLIGHT < MEDIUM < HEAVYの平均・中央値の傾向を確認。時間目標への調整は行っていない。MEDIUMの遅延設定を変えても状態件数は同じ。実処理時間のばらつきはあるが、待機0では実測待機は全件0、20/100では待機分が別途記録された。

全5設定×6サービス数×12試行＝360試行で失効成功。各結果のraw 72行・サービス時間2232行（ヘッダー除外）、合計11160件のHTTP 200を確認。全行の時間加法関係、rawのサービス間平均、summaryのwarm-up除外と平均、ラベル・遅延設定、各4グラフを照合した。

結果ディレクトリ:

- light, delay=0: results/benchmark-scale-2026-09-13T04-35-13-396Z
- medium, delay=0: results/benchmark-scale-2026-09-13T04-35-31-749Z
- heavy, delay=0: results/benchmark-scale-2026-09-13T04-35-47-982Z
- medium, delay=20: results/benchmark-scale-2026-09-13T04-36-11-367Z
- medium, delay=100: results/benchmark-scale-2026-09-13T04-36-26-717Z
