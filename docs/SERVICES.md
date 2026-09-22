# 外部サービスの技術ガイド

この資料は公開APIの使い方とアプリの設計を説明する。個別アカウント、残高、認証情報、運用上限、内部の承認記録は含めない。設定手順は[実行ガイド](RUNNING.md)、検証結果と未達は[実API検証記録](validation/LIVE_API_VALIDATION.md)を参照。

## OrcaRouter

APIの接続先は `https://api.orcarouter.ai/v1`。Chat CompletionsのJSON出力で対象を抽出し、取得本文の候補文からカードを選ぶ。アプリは明示したモデルを使い、自動で別モデルへ切り替えない。

- [Quickstart](https://docs.orcarouter.ai/getting-started/quickstart)
- [モデル一覧](https://docs.orcarouter.ai/getting-started/models)
- [Chat Completions](https://docs.orcarouter.ai/api-reference/chat/create-a-chat-completion)
- [構造化出力](https://docs.orcarouter.ai/advanced/structured-outputs)
- [入力音声](https://docs.orcarouter.ai/advanced/audio-input)

`usage.cost_usd` は暫定報告額として扱い、確定額と区別する。金額がない応答を無料と推定しない。[公式費用仕様](https://docs.orcarouter.ai/operations/per-request-cost)。401/403・429・5xx・タイムアウトの扱いは[公式エラー仕様](https://docs.orcarouter.ai/operations/errors)とアプリの上限に従う。

## 公開情報の検索

Tavilyはbasic検索・最大5結果。検索抜粋を事実として採用せず、URLの安全性を検査して本文を取得する。[検索API](https://docs.tavily.com/documentation/api-reference/endpoint/search)・[料金体系](https://docs.tavily.com/documentation/api-credits)。

Xは入力に明示された単一のハンドル、またはHTTPSのプロフィールURLに対応する公開ユーザーを照会し、そのユーザー自身の投稿を最大5件取得する。保護アカウントを拒否し、投稿者IDを照合する。空の投稿一覧や障害の場合は、残りの検索枠でWeb調査へ進む。追加ページの自動取得、投稿、DM、フォロー操作は行わない。

- [ユーザー照会](https://docs.x.com/x-api/users/lookup/introduction)
- [投稿一覧](https://docs.x.com/x-api/posts/timelines/introduction)
- [従量料金](https://docs.x.com/x-api/getting-started/pricing)

Facebookの任意個人プロフィールや、ログイン必須ページを直接取得する機能はない。利用できる公式APIや公開サイトを優先する。日英表記・愛称の自動同一視や交友関係の推定も対象外。

## 音声・Even G2・配信

音声は利用者の開始と相手への説明・同意を前提とする。STT接続は実際の入力形式、対応モデル、日本語の固有名詞、保持条件、料金を確認する。アダプターの実装と実音声の検証は区別する。

Even G2は[既存接続方式](EVEN_G2_INTEGRATION.md)を引き継ぐ。スマートフォンのEven App内WebViewから届くHTTPSサーバー、認証、network whitelist、Cookie再開、実機での表示と音声を検証する。静的パッケージだけではNodeバックエンドは配布されない。

AWS AI-DLCは開発手法であり、ホスティング先の選択とは別。配信先を決める際は、最小権限、秘密管理、費用上限、会場からの接続性、保持・削除、停止と撤去の手順を確認する。[要件と検証計画](specs/03_BUILD_AND_VERIFY.md)に未達を残す。
