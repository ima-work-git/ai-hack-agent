import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLunaCorrection, type LunaCorrection, type LunaCorrectionInput } from '../server/luna-correction.ts';

const config = { apiKey: 'fixture-server-only-key' };
const input: LunaCorrectionInput = {
  recentTranscript: '株式会社灯の山田はなこさんについて教えて。', rawName: '山田はなこ', rawCompany: '株式会社灯',
  curatedCandidates: [{ publicFigureId: 'fixture-hanako', canonicalName: '山田花子', aliases: ['やまだはなこ'] }],
};
const correction: LunaCorrection = { literalName: '山田はなこ', correctedName: '山田花子', companyName: '株式会社灯', publicFigureId: 'fixture-hanako', evidenceInTranscript: '株式会社灯の山田はなこさん', confidence: 0.96, needsConfirmation: false };
const signal = () => new AbortController().signal;
const response = (value: unknown) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
afterEach(() => vi.restoreAllMocks());

describe('bounded Luna name-correction hypothesis', () => {
  it('sends one strict, tool-free, non-stored request and leaves monetary cost unknown', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(correction));
    const result = await createLunaCorrection(config, { fetch })(input, signal());
    expect(result).toEqual({ value: correction }); expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${config.apiKey}` } });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', max_output_tokens: 500, reasoning: { effort: 'none' }, store: false, tools: [], tool_choice: 'none', text: { format: { type: 'json_schema', strict: true, schema: { additionalProperties: false } } } });
    expect(body.input[1].content).toBe(JSON.stringify(input)); expect(JSON.stringify(body)).not.toContain(config.apiKey);
  });

  it('does not call without server credentials, literal grounding, or after cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const correct = createLunaCorrection(config, { fetch });
    await expect(createLunaCorrection({ apiKey: '' }, { fetch })(input, signal())).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
    await expect(correct({ ...input, rawName: '' }, signal())).rejects.toMatchObject({ code: 'INVALID_CORRECTION_INPUT' });
    await expect(correct({ ...input, recentTranscript: 'いい天気ですね。' }, signal())).rejects.toMatchObject({ code: 'UNGROUNDED_CORRECTION' });
    const controller = new AbortController(); controller.abort();
    await expect(correct(input, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' }); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { literalName: '別人' }, { evidenceInTranscript: '原文にない根拠' }, { publicFigureId: 'invented-person' },
    { correctedName: '候補にない人' }, { confidence: 2 }, { extra: 'injected' },
  ])('rejects unsupported output fields or grounding %j', async patch => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...correction, ...patch }));
    await expect(createLunaCorrection(config, { fetch })(input, signal())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires confirmation for non-curated or low-confidence names and strips invented affiliation', async () => {
    for (const patch of [{ publicFigureId: null, correctedName: '山田華子' }, { confidence: 0.6 }, { companyName: '架空の所属' }]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...correction, ...patch }));
      const result = await createLunaCorrection(config, { fetch })(input, signal());
      expect(result.value.needsConfirmation).toBe(true);
      if ('companyName' in patch) expect(result.value.companyName).toBe('');
    }
  });

  it('bounds bodies and rejects refusal or incomplete output without retrying', async () => {
    for (const reply of [
      new Response('x'.repeat(32769)), new Response('{}', { headers: { 'content-length': '32769' } }),
      new Response(JSON.stringify({ status: 'incomplete', output: [] })),
      new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal' }] }] })),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply);
      await expect(createLunaCorrection(config, { fetch })(input, signal())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' }); expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('sanitizes upstream errors, timeouts and late responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`connection error ${config.apiKey}`));
    await expect(createLunaCorrection(config, { fetch })(input, signal())).rejects.toMatchObject({ code: 'PROVIDER_NETWORK', message: '人名補正サービスに接続できませんでした。' });
    const timedOut = new AbortController(); timedOut.abort(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timedOut.signal);
    await expect(createLunaCorrection(config, { fetch })(input, signal())).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(8000); vi.restoreAllMocks();
    const controller = new AbortController();
    const late = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { controller.abort(); return response(correction); });
    await expect(createLunaCorrection(config, { fetch: late })(input, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
