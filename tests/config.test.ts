import { describe, expect, it } from 'vitest';
import { readConfig } from '../server/config.ts';

// Deliberately synthetic credentials: these tests never contact a provider.
const liveEnv = (): NodeJS.ProcessEnv => ({
  AGENT_LIVE_ENABLED: 'true',
  APP_ACCESS_CODE: 'fixture-access-code',
  ORCAROUTER_API_KEY: 'fixture-orca-key',
  ORCAROUTER_MODEL: 'fixture-model',
  TAVILY_API_KEY: 'fixture-search-key',
  RUN_BUDGET_USD: '0.5',
  DAY_BUDGET_USD: '5',
  EVENT_BUDGET_USD: '10',
  MAX_LLM_CALL_USD: '0.03',
  MAX_SEARCH_CALL_USD: '0.02',
  MAX_PAGE_CALL_USD: '0',
});

describe('live configuration gates (REQ-007, REQ-008, REQ-009)', () => {
  it('requires explicit live enablement even when credentials and amounts are present', () => {
    const config = readConfig({ ...liveEnv(), AGENT_LIVE_ENABLED: 'false' });
    expect(config.status.liveEnabled).toBe(false);
    expect(config.status.sttEnabled).toBe(false);
    expect(config.status.missing).toContain('実APIモードの有効化');
  });

  it('enables configured live research and accepts an explicitly free page fetch', () => {
    const config = readConfig(liveEnv());
    expect(config.status.liveEnabled).toBe(true);
    expect(config.status.missing).toEqual([]);
    expect(config.maximumCosts.page).toBe(0);
    expect(config.status.sttEnabled).toBe(false);
    expect(config.status.xEnabled).toBe(false);
  });

  it.each([
    'APP_ACCESS_CODE', 'ORCAROUTER_API_KEY', 'ORCAROUTER_MODEL', 'TAVILY_API_KEY',
    'RUN_BUDGET_USD', 'DAY_BUDGET_USD', 'EVENT_BUDGET_USD',
    'MAX_LLM_CALL_USD', 'MAX_SEARCH_CALL_USD', 'MAX_PAGE_CALL_USD',
  ])('disables live when %s is missing', (key) => {
    const env = liveEnv();
    delete env[key];
    const config = readConfig(env);
    expect(config.status.liveEnabled).toBe(false);
    expect(config.status.missing.length).toBeGreaterThan(0);
  });

  it.each(['', '0', '-0.01', 'NaN', 'Infinity', 'not-an-amount'])('rejects invalid positive cost/budget %j', (value) => {
    for (const key of ['RUN_BUDGET_USD', 'DAY_BUDGET_USD', 'EVENT_BUDGET_USD', 'MAX_LLM_CALL_USD', 'MAX_SEARCH_CALL_USD']) {
      expect(readConfig({ ...liveEnv(), [key]: value }).status.liveEnabled, key).toBe(false);
    }
  });

  it.each(['', '-0.01', 'NaN', 'Infinity'])('does not treat an unspecified or invalid page cost %j as free', (value) => {
    expect(readConfig({ ...liveEnv(), MAX_PAGE_CALL_USD: value }).status.liveEnabled).toBe(false);
  });

  it.each(['0.0.0.0', '::', '192.0.2.10'])('requires at least 16 access-code characters when binding %s', (host) => {
    for (const code of ['', '123456789012345']) {
      expect(() => readConfig({ ...liveEnv(), HOST: host, APP_ACCESS_CODE: code })).toThrow(/16/);
    }
    expect(readConfig({ ...liveEnv(), HOST: host, APP_ACCESS_CODE: '1234567890123456' }).status.liveEnabled).toBe(true);
  });

  it.each(['127.0.0.1', 'localhost', '::1'])('allows local demo on %s without a code but keeps live disabled', (host) => {
    const config = readConfig({ HOST: host });
    expect(config.status.accessCodeRequired).toBe(false);
    expect(config.status.liveEnabled).toBe(false);
  });

  it('requires both X credentials and a positive maximum cost when X is enabled', () => {
    const env = { ...liveEnv(), X_API_ENABLED: 'true', X_API_BEARER_TOKEN: 'fixture-x-token', X_MAX_SEARCH_COST_USD: '0.08' };
    expect(readConfig(env).status.xEnabled).toBe(true);
    expect(readConfig(env).maximumCosts.search).toBe(0.08);
    for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity']) {
      const config = readConfig({ ...env, X_MAX_SEARCH_COST_USD: value });
      expect(config.status.liveEnabled).toBe(false);
      expect(config.status.xEnabled).toBe(false);
    }
    expect(readConfig({ ...env, X_API_BEARER_TOKEN: '' }).status.liveEnabled).toBe(false);
  });

  it('does not require X credentials or cost when X is disabled', () => {
    expect(readConfig({ ...liveEnv(), X_API_ENABLED: 'false' }).status.liveEnabled).toBe(true);
  });

  it('enables STT only with all three settings, a positive cost, and enabled live research', () => {
    const env: NodeJS.ProcessEnv = {
      ...liveEnv(), STT_API_KEY: 'fixture-stt-key', STT_API_BASE_URL: 'https://stt.example.invalid/v1',
      STT_MODEL: 'fixture-stt-model', MAX_STT_CALL_USD: '0.01',
    };
    expect(readConfig(env).status.sttEnabled).toBe(true);
    for (const key of ['STT_API_KEY', 'STT_API_BASE_URL', 'STT_MODEL', 'MAX_STT_CALL_USD']) {
      const incomplete = { ...env };
      delete incomplete[key];
      expect(readConfig(incomplete).status.sttEnabled, key).toBe(false);
    }
    for (const value of ['', '0', '-1', 'NaN', 'Infinity']) {
      expect(readConfig({ ...env, MAX_STT_CALL_USD: value }).status.sttEnabled).toBe(false);
    }
    expect(readConfig({ ...env, AGENT_LIVE_ENABLED: 'false' }).status.sttEnabled).toBe(false);
    expect(readConfig({ ...env, RUN_BUDGET_USD: '' }).status.sttEnabled).toBe(false);
  });

  it('allows OrcaRouter STT only with an explicit audio-capable model and a positive STT cost', () => {
    const env = { ...liveEnv(), ORCAROUTER_STT_MODEL: 'fixture-audio-model', MAX_STT_CALL_USD: '0.01' };
    expect(readConfig(env).providers.orcaSttModel).toBe('fixture-audio-model');
    expect(readConfig(env).status.sttEnabled).toBe(true);
    expect(readConfig({ ...env, ORCAROUTER_STT_MODEL: '' }).status.sttEnabled).toBe(false);
    expect(readConfig({ ...env, ORCAROUTER_API_KEY: '' }).status.sttEnabled).toBe(false);
    for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity']) {
      expect(readConfig({ ...env, MAX_STT_CALL_USD: value }).status.sttEnabled).toBe(false);
    }
  });

  it('does not fall back to OrcaRouter when an explicit STT provider is only partly configured', () => {
    const env = { ...liveEnv(), ORCAROUTER_STT_MODEL: 'fixture-audio-model', MAX_STT_CALL_USD: '0.01' };
    for (const key of ['STT_API_KEY', 'STT_API_BASE_URL', 'STT_MODEL']) {
      expect(readConfig({ ...env, [key]: 'fixture-explicit-stt-setting' }).status.sttEnabled, key).toBe(false);
    }
  });
});
