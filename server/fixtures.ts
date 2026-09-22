import type { Assessment, EvidenceSource, Scenario, Target } from '../src/shared/contracts.ts';
import type { ResearchProvider } from './provider-contract.ts';
import { ProviderError } from './provider-contract.ts';

export const DEMO_TARGET: Target = { personName: '星野あおい', companyName: '架空・みなもデザイン株式会社' };
export const DEMO_TEXT = '架空・みなもデザイン株式会社の星野あおいさんについて調べたい。';
const SECOND_TARGET: Target = { personName: '星野あおい', companyName: '架空・こもれび研究所' };
const FACT_ONE = '架空・みなもデザイン株式会社の星野あおいは、地域の図書館向けに読書案内サービスを設計しています。';
const FACT_TWO = '架空・みなもデザイン株式会社の星野あおいは、公開勉強会「小さなチームの設計」に登壇しました。';
const FACT_OTHER = '架空・こもれび研究所の星野あおいは、地域の植物観察会を企画しています。';

/** Entirely fictional, local fixtures. No public person data or network calls. */
export function createFixtureProvider(scenario: Scenario): ResearchProvider {
  let searches = 0;
  let assessments = 0;
  let target = DEMO_TARGET;
  const candidates = [DEMO_TARGET, SECOND_TARGET].map((t, index) => ({
    ...t, id: `fixture-person-${index + 1}`, reason: '模擬データ：架空の同姓同名候補です。', sourceIds: [],
  }));
  const page = (sourceId: string, text: string): EvidenceSource => ({
    sourceId, url: `https://example.invalid/fictional/${sourceId}`, title: '模擬データ：架空人物・架空企業の紹介',
    retrievedAt: new Date().toISOString(), text: `これは架空の人物・会社を使った模擬データです。\n${text}`, kind: 'fixture',
  });
  return {
    mode: 'demo',
    async plan(input) {
      if (scenario === 'ambiguous') {
        const selected = candidates.find(c => c.id === input.selectedCandidateId);
        if (!selected) return { value: { target: null, needsConfirmation: true, candidates, query: '', reason: '模擬：同姓同名のため選択が必要です。' }, actualUsd: 0 };
        target = { personName: selected.personName, companyName: selected.companyName };
      }
      return { value: { target, needsConfirmation: false, candidates: [], query: `${target.personName} ${target.companyName} 公式`, reason: '模擬：所属と活動を公式紹介相当の固定資料で確認します。' }, actualUsd: 0 };
    },
    async search() {
      searches += 1;
      if (scenario === 'no_evidence') return { value: [], actualUsd: 0 };
      if (scenario === 'failure' && searches > 1) throw new ProviderError('DEMO_SEARCH_UNAVAILABLE', '模擬検索サービスの障害', true);
      return { value: [
        ...(scenario === 'failure' && searches === 1 ? [{ url: 'https://example.invalid/fictional/unavailable', title: '模擬：取得不能ページ' }] : []),
        { url: `https://example.invalid/fictional/${searches === 1 ? 'profile' : 'event'}`, title: '模擬：架空の公開紹介' },
      ], actualUsd: 0 };
    },
    async fetchPage(hit) {
      if (hit.url.endsWith('/unavailable')) throw new ProviderError('DEMO_PAGE_UNAVAILABLE', '模擬ページ取得障害', true);
      const event = hit.url.endsWith('/event');
      return { value: page(event ? 'fixture-event' : 'fixture-profile', target.companyName === SECOND_TARGET.companyName ? FACT_OTHER : event ? FACT_TWO : FACT_ONE), actualUsd: 0 };
    },
    async assess(_target, sources) {
      assessments += 1;
      const cards: Assessment['cards'] = sources.map(source => {
        const fact = source.text.split('\n')[1]!;
        return { fact, suggestedQuestion: fact.includes('登壇') ? '勉強会で特に反響があった話題は何でしたか？' : '活動を始めたきっかけを教えていただけますか？', sourceId: source.sourceId, excerpt: fact };
      });
      return { value: {
        identityVerified: sources.length > 0, needsConfirmation: false, candidates: [], cards,
        followUpQuery: assessments === 1 ? `${target.personName} ${target.companyName} 登壇 公開活動` : null,
        reason: assessments === 1 ? '模擬：別の公開活動を追加で確認します。' : '模擬：取得資料の範囲で調査を終了します。',
      }, actualUsd: 0 };
    },
  };
}
