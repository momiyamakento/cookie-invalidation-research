# Campus SNS 研究デモ

## 起動

リポジトリルートで次を実行します。

```powershell
npm run demo
```

- 利用者画面: http://localhost:4200/
- Cloud Drive（手入力ログイン）: http://localhost:4200/cloud-drive
- 攻撃者画面: http://localhost:4201/
- Management Server: http://localhost:4100/health

2画面は同じブラウザの別タブで開いてください。`localhost` と `127.0.0.1` を混在させたり、別ブラウザやシークレットウィンドウを使ったりすると、デモ状態を共有できません。

既にManagement ServerとSite A〜Dが起動済みの場合は `npm run start:demo` だけでも起動できます。利用者ポートは `DEMO_PORT`、攻撃者ポートは `DEMO_ATTACKER_PORT` で変更できます。

## 発表時の操作

1. 利用者画面で任意のユーザー名とパスワードを入力してCampus SNSへログインします。
2. 「Cloud Driveを開く」で別タブを開き、任意のユーザー名とパスワードでログインします。Campus SNSへ戻り、「Store・Portalにログイン」を押します。
3. 4サービスが「ログイン中」になったことを確認し、「ブラウザのCookieを見る」で2つの自然な名前のCookieを示します。
4. 攻撃者画面で「Cookieを窃取」を押します。
5. 1つ目のCookieをコピーし、入力欄へ手動で貼り付け、「Cookieでアクセス」を押します。パスワードなしで本人用情報が表示されます。
6. 2つ目のCookieをコピーして同様に使用します。囮Cookie検知、Management通知、利用者特定、4サービスへの失効要求と完了を確認します。
7. 最初のCookieをもう一度貼り付けます。「Session Expired」となり再利用できません。
8. 利用者画面がログイン画面に戻ることを確認します。Cloud Driveのタブも約1.5秒間隔で状態を確認し、資料一覧を消してログイン画面へ戻ります。
9. 「デモをリセット」で初期状態へ戻し、再実演できます。

Campus SNS（Site A）だけにログインしている場合は、手順2を省略しても囮Cookieを使用できます。未表示・未ログインのサイトも含めてA〜Dへ失効要求を送り、同一利用者の別ブラウザのセッションも失効します。元々未ログインのサイトは未ログインのまま表示し、全サイトの失効処理が成功すると完了になります。

## 実装上の根拠

- Campus SNSの正規セッションと囮CookieはSite Aが実際に発行します。
- 囮Cookie使用はSite Aの既存 `/__research/decoy-use` に到達します。
- Management Serverは既存mappingから同一利用者のSite A〜Dを解決します。
- 一括失効はManagement Serverから各Siteの既存 `/internal/v1/sessions/revoke` を呼びます。
- UIの完了状態はManagementの処理結果と、保存済みCookieが各Siteで401になることを確認してから表示します。
- Cookie窃取はデモプロセス内の一時メモリでのみ再現し、外部URL・実ブラウザCookie DB・認証情報にはアクセスしません。

Campus SNSに入力した任意の名前は表示用の一時デモIDです。研究DB側では既存の評価用アカウントをアダプターが使用し、研究データやmappingを作り直しません。リセットはデモ中に発行したセッションとデモプロセス内の一時状態だけを対象にします。

Cloud DriveもCampus SNSと同様、任意のユーザー名とパスワードで操作できる発表用デモです。入力した名前は表示用として一時保存し、Site Bの実セッションは設定済みの研究用アカウントで発行します。画面のフォルダーやファイルは表示用のサンプルです。同じブラウザ・同じホスト名のタブで開いてください。Site A/B/Cのいずれの囮Cookie検知でもSite Bのサーバー側セッションが失効します。
