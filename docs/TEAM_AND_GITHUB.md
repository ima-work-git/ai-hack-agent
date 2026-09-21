# GitHubとチーム運用

## 現在の設定（2026-09-21）

- `ima-work-git/ai-hack-agent` をPublicで作成済み。
- mainの保護を設定済み：PR、承認1名、変更時の古い承認の無効化、会話の解決、最新mainへの追従、`preparation-checks` の成功を必須にした。
- force pushとmain削除は許可していない。
- 2人目の招待前のため、管理者にも例外なく適用する設定はまだ有効にしていない。所有者は例外操作が可能。2人が参加したら例外の扱いを見直す。
- Secret Protectionとpush protectionが有効なことを画面で確認済み。
- 準備・仕様・実装・検証・提出物・提出の[6件のIssue](https://github.com/ima-work-git/ai-hack-agent/issues)を作成済み。招待は2人目のユーザー名待ち。
- CIは資料リンクと追跡ファイル名の確認だけ。プロダクトの安全性・品質の合格を意味しない。

## 作成と招待

1. 所有者（個人またはOrganization）とリポジトリ名を確定する。少人数なら既存個人アカウントでも開始できる。
2. 新規リポジトリを **Public** で作成する。既存の非公開リポジトリの公開設定は変更しない。
3. このキット一式を置き、`main` を既定ブランチにする。初回コミットには秘密情報と実データを含めない。
4. Settings → Collaborators（Organizationではアクセス管理）→ Add people で、確認済みのGitHubユーザー名を招待する。
5. 全員の受諾を確認する。招待を送っただけでは参加完了にしない。
6. 各自がcloneし、自分のブランチで台帳を更新してPRを1つ作る。

個人所有リポジトリのcollaboratorは書き込み権限を持つ。Organizationなら開発メンバーは通常 **Write**、管理者は必要な人だけにする。Public閲覧だけなら招待は不要。
参照：[個人リポジトリの招待](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository)・[Organizationの役割](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)。

## 初回コミット後の設定

- mainにPRを必須化する。2人以上なら他者1名のレビューを必須にする。1人なら自己承認で詰まらない設定にする。
- 新しい変更が入った場合の古い承認の無効化、会話の解決、force pushとmain削除の禁止を設定する。
- 同梱CIが1回成功してから `preparation-checks` を必須ステータスチェックに追加する。
- アプリ実装後は、本物のアプリテスト・型検査・ビルドをCIに追加し、必要なチェックを必須化する。
- Actions権限は読み取りを基本にする。デプロイの書き込み権限は対象ジョブだけに与える。
- GitHubの秘密情報検出・push protectionの利用状況を確認する。`.gitignore` は漏えい検出機能ではない。
- CODEOWNERSは担当確定後に実在するユーザー名で追加する。架空名は設定しない。
- コード・素材・依存ライブラリの公開条件を確認し、チーム合意後にライセンスを追加する。

Publicリポジトリのブランチ保護はGitHub Freeでも利用可能。設定UIと利用可能機能は所有者・プランに合わせて確認する。[公式説明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

## 仕様から実装まで

1. チームで課題と受入条件を確認する。AIには不明点と作業案を出してもらう。
2. 人が採用する要件・自律範囲・予算を決め、決定者と理由を記録する。
3. 1つのUnitを1つのIssueにし、担当、依存、対象ファイル、要件ID、テストを明記する。
4. `feat/<issue番号>-<短い内容>` などのブランチでAIと実装する。
5. PRに「仕様リンク・実装・確認した結果・未確認・復旧」を書く。
6. 別メンバーが受入条件とデモを確認し、mainへ取り込む。

仕様変更が起きたら理由と影響を先に記録する。要求されていない機能追加は保留する。
公式AI-DLC導入後の進行状態は公式ツールに管理させ、手で承認済み・完了済みに書き換えない。

## 同時開発の衝突を減らす

- 30〜60分ごとに小さく結合する。共有インターフェース（入力・出力・エラー形式）を最初に合意する。
- 1ファイルの主担当は1人。共有仕様・依存ロック・AI-DLC設定の同時編集を避ける。
- 各人・各AI作業は別ブランチ/作業コピーを使う。公式状態ファイルを都合よく丸ごと上書きしない。
- 15分詰まったら共有し、担当交代か範囲縮小を判断する。
- GitHub Projectsは任意。まずIssueと「未着手・作業中・レビュー・完了」の4状態で足りる。

## 公開前確認

- APIキー、認証情報、バウチャー、顧客情報、内部URLがファイルと履歴にない。
- スクリーンショットや録画にもキー・メール・他人の情報が映っていない。
- 誤って公開したキーは直ちに失効・再発行する。ファイル削除だけで解決した扱いにしない。
- ログアウト状態でREADME、動画、記事が開く。アプリが未公開でも再現手順は読める。
