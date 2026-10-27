import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
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

/** 'other' is a Gibwork status gibreview does not recognise. It fills a slot, is never auto-triaged and needs a human look. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'other';

export interface SubmissionState {
  id: string;
  taskId: string;
  batchId: string;
  username: string;
  createdAt: string;
  reviewStatus: ReviewStatus;
  /** Raw Gibwork submission status, kept so 'other' can be explained. */
  remoteStatus?: string;
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

/**
 * Run files on disk, one JSON file per run, saved atomically and changed under a per-run lock.
 * Generic so QA runs (RunState) and review runs share the same guarantees.
 */
export class Store<S extends { runId: string } = RunState> {
  constructor(
    readonly dir: string,
    /** Shown when there is no run yet, e.g. 'Start one with "gibreview qa plan <testplan.yaml>".' */
    private readonly startHint = 'Start one with "gibreview qa plan <testplan.yaml>".',
  ) {}

  private runPath(runId: string) {
    return join(this.dir, 'runs', `${runId}.json`);
  }

  async save(run: S): Promise<void> {
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

  /**
   * Runs fn with an exclusive lock on the run and a copy loaded inside the lock, so a CLI and an agent
   * (or two terminals) can never publish, pay or refund the same run at the same time.
   */
  async withRun<T>(runId: string | undefined, fn: (run: S) => Promise<T>): Promise<T> {
    const id = runId ?? (await this.currentRunId());
    if (!id) throw new Error(`No active run. ${this.startHint}`);
    const release = await this.lock(id);
    try {
      return await fn(await this.load(id));
    } finally {
      await release();
    }
  }

  private async lock(runId: string): Promise<() => Promise<void>> {
    await mkdir(join(this.dir, 'runs'), { recursive: true });
    const path = join(this.dir, 'runs', `${runId}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
        return () => rm(path, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = await readFile(path, 'utf8').then((t) => JSON.parse(t) as { pid: number; at: string }, () => null);
        if (!holder || processAlive(holder.pid)) {
          throw new Error(
            `Run ${runId} is busy: another gibreview process${holder ? ` (pid ${holder.pid}, since ${holder.at})` : ''} is changing it. ` +
              `Wait for it to finish. If that process is gone, delete ${path}.`,
          );
        }
        await rm(path, { force: true }); // the process that held it has exited
      }
    }
    throw new Error(`Could not lock run ${runId}`);
  }

  async load(runId?: string): Promise<S> {
    const id = runId ?? (await this.currentRunId());
    if (!id) throw new Error(`No active run. ${this.startHint}`);
    try {
      return JSON.parse(await readFile(this.runPath(id), 'utf8')) as S;
    } catch {
      throw new Error(`Run "${id}" not found in ${this.dir}/runs`);
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function newRunId(planName: string, now = new Date()): string {
  const slug = planName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${stamp}-${rand}`;
}
