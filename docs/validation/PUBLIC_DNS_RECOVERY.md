# 公開監視の名前解決回復

2026-09-23。[Issue #32](https://github.com/ima-work-git/ai-hack-agent/issues/32)、[固定QR仕様](../specs/05_STABLE_QR_RECOVERY.md)。

## 検出した問題

PR #31の公開更新時、新しいQuick Tunnelの公開DNSとHTTPSサービスは正常なのに、MacのOS resolverを使う`dns.lookup`が`ENOTFOUND`を返した。`dns.resolve4`とDNSサーバーへの問い合わせは公開IPv4を返し、取得したIPへ元hostnameのTLS接続を行うと、公開`/api/status`と新しい画面を取得できた。

監視がこのDNS失敗をトンネル障害として扱い、5分の猶予後に正常なURLを再生成するため、固定QRが停止した古いURLへ進む問題が発生した。ネットワーク権限のある実行でも再現した。OS内の負キャッシュ等の詳細原因を断定するものではない。

## 修正の範囲

通常fetchの原因が`ENOTFOUND`または`EAI_AGAIN`のときだけ、厳密に許可した`https://<単一名>.trycloudflare.com/api/status`へ代替確認を行う。`dns.resolve4`の公開IPv4を既存のsafeRequestで検証・接続固定し、TLS/SNI/Hostは元hostnameを維持する。固定IP、hostsファイル、システムのDNS設定は変更しない。

最初の確認と代替確認で全体10秒の期限と取消信号を共有する。代替確認は既存safeRequestの最大8秒、16KiB、リダイレクト禁止、成功ステータスとJSON形状の検証に従う。任意URL、内部IP、認証情報、別パス、通常HTTPエラーやTLSエラーに代替経路を広げない。APIキー・音声・会話データは送信しない。

## 確認結果

`npm test`は35ファイル・1,115試験成功。`npm run check`は型、サーバーimport、文書31件のリンク検査成功。独立レビューと関連111試験で、元hostnameのTLS、接続先制限、DNS処理の取消、5分の猶予後も正常なURLを再作成しないことを確認した。DNS処理が内側の8秒期限後に残る指摘は修正し、回帰試験で確認した。実際の問題が起きていた公開URLでも、新しいhealthProbeが正常を返すことを確認した。修正版の監視プロセスで`PUBLIC_ENDPOINT_UPDATED`を確認した。固定QRの実際の入口が参照するendpointと現在のoriginが一致し、公開`/api/status`と画面の200応答、新しい画面資材`index-DB-9C687.js`を確認した。G2実機の読み取り・表示は未確認。今回の変更は公開サーバーの監視に限定し、人物調査、質問生成、ASR、QRの認証期限は変更しない。

## 再接続後の既定DNSキャッシュ（2026-09-23、Issue #44）

ネットワーク再接続後、OS lookupだけでなく既定のresolve4もENOTFOUNDになる一方、1.1.1.1と8.8.8.8で公開IPv4を取得できることを確認した。そのIPv4へ元hostnameのTLSで接続すると、公開アプリとstatusがHTTP 200、実APIとストリーミングASRが有効、最新配布ファイルと一致した。音声そのものや有料APIは試していない。

既定resolverのENOTFOUND/EAI_AGAINに限り、status確認内で公開resolverへ問い合わせ直す。端末のDNS設定は変更しない。認証情報・音声・人物情報を問い合わせず、共有の期限・取消・公開IP検証・元hostnameのTLS・許可したstatusパスを維持する。正常な公開先をローカルDNSの古い否定応答で再発行し続けることを防ぐ。

DNS代替・共有期限と取消・許可URL/TLS・公開IP拒否を含む関連121試験、構文・型・文書チェックが成功。正常経路では公開resolverを使わず、別エラーや取消後には再試行しない。QR入口と利用期限は変更しない。
