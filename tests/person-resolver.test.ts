import { describe, expect, it, vi } from 'vitest';
import { extractHomophoneTarget, resolvePersonTarget, shortlistPersonCandidates } from '../server/person-resolver.ts';
import type { createLunaCorrection } from '../server/luna-correction.ts';
import { ProviderError } from '../server/provider-contract.ts';
import { BudgetError } from '../server/budget.ts';

const signal = () => new AbortController().signal;
const company = '株式会社メイドインジャパン';
const target = { personName: '広行', companyName: company };
const base = { currentTranscript: `${company}の広行さんについて`, previousTranscript: '', target };
const luna = (overrides: Record<string, unknown> = {}) => vi.fn<ReturnType<typeof createLunaCorrection>>().mockResolvedValue({ value: {
  literalName: 'ひろゆぎ', correctedName: '西村博之', companyName: company, publicFigureId: 'hiroyuki-nishimura',
  evidenceInTranscript: 'ひろゆぎさんについて', confidence: 0.98, needsConfirmation: false, ...overrides,
} });

describe('person-name correction without famous-person fallback', () => {
  it('uses a declared homophone plus a sourced company clue without spending another model call', async () => {
    const correct = luna();
    expect(await resolvePersonTarget({ ...base, correct }, signal())).toMatchObject({ target: { personName: '西村博之', companyName: company }, usedLuna: false, hint: expect.stringContaining('候補として') });
    expect(correct).not.toHaveBeenCalled();
    expect(extractHomophoneTarget(base.currentTranscript, '')).toEqual(target);
    expect(await resolvePersonTarget({ ...base, target: null, correct }, signal())).toMatchObject({ target: { personName: '西村博之', companyName: company }, usedLuna: false });
  });

  it('allows a prior literal company clue but requires the name in the current utterance', async () => {
    const correct = luna();
    expect(await resolvePersonTarget({ ...base, currentTranscript: '広行さんについて', previousTranscript: company, correct }, signal())).toMatchObject({ target: { personName: '西村博之', companyName: company } });
    expect(await resolvePersonTarget({ ...base, currentTranscript: 'ありがとうございます', previousTranscript: base.currentTranscript, correct }, signal())).toEqual({ target: null, usedLuna: false });
    expect(await resolvePersonTarget({ ...base, currentTranscript: 'ありがとうございます', previousTranscript: base.currentTranscript, target: null, correct }, signal())).toEqual({ target: null, usedLuna: false });
    expect(await resolvePersonTarget({ ...base, currentTranscript: '広行さんについて', correct }, signal())).toEqual({ target: null, usedLuna: false });
    expect(correct).not.toHaveBeenCalled();
  });

  it('handles verified public aliases and literal kana/case variants without inventing affiliation', async () => {
    const correct = luna();
    for (const name of ['ひろゆき', 'ヒロユキ', 'にしむらひろゆき', 'Hiroyuki Nishimura']) {
      expect(await resolvePersonTarget({ currentTranscript: `${name}さんについて`, previousTranscript: '', target: { personName: name, companyName: '' }, correct }, signal())).toMatchObject({ target: { personName: '西村博之', companyName: '' }, usedLuna: false });
    }
    expect(await resolvePersonTarget({ currentTranscript: 'マイクロソフトのちょまどさん', previousTranscript: '', target: { personName: 'ちょまど', companyName: 'マイクロソフト' }, correct }, signal())).toMatchObject({ target: { personName: '千代田まどか', companyName: 'マイクロソフト' } });
    expect(correct).not.toHaveBeenCalled();
  });

  it('can validate an already-canonical planner proposal against the actual spoken homophone', async () => {
    expect(await resolvePersonTarget({ ...base, target: { personName: '西村博之', companyName: company } }, signal())).toMatchObject({ target: { personName: '西村博之', companyName: company } });
    expect(await resolvePersonTarget({ ...base, currentTranscript: `${company}の山田さん`, target: { personName: '西村博之', companyName: company } }, signal())).toEqual({ target: null, usedLuna: false });
  });

  it('does not turn a common homophone without a company into a verified public person', async () => {
    const correct = luna();
    const result = await resolvePersonTarget({ currentTranscript: '広行さんについて', previousTranscript: '', target: { personName: '広行', companyName: '' }, correct }, signal());
    expect(result).toMatchObject({ target: null, candidate: { personName: '西村博之', companyName: '' }, usedLuna: false });
    expect(result.hint).toContain('確認'); expect(correct).not.toHaveBeenCalled();
  });

  it('keeps an explicitly mismatching company and raw person for research', async () => {
    const correct = luna();
    const original = { personName: '広行', companyName: '株式会社別会社' };
    const result = await resolvePersonTarget({ currentTranscript: '株式会社別会社の広行さん', previousTranscript: company, target: original, correct }, signal());
    expect(result).toMatchObject({ target: original, candidate: { personName: '西村博之', companyName: '' }, usedLuna: false });
    expect(correct).not.toHaveBeenCalled();
  });

  it('uses one Luna call for a phonetic variant only when a curated company clue corroborates it', async () => {
    const correct = luna();
    const input = { currentTranscript: 'ひろゆぎさんについて', previousTranscript: company, target: { personName: 'ひろゆぎ', companyName: company }, correct };
    expect(await resolvePersonTarget(input, signal())).toMatchObject({ target: { personName: '西村博之', companyName: company }, usedLuna: true });
    expect(correct).toHaveBeenCalledOnce();
    expect(correct.mock.calls[0]![0].curatedCandidates.length).toBeLessThanOrEqual(8);
    expect(correct.mock.calls[0]![0]).toMatchObject({ rawName: 'ひろゆぎ', rawCompany: company });
  });

  it('never treats confidence alone as permission to canonicalize a different name', async () => {
    const correct = luna({ companyName: '', confidence: 1 });
    expect(await resolvePersonTarget({ currentTranscript: 'ひろゆぎさんについて', previousTranscript: '', target: { personName: 'ひろゆぎ', companyName: '' }, correct }, signal())).toMatchObject({ target: null, candidate: { personName: '西村博之', companyName: '' }, usedLuna: true });
    expect(correct).toHaveBeenCalledOnce();
  });

  it.each([
    { publicFigureId: 'not-in-catalog' }, { correctedName: '別の名前' }, { literalName: 'ひろゆき' },
    { evidenceInTranscript: `${company}\nひろゆぎさんについて` }, { needsConfirmation: true }, { confidence: 0.5 },
  ])('does not automatically accept unsupported Luna corrections %j', async patch => {
    const correct = luna(patch);
    expect(await resolvePersonTarget({ currentTranscript: 'ひろゆぎさんについて', previousTranscript: company, target: { personName: 'ひろゆぎ', companyName: company }, correct }, signal())).toMatchObject({ target: null, usedLuna: true });
    expect(correct).toHaveBeenCalledOnce();
  });

  it('preserves unregistered literal people and does not infer targets from stale names or ordinary speech', async () => {
    const correct = luna(); const original = { personName: '架空の山田', companyName: '架空工房' };
    expect(shortlistPersonCandidates(original.personName, original.companyName)).toEqual([]);
    expect(await resolvePersonTarget({ currentTranscript: '架空工房の架空の山田さん', previousTranscript: '', target: original, correct }, signal())).toEqual({ target: original, usedLuna: false });
    expect(await resolvePersonTarget({ currentTranscript: 'こんにちは', previousTranscript: '', target: { personName: 'こんにちは', companyName: '' }, correct }, signal())).toEqual({ target: null, usedLuna: false });
    expect(await resolvePersonTarget({ currentTranscript: '堀江貴文さんと西村博之さん', previousTranscript: '', target: null, correct }, signal())).toMatchObject({ target: null, usedLuna: false });
    expect(correct).not.toHaveBeenCalled();
  });

  it('does not accept Latin aliases embedded in another name', async () => {
    expect(await resolvePersonTarget({ currentTranscript: 'notHiroyukiNishimuraName', previousTranscript: '', target: { personName: 'Hiroyuki Nishimura', companyName: '' } }, signal())).toEqual({ target: null, usedLuna: false });
  });

  it('falls back after a provider error but propagates cancellation and budget failures', async () => {
    const input = { currentTranscript: 'ひろゆぎさんについて', previousTranscript: company, target: { personName: 'ひろゆぎ', companyName: company } };
    const correct = luna().mockRejectedValue(new ProviderError('PROVIDER_UNAVAILABLE', 'unavailable'));
    expect(await resolvePersonTarget({ ...input, correct }, signal())).toMatchObject({ target: null, usedLuna: true });
    correct.mockRejectedValue(new BudgetError('BUDGET_EXHAUSTED'));
    await expect(resolvePersonTarget({ ...input, correct }, signal())).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    const controller = new AbortController();
    correct.mockImplementation(async () => { controller.abort(); return { value: { literalName: 'ひろゆぎ', correctedName: '西村博之', companyName: company, publicFigureId: 'hiroyuki-nishimura', evidenceInTranscript: 'ひろゆぎさんについて', confidence: 1, needsConfirmation: false } }; });
    await expect(resolvePersonTarget({ ...input, correct }, controller.signal)).rejects.toThrow();
  });
});
