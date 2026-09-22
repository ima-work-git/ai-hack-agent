/** A conservative lexical guard for conversation suggestions, not a classifier
 * of people or whole sources. Reject the complete fact/question; never remove
 * a sensitive phrase and turn the remainder into a different assertion. */
const sensitiveJapanese = /ワクチン|副反応|副作用|妊娠|出産|不妊|生殖|病気|病名|疾患|持病|投薬|服薬|医療|治療|診断|感染症|コロナ|癌|がん|うつ病|糖尿病|アレルギー|腫れ|手術|入院|通院|宗教|信仰|性的|性交|性行為|性指向|性自認|セックス|避妊|中絶/u;
const sensitiveEnglish = /\b(?:vaccin(?:e|es|ation|ations|ated)|side[ -]?effects?|adverse[ -]?(?:effects?|reactions?)|pregnan(?:t|cy|cies)|fertility|infertility|reproductive|diseases?|illness(?:es)?|diagnos(?:is|es|ed|tic)|medicat(?:ion|ions|ed)|prescription|medical|health(?:care)?|treatment|therapy|cancer|diabetes|depression|allerg(?:y|ies|ic)|covid(?:[ -]?19)?|coronavirus|swelling|surgery|hospitali[sz](?:ed|ation)|religio(?:n|us)|faith|sexual(?:ity)?|sex|contraception|abortion)\b/iu;

export function isAllowedConversationTopic(...texts: (string | undefined)[]): boolean {
  return texts.every(text => {
    if (text === undefined) return true;
    const normalized = text.normalize('NFKC');
    return !sensitiveJapanese.test(normalized.replace(/\s+/gu, '')) && !sensitiveEnglish.test(normalized);
  });
}
