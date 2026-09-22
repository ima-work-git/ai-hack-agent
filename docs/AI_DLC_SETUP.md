# AWS AI-DLC 導入準備ガイド（Codex・2人チーム）

確認日: 2026-09-22（日本時間）

**公式AI-DLC 2.9.0のCodex設定を生成済みです。業務テーマのワークフローは未開始です。** 開発ツールはCodex、約2人、所有者は `ima-work-git`。ローカル準備では設定・スキル・hooks・公式の空のワークスペースを生成しました。GitHubには再現用の小さなセットアップスクリプトを置き、公式配布物は各自の端末で取得します。

2026-09-22に、本リポジトリのローカル環境でも設定生成と版登録を完了しました。再診断はエラー0件・警告4件（hooks用のコマンド検索先、以前のフォルダ登録、更新確認キャッシュ未作成、未コミットの共有記録）。開始時に方式の選択を求められ、現在はMVP方式を推奨して回答待ちです。既存決定を引き継ぐ入口は [開発入力ブリーフ](PROJECT_BRIEF.md) です。hooksの実動作と正式な段階承認は未確認です。

## 準備時に実施したこと

- 公式の署名・チェックサム検証を通して、作業フォルダ内にv2.9.0を導入した。個人の既存設定は変更していない。
- 公式 `config` でCodex設定を生成し、公式 `config --pin` で2.9.0に固定した。
- 既存のChatGPTログインを確認し、共有設定のBedrock指定と特定モデル固定、2つのレビュアーのモデル固定を解除した。各自のモデルを引き継ぐ。
- 初期準備時（2026-09-21）の公式 `doctor` は59件成功・0件失敗。確認時の警告3件は、非対話環境のコマンド検索先、未コミットの共有ファイル、更新確認キャッシュ未作成。モデル実呼出やhooks実行は未確認。
- **残り：各自の実行コマンド導入、Codexのhooksの確認・承認、`$aidlc --doctor` と最初の小さいワークフローの確認。** 作業フォルダ内のバイナリはGitHubには含めない。

ローカル生成ファイルは[公式v2.9.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0)が生成したものです。モデル設定の変更箇所は `.codex/config.toml` と `.codex/agents/` 内の2レビュアー設定。更新時は `--dry-run` で差分を確認し、この調整を不用意に戻さないでください。上流ライセンスは[MIT-0](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/LICENSE)です。

## GitHubから使い始める

リポジトリをcloneし、Codex CLI・curl・Python 3を用意して、ルートで `sh scripts/setup-aidlc.sh` を実行します。公式インストーラーの検証を有効にしたままv2.9.0を導入し、設定生成・バージョン固定・診断を行います。個人のCodex認証は共有しません。新規設定だけモデル固定を解除し、既存の設定は上書きしません。途中で競合や診断失敗が出たら表示を確認してください。

公式の生成ファイルは自動でGitHubへ送信しません。人が差分を確認し、必要な共有仕様・監査記録をPRに含めます。以下は手順の詳細です。

## 1. 採用するものを区別する

| 対象 | 内容 | 本ハッカソンでの扱い |
| --- | --- | --- |
| AWS の AI-DLC 方法論 | Inception（意図・要件を具体化）、Construction（設計・実装・テスト）、Operations（デプロイ・運用）の 3 フェーズ。AI の提案と人の判断を繰り返す | 開発の進め方として採用する |
| `awslabs/aidlc-workflows` | 方法論を開発ツールで動かす公式公開実装 | 採用バージョンと開発ツールを決め、後述の手順で導入する |
| このキットの `docs/specs/` | ハッカソン向けに独自作成した、テーマ決定前から使える準備テンプレート | 公式仕様・公式の状態管理ファイルとは扱わない |

原典は [AWS AI-DLC 紹介記事](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)。現在の公開実装は、Initialization / Ideation / Inception / Construction / Operation の **5 フェーズ・33 ステージ**を持ち、選ぶワークフローによって実行範囲が異なります。原典の 3 フェーズと実装の 5 フェーズを同じ説明として混ぜません。[v2.9.0 Introduction](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/00-introduction.md)

## 2. 現行安定版を固定する

確認時点の GitHub `releases/latest` は **v2.9.0（2026-09-15 公開、コミット表示 `22f5d1b`）**に解決しました。大会中は全員この版に揃える案とします。検索結果に古い v1 系のリリース一覧が出る場合があるため、導入前にもリリース本体を確認してください。[v2.9.0 リリース](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0)

`main` は開発ブランチです。`latest` や `main` を毎回取得する手順にせず、バージョン付き URL と公式のプロジェクト固定機能を使います。新しい版へ変更する場合は、全員の版とドキュメントも一緒に更新します。`.aidlc-version` は今は手書きせず、導入時に公式コマンドで生成します。[v2.9.0 Install and Lifecycle](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/18-install-and-lifecycle.md)

## 3. Codex アプリと CLI の区別

AI-DLC v2.9.0 が導入手順を公開しているのは **Codex CLI 用の `codex` harness** です。このガイドの初回検証は、ターミナルで起動する Codex CLI で行います。アプリでリポジトリを開いただけでは、AI-DLC の導入完了とは扱いません。これはアプリに hooks がないという意味ではなく、AI-DLC の CLI 向け配布物が現在のアプリで同等に動くことまでは今回確認できていないためです。[AI-DLC Codex CLI ガイド](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/harnesses/codex-cli.md)、[OpenAI のアプリ／CLI コマンド案内](https://learn.chatgpt.com/docs/developer-commands)

| 入力する場所 | 入力例 | 用途 |
| --- | --- | --- |
| ターミナル | `codex --version` / `aidlc doctor` | CLI の版、AI-DLC 設定を確認する |
| Codex CLI を起動した後の入力欄 | `/hooks` | 読み込まれた hooks を確認・信頼する |
| 同じ Codex CLI の入力欄 | `$aidlc --doctor` / `$aidlc …` | AI-DLC の診断／ワークフローを呼び出す |

`$aidlc` はシェルに入力するコマンドではありません。アプリを併用する場合も、CLI で確認した後、別途アプリ側でスキルの認識、hooks の信頼、診断と承認待ちの動作を確認します。

## 4. 採用テーマで開発を始める前に決めること

- [ ] 要件の最終判断をする人、実装の統合をする人、提出担当を決める。兼任可。
- [ ] 2人それぞれの Codex ログイン方法、利用可能なモデル、利用上限を確認する。
- [ ] AI-DLC を進行する主担当を決める。最初の要件整理は全員で確認し、同じ要件を別々に承認しない。
- [ ] 開発に使う AI の予算と、作るプロダクトの API 利用予算を分ける。
- [ ] `docs/specs/` に課題、対象利用者、成功条件、人が承認する操作、デモの範囲を記入する。
- [ ] 外部サービスのキーを共有文書・GitHub・プロンプトへ貼らない。公開可能な架空データを準備する。

AWS の方法論採用だけで、プロダクトのホスティング先や推論サービスが AWS に決まるわけではありません。AI-DLC の開発ツール用プロバイダーと、成果物が使う OrcaRouter は別の設定として管理します。このガイドでは OrcaRouter を AI-DLC のプロバイダーに接続できるとは確認していません。公開実装自体はプロバイダー非依存ですが、配布設定には開発ツール別の既定値があります。[現行 README](https://github.com/awslabs/aidlc-workflows#pick-your-harness)

## 5. 導入手順（各自のマシン）

以下は **macOS / Linux 向け**。実行するとユーザー環境に `aidlc` と各開発ツール用ランタイムが入ります。AI-DLC のネイティブ導入経路自体は Bun / Node.js 不要ですが、Codex CLI の導入は別です。Windows は [v2.9.0 リリースの PowerShell 手順](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0)を使用してください。

### A. Codex と対象リポジトリを確認する

公開されたチームリポジトリを各自のマシンへ clone し、そのルートで次を実行します。

```sh
git rev-parse --show-toplevel
codex --version
codex login status
```

AI-DLC v2.9.0 の要件は **Codex CLI 0.145.0 以上**と **対象が Git リポジトリであること**です。準備時のローカル CLI は `0.153.4` と確認していますが、AI-DLC の実行確認は別です。2人の実際の CLI バージョンを記録し、初回確認に通った版に揃えます。`codex` がなければ [OpenAI の CLI 導入手順](https://learn.chatgpt.com/docs/codex/cli#getting-started)を使います。未ログインの場合は各自で `codex login` を実行します。ログイン情報を相手に渡して共有する必要はありません。[AI-DLC の前提条件](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/harnesses/codex-cli.md#prerequisites)、[OpenAI: codex login](https://learn.chatgpt.com/docs/developer-commands#codex-login)

### B. AI-DLC を固定版で導入する

プロジェクトのルートで、バージョン付きインストーラーをいったん保存して内容を確認します。

```sh
mkdir -p work/aidlc-bootstrap
curl -fSL https://github.com/awslabs/aidlc-workflows/releases/download/v2.9.0/install.sh -o work/aidlc-bootstrap/install.sh
```

確認後に導入します。

```sh
sh work/aidlc-bootstrap/install.sh --version 2.9.0
```

`aidlc` が見つからない場合は、インストーラーの PATH 案内に従って新しいシェルを開きます。次に、プロジェクトのルートで版を固定し、設定の変更予定を確認します。

```sh
aidlc version
aidlc config --pin 2.9.0
aidlc config --harness codex --dry-run
```

既存の `AGENTS.md` がある場合は、チームの指示を残して公式の管理ブロックだけが追加されるか確認します。公式 `config` は管理外の内容を保持します。競合が出たら、差分と所有者を確認して解消し、最初から `--force` を使わないでください。`AGENTS.override.md` が同じ階層にあると通常の `AGENTS.md` より優先されるため、読み込まれる指示も確認します。[AI-DLC の管理ブロック](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/18-install-and-lifecycle.md#root-integrations-and-ownership)、[OpenAI: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

変更予定を確認したら設定します。

```sh
aidlc config --harness codex
aidlc doctor
```

この時点の診断では、hooks の信頼など未完了の項目が表示される場合があります。次の C・D を終えてから再診断します。

### C. プロバイダーと共有／個人設定を確認する

AI-DLC の配布設定は Bedrock 向けの既定値を含みますが、今回の利用先を Bedrock と決めたわけではありません。各自が実際に使用する認証・プロバイダー・モデルを確認し、主エージェントだけでなく生成されたサブエージェント設定にも、利用不能な指定が残っていないか確認します。モデル銘柄はこのガイドでは固定しません。

**文書間の差に注意:** 現在の OpenAI 公式設定仕様では、プロジェクトの `.codex/config.toml` にある `model_provider` / `model_providers` などは無視され、プロバイダー設定はユーザー設定に置きます。AI-DLC v2.9.0 の案内と現在の Codex の仕様に差があるため、生成設定だけで接続成功とは判断しません。既存の `~/.codex/config.toml` を配布ファイルで丸ごと置換せず、必要な設定だけ各自の環境へ反映します。[OpenAI Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)

| 共有するもの | 個人の環境に残すもの |
| --- | --- |
| `.aidlc-version`、チームの `AGENTS.md`、レビュー済みの生成 hooks・skills・ルール、公式の要件・設計・監査記録 | Codex / AWS / OrcaRouter の認証情報、API キー、個人の利用上限やアカウント設定 |
| 対応する Codex CLI バージョン、利用可能な範囲で合意したモデル・実行方針 | `~/.codex/config.toml`、認証キャッシュ、端末ごとの hooks 信頼状態、ローカル絶対パス |
| 公式で生成したプロジェクト方針 `aidlc.settings.json`（利用する場合） | 公式の `aidlc.settings.local.json`（利用する場合）、個人カーソルと実行中のローカル状態 |

プロジェクト設定は信頼したリポジトリでのみ読み込まれます。公開リポジトリに設定を置いても、各自の認証と信頼操作は完了しません。[OpenAI Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)

### D. Codex CLI で hooks を確認する

プロジェクトルートで `codex` を起動し、プロジェクトを信頼します。現在の CLI では `/hooks` を開き、AI-DLC の生成 hooks の内容・実行コマンドを確認して信頼します。CLI の版によって起動時の確認画面が出る場合は、その案内に従います。信頼は変更された hook 定義に対して再確認が必要です。[OpenAI Hooks](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

既存の個人 hooks も読み込まれるため、同じ処理が二重に登録されていないか確認します。信頼情報を相手の端末からコピーする手順にはせず、各自で確認します。次に Codex CLI の入力欄で `$aidlc --doctor` を実行し、ターミナルの `aidlc doctor` も再確認します。診断が通らない場合は、表示された未完了項目を解消します。

## 6. 最初の起動と仕様の受け渡し

最初は1人が AI-DLC を進行し、もう1人が要件と提案を一緒に確認します。Codex CLI の入力欄へ、次の独自開始文例を確定情報に合わせて入力します。

```text
$aidlc AI HACK の「業務を自律化する AI エージェント」を2人で開発します。
まず docs/specs/ の準備資料と大会の提出条件を読み、未確定の内容を質問してください。
テーマはEven G2を使った会話中の人物・会社調査です。懇親会や打ち合わせでの立ち話を対象にします。
既存G2試作の接続方式を再利用し、docs/EVEN_G2_INTEGRATION.mdも読んでください。
サービス名は未定、実機接続・STT・調査AIの今回の動作は未検証です。
最初に、残り時間で実行可能なワークフローを提案してください。
テーマ、MVP、受入条件、人の承認が必要な操作をチームが確認するところまで進めてください。
セキュリティ、費用上限、障害復旧、自律性の評価方法を要件に含めてください。
準備テンプレートを、公式の状態や承認済み成果物とみなさないでください。
公式成果物ができたら、準備資料から参照できるようにしてください。
```

テーマが決まっていても、詳細要件と既存実装の再利用範囲が未確定のため `express` を固定しないでください。公式では Express は既に要件が分かっている仕事向けで、発想整理や設計の一部を省きます。v2.9.0 の Classic は Build and Test までの 18 ステージで、運用は対象外です。短期ハッカソンでも、採用ルートに含まれないデプロイ・停止・復旧の確認はチームの提出準備に残します。[Workflow Profiles](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/workflow-profiles.md)

## 7. 2人で使うときの導入順

1. 主担当が第5節を実施し、診断と小さな初回実行を確認する。
2. もう1人が生成差分をレビューする。公式生成物から秘密情報・個人情報・個人の絶対パスを除外し、必要な共有ファイルを PR で取り込む。
3. もう1人も自分の clone で同じ固定版を導入し、`aidlc config --pin 2.9.0` と診断を実行する。共有設定を勝手に再生成せず、設定の追加・更新が必要なら主担当と同じ版で dry-run を確認する。
4. 認証、プロジェクトの信頼、hooks の信頼はそれぞれの端末で完了する。相手の成功結果だけで完了にしない。
5. 最初の要件・設計の承認は一緒に行う。開始時は主担当が AI-DLC の実装を進め、もう1人はレビュー・検証・提出資料を担当する。両者で実装する場合は次の公式 Unit 分担を設定する。

これは小規模チーム向けの運用案です。公式の状態ファイルを同時に手編集したり、同じ Intent を2人が独立して先へ進めたりしません。公式の並行実装は、承認済みの Unit 依存関係と team ownership を用意し、各自の clone で Unit を claim して進めます。通常のブランチ作成だけではこの設定の代わりになりません。利用する場合は [Workshop / Multi-Team の手順](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/workshop-mode.md)を確認します。GitHub の共同編集者への招待は、Codex の利用権や API キーの共有にはなりません。

## 8. 準備資料と公式生成物の置き場

| 場所 | 用途 | 作成者・更新方法 |
| --- | --- | --- |
| `docs/specs/` | 本キット独自の事前整理と審査・提出に向けた補助資料 | チームが更新。正式要件との対応リンクを持つ |
| `aidlc/` | v2.9.0 の公式ワークスペース | 公式設定とワークフローが作成・管理 |
| `aidlc/spaces/default/intents/<日付>-<名称>/` | 公式の要件、設計、状態、監査履歴 | AI-DLC の進行に従って生成 |
| `aidlc-docs/` | 過去の案内との混同を避けるための予約扱い | 本キットでは作らない。現行の標準生成先として案内しない |

現行実装の保存先は `aidlc/` です。`aidlc-state.md`、`intents.json`、現在位置のカーソル、監査ファイル、生成済みを装う設定ファイルを手作りしません。AI-DLC 開始後は、公式成果物を正式な要件・設計の参照先にし、`docs/specs/` に同じ仕様の別コピーを維持しない運用にします。[Spaces and Intents](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/03-spaces-and-intents.md)

`aidlc/` 全体を Git の除外対象にしないでください。公式は状態・成果物と監査記録の共有を想定し、個人のカーソル等を分けています。公式 `config` が作成する除外設定をレビューします。公開する前には、公式生成物も含めて秘密情報・個人情報がないか確認します。[State and Audit](https://github.com/awslabs/aidlc-workflows/blob/v2.9.0/docs/guide/10-state-and-audit.md)

## 9. 導入完了の確認欄

以下は各メンバーが自分の端末で埋める確認欄です。準備担当の実施結果は冒頭に記録しました。

- [ ] `aidlc version` で採用版が表示された。
- [ ] 2人の Codex CLI バージョンが要件を満たし、記録した版に揃った。
- [ ] 公式コマンドで生成した `.aidlc-version` を共有した。
- [ ] `aidlc doctor` とツール内の診断に失敗項目がない。残る警告の意味も確認した。
- [ ] 2人それぞれが Codex の認証、プロバイダー、権限、費用上限、hooks の信頼を確認した。
- [ ] 最初のワークフローで要件確認と人の承認待ちが動いた。
- [ ] 公式の成果物・状態・監査記録が実際に作られた。
- [ ] 別メンバーが clone して同じ版で資料を読み、次の作業を理解できた。

診断だけでは外部モデルへの接続成功や課金設定は保証できません。実行結果と費用は最初の小さな作業で確認します。進行中の状態ファイルを書き換えて「完了」にしたり、停止理由が不明なまま保護を無効化したりせず、公式の診断と表示された修正手順を使用します。

## 10. 未確認事項

- 各メンバーの OS・Codex CLI の実際の版・ログイン状況。
- 各アカウントの API 利用可否、残額、利用上限、組織の権限設定。
- 各メンバーの通常環境での実行コマンド検索先、hooks、初回ワークフローの実動作。
- Codex デスクトップアプリでの AI-DLC v2.9.0 配布物の動作互換性。
- OrcaRouter と開発ツールの直接接続可否。成果物側の利用要件とは分けて確認する。
- `main`・タグ付き AI-DLC 文書・現在の Codex 公式文書には更新差がある。AI-DLC 固有の操作は採用版、Codex 本体の設定と信頼は実際の CLI に対応する OpenAI 公式仕様と実行結果で判断する。

AI-DLCはAWS公式資料、CodexはOpenAI公式資料を参照しました。公式ツールの導入・プロジェクト設定・診断まで実施済み。モデルAPI呼出、業務ワークフロー、個人設定への書き込みは実施していません。
