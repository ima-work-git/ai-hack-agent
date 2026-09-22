/** Narrow, question-only checks for clearly unsuitable conversation starters.
 * This is not a semantic quality or factuality classifier: the model must still
 * ground its interest in the selected source and avoid invented premises.
 * Reject the suggestion intact; never turn it into a universal fallback. */
export function isUsefulConversationQuestion(question: string): boolean {
  const text = question.normalize('NFKC').replace(/\s+/gu, '').trim();
  if (!text || (text.match(/\?/gu)?.length ?? 0) > 1) return false;
  const rude = /お前|あんた|(?:馬鹿|バカ|阿呆|アホ)(?:な|に|だ|です|じゃ|なの|みたい|か[?])|無能|くだらない|しょうもない|しょぼい|ダサい/u;
  const interrogation = /(?:誰の責任|責任は誰|言い訳|答えろ|教えろ|説明しろ|証明して|失敗(?:した)?(?:原因|理由))|(?:なぜ|なんで|どうして).{0,24}(?:失敗した|できなかった|やらなかった|しなかった)|(?:本当に|ちゃんと).{0,16}(?:ご自身で|自分で|理解して|分かって|わかって|知って)|(?:それ|その(?:仕事|活動|取り組み|投稿))って(?:意味|価値)(?:が)?(?:ある|あります)|(?:分から|わから|知ら)ないんですか|説明できますか|知ってますよね/u;
  const flattery = /さすが(?:ですね|です|の|[、,!])|天才(?:ですね|です|だ|すぎ|なん|じゃ|[、,!])|すごすぎ|凄すぎ|素晴らしすぎ|(?:すごい|凄い|素晴らしい)ですね|成功の秘訣/u;
  // Distinguish the wearer's invented personal claim from a respectful
  // question addressed to the other person, e.g.「愛用していますか？」.
  const assumedFamiliarity = /(?:ずっとファン|大ファン)(?:でした|です)(?:[、,。!]|が|ので)|(?:愛用しています|愛用しております|毎日使っています|毎日使ってます|拝見しています|拝見しております|使わせていただいています|読ませていただきました|読んだことがあります)(?:[、,。!]|が|ので)|(?:以前|前に)お会い(?:しました|しています)(?:ね)?(?:[、,。!]|が|ので)/u;
  if (rude.test(text) || interrogation.test(text) || flattery.test(text) || assumedFamiliarity.test(text)) return false;

  // Only whole, context-free templates are rejected. A concrete subject such
  // as「木製の試作機」keeps the same question angle eligible.
  const bare = text.replace(/^(?:(?:当時|以前|その後|20\d{2}年)[、,]?)/u, '')
    .replace(/^(?:もしよければ|よろしければ)[、,]?/u, '').replace(/[?。!]/gu, '');
  const genericSubject = '(?:(?:その|この|今回の|最近の|過去の|以前の)?(?:活動|取り組み|投稿|お仕事|仕事|事業|経験|イベント|こと|話題|話|件)(?:について|では|で|の|は|[、,])[、,]?)?(?:特に)?';
  const emptyAngle = '(?:工夫した点|工夫したこと|印象に残ったこと|印象に残った点|印象に残った反応|興味深かった点|気になった点|きっかけ|感想|意気込み|今後の展望)(?:は)?(?:何ですか|何でしょうか|ありましたか|ありますか|教えてください)?';
  if (new RegExp(`^${genericSubject}${emptyAngle}$`, 'u').test(bare)) return false;
  if (/^(?:最近|過去|以前|今回)の投稿で(?:紹介した|取り上げた|触れた)(?:内容|こと|話題)[、,](?:どのように|どう|どんな場面で)(?:活用|使って)/u.test(bare)) return false;
  if (/^[^、,。?]{1,30}としての役割で[、,]?(?:特に)?(?:大切にしていること|意識していること|心がけていること)は(?:何ですか|何でしょうか)$/u.test(bare)) return false;
  return !/^(?:活動|取り組み|投稿|仕事|事業|それ|そのこと)(?:について)?教えて(?:ください|いただけますか)$|^(?:何か面白い話はありますか|どんな工夫をしましたか|どんな気持ちでしたか|どうですか|どうでしたか|どう思いますか|何ですか|何でしたか|なぜですか|どうしてですか|教えてください)$/u.test(bare);
}

/** A short helper must still sound like a complete polite spoken question.
 * Rejecting it does not alter the source-backed full question. */
export function isPoliteDisplayQuestion(question: string): boolean {
  const text = question.normalize('NFKC').trim();
  //「製品名、気をつけてますか？」is an unexplained warning, not an
  // interested question. A concrete object/question angle is required.
  if (/(?:^|[、,])(?:気を(?:つけ|付け)て|注意して)(?:い)?ます(?:か)?\?$/u.test(text)) return false;
  return isUsefulConversationQuestion(text) && /(?:です|でした|でしょう|ます|ました|ません)(?:か)?\?$/u.test(text);
}
