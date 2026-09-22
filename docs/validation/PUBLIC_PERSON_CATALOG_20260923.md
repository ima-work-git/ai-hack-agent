# 公開人物の名前検索候補の拡張（2026-09-23）

会話に出た名前だけで調査候補を作れるよう、既存18名へ11名を追加し、計29名にした。登録は公開プロフィール・名前の読み・確認できた本人Xへの手掛かりだけで、投稿内容や人物属性を固定データとして表示する機能ではない。未登録の人物も従来どおり一般Web検索の対象となる。API取得と本文評価を経た根拠が不足すれば質問を作らない。

## 新規候補と一次資料

| 公開名 | 読み・公開名の根拠 | 本人Xへの一次リンク |
| --- | --- | --- |
| こま | [本人note](https://note.com/ai_yorozuya)の公開名。実名のフルネームは未確認 | [本人記事](https://note.com/ai_yorozuya/n/n0631c3a30f0c)中の「こまさん」と `@ai_yorozuya` |
| 大谷翔平 | [MLBプロフィール](https://www.mlb.com/player/shohei-ohtani-660271)の英語名、[NPB](https://npb.jp/bis/players/01305137.html)の氏名と読み | 今回未確認のため未登録。Xを利用していないと断定するものではない |
| サム・アルトマン | [本人ブログ](https://blog.samaltman.com/)の英語名、[本人名義のOpenAI記事](https://openai.com/ja-JP/index/our-principles/)の日本語表記 | [本人ブログ](https://blog.samaltman.com/)の `@sama` |
| イーロン・マスク | [Teslaの本人紹介](https://www.tesla.com/ja_jp/elon-musk)の日本語・英語名 | [Tesla IR](https://ir.tesla.com/press-release/tesla-motors-releases-third-quarter-2013-financial-results)の本人Twitter `@elonmusk`。過去の公式開示として使用 |
| Andrej Karpathy | [本人サイト](https://karpathy.ai/)の英語名をカナ転写。アンドレイ・カーパシーは転写表記 | [本人サイトからリンクされたGitHub](https://github.com/karpathy)の `@karpathy` |
| 松尾豊 | [本人サイト](https://ymatsuo.com/)の日本語氏名と `Yutaka Matsuo` をカナ転写 | 未確認のため未登録 |
| 松本大 | [Monex本人対談](https://www.monexgroup.jp/jp/company/chronicle/25th/talk.html)と[同社株主総会資料](https://www.monexgroup.jp/jp/news_release/irnews/auto_20230530588932/pdfFile.pdf)の読み | 未確認のため未登録 |
| 村上世彰 | [本人財団のメッセージ](https://murakamizaidan.jp/concept/)と[本人著者プロフィール](https://bunshun.jp/bungeishunju/author/5d91c36b7765619c0a010000)の読み | 未確認のため未登録 |
| 岡野原大輔 | [本人サイト](https://hillbig.github.io/)の日本語氏名と `Daisuke Okanohara` をカナ転写 | [本人公開スライド](https://hillbig.github.io/AIEXPO2024spring_okanohara.pdf)の自己紹介 `@hillbig` |
| 西川徹 | [所属組織の紹介](https://www.preferred.jp/ja/company/leadership)と[同社英語略歴](https://www.preferred.jp/wp-content/uploads/2025/07/PFN_cofounders_biographies_en_20250701.pdf)の `Toru Nishikawa` をカナ転写 | 未確認のため未登録 |
| 深津貴之 | [所属組織の本人インタビュー](https://note.theguild.jp/n/n93dc7e7c12d8)と[就任先の発表](https://www.ssu.co.jp/news/2025/11/06/ai-dialogue-relations-team/)の読み | [同インタビュー](https://note.theguild.jp/n/n93dc7e7c12d8)の `@fladdict` |

役職・所属は資料の掲載時点のものを含む。会話で会社が明示されない場合に会社を追加せず、確認できていない本人Xも作らない。今回確認した会社の関係は検索の絞り込みにのみ使い、現職の証明として扱わない。

## 高野さんという呼称の扱い

ユーザーは大会責任者の呼称として「こまさん、高野さん」と `@ai_yorozuya` を指定した。公開一次資料から「高野」と本人アカウントを結び付けるフルネームや対応は、今回の調査では確認できなかった。

`userProvidedSearchNames` に「高野」「たかの」だけを分離して記録し、現在の発話に名前がある場合、スマホの検索候補に「こま（ユーザー指定の呼称・要確認）」を提示する。選択するまでは自動的に人物名を置換せず、確認済み公開別名・ASR誤記・本人根拠へ含めない。人物抽出側が「こま」へ先回りして置換しても、この来歴を省略しない。

「高野豆腐」「高野山」「高野太郎」などは候補にしない。別会社が明示された抽出結果からも、こまへ置換しない。ひらがな・カタカナの呼称は同じ検索候補として扱う。過去の発話にしか名前がない場合は提示しない。「こまを回す」「コマンド」や「4コマ」「一コマ」「ひとコマ」のような一般語・数量表現も公開人物に変換しない。

## 検証範囲

`tests/public-figure-expansion.test.ts` と既存の alias・人物解決・検索候補・審査員試験の計180件が成功。会社なしの漢字・カナ名、確認済みXと偽アカウントの区別、X未確認時の公式Web、短い一般語、ユーザー指定候補の表示来歴と自動採用の禁止を検証した。外部APIの有料呼出や実機音声試験は行っていない。実際の投稿取得・質問作成の成功は、登録や単体試験の成功とは別に確認する必要がある。
