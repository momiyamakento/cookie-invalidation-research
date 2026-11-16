# Cookie Invalidation Research

大学卒業研究「囮を用いたCookie窃取後の被害拡大防止手法の提案」の実験用システムです。1つの独立Webサービスで得られた囮Cookieの利用検知を、同一利用者が使う複数サービスのサーバー側セッション失効へ接続することを目的とします。共通IdPやSSOは前提としません。

## 現在の実装範囲

現在はPhase 13までの機能に加え、Management mapping APIへのサービス別Bearer認証・認可を実装しています。Phase 1の基盤、Management Serverの利用者対応管理、Site A/B/Cの通常セッションと実験用囮Cookie detector、起動時mapping登録、認証付き検知通知、各Siteの内部失効API、Management Serverによる複数Siteの並列一括失効に加え、3サービス構成を反復計測する評価基盤を実装しています。Phase 11ではSite Dを追加し、Phase 12/13では可変数の軽量benchmarkサービスをManagement Server経由で一括失効できます。

検知通知がManagement Serverへ正常に届くと、解決した全targetへ失効要求を送り、正規セッションをサーバー側で失効します。任意サービス数への拡張、大量サービス性能実験、永続Outbox、失敗jobの明示的な再実行APIは実装していません。

## 現行の発表デモ

`npm run demo` で研究本体と発表デモをまとめて起動します。利用者用Campus SNSは `http://localhost:4200/`、攻撃者用Cookie Theft Demoは `http://localhost:4201/` です。任意の表示ユーザーでログインし、Cookie窃取、正規Cookieによる侵入、囮Cookie検知、Management Server経由のSite A〜D一括失効、盗難Cookieの再利用失敗までを別タブで操作できます。詳しい手順は [DEMO-GUIDE.md](./DEMO-GUIDE.md) を参照してください。

## 使用技術

- Node.js 22以上
- TypeScript（strict mode）
- Express 5
- SQLite / better-sqlite3
- dotenv
- EJS
- ESLint
- Vitest
- npm workspaces / tsx

## セットアップ

Windows PowerShellで次を実行します。

```powershell
cd C:\Cookie_KEN\cookie-invalidation-research
npm install
Copy-Item .env.example .env
# .envのSITE_A/B/C_SEED_PASSWORDに各12文字以上の実験用パスワードを設定する
npm run typecheck
npm run lint
npm test
```

`.env`はGit管理対象外です。`SITE_A_SEED_PASSWORD`、`SITE_B_SEED_PASSWORD`、`SITE_C_SEED_PASSWORD`へ別々の実験用パスワードを設定してください。`MANAGEMENT_BASE_URL`、`SITE_A/B/C_PRINCIPAL_ID`、互いに異なる`SITE_A/B/C_TO_MANAGER_TOKEN`と`MANAGER_TO_SITE_A/B/C_TOKEN`が必須です。Phase 9ではManagement Serverも後者を読み込みます。通信方向をまたぐtoken再利用も設定エラーです。

## 起動方法

4サーバーをまとめて起動します。

```powershell
npm run start:all
```

個別に起動する場合は`npm run start:management`、`npm run start:site-a`、`npm run start:site-b`、`npm run start:site-c`を使用します。開発時のwatch modeには対応する`dev:*`スクリプトがあります。

既定のURLは次のとおりです。

- Management Server: `http://localhost:4100/health`
- Site A: `http://localhost:3101/health`
- Site B: `http://localhost:3102/health`
- Site C: `http://localhost:3103/health`

## Site Aへのログイン

Site Aを起動し、`http://localhost:3101/login`を開きます。

- username: `alice-a`
- password: `.env`の`SITE_A_SEED_PASSWORD`に初回DB作成時に設定した値

ログイン後は`/protected`へ移動します。ログアウトすると、ブラウザCookieの削除に加えてSQLite上の対応セッションが`ACTIVE`から`REVOKED`へ変更されます。そのため、ログアウト前の`sid_site_a`を再利用しても`/protected`は`401 Unauthorized`を返します。

Site Aの既定DBは`apps/site-a/data/site-a.sqlite`です。DBにはパスワードのscryptハッシュとセッショントークンのSHA-256ハッシュだけを保存し、平文パスワードやセッショントークン本体は保存しません。

seedは冪等で、既存の`user-a-001`を起動時に上書きしません。このため、DB作成後に`SITE_A_SEED_PASSWORD`を変更しても既存ユーザーのパスワードは自動変更されません。

## Site B/Cへのログイン

| Site | URL | Username | Password source |
|---|---|---|---|
| Site B | `http://localhost:3102/login` | `alice-b` | `SITE_B_SEED_PASSWORD` |
| Site C | `http://localhost:3103/login` | `alice-c` | `SITE_C_SEED_PASSWORD` |

Site B/CもSite Aと同じく、ログインで正規・囮Cookieを発行し、`/protected`は自サービスの正規Cookieだけを認証に使用します。logoutはサーバー側セッションを`REVOKED`にしたうえでCookieを削除します。

各サービスの独立情報：

| Site | Database | Local user ID | Regular Cookie | Decoy Cookie |
|---|---|---|---|---|
| Site A | `apps/site-a/data/site-a.sqlite` | `user-a-001` | `sid_site_a` | `decoy_site_a` |
| Site B | `apps/site-b/data/site-b.sqlite` | `user-b-018` | `sid_site_b` | `decoy_site_b` |
| Site C | `apps/site-c/data/site-c.sqlite` | `user-c-105` | `sid_site_c` | `decoy_site_c` |

Site B/Cの共通処理は`packages/service-kit/src/research-site`に置いています。共通化されるのはコードだけであり、実行プロセス、SQLite、利用者、セッション、Cookieは共有しません。Site Aは既存実装を維持しています。

## Phase 3の実験用囮Cookie detector

ログイン成功時、正規Cookieとは別に`decoy_site_a`を発行します。このCookieは`HttpOnly=true`、`SameSite=Lax`、`Secure=false`、`Path=/__research/decoy-use`です。通常画面から研究用URLへのリンクはありません。

研究用の`GET /__research/decoy-use`に有効な囮Cookieを明示的に提示すると、Site A内部で次を行います。

```text
SHA-256(decoy token)
→ decoy_sessionsを検索
→ ISSUEDからUSEDへ原子的に更新
→ local_detection_eventsへ1件記録
→ 検知内容をJSONで返却
```

同じ囮Cookieの再利用は`already_detected`となり、新しいイベントを作成しません。偽Cookieは404、Cookieなしは400です。検知イベントに正規・囮Cookieトークンやパスワードは含めません。また、Phase 3では検知後に正規セッションを失効せず、Management Serverへの通知も行いません。

このdetectorは囮Cookie方式の最適解を確定するものではなく、後続の検知通知・一括失効機構を評価するための交換可能な実験用検知部です。

## Phase 4のManagement mapping API

Management Serverの既定DBは`apps/management-server/data/management.sqlite`です。このDBだけを開き、Site A/B/CのSQLiteを直接参照しません。起動時に次のサービスを冪等にseedします。

- `site-a` / `Site A` / `http://localhost:3101`
- `site-b` / `Site B` / `http://localhost:3102`
- `site-c` / `Site C` / `http://localhost:3103`

利用者対応API：

```text
POST /api/v1/mappings
GET  /api/v1/mappings/:principalId
GET  /api/v1/mappings/resolve?serviceId=...&localUserId=...
```

登録例：

```json
{
  "principalId": "principal-001",
  "serviceId": "site-a",
  "localUserId": "user-a-001"
}
```

Management DBに保存するのは`principalId`、`serviceId`、`localUserId`、サービス接続先などの対応付け情報だけです。Cookie、パスワード、正規・囮トークン、Site側のハッシュは保存しません。

mapping APIはサービス別の`SITE_X_TO_MANAGER_TOKEN`によるBearer認証を必須とします。さらに、認証されたサービスIDと要求中の`serviceId`が一致しない登録・逆引きを403で拒否し、principalIdによる参照でも呼出元サービス自身の対応だけを返します。認証情報がない、または不正な要求は401です。これはネットワーク経由の未認証操作とサービス間の権限越境を防ぐ対策であり、Management Serverホスト自体を奪取された場合まで防ぐものではありません。

## Phase 6の起動時mapping登録

各Siteは自分のDB初期化と実験利用者seedを完了し、HTTPサーバーがlistenを開始した後に、`POST /api/v1/mappings`へ次の3項目だけを送ります。

```json
{
  "principalId": "principal-001",
  "serviceId": "site-a",
  "localUserId": "user-a-001"
}
```

Site B/Cはそれぞれ`site-b` / `user-b-018`、`site-c` / `user-c-105`を送信します。`principalId`は認証情報ではなく、独立サービス上の実験用アカウントを同じ利用者へ関連付ける内部識別子です。Cookie、パスワード、セッション／囮トークン、ハッシュ、`decoyId`、検知イベントは送信しません。要求には検知通知と同じサービス別資格情報を`Authorization: Bearer <SITE_X_TO_MANAGER_TOKEN>`として付与しますが、Bearer値を本文やDBへ保存しません。

登録はNode.js標準`fetch`を使用し、各要求のtimeoutは1.5秒、最大3回、再試行間隔は300msです。ネットワーク失敗・timeout・HTTP 5xxだけを再試行し、4xxは設定またはデータ不整合として直ちに終了します。201 `registered`と200 `already_registered`はどちらも正常です。全試行が失敗してもログを記録するだけでSiteを停止しません。永続Outboxや無限再試行は実装していません。

## Phase 7の認証付き検知通知

各Siteの`GET /__research/decoy-use`は、まず自サービスのSQLite transaction内で囮セッションを`ISSUED`から`USED`へ更新し、同じtransactionで`local_detection_events`を保存します。commit後に、サービス別Bearer tokenを付けてManagement Serverへ通知します。

```text
POST /api/v1/detections
Authorization: Bearer <SITE_X_TO_MANAGER_TOKEN>
Content-Type: application/json
```

通知payloadは`eventId`、`serviceId`、`localUserId`、`decoyId`、`detectedAt`の5項目だけです。`principalId`、Cookie、パスワード、正規・囮tokenやhashは含めません。`eventId`はlocal eventと同じ値です。

Management Serverはtokenから送信元Siteを識別し、payloadの`serviceId`との一致を検証します。その後、`serviceId + localUserId`から`principalId`を解決し、同じprincipalに属するサービスを`serviceId`順のtargetsとして返します。初回は201 `received`、同一payloadの再送は200 `already_received`、同じ`eventId`で内容が異なる場合は409 `EVENT_ID_CONFLICT`です。

Management DBの`detection_events`には、検知識別子、送信元サービス／ローカル利用者、解決したprincipal、検知・受信時刻、`RESOLVED`状態だけを保存します。これは失効成功を意味しません。

通知clientはtimeout 1.5秒、最大3回、間隔300msで、ネットワーク失敗・timeout・5xxだけを再試行します。401、403、404、409を含む4xxは再試行しません。通知に失敗しても研究用endpointはlocal検知結果としてHTTP 200を返し、`notificationStatus: "failed"`で通信結果を区別します。local eventと正規sessionの`ACTIVE`状態は維持されます。永続Outboxはまだありません。

## Phase 8のSite内部セッション失効API

Site A/B/Cはそれぞれ次の内部APIを持ちます。

```text
POST /internal/v1/sessions/revoke
Authorization: Bearer <MANAGER_TO_SITE_X_TOKEN>
Content-Type: application/json
```

```json
{
  "requestId": "UUID",
  "eventId": "UUID",
  "localUserId": "user-b-018",
  "reason": "DECOY_COOKIE_DETECTED",
  "detectedAt": "2026-08-22T06:00:00.000Z"
}
```

payloadはこの5項目だけを受け付けます。`principalId`、`serviceId`、Cookie、session token/hash、decoy token/hash、passwordは不要です。各Siteは自分のSQLiteだけで対象利用者の全`ACTIVE`正規sessionを一括UPDATEし、`revoked_at`を設定します。

`requestId`重複確認、利用者確認、全session UPDATE、`revokedCount`取得、`invalidation_requests`保存は1つの`IMMEDIATE` transactionです。初回は`success`、同一payloadの再送は保存済み件数を返す`already_processed`、同じrequestIdで内容が異なる場合は409 `REQUEST_ID_CONFLICT`です。利用者が存在してACTIVE sessionが0件の場合も`revokedCount: 0`で成功します。

内部APIはCookieを削除せず、`decoy_sessions`と`local_detection_events`も変更しません。以前取得した正規Cookieはブラウザ側に残っていても、サーバー側sessionが`REVOKED`のため`/protected`で401になります。Phase 8ではManagement ServerからこのAPIを呼ぶ処理はありません。

## Phase 9の並列一括失効

Management Serverは初回検知イベントについて、targetごとに固定requestIdを生成し、`detection_events`を`PROCESSING`へ更新すると同時に`invalidation_jobs`を`PENDING`で先に保存します。この短いSQLite transactionをcommitしてから、Node.js標準`fetch`でSite A/B/Cの失効APIを`Promise.allSettled()`により並列呼び出しします。HTTP通信中にDB transactionを保持しません。

失効clientはservicesテーブルの`base_url`と、serviceIdに対応する`MANAGER_TO_SITE_*_TOKEN`を使用します。payloadは`requestId`、`eventId`、`localUserId`、固定reason、`detectedAt`だけで、Cookie、session token/hash、principalId、serviceIdは送りません。

各要求はtimeout 1.5秒、最大3回、間隔300msです。ネットワーク失敗・timeout・5xxだけを同じrequestIdで再試行し、4xxは再試行しません。200 `success`と`already_processed`は、`revokedCount: 0`を含め成功です。

jobには開始・完了時刻、HTTP status、duration、revokedCountまたは安全なエラーコードを保存します。全job成功なら検知は`SUCCESS`、一部だけ成功なら`PARTIAL_FAILURE`、全失敗なら`FAILED`です。`detection_events.total_duration_ms`は検知通知受信から最後のjob結果保存までを計測します。

同じeventIdの再送時、`PROCESSING`または最終状態なら新しいjobやrequestIdを作らず、保存済み状態を返します。job情報は`GET /api/v1/detections/:eventId`または`GET /api/v1/detections/:eventId/invalidation-jobs`で確認できます。

## Phase 10の評価実験

評価は通常テストと分離した`evaluation/`のrunnerで行います。Site A/B/CとManagement Serverの4プロセスを通常構成で起動してから、別のPowerShellで実行してください。

```powershell
# terminal 1
npm run start:all

# terminal 2（warm-up 3回は破棄し、その後10回をCSVへ記録）
npm run evaluate -- --trials 10 --warmup 3
```

各試行ではSite A/B/Cへ毎回新規ログインし、新しい正規sessionと囮sessionを作成します。その後Site Aの新しい囮Cookieを研究用endpointへ提示し、Management Serverによる3サービスの並列失効完了を待ちます。保存済みの失効済みsession、使用済み囮session、過去のeventIdは再利用しません。最後に、各試行で発行した3つの正規Cookieがすべて`/protected`で401になることも確認します。

warm-upは同じ完全な処理を行いますが、CSVと集計から除外します。`--trials`は1以上、`--warmup`は0以上の整数です。評価対象は設計どおり固定の3サービスであり、任意サービス数や障害注入は扱いません。

結果は次の形式で作成されます（Git管理対象外）。summary JSONも同じ日時で保存します。

```text
evaluation/results/evaluation-YYYYMMDD-HHMMSS.csv
evaluation/results/evaluation-YYYYMMDD-HHMMSS.summary.json
```

CSVには`runId`、試行番号、固定`serviceCount=3`、`eventId`、最終状態、Management全体時間、Site別job時間・失効数、ManagementプロセスのCPU user/system差分、RSS・heap usedの前後値、runner上の開始・完了時刻を記録します。Cookie、パスワード、Bearer token、token/hash本体は記録しません。

`totalDurationMs`はPhase 9と同じく、Management Serverが検知通知を受信した`received_at`から、最後の失効job結果を保存して検知イベントを最終更新するまでの時間です。Site別`DurationMs`は各jobの開始から完了までです。CPU値はManagementプロセスの累積`process.cpuUsage()`を失効前後にsampleした差（microseconds）、メモリ値は同じ時点の`process.memoryUsage()`によるbyte値です。計測用endpointはSite別Bearer tokenを要求し、resource counter以外を返しません。

consoleとsummary JSONの時間統計は`SUCCESS`試行の`totalDurationMs`だけを対象とし、件数、平均、中央値、最小、最大、母標準偏差（分母は成功試行数N）を表示します。`FAILED`または`PARTIAL_FAILURE`もCSVへ残しますが、失敗jobの取得不能値は空欄とし、正常系統計から除外します。固定性能値を合否条件にはしていません。

## Phase 13の動的benchmarkサービス登録・失効

評価専用のbenchmarkサービスは、固定Site A/B/C/Dとは別にManagement Serverへ動的登録できます。次の登録APIは、サービス登録とprincipal対応付けを一度に行います。

```text
POST /api/v1/benchmark-services
```

```json
{
  "serviceId": "benchmark-001",
  "baseUrl": "http://127.0.0.1:3201",
  "principalId": "benchmark-principal-001",
  "localUserId": "benchmark-user"
}
```

`benchmark-001`から任意個数の`benchmark-NNN`を同じ`principalId`へ登録できます。Management Serverは`BENCHMARK_SHARED_SECRET`から、`HMAC-SHA-256(secret, "cookie-research:" + serviceId)`でサービス固有Bearer tokenを都度導出します。登録済みの同一principalのbenchmarkサービスは全件がtargetとなり、既存の並列失効処理で一括失効されます。固定Site A/B/C/Dの登録・token・APIは変更しません。

## 構成上の制約

Site A/B/CとManagement Serverは、それぞれ専用SQLiteと別Expressプロセスを使用しています。各サービスは自サービス名のCookieだけを読み、他サービスのCookieを認証・検知に使用しません。Management Serverは各サービスのDBを直接操作せず、認証済みHTTP APIを通じて失効を仲介します。

ローカル実験ではHTTPおよび`Secure=false`のCookieを使用します。実環境ではHTTPSおよびSecure Cookieを必須とします。

## benchmarkサービス側負荷の比較

Processing Load（内部の実処理量）とService Delay（制御された待機）を独立指定します。現行モデルは `related-sessions-v2`。旧モデルのMEDIUM=20ms、HEAVY=100msという暗黙の待機は廃止し、すべて既定0msです。旧結果と混在させないでください。

| 条件 | セッション | 認可情報 | 監査記録 | SELECT文 | 書込文 | 既定待機 |
|---|---:|---:|---:|---:|---:|---:|
| LIGHT | 1（メモリ） | 0 | 0 | 0 | 0 | 0ms |
| MEDIUM | 8 | 32（各4件） | 8 | 3 | 11 | 0ms |
| HEAVY | 128 | 1024（各8件） | 128 | 3 | 131 | 0ms |

正常な初回失効1要求あたり。BEGIN/COMMIT・初期化・リセットを除き、SQL内サブクエリを別の文として数えません。LIGHTは利用者ID確認とメモリフラグ更新。MEDIUM/HEAVYは利用者・有効セッション・セッション別認可件数を検索し、認可とセッションを一括更新、各失効セッションに認可失効数付き監査を保存、利用者revisionを更新します。同じ無意味なSQL反復ではなく、別々のセッションの監査です。返却revokedCountは1／8／128、再失効時は0です。

SQLiteはサービスごとに独立した :memory: DBです。失効処理は1つのIMMEDIATEトランザクション。各試行前に状態・監査をリセットし、初期化・リセット時間は計測外です。ユーザー不在は404、状態変更も待機もありません。

PowerShell（リポジトリルート）:

```powershell
npm run evaluate:benchmark -- --service-counts 1 --load-profile light --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile heavy --service-delay-ms 0 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 20 --warmup 2 --trials 10
npm run evaluate:benchmark -- --service-counts 1 --load-profile medium --service-delay-ms 100 --warmup 2 --trials 10
```

負荷指定はCLI > SERVICE_LOAD_PROFILE環境変数 > light。遅延はCLIのみ、未指定0ms。CLIは.envを読みません。遅延は非負整数でNodeタイマー上限2147483647ms以下（実用上は下記timeoutに注意）。全負荷で実処理完了後に同じ非同期タイマーを使い、0msではタイマーを呼びません。乱数・busy waitは使いません。

既定のサービス数1,5,10,20,50,100、warm-up 5回・測定30回は維持。ランナーがManagement Serverと連番benchmarkサービスをOS割当ポートで起動し、既存APIで動的登録して終了時に停止します。通常のstart:allは不要。プログラムでは `startBenchmarkCluster(count, secret, basePort, profile, serviceDelayMs)` を使用できます。

### 計測と互換性

結果は `evaluation/results/benchmark-scale-日時/` に保存します。

- `service-timings.csv`: 各要求のloadProfile、serviceDelayMs、serviceProcessingMs、actualProcessingMs、measuredDelayMsを記録。旧列も維持。
- `raw.csv`: 全体時間・Management CPU user/system差分ms・RSS/heapUsed前後byte値・loadProfileを維持し、遅延設定と上記3時間を末尾に追加。ここでのサービス時間はその試行の全サービス平均です。
- `summary.json`: loadModelVersion、データ件数、serviceDelayMsと時間統計を追加。サービス時間統計は全サービス×測定試行の分布で、warm-upは除外。rawにはwarmup=trueで保存。
- `graphs/`: 既存の全体時間・CPU・メモリ4グラフを維持。

actualProcessingMsは認証・入力検証後、ハンドラー内で利用者確認を開始する直前から実処理完了まで。measuredDelayMsはそこからタイマー復帰まで。両者の和がserviceProcessingMsです。遅延0時のmeasuredDelayMsは厳密に0。実測待機はOS・イベントループ遅延を含みCPU時間ではありません。旧actualWorkMs／observedDelayMsは新内訳の別名、intentionalDelayMsは実際に適用した設定値（404は0）です。processingDurationMsは従来どおりハンドラー経過時間に対応します。

receivedAtはExpressミドルウェア到達時の壁時計、handlerStartedMs／handlerCompletedMs／responseFinishedMsは到達からのperformance.now()差分。サービス処理にはHTTP応答生成・共通成功ログを含まず、responseFinishedMsはNodeのfinish時点です。APIレスポンスJSON・認証・Cookie・共通プロトコルは変更しません。

invalidationCompletionTimeMsはランナーの検知POST開始からManagement応答受信までで、ネットワークとManagement処理を含みます。サービス時間を単純に引いてManagement単独処理時間にはできません。CPU・RSS・heapUsedは別プロセスのManagementのみの値です。

### 研究上の制約

128セッション・1024認可は多数の関連状態を持つ合成条件で、一般的ユーザーの端末数を代表する主張ではありません。benchmarkとランナーは1プロセス・イベントループを共有し、同期DB処理は直列化、非同期待機は重なります。メモリDBなのでディスクI/Oを再現せず、短い処理はOS・JIT・GCの影響を受けます。時間の固定目標や毎試行の大小関係は保証しません。

Service Delayは応答待ちの模擬で、実ネットワークの帯域・損失を再現しません。Management→サービスの既存timeout 1.5秒・最大3回は変更していません。--timeout-msはランナーの検知POST待機上限だけです。大きな遅延や100サービス時の同期処理の蓄積はtimeoutを起こし得ます。

今回の実測・検証結果は [Processing Load / Service Delay報告](evaluation/PROCESSING-LOAD-REPORT.md) を参照。旧 [LOAD-PROFILE-REPORT.md](evaluation/LOAD-PROFILE-REPORT.md) は固定待機が負荷に含まれていた前Phaseの履歴です。

## 学校発表用デモ：Phase 3（囮検知・複数サービスの一括失効）

現在の `/demo` はPhase 1・2を維持し、本物Cookieの悪用から囮Cookie検知、ManagementによるA〜Dの失効、攻撃者のアクセス拒否まで実演できます。研究本体・DBスキーマ・性能評価コードは変更していません。

### 起動と実演

```powershell
cd C:\Cookie_KEN\cookie-invalidation-research
npm run start:demo:all
```

`http://localhost:4200/demo` を開きます。既存サービスが起動中なら `npm run start:demo` を使用します。

1. `alice-a` と既存DB作成時の `SITE_A_SEED_PASSWORD` でログインし、A〜Dがログイン中になることを確認します。B〜Dは設定済みのデモアカウントで自動ログインします。
2. 本物Cookieの「コピー」→攻撃者欄に貼り付け→「Cookieを使用」。パスワードなしで秘密ページにアクセスできることを確認します。
3. 囮Cookieの「コピー」→攻撃者欄の文字列を置き換え→「Cookieを使用」。実際の囮検知APIがManagementへ通知し、既存処理で4サービスへ失効要求を送ります。
4. Managementパネルの4段階と履歴を確認します。A〜Dすべてについて、保持していた元のCookieで保護ページが401になることを確認した場合に失効済みと表示します。攻撃者が保持した本物Cookieも独立して再使用し、401ならアクセス不可を表示します。
5. 再読み込みでも同じ結果を復元・再確認します。「デモをリセット」で一時状態を消去して再実演できます。性能評価画面へのリンクも維持しています。

### 実データ・失敗表示・演出

囮入力も既存の `POST /demo/api/attacker/use-cookie` を利用します。`decoy_site_a=値` または現在の囮の値だけを受け付けます。現在のデモで発行した囮との一致、A〜Dの保持Cookie、Managementのmappingを確認し、設定済みService Aの `/__research/decoy-use` へ入力囮Cookieだけを送ります。他のデモやリセット前の囮は拒否します。

Managementの検知結果はイベントIDで取得し、通知元の利用者と、失効対象のサービス・ローカル利用者がデモ設定と一致することを確認します。既存mappingは囮送信前に照合します。ManagementのSUCCESSだけでは完了扱いにせず、A〜Dの元のCookieで401になることも必要です。攻撃者の再確認結果は別に表示し、未使用・接続不能なら無効化を断定しません。

通知失敗、一部失効失敗、接続不能を完了と区別します。通知失敗後は同じ囮を明示的に再送すると既存の冪等処理で通知を再試行できます。既に完了した一部失敗ジョブの自動再実行は追加していません。接続復旧後に状態確認し、必要に応じてリセットして再実演してください。

各段階を順に強調する説明再生は、API応答後のブラウザ内だけで行います。研究APIに待機を追加せず、画面のManagement処理時間は実APIの値です。検知・通知受信・処理完了の履歴には実記録の時刻を使用し、それ以外はデモ側の確認時刻を明示します。履歴は再読み込みで重複追加しません。

Cookieと成功した攻撃者Cookieは既存のブラウザ別サーバーメモリに保持し、ログやlocalStorageへ保存しません。デモサーバー再起動では一時状態が失われます。リセットは研究DB・検知記録・評価結果を削除せず、既存DBの古い囮レコードやOSクリップボードも削除しません。

主な変更箇所は `apps/demo/src/demo-revocation.ts`、`demo-routes.ts`、`demo-session.ts`、`views/dashboard.ejs`、`public/demo.js`、`public/demo.css` と関連テストです。

### Phase 3の検証（2026-09-18）

型チェック・lint成功。全テストは23ファイル・272件成功（`npm test -- --reporter=dot --maxWorkers=2`）。実サービスと一時SQLite DBを使い、全件失効、攻撃者Cookieの401、再読み込み・重複送信・リセット後の再実演、通知失敗からの再送、一部失効失敗、接続不能、古い囮の拒否を検証しています。

## 学校発表用デモ：Phase 2（本物Cookieの悪用・実装記録）

以下はPhase 2時点の操作・制約・検証記録です。現在の操作は上のPhase 3を参照してください。Phase 2ではPhase 1の利用者ログイン・Cookie表示・A〜Dの状態確認に加え、攻撃者が本物CookieだけでService Aへアクセスするデモを実装しました。研究本体と性能評価コードは変更していません。

### 起動と操作

```powershell
cd C:\Cookie_KEN\cookie-invalidation-research
npm run start:demo:all
```

`http://localhost:4200/demo` を開きます。既にManagementとA〜Dが起動中なら `npm run start:demo` のみで構いません。

1. 利用者側で `alice-a` と、既存DB作成時の `SITE_A_SEED_PASSWORD`（通常は `.env` の設定値）を入力します。既存ログインで認証し、B〜Dもデモアカウントでログインします。
2. 本物Cookieの「コピー」を押し、攻撃者のCookie欄へ貼り付けます。コピーがCookie窃取の模擬操作です。
3. 「Cookieを使用」を押します。Service Aの保護ページが実際に200を返した場合だけ、攻撃者側にも秘密ページと、パスワードなしでアクセスできる危険性を表示します。A〜Dはログインしたままです。
4. `sid_site_a=wrong-cookie` では保護ページの401を根拠にアクセス不可を表示します。
5. 囮Cookieをコピーして入力した場合は「囮Cookieの使用は次のPhaseで実演します」と表示するだけです。検知API・通知・一括失効は呼び出しません。
6. リセットすると利用者のA〜Dセッションを終了し、Cookie表示、攻撃者入力、保持した本物Cookie、成功状態、履歴を初期化して手順①に戻ります。

### 攻撃者の通信と一時状態

`POST /demo/api/attacker/use-cookie` はJSON `{ "cookie": "sid_site_a=…" }` を受け付けます。値のみの入力は、このデモで発行した本物Cookieと一致するときだけ受け付けます。囮の名前付き入力、およびこのデモの囮の値のみ入力は案内表示で終了します。複数Cookie、改行、任意URL、追加のJSONフィールドを受け付けません。

送信先は設定済みService Aの `/protected` に固定です。Node.jsのfetchで `GET` を送り、明示的な認証ヘッダーは入力値による `Cookie: sid_site_a=…` だけです。リクエスト本文・パスワード・Bearer tokenは送信せず、利用者のCookie jarや受信Cookieヘッダーも転送しません。リダイレクトは追従しません。HTTP 200 / 401 / 通信失敗を区別します。

成功した攻撃者の本物Cookieは `demo-session.ts` のサーバーメモリだけに保持します。攻撃者APIの応答やイベントログには生Cookieを出力しません。Phase 1の利用者Cookie表示APIは引き続き表示用のCookieを返します。HttpOnly属性、ローカルHost制限、X-Demo-Token、cross-site拒否、no-storeを維持します。デモ識別Cookieは `/demo/api` 配下で共有します。

ページ再読み込みでは成功状態を復元し、確認時刻と「前回の確認結果」を表示します。これは保存済みの成功記録で、攻撃者Cookieの継続的な再認証ではありません。後で誤ったCookieや囮を入力しても、最後に成功したCookieと成功時刻はリセットまでサーバーメモリに保持します。Phase 3の再確認処理はまだ実装していません。デモサーバーを再起動すると一時状態は失われるため、終了前にリセットしてください。

### Phase 2の検証（2026-09-18）

型チェック・lint成功。全既存テストを含め `npm test -- --reporter=dot --maxWorkers=2` で22ファイル・269テスト成功。攻撃者の送信先・GET・入力Cookieのみのヘッダー・本文なしを検証し、囮入力では外向き通信ゼロ・検知イベントゼロを確認しました。

一時DBの実ブラウザで、本物Cookieのコピー→実貼り付け（一致確認）→アクセス成功、誤Cookie拒否、囮Cookieの実貼り付けと案内のみ表示、4サービスのログイン維持、再読み込み復元、リセット、再実演、性能評価画面への切替を確認しました。1920×1080の成功画面はページ全体の縦横スクロールなしです。Phase 1時点で未確認だった実際のコピー・貼り付けも確認できました。

## 学校発表用デモダッシュボード（Phase 1の実装記録）

Phase 1時点の `/demo` は **利用者ログイン → 本物Cookie・囮Cookie表示 → A〜Dのログイン状態確認** までの画面です。左に利用者、右に「Phase 2で実装予定」の攻撃者領域、下に確認済みイベントを表示します。攻撃者のCookie入力・使用、囮検知、通知、一括失効の操作・演出はこの画面にはありません。研究本体にある既存APIと旧中継は変更していません。

### PowerShellで起動

```powershell
cd C:\Cookie_KEN\cookie-invalidation-research
npm run start:demo:all
```

ブラウザで `http://localhost:4200/demo` を開きます。既にManagement ServerとSite A〜Dが起動している場合は `npm run start:demo` だけ実行してください。任意の `DEMO_PORT` は既定4200で、デモは127.0.0.1にbindします。

- Service Aのユーザー名：`alice-a`
- パスワード：既存Site AのDBを初めて作成した際の `SITE_A_SEED_PASSWORD`。通常は `.env` に設定した値です。デモ画面にはパスワードを埋め込みません。
- B/C/Dは `.env` の各 `SITE_B/C/D_SEED_PASSWORD` と既存の `alice-b` / `alice-c` / `diana-d` を使って自動ログインします。SSOではなく、同一利用者の複数サービス利用を再現するデモ補助です。
- A〜Dの `SITE_X_PRINCIPAL_ID` は同一の値に設定してください。操作前にManagementのmappingがA〜Dの既存ローカル利用者に一致することを確認します。
- 既存の内部通信tokenなど各サービスの起動設定は従来どおり必要です。Site Dを含めて `.env.example` を参照してください。
- `.env` のパスワードを変更しても、既存DBに保存済みのアカウントのパスワードは自動更新されません。

### 実演手順

1. Service Aのユーザー名・パスワードを入力し「ログイン」。既存の `POST /login` で認証します。
2. 既存 `/protected` が200になることを確認すると、利用者の秘密ページを表示します。B〜Dにもログインし、各保護ページへのアクセスで状態を確認します。
3. Site Aの実際の `sid_site_a` と `decoy_site_a` を表示します。それぞれの「コピー」は `Cookie名=値` をコピーし、「コピーしました」と表示します。
4. 再読み込みしても、同じデモサーバーが起動中であればCookie表示・履歴を復元し、サービス状態を再取得します。表示中は10秒ごとにも状態を確認します。
5. 「デモをリセット」でA〜Dのデモ用セッションを既存 `/logout` で終了します。元のCookieで401になることまで確認し、Cookie表示・一時状態・イベントを初期化します。再ログインして繰り返せます。

接続不能は「状態確認失敗」、401は「未ログイン」と区別します。一部サービスへのログイン失敗は警告し、4サービス成功と表示しません。リセット失敗時は終了できなかったセッション情報を残すため、接続復旧後に再試行できます。

### Cookieと一時状態

デモサーバーが既存ログイン応答の `Set-Cookie` を取得し、Site AのCookie値をデモ専用JSONで返します。ブラウザにも元のCookie名・HttpOnly属性を維持して設定し、Pathだけを `/demo/proxy/site-x/...` 配下にします。囮Cookieの研究URL限定Pathも維持します。Site Dは本物Cookieだけを発行する既存仕様です。

再読み込みのため、サーバーメモリにブラウザごとのデモ状態・Cookie・最大80件の確認履歴を保持します。ブラウザとの対応にはランダムなHttpOnly / SameSite=Strictのデモ識別Cookieを使用します。パスワード、Cookie値、内部Bearer tokenをログやlocalStorage/sessionStorageへ保存しません。ログの時刻はデモサーバー側で応答・状態を確認した時刻で、Site内部の発行時刻を示すものではありません。

デモサーバーの再起動は一時状態を失います。終了前に「デモをリセット」してください。再起動や識別Cookieの削除で失われた状態から、以前の研究セッションを自動回収する機能はありません。

リセットは研究DB・mapping・検知記録・評価結果を削除しません。既存logoutにはDB内の囮レコードの無効化機能がないため、ブラウザ・デモメモリから囮を取り除き、再ログインで新しい囮を発行します。OSのクリップボードにコピー済みの文字列はリセットでは消去しません。

### Phase 1専用API

全ルートに既存の `X-Demo-Token`、cross-site拒否、ローカルHost制限、`Cache-Control: no-store` を適用します。

| API | 用途 |
|---|---|
| `GET /demo/api/session` | ブラウザ別の一時状態を復元し、各Siteの `/protected` で再確認 |
| `POST /demo/api/session/login` | 入力された `username` / `password` でAを認証し、設定済みアカウントでB〜Dにログイン |
| `POST /demo/api/session/reset` | デモが作成したセッションをログアウトし、一時状態をクリア |

新規研究API、DB直接操作、囮使用APIは追加していません。性能評価画面・API・実行コードは従来のままです。

変更は `apps/demo/src/views/dashboard.ejs`、`public/demo.css`、`public/demo.js`、`src/app.ts`、新規 `src/demo-session.ts` / `src/demo-routes.ts`、デモ関連テストとREADMEだけです。

Phase 1検証（2026-09-16）：`npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot --maxWorkers=2` が成功（21ファイル・265テスト）。既定の並列実行では既存の評価テスト1件が5秒でタイムアウトしたため、コードを変更せず同時実行数を2にして確認しました。一時DBを用いた実ブラウザで誤パスワード、ログイン、Cookie表示、再読み込み、リセット、再ログイン、性能評価への往復を確認。1920×1080のログイン後画面はページ全体の縦横スクロールなしです。コピー文字列と失敗時の動作はClipboard APIを模擬した自動テストで確認し、実ブラウザでは両コピーの成功表示を確認しました。検証ブラウザのクリップボード読み取りでは内容を取得できなかったため、実際の貼り付け完了は未確認です。

## デモ画面からの性能評価

`http://localhost:4200/demo` の上部「性能評価」から `http://localhost:4200/demo/evaluation` へ切り替えます。初期表示は従来のシステムデモです。

```powershell
npm run start:demo
# システムデモのSite A〜Dも同時に使う場合
npm run start:demo:all
```

性能評価は「サービス数」「Processing Load」「Service Delay」「Warm-up」「測定試行回数」を設定して「評価を開始」を押します。全体失効時間、実処理、待機、サービス内合計の平均・中央値・最小・最大・母標準偏差を表示します。成功／失敗数はwarm-upを除いたサービス要求の合計（サービス数×測定回数）です。CSV2種類とsummaryを保存できます。

条件はサーバー側で厳密に検証します。サービス数は1/5/10/20/50/100、負荷はlight/medium/heavy、遅延は0/20/100ms、warm-upは整数0〜20、測定は整数1〜100。余分なフィールド・数値文字列・任意コマンド・パスは受け付けません。初期値は1/light/0ms/warm-up 2/測定10です。

追加API（全て既存デモと同じX-Demo-Tokenを要求、cross-site拒否）:

- `POST /demo/api/evaluations`: 上記5条件で開始。202を返し、実行中の追加開始は409。
- `GET /demo/api/evaluations`: 最新30件の実行状態・条件・完了結果。
- `GET /demo/api/evaluations/:id/files/:name`: 完了したジョブのraw.csv、service-timings.csv、summary.jsonのみダウンロード。

ジョブは専用Nodeプロセスの固定エントリーポイント `evaluation/src/demo-worker.ts` から既存 `runBenchmarkScale` を直接呼び出します。shellやnpm CLIを文字列実行しません。cwdをリポジトリルートに固定し、demoをnpm workspace経由で起動しても動作します。Management・benchmarkは評価専用のものを自動生成し、従来のCLI、負荷定義、失効ロジック、CSV生成は変更していません。

比較グラフはライブラリなしのSVGです。負荷・遅延・warm-up・試行数・モデルが同じ結果だけを選び、サービス数別の全体失効時間平均を表示します。同じサービス数では最新の完了結果を使用します。1点でも表示でき、別の負荷条件を混ぜません。

制約: 実行中／完了／失敗のみをポーリング表示し、試行ごとの進捗・キャンセルは未実装。履歴はサーバー起動中の最新30件で、再起動すると画面履歴は消えますがevaluation/resultsのファイルは残ります。失敗時は既存ランナーが例外終了するため部分統計は表示しません。二重実行制御はこのdemoプロセス内で、別途起動したCLIとの同時実行までは防ぎません。学校で比較する際は他の評価を同時に実行しないでください。既存CLI同様、Pythonとmatplotlibによるグラフ生成環境も必要です。

画面はsummaryの数値を小数4桁へ丸めて表示します。サービス内時間の分布は全サービス×測定試行、全体時間は測定試行の分布です。単一利用者の複数セッション失効数と「成功したサービス数」を混同しないでください。

性能評価フロントエンドのブラウザ実測、CSV照合、安全性テストと完成判断は [完了報告書](evaluation/FRONTEND-EVALUATION-REPORT.md) を参照してください。

本実験の自動実行・集計には `npm run evaluate:full` を使用します。Processing Load評価とService Delay評価を分離し、warm-up、seed付き順序、途中保存・再開に対応しています。まず `npm run evaluate:full -- --dry-run` で計画を確認してください。既定の実行は36条件・1260試行です。測定定義、縮小smoke結果、本番用PowerShellコマンドは [本実験ランナー完了報告](evaluation/FULL-EXPERIMENT-REPORT.md) を参照してください。

MEDIUM / Delay 0msの独立した再現性検証には `npm run evaluate:zero-delay` を使用します。既定は6条件・210試行です。先に `npm run evaluate:zero-delay -- --dry-run` で確認してください。固定seed、Windows保存、A/B比較、実行コマンドは [Zero Delay Verification](evaluation/ZERO-DELAY-VERIFICATION.md) を参照してください。
