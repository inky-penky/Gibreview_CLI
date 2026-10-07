import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Batch, TestPlan } from './plan.js';
import type { ParsedSubmission } from './parser.js';

export type Environment = 'mock' | 'stage' | 'production';

export interface BatchState extends Batch {
  title: string;
  content: string;
  taskId?: string;
  txHash?: string;
  publishedAt?: string;
  /** Set when the SDK could not tell whether a create transaction landed. Never auto-retried. */
  ambiguous?: { intentId: string; message: string };
  refundedAt?: string;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface SubmissionState {
  id: string;
  taskId: string;
  batchId: string;
  username: string;
  createdAt: string;
  reviewStatus: ReviewStatus;
  content: string;
  parsed: ParsedSubmission;
  decision?: { action: 'approve' | 'reject'; at: string; amount?: string; reason?: string; txHash?: string };
}

export interface RunState {
  version: 1;
  runId: string;
  planPath: string;
  plan: TestPlan;
  environment: Environment;
  createdAt: string;
  batches: BatchState[];
  submissions: Record<string, SubmissionState>;
  collectedAt?: string;
}

export class Store {
  constructor(readonly dir: string) {}

  private runPath(runId: string) {
    return join(this.dir, 'runs', `${runId}.json`);
  }

  async save(run: RunState): Promise<void> {
    await mkdir(join(this.dir, 'runs'), { recursive: true });
    const path = this.runPath(run.runId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(run, null, 2));
    await rename(tmp, path); // atomic, so an interrupted publish never corrupts the run file
    await writeFile(join(this.dir, 'current'), run.runId);
  }

  async currentRunId(): Promise<string | null> {
    try {
      return (await readFile(join(this.dir, 'current'), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  async load(runId?: string): Promise<RunState> {
    const id = runId ?? (await this.currentRunId());
    if (!id) throw new Error('No active run. Start one with "bugbash plan <testplan.yaml>".');
    try {
      return JSON.parse(await readFile(this.runPath(id), 'utf8')) as RunState;
    } catch {
      throw new Error(`Run "${id}" not found in ${this.dir}/runs`);
    }
  }
}

export function newRunId(planName: string, now = new Date()): string {
  const slug = planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${stamp}-${rand}`;
}
