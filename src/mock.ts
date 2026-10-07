import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { CreateTaskInput, ApproveSubmissionInput } from '@gibwork/sdk';
import { htmlToText } from './content.js';

/**
 * Offline stand-in for the Gibwork SDK, persisted to .bugbash/mock-ledger.json.
 * It simulates a small crowd of testers answering each published bounty so the whole
 * plan → publish → collect → triage → report loop can be reviewed without a funded wallet.
 * Shapes mirror @gibwork/sdk 0.2.x responses for the fields BugBash reads.
 */

interface MockTask {
  id: string;
  index: number;
  title: string;
  content: string;
  amount: string;
  perTester: string;
  createdAt: string;
  refunded: boolean;
}

interface MockSubmission {
  id: string;
  taskId: string;
  content: string;
  status: 'OPEN' | 'REJECTED' | 'CLAIMED';
  rejectReason: string | null;
  createdAt: string;
  username: string;
}

interface Ledger {
  tasks: MockTask[];
  submissions: MockSubmission[];
}

const TESTERS = ['ada_qa', 'tunde.tests', 'kemi_bugs', 'quickcash99'];

const DEVICES: Array<[RegExp, string[]]> = [
  [/android/i, ['Samsung Galaxy A14, Android 14, Chrome 129', 'Tecno Spark 20, Android 13, Chrome 128', 'Infinix Hot 40i, Android 13, Chrome 129']],
  [/ios|iphone|safari/i, ['iPhone 12, iOS 17.6, Safari', 'iPhone SE (2nd gen), iOS 16.7, Safari', 'iPhone 14, iOS 18.0, Safari']],
  [/.*/, ['ThinkPad T480, Windows 11, Chrome 129', 'MacBook Air M1, macOS 14, Firefox 131', 'Dell Latitude, Ubuntu 24.04, Chrome 129']],
];

const fakeTx = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 44);

export class MockGibwork {
  private path: string;

  constructor(private stateDir: string) {
    this.path = join(stateDir, 'mock-ledger.json');
  }

  private async read(): Promise<Ledger> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Ledger;
    } catch {
      return { tasks: [], submissions: [] };
    }
  }

  private async write(l: Ledger) {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.path, JSON.stringify(l, null, 2));
  }

  tasks = {
    create: async (input: CreateTaskInput) => {
      const l = await this.read();
      const task: MockTask = {
        id: randomUUID(),
        index: l.tasks.length,
        title: input.title,
        content: input.content,
        amount: input.payment.amount,
        perTester: input.minSubmissionAmount,
        createdAt: new Date().toISOString(),
        refunded: false,
      };
      l.tasks.push(task);
      await this.write(l);
      return {
        taskId: task.id,
        txHash: fakeTx(task.id),
        status: 'confirmed' as const,
        intentId: randomUUID(),
        lastValidBlockHeight: 0,
        paymentQuote: {
          token: { mintAddress: input.payment.mintAddress, symbol: 'USDC', decimals: 6 },
          fundingAmount: input.payment.amount,
          platformFee: { percent: 0, amount: '0.00' },
          totalDebit: input.payment.amount,
        },
      };
    },

    get: async (taskId: string) => {
      const l = await this.read();
      const t = l.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`mock: task ${taskId} not found`);
      return { id: t.id, title: t.title, content: t.content, isOpen: !t.refunded } as never;
    },

    refund: async (taskId: string) => {
      const l = await this.read();
      const t = l.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`mock: task ${taskId} not found`);
      t.refunded = true;
      await this.write(l);
      return { taskId, txHash: fakeTx(`refund-${taskId}`), intentId: randomUUID(), lastValidBlockHeight: 0 } as never;
    },
  };

  submissions = {
    list: async (taskId: string, query: { page?: number; limit?: number } = {}) => {
      const l = await this.read();
      const task = l.tasks.find((x) => x.id === taskId);
      if (!task) throw new Error(`mock: task ${taskId} not found`);
      if (!l.submissions.some((s) => s.taskId === taskId)) {
        l.submissions.push(...simulateTesters(task));
        await this.write(l);
      }
      const all = l.submissions.filter((s) => s.taskId === taskId);
      const page = query.page ?? 1;
      const limit = query.limit ?? 15;
      const results = all.slice((page - 1) * limit, page * limit).map((s) => ({
        id: s.id,
        taskId: s.taskId,
        content: s.content,
        status: s.status,
        rejectReason: s.rejectReason,
        createdAt: s.createdAt,
        createdBy: s.username,
        user: { username: s.username },
        comments: [],
        media: [],
      }));
      return { results, page, limit, total: all.length, lastPage: Math.max(1, Math.ceil(all.length / limit)) } as never;
    },

    approve: async (taskId: string, submissionId: string, input: ApproveSubmissionInput) => {
      const l = await this.read();
      const s = l.submissions.find((x) => x.id === submissionId && x.taskId === taskId);
      if (!s) throw new Error(`mock: submission ${submissionId} not found`);
      if (s.status !== 'OPEN') throw new Error(`mock: submission ${submissionId} already ${s.status}`);
      s.status = 'CLAIMED';
      await this.write(l);
      return {
        taskId,
        taskSubmissionId: submissionId,
        txHash: fakeTx(`approve-${submissionId}`),
        intentId: randomUUID(),
        lastValidBlockHeight: 0,
        approvalQuote: { grossApprovalAmount: input.amount, netPayoutAmount: input.amount },
      } as never;
    },

    reject: async (taskId: string, submissionId: string, reason?: string | null) => {
      const l = await this.read();
      const s = l.submissions.find((x) => x.id === submissionId && x.taskId === taskId);
      if (!s) throw new Error(`mock: submission ${submissionId} not found`);
      s.status = 'REJECTED';
      s.rejectReason = reason ?? null;
      await this.write(l);
      return { message: 'Submission rejected', submission: { id: s.id, taskId, status: 'REJECTED', rejectReason: reason, reviewedAt: new Date().toISOString() } } as never;
    },
  };
}

/** Deterministic crowd behaviour per bounty, so demos and tests are repeatable. */
function simulateTesters(task: MockTask): MockSubmission[] {
  const text = htmlToText(task.content);
  const caseIds = [...text.matchAll(/^([A-Za-z0-9][\w.-]*): PASS \| FAIL \| BLOCKED/gm)].map((m) => m[1]);
  const devices = DEVICES.find(([re]) => re.test(task.title))![1];
  const base = new Date(task.createdAt).getTime();
  const at = (mins: number) => new Date(base + mins * 60_000).toISOString();
  const evidence = (who: string, id: string) => `https://drive.example.com/bugbash/${who}/${id.toLowerCase()}.mp4`;

  // The first bounty reproduces a real defect; the third has testers disagreeing (a flaky case).
  const failing = task.index === 0 && caseIds.length > 1 ? caseIds[1] : null;
  const flaky = task.index === 2 && caseIds.length > 2 ? caseIds[2] : null;

  const line = (id: string, who: string, i: number): string => {
    if (id === failing) return `${id}: FAIL - Pay button stays disabled after applying coupon SAVE10, order cannot be placed - ${evidence(who, id)}`;
    if (id === flaky && i === 0) return `${id}: FAIL - Confirmation email arrived after 9 minutes, expected under 2 - ${evidence(who, id)}`;
    if (id === flaky && i === 1) return `${id}: PASS - email arrived in about 40 seconds`;
    return `${id}: PASS`;
  };

  const block = (who: string, i: number, ids: string[], extra: (id: string) => string | null = () => null) =>
    ['BUGBASH RESULT', `Device: ${devices[i % devices.length]}`, ...ids.map((id) => extra(id) ?? line(id, who, i)), 'END'].join('\n');

  const subs: Array<[string, string, number]> = [
    [TESTERS[0], block(TESTERS[0], 0, caseIds), 18],
    [
      TESTERS[1],
      block(TESTERS[1], 1, caseIds, (id) =>
        id === caseIds[caseIds.length - 1] && id !== failing && id !== flaky ? `${id}: BLOCKED - staging returned 502 for 10 minutes, could not finish` : null,
      ),
      31,
    ],
    // Skips the last case and gives no evidence: should come back as incomplete.
    [
      TESTERS[2],
      ['Tested on my phone, results below', ...block(TESTERS[2], 2, caseIds.slice(0, -1), (id) => (id === failing ? `${id}: FAIL - could not pay` : null)).split('\n')].join('\n'),
      44,
    ],
    // Low-effort spam: no result block at all.
    [TESTERS[3], '<p>Tested everything, all good 👍 please approve</p>', 3],
  ];

  return subs.map(([username, content, mins]) => ({
    id: randomUUID(),
    taskId: task.id,
    content: content.startsWith('<') ? content : content.split('\n').map((l) => `<p>${l}</p>`).join(''),
    status: 'OPEN' as const,
    rejectReason: null,
    createdAt: at(mins),
    username,
  }));
}
