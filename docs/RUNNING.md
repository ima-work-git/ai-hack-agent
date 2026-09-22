# 実行・設定・復旧

## まず架空データで動かす

Node.js 24、`npm ci` → `npm run dev` → `http://localhost:4173`。
「架空の会話を入力」から通常／同姓同名／検索障害／根拠なしを確認できます。デモ結果は実APIや実機の証拠ではありません。

本番相当のローカル配信は `npm run build` → `npm start`。サーバーの同一originから画面とAPIを配信します。

## 実APIを有効にする

`.env.example`を`.env.local`へコピーします。鍵をこのリポジトリ、ブラウザー用の`VITE_*`変数、記事、スクリーンショットに含めないでください。

1. `APP_ACCESS_CODE`に16文字以上の利用コードを設定。
2. `ORCAROUTER_API_KEY`、構造化出力対応の`ORCAROUTER_MODEL`、`TAVILY_API_KEY`を設定。
3. USDの1回／1日／大会全体の予算、およびLLM・検索・本文取得の最大見積額をすべて設定。無料の直接ページ取得は`MAX_PAGE_CALL_USD=0`を明示。
4. 必要ならX読取トークン、`X_API_ENABLED=true`、ユーザー1件＋投稿最大5件の合計最大額を設定。自分の開発アカウントが検索対象になるわけではありません。
5. 設定を確認して`AGENT_LIVE_ENABLED=true`、サーバーを再起動。画面で利用コードを入力し「実APIで調査」を選択。

モデル名や価格は固定の推測値を置いていません。選択モデルの最大入出力と現在のサービス料金から、1操作の最大額を保守的に決めます。APIが実費を返さない場合、成功・失敗とも予約を残します。予算ファイルを消して課金制限をリセットしないでください。X利用可能・チャージ済みという申告と、鍵の実接続成功は別です。

OrcaRouterは [Chat Completions](https://docs.orcarouter.ai/api-reference/chat/create-a-chat-completion) と [構造化出力](https://docs.orcarouter.ai/advanced/structured-outputs) を使用します。モデルが非対応ならエラーで止まり、無制限な修復や勝手なモデル変更をしません。

Tavilyはbasic検索を最大5結果に固定します。検索抜粋をそのまま根拠にせず、実際の本文を取得します。JavaScript必須ページ、ログイン壁、Facebook、Xの直接スクレイピングには対応しません。Xは入力に明示した`@handle`のみ公開APIで調べ、保護アカウントを拒否します。名前からの推測ハンドルや交友関係の推測は行いません。

## 音声

`ORCAROUTER_STT_MODEL`に[input_audio対応モデル](https://docs.orcarouter.ai/advanced/audio-input)、`MAX_STT_CALL_USD`に1回の最大額を設定します。または`STT_API_BASE_URL`・`STT_API_KEY`・`STT_MODEL`をすべて指定したOpenAI互換STTを使用できます。明示STTが優先、部分設定なら停止です。

相手への説明と同意後、画面の同意チェックと音声入力ボタンで開始します。G2接続時はG2、未接続時はスマホのマイクです。30秒以内に停止し、16 kHz・mono・PCM16のWAVをサーバー経由でSTTへ送ります。音声はディスクへ保存しません。中止・背景移行・ページ離脱では送信を開始しません。送信済みの外部サービス処理を撤回できるとは保証しません。

STTと直後の調査は同じ要求UUIDの予算を共有します。調査の20秒制限はSTT後から計測、STT自体は8秒で停止します。スマホのWeb Audioと実際の音質は実機未検証です。

## Even G2

既存アプリと同じEven Hub SDK 0.0.12のWebViewブリッジを使います。画面から明示接続し、1枚ずつ短文を表示します。SDK受付の成功とグラス上で読めることは区別します。

現在の確認経路は、UIとAPIを同じoriginで配信するサーバーをEvenアプリのローカルテストQRから開く方式です。スマホからlocalhostは開けません。端末から届くサーバーの`HOST`・`APP_ORIGIN`を設定し、利用コードを必須にします。LANに開く場合も鍵や保存データの公開は禁止です。実APIを使う配信はHTTPSにしてください。

```sh
npm run build
npm run pack:g2
```

`.ehpk`は静的画面の梱包確認用で、Nodeバックエンドを含みません。配布版にはHTTPSバックエンドURL、manifestのnetwork whitelist、WebView originに対応するCORS・認証・Cookie再開の検証が必要です。現時点で「このパッケージだけでG2の調査が使える」とは扱いません。min_app_versionは設定値であり、実対応確認済みではありません。[公式ローカル試験](https://hub.evenrealities.com/docs/test/local-testing)・[通信権限](https://hub.evenrealities.com/docs/build/networking)。

## 保存と復旧

- `.private/sessions/`はAES-256-GCMで暗号化。鍵は`.private/.session-key`、端末のファイル権限で保護します。鍵と暗号文を同時に盗まれた場合まで保護する設計ではありません。
- セッションは最大15分。明示終了で個人データを削除し、期限切れも掃除します。再ログインでBearerを更新し、前の結果は「再開」操作後のみ表示、マイクは再開しません。
- 中断時は手動で再調査します。遅れた旧結果は破棄。G2のSDK応答不明や切断時はスマホへ縮退し、実機の残留表示が消えたと断定しません。再接続は明示操作です。
- 429・5xx・本文取得失敗は残る情報へ縮退します。同じ外部操作の無条件再試行はせず、上限内で別資料や追加調査を選びます。未確認の事実は表示しません。
- 予算記録は匿名UUID・UTC日次集計。再起動しても予約を維持。残ったロックや破損ファイルはfail-closedで止めます。実行プロセスが残っていないこととサービス明細を確認してから復旧してください。
- 既定は端末内のみで起動します。公開デプロイ・G2実測・実API疎通・実費照合は未完了です。
