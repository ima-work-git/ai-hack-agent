# Even G2 — 既存方式の再利用と最初の接続確認

確認日：2026-09-22。機種はユーザー指定。以前のG2試作のコードを確認し、表示・入力の接続方式を再利用する方針。今回のコード移植、実機動作、音声認識、調査AIの動作確認はまだ行っていない。

## 引き継ぐ構成

G2 ⇄ Bluetooth ⇄ スマホのEven Realities App内WebView ⇄ 自分たちのバックエンド ⇄ STT / OrcaRouter / Web検索。

G2用プラグインはWebアプリ。以前の試作はVite・TypeScriptとEven Hub SDK `^0.0.12`、CLI `^0.1.13`、Simulator `^0.8.0`を宣言していた。これは当時の依存宣言で、今回の採用版や実機対応の証明ではない。移植時にlockfileの実解決版、スマホOS、Even App、firmwareを記録し、動作確認した版を固定する。[公式概要](https://hub.evenrealities.com/docs/get-started/overview)

| 既存試作で確認したもの | 今回の使い方 / 未対応部分 |
| --- | --- |
| ホスト確認 → SDK bridge待機 → startup page作成 | 接続adapterを選択移植。通常ブラウザでSDK呼出が待ち続けない方式を維持 |
| ヘッダ/本文/フッタの3段テキスト、上下操作でカード切替 | 人物名/調査結果/出典と操作案内へ変更。1回に1枚 |
| audioControlによる開始/停止、PCMイベント受信 | 同意確認と30秒上限を付け、実STTへ接続 |
| WebSocket送信口 | 認証・Schema検証・再接続・欠損検出・停止後の拒否を追加 |
| 表示の短時間集約、textContainerUpgrade | 更新を直列化し、失敗結果を確認。旧対象の遅延表示を防止 |
| ブラウザデモ、Simulator、QR、.ehpk生成手順 | 実機再検証を先に行い、デモと実機を明確に区別 |

以前の試作の解析は固定データのデモで、STT/LLMは未接続。既存コードの存在をハード接続成功や調査成功の証拠にしない。用途固有のデータ・秘密・設定を丸ごとコピーしない。

## 公式APIで確認した接続条件

- `waitForEvenAppBridge` → `createStartUpPageContainer` → `audioControl(true, AudioInputSource.Glasses)`。G2マイクではstartup pageが先に必要。停止は`audioControl(false)`。
- `audioEvent.audioPcm`は16kHz / signed 16-bit little-endian / mono。音声認識サービスは別に接続する。必要権限は`g2-microphone`。スマホマイクを代替にする場合は別権限・入力元表示が必要。
- 実際の型・戻り値は採用SDKの型定義で確認し、新しい資料だけを古いSDKに当てはめない。[Device APIs](https://hub.evenrealities.com/docs/build/device-apis)

画面は片眼576×288、緑色単色の固定コンテナ。Webページそのものはグラスに表示されない。既存の3段テキスト構成で、イベント捕捉を1コンテナに絞る。内容更新に`textContainerUpgrade`を使い、日本語・改行・長い名前を確認する。[Display](https://hub.evenrealities.com/docs/build/display)

WebViewからの通信には`app.json`の接続先許可とサーバー側CORSの両方が必要。プラグインの接続先は認証付き自社バックエンドに絞り、外部サイトの取得はサーバー側で検証する。WebSocketは接続時のOrigin・認証も確認する。[Networking](https://hub.evenrealities.com/docs/build/networking)

## 最初に通す小さな確認

1. G2・Even App・スマホOS・SDK版・利用者のDeveloper Modeを記録する。
2. 既存の接続/表示adapterを今回の最小アプリへ移植する。CLIでQRを出し、同一ネットワークのスマホからテスト起動する。会場ネットワークで端末間通信が遮断される場合は、到達可能な開発環境かprivate buildを使う。[Local Testing](https://hub.evenrealities.com/docs/test/local-testing)
3. 「接続確認」と架空の名前をグラスに表示。タップ/上下/終了操作と、書換え失敗時のスマホ通知を確認する。
4. 同意した短い音声だけ受信し、PCMバイト数と入力元を確認。音声をログに保存しない。停止後のデータを拒否する。
5. STTの短い確定文 → 人名/会社 → 1件の根拠付きカードを実APIで往復させる。これが完成するまで複数SNS連携を広げない。
6. G2切断、スマホ画面ロック、アプリ切替、通信断を試す。復帰で自動録音しない。スマホ縮退とカードの対象/時刻を表示する。

公式資料ではAndroidのWebView停止でメモリ状態・音声・通信が失われる可能性がある。以前のデモコードに自動復旧が実装済みとは見なさない。[Background & Lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle)

切断したグラスに既に残った表示はサーバーから消せない場合がある。各カードに対象と時刻を含め、実機で残留表示を確認する。停止/復帰後に旧カードを新しい調査結果として送り直さない。

## 共有する結果

| 項目 | 現在 |
| --- | --- |
| 既存接続・表示コードの確認 | 済み |
| 今回への移植、SDK版固定 | adapter実装、SDK 0.0.12固定 |
| 実機の文字表示・操作・PCM受信 | 未検証 |
| STT・OrcaRouter・Web検索接続 | adapter実装・模擬試験済み、実API未検証 |
| ロック/切断/再接続・遅延結果棄却 | SDK模擬試験済み、実機未検証 |
| 秘密のないパッケージ生成 | 静的UIを生成済み、バックエンドを含まない |

この資料は過去の方式を引き継ぐための設計入力。実装順と証拠は[実装・検証](specs/03_BUILD_AND_VERIFY.md)で管理する。

最新の証拠は[実装検証記録](validation/MVP_IMPLEMENTATION.md)、接続方法と配布版の制約は[実行ガイド](RUNNING.md)を参照。
