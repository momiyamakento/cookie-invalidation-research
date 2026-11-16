# 診断実験（2026-09-25）

元の発表資料の50サービスでのlight/medium時間逆転と、100サービスでの管理サーバーRSS逆転を調査するための独立した計測スクリプト。通常のサーバー起動・元の評価コード・元データは変更しない。

## 計測

- 管理サーバーと実験ランナー（全模擬サービスを含む）のRSS、heapUsed、heapTotal、external、CPU時間。
- Node PerformanceObserverのGC時刻・種類・継続時間。
- 管理側の検知通知受付から応答完了、外向きHTTPの開始・ヘッダー受信・JSON本文読み取り完了。
- イベントループ遅延（5ms間隔）、ホスト全体CPU時刻カウンター。
- 処理終了直後、2.5秒待機後、明示GC後のメモリ。

通常のHTTP認証は保持。計測制御とGC指示は診断用子プロセスのIPCに限定し、HTTPに管理エンドポイントを追加しない。実験DBは結果ディレクトリ内に新規作成する。

## 実行

リポジトリルートから、元実験と同じNode v24.14.0を使用した。

```powershell
# 14条件（各ウォームアップ5回、本測定30回）。条件単位でプロセスを再起動。
./evaluation/diagnostics/run-matrix.ps1

# 上の出力ディレクトリを指定。light/mediumを交互に各30回、2組。
node evaluation/diagnostics/run-paired.mjs evaluation/results/causal-diagnostics-YYYYMMDD-HHMMSS

# 集計。Pythonは標準ライブラリのみ。
python evaluation/diagnostics/analyze.py evaluation/results/causal-diagnostics-YYYYMMDD-HHMMSS
```

個別実行：

```powershell
node --expose-gc --import tsx evaluation/diagnostics/run-condition.ts <新しい結果ディレクトリ> 100 light baseline 30
```

modeはbaseline、force-gc（両プロセスで試行前にGC）、paced（前試行の計測開始から次のリセットまで最低1秒）を指定できる。pairedはIPCコントローラー専用。新しい結果ディレクトリを使用すること。

## 限界

- 診断API、IPC、PerformanceObserver自身の負荷があるため、絶対時間は元のスライドの値の置き換えに使わない。
- 元のfull-runnerは各試行後に蓄積した全結果をCSVへ再出力していた。本診断は条件終了時に一括保存するため、そのファイルI/Oや試行間隔を完全には再現しない。
- GC前処理は因果切り分けの操作であり、高速化策ではない。通常時とメモリ・JIT・GCの状態が変わる。
- イベントループ遅延はサンプリング値であり、全停止を必ず捕捉するものではない。
- 外向きHTTPの完了までには、サービスの処理・HTTP処理・CPUスケジューリング等が含まれる。ネットワークだけの時間とは呼ばない。
- サービス側RSSは実験ランナー込み。各サービスを独立したOSプロセスとしては測っていない。
- 同一条件30試行は同一プロセス内であり、30個の独立した起動ではない。

出力のdiagnostic.jsonは各試行の生データ、summary.csv/jsonは条件集計、trials.csv/jsonは処理区間とGCの集計。

公式仕様：
- https://nodejs.org/api/perf_hooks.html
- https://nodejs.org/api/process.html#processmemoryusage
- https://nodejs.org/api/cli.html#--expose-gc
