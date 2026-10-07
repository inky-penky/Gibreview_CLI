import type { GibworkClient } from '@gibwork/sdk';
import { createGibworkClient } from '@gibwork/sdk/node';
import type { Environment } from './state.js';
import { MockGibwork } from './mock.js';

/** The slice of the Gibwork SDK that BugBash depends on. The mock implements the same surface. */
export interface GibworkLike {
  tasks: Pick<GibworkClient['tasks'], 'create' | 'get' | 'refund'>;
  submissions: Pick<GibworkClient['submissions'], 'list' | 'approve' | 'reject'>;
}

export interface ClientConfig {
  environment: Environment;
  stateDir: string;
}

export function resolveEnvironment(opts: { mock?: boolean; prod?: boolean }): Environment {
  if (opts.mock || process.env.BUGBASH_MOCK === '1') return 'mock';
  if (opts.prod || process.env.GIBWORK_ENV === 'production') return 'production';
  return 'stage';
}

export function createClient(cfg: ClientConfig): GibworkLike {
  if (cfg.environment === 'mock') return new MockGibwork(cfg.stateDir);
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'SOLANA_PRIVATE_KEY is not set. Add it to .env (base58 or JSON byte array), or run with --mock to try the full flow offline.',
    );
  }
  return createGibworkClient({
    privateKey,
    production: cfg.environment === 'production',
    timeoutMs: 30_000,
  });
}
