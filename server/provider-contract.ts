import type { Assessment, EvidenceSource, PlanDecision, ResearchInput, SearchHit, Target } from '../src/shared/contracts.ts';

export interface ProviderResult<T> { value: T; actualUsd?: number; }
export interface ResearchProvider {
  readonly mode: 'demo' | 'live';
  plan(input: ResearchInput, signal: AbortSignal): Promise<ProviderResult<PlanDecision>>;
  search(query: string, signal: AbortSignal): Promise<ProviderResult<SearchHit[]>>;
  fetchPage(hit: SearchHit, signal: AbortSignal): Promise<ProviderResult<EvidenceSource>>;
  assess(target: Target, sources: EvidenceSource[], signal: AbortSignal): Promise<ProviderResult<Assessment>>;
  transcribe?(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<ProviderResult<string>>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  constructor(code: string, message: string, retryable = false, retryAfterMs = 0) {
    super(message); this.name = 'ProviderError'; this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}

export interface ProviderConfig {
  orcaApiKey: string; orcaModel: string; tavilyApiKey: string; orcaSttModel?: string;
  xBearerToken?: string; xEnabled?: boolean;
  sttApiKey?: string; sttBaseUrl?: string; sttModel?: string;
}
