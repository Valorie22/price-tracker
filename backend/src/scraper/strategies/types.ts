import type { Fingerprint } from '../fingerprint.js';
import type { CandidateReading } from '../validate.js';

export type StrategyName = 'api' | 'embedded_json' | 'dom' | 'browser';

export interface StrategyContext {
  storeProductId: string;
  expect: { storeProductId: string; name: string; slug?: string | null; sku?: string | null };
  attempt: number;
  /** Live narration for the headed run; no-op in production. */
  onStage?: (stage: string, detail?: Record<string, unknown>) => void;
  /** Simulation switches used by the headed run only. Never set by the cron path. */
  simulate?: 'slow' | 'error' | 'late' | 'all' | null;
}

export interface StrategyResult {
  reading: CandidateReading;
  httpStatus?: number;
  fingerprint: Fingerprint;
  durationMs: number;
  meta: Record<string, unknown>;
}

export interface Strategy {
  readonly name: StrategyName;
  /** False when the strategy cannot run at all in this deployment (e.g. no browser). */
  available(): boolean;
  run(ctx: StrategyContext): Promise<StrategyResult>;
}
