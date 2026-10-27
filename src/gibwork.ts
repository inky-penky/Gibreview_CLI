import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GibworkClient } from '@gibwork/sdk';
import { createGibworkClient } from '@gibwork/sdk/node';
import type { Environment } from './state.js';
import { MockGibwork } from './mock.js';

/** The slice of the Gibwork SDK that gibreview depends on. The mock implements the same surface. */
export interface GibworkLike {
  tasks: Pick<GibworkClient['tasks'], 'create' | 'get' | 'refund' | 'list'>;
  submissions: Pick<GibworkClient['submissions'], 'list' | 'approve' | 'reject'> & {
    comments: Pick<GibworkClient['submissions']['comments'], 'create'>;
  };
}

export interface ClientConfig {
  environment: Environment;
  stateDir: string;
}

/**
 * Loads .env.local, then .env, from dir. Node never overwrites a variable that is already set,
 * so the shell environment wins, then .env.local (local secrets), then .env.
 */
export function loadEnvFiles(dir = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const name of ['.env.local', '.env']) {
    const path = join(dir, name);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      loaded.push(path);
    }
  }
  return loaded;
}

/**
 * Which Gibwork environment a command uses. Commands that fund bounties default to stage; commands that only
 * read an existing bounty (attach, check) default to production, where bounties made on gibwork.com live.
 */
export function resolveEnvironment(opts: { mock?: boolean; prod?: boolean; stage?: boolean }, fallback: Environment = 'stage'): Environment {
  if (opts.mock || process.env.GIBREVIEW_MOCK === '1') return 'mock';
  if (opts.prod) return 'production';
  if (opts.stage) return 'stage';
  if (process.env.GIBWORK_ENV === 'production' || process.env.GIBWORK_ENV === 'stage') return process.env.GIBWORK_ENV;
  return fallback;
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
