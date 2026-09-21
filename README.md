# AI HACK — AI-DLC 開発準備キット

テーマが決まってから、すぐにチームで仕様を固めて開発を始めるためのひな形です。
対象テーマは「業務を自律化するAIエージェント」。約2人でCodexを使います。個別の業務、技術スタック、チーム名は未定です。

**現在の状態：Publicリポジトリ作成済み。プロダクト未実装、AWS公式AI-DLCの導入は未完了、2人目の招待はユーザー名待ち。**
このキットの独自テンプレートと、公式AI-DLCが生成する状態・監査情報は別物です。

リポジトリ：[ima-work-git/ai-hack-agent](https://github.com/ima-work-git/ai-hack-agent)

## 最初にすること

1. [準備チェックリスト](docs/PREPARATION.md)で担当者と未決定事項を埋める。
2. [GitHub・チーム運用](docs/TEAM_AND_GITHUB.md)に沿ってPublicリポジトリを作り、招待の受諾まで確認する。
3. [AI-DLC導入](docs/AI_DLC_SETUP.md)で全員のバージョンと利用AIツールを合わせる。
4. チームで30分集まり、[課題・要件](docs/specs/01_INTENT_AND_REQUIREMENTS.md)のMVPと受入条件を決める。
5. [エージェント設計](docs/specs/02_AGENT_DESIGN.md)で自律実行・人の承認・失敗時の動きを決め、1本の業務を最後まで通す。

**開発時の人間の承認と、完成したエージェントの利用者承認は別です。**
AI-DLCでは人が重要な開発判断を行います。プロダクト側では、どの操作をAIだけで進め、どこで人に戻すかを仕様化して審査で説明します。

## 資料一覧

| 目的 | 資料 |
| --- | --- |
| 準備の抜けを防ぐ | [準備・初期タスク](docs/PREPARATION.md) |
| 招待、分担、PR、main保護 | [チーム・GitHub](docs/TEAM_AND_GITHUB.md) |
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
