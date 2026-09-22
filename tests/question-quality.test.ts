import { describe, expect, it } from 'vitest';
import { isPoliteDisplayQuestion, isUsefulConversationQuestion } from '../src/shared/question-quality.ts';

describe('narrow conversation-question safeguards', () => {
  it.each(['Jev使うときの注意は？', 'OpenAI設立の印象は？', '木製を選んだ理由は？', 'TypeSafe AIのJev、気をつけてますか？', 'Jev、注意していますか？'])(
    'rejects a clipped short helper without globally rejecting the same full question: %s', short => {
      expect(isPoliteDisplayQuestion(short)).toBe(false);
      expect(isUsefulConversationQuestion(short)).toBe(true);
    });
  it.each(['Jevで試したい使い方はありますか？', '木製を選んだ理由は何ですか？', '展示で気になった作品はありました？', 'Jev、入力の扱いで気をつけた点はありますか？'])(
    'keeps a complete polite short question: %s', short => {
      expect(isPoliteDisplayQuestion(short)).toBe(true);
    });

  it.each([
    '本当にご自身で作ったんですか？',
    'なぜ試作機の展示で失敗したのですか？',
    'その失敗した原因は何ですか？',
    'それって意味あるんですか？',
    'そんなバカな仕様、誰の責任ですか？',
    'その技術の定義を説明できますか？',
    'すごいですね、成功の秘訣は？',
    'さすがですね、アプリで工夫した点は？',
    '以前から愛用しています、次の機能は？',
    'ずっとファンでした、登壇の予定は？',
    '以前お会いしましたね、アプリの近況は？',
    '投稿のきっかけは？',
    'どうでしたか？',
    'その話題、特に興味深かった点は何ですか？',
    'その話題について、気になった点はありますか？',
    '最近の投稿で紹介した内容、どのように活用してほしいと思っていますか？',
    '過去の投稿で特に印象に残った反応はありましたか？',
    '取締役COOとしての役割で、特に大切にしていることは何ですか？',
    'その活動で工夫した点は何ですか？',
    '当時、その活動で印象に残ったことは？',
    '取り組みについて教えていただけますか？',
    'よろしければ、感想はありますか？',
    '木製の試作機はどう作りましたか？どんな反応でしたか？',
  ])('rejects the complete unsuitable question: %s', question => {
    expect(isUsefulConversationQuestion(question)).toBe(false);
  });

  it.each([
    'その音声学習アプリ、特に試してほしい機能はありますか？',
    '木製の試作機、素材を選ぶときに大切にしたことは何ですか？',
    '翻訳の登壇で、特に伝えたかったことは何ですか？',
    '翻訳の展示で印象に残った反応はありましたか？',
    '当時、木製の試作機で試してみたかったことは何ですか？',
    'なぜその仕様にしたんですか？',
    '失敗からの学びを展示に取り入れた工夫はありますか？',
    '試作機のきっかけは何でしたか？',
    '素材の選び方、気に入っている点はありますか？',
    '展示で使った道具は、今も愛用していますか？',
    '展示の試作機、実際に触ってもよいでしょうか？',
    '木製の展示の話題で、気になった点はありますか？',
    '最近の投稿で紹介した音声学習アプリ、どんな場面で使ってほしいですか？',
    '過去の木製の試作機の展示で、印象に残った反応はありましたか？',
    'バカラの展示、気になった技法はありましたか？',
    '天才ピアニストの公演で、印象に残った場面はありましたか？',
  ])('keeps natural questions instead of banning entire words or question angles: %s', question => {
    expect(isUsefulConversationQuestion(question)).toBe(true);
  });
});
