# PC復帰後の固定QRと自動復旧

2026-09-23追加要求: PCを閉じて開き直した後も、同じQRで利用を再開する。ユーザーの既存の開発・レビュー・マージ委任に基づくConstruction変更。公式AI-DLCの承認履歴を後付けしない。

## 原因と構成

ローカルアプリは生存していたが、Cloudflare Quick Tunnelは接続0となり、以前の一時ホストはDNS解決できなくなった。Quick Tunnelは起動時にランダムなホストを取得する開発用接続で、旧ホストを指定して再取得する仕組みではない。[Cloudflare公式](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

固定入口 `https://ima-work-git.github.io/ai-hack-agent/` を一度QR化する。入口は同じリポジトリの `live-endpoint` ブランチから、現在の接続先origin・更新日時・期限だけを取得し、アプリへページ遷移する。GitHub Pagesは静的な入口だけを配信し、音声・認証API・AI処理は従来のアプリが処理する。[GitHub Pages公式](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。

## 受入条件

- QR-01: トンネルのURLが変わっても、固定入口を含む同じQRから現在のアプリへ遷移する。元の一時ホストを含むQRは一度差し替える。
- QR-02: macOSのユーザーログイン時に専用LaunchAgentがアプリとトンネルを起動する。接続確認に連続失敗し、インターネット接続は生きている場合に復旧する。オフライン中は再起動を連打しない。
- QR-03: QR内のログイン用値はURLフラグメントからメモリへ読み、公開APIのリクエストやリポジトリに送らない。外部入力の転送先や任意queryを受け付けず、管理下の公開設定・許可したHTTPSホストだけを使う。
- QR-04: 既存の再利用QR期限・認証・費用集計・音声同意を維持する。PC再起動で期限を延ばさず、マイクや有料調査は勝手に開始しない。
- QR-05: プロセスの二重起動を防ぐ。他アプリのプロセスを停止せず、自分が起動した子だけを停止する。キーと会話データは公開しない。

## 運用と制約

PCの電源・ネット接続とユーザーログインが必要。スリープ中・電源OFF中の調査はできない。復帰と通信再確立には数分かかる場合がある。常時稼働は別のHTTPSサーバーへ移す作業が必要。

固定URLとログイン期限は別。ログイン用QRの有効期限は発行時に指定し、最大48時間。期限後は新しいログイン用QRが必要。アプリのキー・非公開保存領域を維持すれば、期限内のQRはプロセス再起動後も交換できる。端末の記憶はhostごとであり、接続先が変わったときはQRの値で再ログインする。

公開入口の取得失敗・期限切れは『PCの起動とネット接続を確認』『再確認』を表示する。遷移後の通信断はアプリ側またはブラウザーに表示される。Evenアプリ内で入口からの遷移後もSDKが接続できるかは、PC上の検証と区別して実機確認する。

### 起動・停止・更新

1. `npm run build`、`gh auth status`を確認。既存の手動起動サービスを終了する。
2. 非公開`.env.local`を準備し、`ZATSUDAN_CLOUDFLARED`に公式cloudflared実行ファイルの絶対パスを指定する。
3. `node scripts/install-public-service.mjs`で専用LaunchAgentを登録する。`--output /path/to/file.plist`なら設定ファイル生成だけで登録しない。
4. `.private/public-supervisor/status.json`と`service.log`で状態を確認。ログには秘密・発話本文を出力しない。
5. 停止は`launchctl bootout gui/$(id -u)/com.ima-work-git.zatsudan-master`。自動起動を解除するときは、その専用plistを`~/Library/LaunchAgents/`から別の保存場所へ移す。
6. コード更新時はビルド後に同じLaunchAgentを再起動する。非公開保存領域を削除しない。

公開入口はGitHub Actionsが`launcher/`だけを配信する。公開接続先は起動と復旧時に`gh`の既存認証で更新し、秘密・認証ハッシュ・トークンは記録しない。GitHub認証が切れた場合は自動更新できないので再ログインが必要。

## 検証記録

入口28件・復旧19件を含む870件の自動試験、型検査、資料リンク検査、配布ビルドが成功。別エージェントが公開先検証・秘密の扱い・所有する子プロセスだけの停止をレビューした。

このMacではLaunchAgentsへの書込権限が付与されず、作業フォルダからのサービス登録もbootstrap error 5で失敗した。そのためログイン時の自動起動は未登録。復旧supervisorを現在のセッションで起動する。スリープ復帰時は稼働中supervisorが復旧できるが、OS再起動・ログアウト後は手動起動または専用LaunchAgentの登録が必要。この環境で実施できなかった登録を完了扱いにしない。
