/** Search/correction candidates, not an identity-verification allowlist.
 * Names/readings below were checked against the linked primary profiles on
 * 2026-09-22. A romanized reading is transliterated to kana, not a quoted furigana.
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
