/** Search/correction candidates, not an identity-verification allowlist.
 * Names/readings below were checked against the linked primary profiles on
 * each record's checkedOn date. A romanized reading is transliterated to kana,
 * not a quoted furigana.
 * commonASRHomophones are possible correction prompts (not measured error rates,
 * verified aliases, or permission to silently replace a name in raw speech).
 * A same-sounding/private person may be intended. Resolve ambiguity separately;
 * re-fetch evidence before adopting facts. Unlisted people still use Web discovery.
 */
export interface PublicFigureCatalogEntry {
  readonly id: string;
  readonly canonicalName: string;
  readonly kana: string;
  readonly publicNames: readonly string[];
  readonly commonASRHomophones: readonly string[];
  /** User-supplied event nicknames, NOT public aliases or ASR homophones.
   * Search choices may offer these with explicit provenance and confirmation;
   * identity grounding, resolution and source verification must ignore them. */
  readonly userProvidedSearchNames?: readonly string[];
  /** Keep an uncertain ASR spelling selectable even when a company corroborates it. */
  readonly asrCorrectionRequiresConfirmation?: boolean;
  readonly officialProfileUrl: string;
  readonly readingSourceUrl?: string;
  readonly readingBasis?: 'kana-primary-source' | 'romanized-primary-source';
  readonly xHandle?: string;
  readonly xHandleSourceUrl?: string;
  readonly checkedOn: string;
  /** Corroborated relationship clues for disambiguation, never automatic
   * current-employment claims. Spoken company text must be checked separately.
   * aliases are search spellings, not assertions about registered legal names. */
  readonly companyClues?: readonly {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly sourceUrl: string;
  }[];
}

export const PUBLIC_FIGURE_CATALOG: readonly PublicFigureCatalogEntry[] = [
  {
    id: 'koma-ai-yorozuya', canonicalName: 'こま', kana: 'こま',
    publicNames: ['こまさん', 'ai_yorozuya', '@ai_yorozuya'], commonASRHomophones: [],
    // Supplied by the user as the event organizer's name. No primary source
    // establishing this surname-to-account relationship was found.
    userProvidedSearchNames: ['高野', 'たかの'],
    officialProfileUrl: 'https://note.com/ai_yorozuya',
    readingBasis: 'kana-primary-source',
    xHandle: 'ai_yorozuya', xHandleSourceUrl: 'https://note.com/ai_yorozuya/n/n0631c3a30f0c',
    checkedOn: '2026-09-23',
  },
  {
    id: 'shohei-ohtani', canonicalName: '大谷翔平', kana: 'おおたにしょうへい',
    publicNames: ['Shohei Ohtani'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.mlb.com/player/shohei-ohtani-660271',
    readingSourceUrl: 'https://npb.jp/bis/players/01305137.html', readingBasis: 'kana-primary-source',
    // No independently verified personal X account: retain ordinary Web discovery.
    checkedOn: '2026-09-23',
  },
  {
    id: 'sam-altman', canonicalName: 'サム・アルトマン', kana: 'さむあるとまん',
    publicNames: ['Sam Altman', 'サム アルトマン'], commonASRHomophones: [],
    officialProfileUrl: 'https://blog.samaltman.com/',
    readingSourceUrl: 'https://openai.com/ja-JP/index/our-principles/', readingBasis: 'kana-primary-source',
    xHandle: 'sama', xHandleSourceUrl: 'https://blog.samaltman.com/',
    companyClues: [{ name: 'OpenAI', aliases: ['オープンAI', 'オープンエーアイ'], sourceUrl: 'https://openai.com/index/introducing-openai-japan/' }],
    checkedOn: '2026-09-23',
  },
  {
    id: 'elon-musk', canonicalName: 'イーロン・マスク', kana: 'いーろんますく',
    publicNames: ['Elon Musk', 'イーロン マスク'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.tesla.com/ja_jp/elon-musk', readingBasis: 'kana-primary-source',
    xHandle: 'elonmusk', xHandleSourceUrl: 'https://ir.tesla.com/press-release/tesla-motors-releases-third-quarter-2013-financial-results',
    companyClues: [
      { name: 'Tesla', aliases: ['テスラ'], sourceUrl: 'https://www.tesla.com/ja_jp/elon-musk' },
      { name: 'SpaceX', aliases: ['スペースX', 'スペースエックス'], sourceUrl: 'https://www.tesla.com/ja_jp/elon-musk' },
    ],
    checkedOn: '2026-09-23',
  },
  {
    id: 'andrej-karpathy', canonicalName: 'Andrej Karpathy', kana: 'あんどれいかーぱしー',
    publicNames: ['アンドレイ・カーパシー', 'アンドレイ カーパシー'], commonASRHomophones: [],
    officialProfileUrl: 'https://karpathy.ai/', readingBasis: 'romanized-primary-source',
    xHandle: 'karpathy', xHandleSourceUrl: 'https://github.com/karpathy',
    checkedOn: '2026-09-23',
  },
  {
    id: 'yutaka-matsuo', canonicalName: '松尾豊', kana: 'まつおゆたか',
    publicNames: ['Yutaka Matsuo'], commonASRHomophones: [],
    officialProfileUrl: 'https://ymatsuo.com/', readingBasis: 'romanized-primary-source',
    checkedOn: '2026-09-23',
  },
  {
    id: 'oki-matsumoto', canonicalName: '松本大', kana: 'まつもとおおき',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://www.monexgroup.jp/jp/company/chronicle/25th/talk.html',
    readingSourceUrl: 'https://www.monexgroup.jp/jp/news_release/irnews/auto_20230530588932/pdfFile.pdf',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-23',
  },
  {
    id: 'yoshiaki-murakami', canonicalName: '村上世彰', kana: 'むらかみよしあき',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://murakamizaidan.jp/concept/',
    readingSourceUrl: 'https://bunshun.jp/bungeishunju/author/5d91c36b7765619c0a010000',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-23',
  },
  {
    id: 'daisuke-okanohara', canonicalName: '岡野原大輔', kana: 'おかのはらだいすけ',
    publicNames: ['Daisuke Okanohara'], commonASRHomophones: [],
    officialProfileUrl: 'https://hillbig.github.io/', readingBasis: 'romanized-primary-source',
    xHandle: 'hillbig', xHandleSourceUrl: 'https://hillbig.github.io/AIEXPO2024spring_okanohara.pdf',
    checkedOn: '2026-09-23',
  },
  {
    id: 'toru-nishikawa', canonicalName: '西川徹', kana: 'にしかわとおる',
    publicNames: ['Toru Nishikawa'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.preferred.jp/ja/company/leadership',
    readingSourceUrl: 'https://www.preferred.jp/wp-content/uploads/2025/07/PFN_cofounders_biographies_en_20250701.pdf',
    readingBasis: 'romanized-primary-source', checkedOn: '2026-09-23',
  },
  {
    id: 'takayuki-fukatsu', canonicalName: '深津貴之', kana: 'ふかつたかゆき',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://note.theguild.jp/n/n93dc7e7c12d8',
    readingSourceUrl: 'https://www.ssu.co.jp/news/2025/11/06/ai-dialogue-relations-team/',
    readingBasis: 'kana-primary-source',
    xHandle: 'fladdict', xHandleSourceUrl: 'https://note.theguild.jp/n/n93dc7e7c12d8',
    checkedOn: '2026-09-23',
  },
  {
    id: 'hiroyuki-nishimura', canonicalName: '西村博之', kana: 'にしむらひろゆき',
    publicNames: ['ひろゆき', 'Hiroyuki Nishimura'],
    // User-reported ASR example. This must remain outside publicNames/verified aliases.
    commonASRHomophones: ['広行'],
    officialProfileUrl: 'https://modein.co.jp/corp/',
    readingSourceUrl: 'https://cocreco.kodansha.co.jp/profile/supervisor/ukGIy/',
    readingBasis: 'kana-primary-source',
    xHandle: 'hirox246',
    xHandleSourceUrl: 'https://guild.to/news/弊社のメンバー達がノンタイトルで激突すること/',
    companyClues: [{
      name: '株式会社made in Japan',
      aliases: ['株式会社メイドインジャパン', 'メイドインジャパン', 'made in Japan', '株式会社made in Japan'],
      sourceUrl: 'https://modein.co.jp/corp/',
    }],
    checkedOn: '2026-09-22',
  },
  {
    id: 'takafumi-horie', canonicalName: '堀江貴文', kana: 'ほりえたかふみ',
    publicNames: ['ホリエモン', 'Takafumi Horie'], commonASRHomophones: [],
    officialProfileUrl: 'https://snsgroup.jp/',
    readingSourceUrl: 'https://the21.php.co.jp/author/1655',
    readingBasis: 'kana-primary-source',
    xHandle: 'takapon_jp', xHandleSourceUrl: 'https://columbia.jp/artist-info/horiemon/link.html',
    checkedOn: '2026-09-22',
  },
  {
    id: 'madoka-chiyoda', canonicalName: '千代田まどか', kana: 'ちよだまどか',
    publicNames: ['ちょまど', 'Madoka Chiyoda'], commonASRHomophones: [],
    officialProfileUrl: 'https://chomado.com/chomado/',
    readingSourceUrl: 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda',
    readingBasis: 'romanized-primary-source',
    xHandle: 'chomado', xHandleSourceUrl: 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda',
    checkedOn: '2026-09-22',
  },
  {
    id: 'kazunari-ito', canonicalName: '伊東和成', kana: 'いとうかずなり',
    publicNames: ['かずなり', 'MacopeninSUTABA', '@MacopeninSUTABA'],
    // User-reported ASR variants are correction candidates, never public aliases.
    commonASRHomophones: ['かすなり', '数なり', 'かつなり'],
    asrCorrectionRequiresConfirmation: true,
    officialProfileUrl: 'https://third-scope.com/about/',
    readingSourceUrl: 'https://ai-reskilling.jp/', readingBasis: 'kana-primary-source',
    xHandle: 'macopeninsutaba', xHandleSourceUrl: 'https://qiita.com/KNR109',
    companyClues: [{ name: '株式会社サードスコープ', aliases: ['サードスコープ', 'Third Scope'], sourceUrl: 'https://third-scope.com/about/' }],
    checkedOn: '2026-09-23',
  },
  {
    id: 'taishi-yamasaki', canonicalName: '山崎大志', kana: 'やまさきたいし',
    publicNames: ['Taishi', 'たいし', 'Taishi Yamasaki', 'taishiyade', '@taishiyade'],
    commonASRHomophones: [],
    officialProfileUrl: 'https://taishiyade.com/',
    readingSourceUrl: 'https://gist.github.com/Taishi-Y', readingBasis: 'romanized-primary-source',
    xHandle: 'taishiyade', xHandleSourceUrl: 'https://note.com/taishiyade/n/n64b013945dfc',
    companyClues: [{ name: '株式会社AlphaByte', aliases: ['AlphaByte', 'AlphaByte株式会社', 'アルファバイト'], sourceUrl: 'https://taishiyade.com/' }],
    checkedOn: '2026-09-23',
  },
  {
    id: 'tre-conigli', canonicalName: '宇佐美良治', kana: 'うさみりょうじ',
    publicNames: ['宇佐美 良治', 'tre_conigli', '@tre_conigli'], commonASRHomophones: [],
    officialProfileUrl: 'https://cyberace.co.jp/event/2259/',
    readingSourceUrl: 'https://www.wantedly.com/companies/company_5212273/post_articles/889192',
    readingBasis: 'kana-primary-source',
    xHandle: 'tre_conigli', xHandleSourceUrl: 'https://techplay.jp/event/973052',
    companyClues: [{ name: '株式会社CyberACE', aliases: ['CyberACE', 'サイバーエース', '株式会社サイバーエース'], sourceUrl: 'https://cyberace.co.jp/event/2259/' }],
    checkedOn: '2026-09-23',
  },
  {
    id: 'masayoshi-son', canonicalName: '孫正義', kana: 'そんまさよし',
    publicNames: ['Masayoshi Son'], commonASRHomophones: [],
    officialProfileUrl: 'https://group.softbank/about/officer/son',
    readingSourceUrl: 'https://www.softbank.jp/corp/aboutus/profile/officer/son/',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'hiroshi-mikitani', canonicalName: '三木谷浩史', kana: 'みきたにひろし',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://corp.rakuten.co.jp/about/management.html',
    readingSourceUrl: 'https://books.rakuten.co.jp/event/book/interview/mikitani_h_20090716/',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'susumu-fujita', canonicalName: '藤田晋', kana: 'ふじたすすむ',
    publicNames: ['Susumu Fujita'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.cyberagent.co.jp/corporate/directors/detail/id',
    readingSourceUrl: 'https://pdf.cyberagent.co.jp/C4751/lAG8/ELbd/Td7Z.pdf',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'yusaku-maezawa', canonicalName: '前澤友作', kana: 'まえざわゆうさく',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://racing.yusakumaezawa.com/',
    readingSourceUrl: 'https://corp.zozo.com/ir-info/files/pdf/shareholders-meeting_14.pdf',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'yoichi-ochiai', canonicalName: '落合陽一', kana: 'おちあいよういち',
    publicNames: ['Yoichi Ochiai'], commonASRHomophones: [],
    officialProfileUrl: 'https://trios.tsukuba.ac.jp/ja/researcher/3783',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'yusuke-narita', canonicalName: '成田悠輔', kana: 'なりたゆうすけ',
    publicNames: ['Yusuke Narita'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.rieti.go.jp/users/narita-yusuke/',
    readingBasis: 'romanized-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'tsuyoshi-morioka', canonicalName: '森岡毅', kana: 'もりおかつよし',
    publicNames: ['Tsuyoshi Morioka'], commonASRHomophones: [],
    officialProfileUrl: 'https://katana-marketing.co.jp/member/',
    readingSourceUrl: 'https://katana-marketing.co.jp/news/detail_1.html',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'tadashi-yanai', canonicalName: '柳井正', kana: 'やないただし',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://www.fastretailing.com/jp/about/company/profile_yanai.html',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'akio-toyoda', canonicalName: '豊田章男', kana: 'とよだあきお',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://global.toyota/jp/company/profile/executives/akio_toyoda.html',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'shinya-yamanaka', canonicalName: '山中伸弥', kana: 'やまなかしんや',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://www.cira.kyoto-u.ac.jp/j/research/yamanaka_summary.html',
    readingSourceUrl: 'https://www.cira.kyoto-u.ac.jp/j/pressrelease/nl/vol49/focus.html',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'sota-fujii', canonicalName: '藤井聡太', kana: 'ふじいそうた',
    publicNames: [], commonASRHomophones: [],
    officialProfileUrl: 'https://www.shogi.or.jp/player/sota_fujii',
    readingSourceUrl: 'https://kifulog.shogi.or.jp/kisei/2020/06/post-d68b.html',
    readingBasis: 'kana-primary-source', checkedOn: '2026-09-22',
  },
  {
    id: 'yoshiharu-habu', canonicalName: '羽生善治', kana: 'はぶよしはる',
    publicNames: ['Yoshiharu Habu'], commonASRHomophones: [],
    officialProfileUrl: 'https://www.shogi.or.jp/player/yoshiharu_habu',
    readingBasis: 'romanized-primary-source', checkedOn: '2026-09-22',
  },
];
