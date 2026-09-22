# AI HACK — Even G2 会話中の調査アシスタント（名称未定）

懇親会や打ち合わせで出た人名・会社名をEven G2で捉え、AIが公開サイトや利用可能なSNSを調べ、出典付きの短い話題カードを表示するサービスです。サービス名は未定。約2人でCodex・AWS AI-DLCを使います。

2026-09-22にテーマ・Even G2・既存G2試作の接続方式再利用を決定し、ユーザーが提示済み要件を確認しました。レビューとマージはCodexへ委任されています。[決定記録](docs/DECISIONS.md)。**プロダクトは未実装・実機未検証です。**

**現在の状態：Publicリポジトリ・初期Issue・main保護・資料チェックCIを作成済み。採用テーマを仕様・開発分担・デモ台本へ反映。公式AI-DLC 2.9.0をCodex向けに導入するスクリプトを同梱。プロダクトは未実装、2人目の招待はユーザー名待ち。**
このリポジトリの仕様草案と、公式AI-DLCが生成する状態・監査情報は別物です。

初回利用時は各自の `aidlc` コマンドの利用準備、Codexのhooks承認、ツール内の診断を行ってください。進行担当のローカル環境ではMVPのワークフローを開始し、初期化を完了しました。要件確認は決定記録に基づき、公式の段階完了とは区別します。

2026-09-22：本リポジトリのローカル環境へ公式設定・版登録を適用し、診断はエラー0件。要件確認と開発の委任を受け、進行担当がMVP方式を選んで進めます。[開発入力ブリーフ](docs/PROJECT_BRIEF.md)に決定事項・未確認事項をまとめています。

リポジトリ：[ima-work-git/ai-hack-agent](https://github.com/ima-work-git/ai-hack-agent)

## 最初にすること

1. [準備チェックリスト](docs/PREPARATION.md)で担当者と未決定事項を埋める。
2. [GitHub・チーム運用](docs/TEAM_AND_GITHUB.md)に沿ってこのリポジトリへ参加し、招待受諾・clone・練習PRを確認する。
3. [AI-DLC導入](docs/AI_DLC_SETUP.md)を読み、`sh scripts/setup-aidlc.sh` で各自の端末へ公式2.9.0を導入する。
4. [Even G2連携](docs/EVEN_G2_INTEGRATION.md)で既存方式と未検証箇所を確認し、[課題・要件](docs/specs/01_INTENT_AND_REQUIREMENTS.md)のMVPと受入条件に沿って実装する。
5. [エージェント設計](docs/specs/02_AGENT_DESIGN.md)で自律実行・人の承認・失敗時の動きを決め、1本の業務を最後まで通す。

**開発時の人間の承認と、完成したエージェントの利用者承認は別です。**
AI-DLCでは人が重要な開発判断を行います。プロダクト側では、どの操作をAIだけで進め、どこで人に戻すかを仕様化して審査で説明します。

## 資料一覧

| 目的 | 資料 |
| --- | --- |
| AI-DLCで作業を開始・再開する | [開発入力ブリーフ](docs/PROJECT_BRIEF.md) |
| 準備の抜けを防ぐ | [準備・初期タスク](docs/PREPARATION.md) |
| 招待、分担、PR、main保護 | [チーム・GitHub](docs/TEAM_AND_GITHUB.md) |
| Even G2の既存方式を引き継ぐ | [G2連携と接続確認](docs/EVEN_G2_INTEGRATION.md) |
| 再利用コードの確認結果と修正候補を見る | [G2再利用確認記録](docs/validation/EVEN_G2_REUSE_AUDIT.md) |
| AWS公式ワークフローを導入する | [AI-DLCセットアップ](docs/AI_DLC_SETUP.md) |
| OrcaRouter・クラウドの利用準備 | [サービス準備](docs/SERVICES.md) |
| 作るものを決める | [課題・要件](docs/specs/01_INTENT_AND_REQUIREMENTS.md) |
| 自律性、権限、復旧を設計する | [エージェント設計](docs/specs/02_AGENT_DESIGN.md) |
| 作業分割、検証、運用 | [実装・検証](docs/specs/03_BUILD_AND_VERIFY.md) |
| 期限、提出先、提出確認 | [ルール・提出](docs/event/RULES_AND_SUBMISSION.md) |
| 審査で見せる証拠を決める | [審査証拠](docs/event/JUDGING_EVIDENCE.md) |
| 動画・プレゼンを準備する | [デモ・発表台本](docs/event/DEMO_AND_PITCH.md) |
| Qiita/Zennにまとめる | [記事ひな形](docs/event/ARTICLE_OUTLINE.md) |

## このリポジトリの使い方

- `docs/specs/` は事前検討用。公式ワークフローを起動したら採用済み内容を入力し、生成された仕様へのリンクを残す。二重に仕様を更新しない。
- 公式ワークフローの出力先・管理対象は[導入ガイド](docs/AI_DLC_SETUP.md)に従う。
- `.github/` にはIssueフォーム、PRテンプレート、資料チェック用のCIがある。
- `.env.example` は設定項目のひな形。実際のキーは `.env.local` など、Git対象外のファイルに保存する。
- アプリの起動方法、依存関係、テスト、構成図、デモURLは実装後にこのREADMEへ追記する。

資料のローカルリンクと追跡ファイル名の確認：

```sh
python3 scripts/check_preparation.py
```

この確認は仕様内容の承認、アプリのテスト、秘密情報の全検出を代替しません。
提出期限はユーザー提示の「9月22日15:00」。年・タイムゾーンを主催者に確認するまで、計画上は2026年9月22日15:00 JSTを仮置きします。

参照：[AWS AI-DLCの原典](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)・[AWS Labs公式実装](https://github.com/awslabs/aidlc-workflows)。公式リポジトリの複製ではなく、このハッカソン向けの独自準備キットです。
