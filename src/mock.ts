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
  deadline?: string | null;
}

interface MockSubmission {
  id: string;
  taskId: string;
  content: string;
  status: 'OPEN' | 'REJECTED' | 'CLAIMED';
  rejectReason: string | null;
  createdAt: string;
  username: string;
  comments?: Array<{ id: string; content: string; createdAt: string }>;
  paid?: string;
}

interface Ledger {
  tasks: MockTask[];
  submissions: MockSubmission[];
}

const TESTERS = ['ada_qa', 'tunde.tests', 'kemi_bugs', 'quickcash99'];

/** Gibwork track records for simulated participants. */
const REPUTATION: Record<string, { approvedTaskSubmissions: number; rejectedTaskSubmissions: number; rating: number }> = {
  ada_writes: { approvedTaskSubmissions: 14, rejectedTaskSubmissions: 1, rating: 4.9 },
  ada_dev: { approvedTaskSubmissions: 22, rejectedTaskSubmissions: 2, rating: 4.8 },
  'tunde.docs': { approvedTaskSubmissions: 6, rejectedTaskSubmissions: 0, rating: 4.7 },
  'tunde.codes': { approvedTaskSubmissions: 9, rejectedTaskSubmissions: 1, rating: 4.6 },
  kemi_b: { approvedTaskSubmissions: 3, rejectedTaskSubmissions: 2, rating: 4.1 },
  quickcash99: { approvedTaskSubmissions: 0, rejectedTaskSubmissions: 31, rating: 1.2 },
  copycat: { approvedTaskSubmissions: 1, rejectedTaskSubmissions: 9, rating: 2.0 },
};

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
        deadline: input.deadline ?? null,
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
      return {
        id: t.id,
        title: t.title,
        content: t.content,
        createdAt: t.createdAt,
        deadline: t.deadline ?? null,
        isOpen: !t.refunded,
        status: t.refunded ? 'refunded' : 'complete',
        // Base units, as the discovery endpoint reports them.
        asset: { id: 'mock-usdc', mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', imageUrl: null, amount: Math.round(Number(t.amount) * 1e6), price: 1, decimals: 6 },
        minSubmissionAmount: Math.round(Number(t.perTester) * 1e6),
      } as never;
    },

    refund: async (taskId: string) => {
      const l = await this.read();
      const t = l.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`mock: task ${taskId} not found`);
      if (t.refunded) throw new Error(`mock: task ${taskId} was already refunded`);
      t.refunded = true;
      await this.write(l);
      const paidCents = l.submissions.filter((s) => s.taskId === taskId && s.paid).reduce((n, s) => n + Math.round(Number(s.paid) * 100), 0);
      const left = ((Math.round(Number(t.amount) * 100) - paidCents) / 100).toFixed(2);
      const token = { mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 };
      return {
        taskId,
        txHash: fakeTx(`refund-${taskId}`),
        intentId: randomUUID(),
        lastValidBlockHeight: 0,
        refundQuote: { token, grossRefundAmount: left, platformFee: { percent: 0, amount: '0.00' }, netRefundAmount: left },
      } as never;
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
        user: { username: s.username, ...(REPUTATION[s.username] ?? { approvedTaskSubmissions: 0, rejectedTaskSubmissions: 0, rating: 0 }) },
        comments: (s.comments ?? []).map((c) => ({ ...c, taskSubmissionId: s.id })),
        media: [],
      }));
      return { results, page, limit, total: all.length, lastPage: Math.max(1, Math.ceil(all.length / limit)) } as never;
    },

    approve: async (taskId: string, submissionId: string, input: ApproveSubmissionInput) => {
      const l = await this.read();
      const s = l.submissions.find((x) => x.id === submissionId && x.taskId === taskId);
      if (!s) throw new Error(`mock: submission ${submissionId} not found`);
      if (s.status !== 'OPEN') throw new Error(`mock: submission ${submissionId} already ${s.status}`);
      const t = l.tasks.find((x) => x.id === taskId)!;
      if (t.refunded) throw new Error(`mock: task ${taskId} is closed`);
      const paidCents = l.submissions.filter((x) => x.taskId === taskId && x.paid).reduce((n, x) => n + Math.round(Number(x.paid) * 100), 0);
      if (paidCents + Math.round(Number(input.amount) * 100) > Math.round(Number(t.amount) * 100)) throw new Error('mock: approval is more than the escrow has left');
      s.status = 'CLAIMED';
      s.paid = input.amount;
      await this.write(l);
      return {
        taskId,
        taskSubmissionId: submissionId,
        txHash: fakeTx(`approve-${submissionId}`),
        intentId: randomUUID(),
        lastValidBlockHeight: 0,
        approvalQuote: {
          token: { mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
          grossApprovalAmount: input.amount,
          platformFee: { percent: 0, amount: '0.00' },
          referralFee: '0.00',
          netPayoutAmount: input.amount,
          // Gibwork keeps a bounty open after an approval, so every winner can be paid.
          closeTask: false,
        },
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

    comments: {
      create: async (taskId: string, submissionId: string, content: string) => {
        const l = await this.read();
        const s = l.submissions.find((x) => x.id === submissionId && x.taskId === taskId);
        if (!s) throw new Error(`mock: submission ${submissionId} not found`);
        const comment = { id: randomUUID(), content, createdAt: new Date().toISOString() };
        (s.comments ??= []).push(comment);
        await this.write(l);
        return { ...comment, taskSubmissionId: submissionId } as never;
      },
    },
  };
}

/** Deterministic crowd behaviour per bounty, so demos and tests are repeatable. */
function simulateTesters(task: MockTask): MockSubmission[] {
  const text = htmlToText(task.content);
  const caseIds = [...text.matchAll(/^([A-Za-z0-9][\w.-]*): PASS \| FAIL \| BLOCKED/gm)].map((m) => m[1]);
  if (!caseIds.length && /^SUBMISSION$/m.test(text)) return simulateReviewSubmissions(task, text);
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

// ---------- review bounties ----------

const WRITE_A =
  'A step by step beginner guide to the three payments endpoints. It explains authentication first, then creates a payment, ' +
  'reads its status and issues a refund, with a full request and response example for every call and a short section on common errors.';
const WRITE_B =
  'This tutorial walks through charging a customer with the payments API from a small Node script. It covers creating a payment intent, ' +
  'polling for the result and refunding it, and ends with a checklist for going live with real keys.';

/**
 * A believable crowd for a review bounty, driven by the template in the bounty text: two strong entries,
 * one with a dead link or failing CI, one too short or closed without merging, a copy of the first,
 * a late entry when there is a deadline, and spam.
 */
function simulateReviewSubmissions(task: MockTask, text: string): MockSubmission[] {
  const block = text.slice(text.search(/^SUBMISSION$/m));
  const keys = [...block.matchAll(/^([a-z][\w-]*): </gm)].map((m) => m[1]);
  const isDev = keys.includes('pr');
  const base = new Date(task.createdAt).getTime();
  const at = (mins: number) => new Date(base + mins * 60_000).toISOString();
  const fill = (values: Record<string, string>) => ['SUBMISSION', ...keys.map((k) => `${k}: ${values[k] ?? 'n/a'}`), 'END'].join('\n');
  const repo = 'https://github.com/acme/payments-sdk/pull';
  const notes = (s: string) => `${s} I ran the unit tests and the example script locally before opening the pull request.`;

  const subs: Array<[string, string, number]> = isDev
    ? [
        ['quickcash99', '<p>done, check my github 👍 please approve</p>', 4],
        ['closed_carl', fill({ pr: `${repo}/39`, notes: notes('First attempt at the retry logic using a simple fixed delay between calls.') }), 30],
        ['ada_dev', fill({ pr: `${repo}/41`, notes: notes('Added retry with backoff for 429 responses and a test for each status code.') }), 95],
        ['tunde.codes', fill({ pr: `${repo}/43`, notes: notes('Implemented the retry helper and documented the new option in the README.') }), 140],
        ['kemi_b', fill({ pr: `${repo}/45`, notes: notes('Retry support for rate limits, needs a second look at the timer handling.') }), 160],
        ['wrongrepo_will', fill({ pr: 'https://github.com/someone/else/pull/2', notes: notes('Retry logic, written against my own fork of the project instead.') }), 170],
      ]
    : [
        ['quickcash99', '<p>Wrote it, all good 👍 please approve</p>', 5],
        ['ada_writes', fill({ link: 'https://dev.to/ada/payments-api-guide', summary: WRITE_A }), 30],
        ['tunde.docs', fill({ link: 'https://hashnode.dev/tunde/charging-with-the-payments-api', summary: WRITE_B }), 50],
        ['kemi_b', fill({ link: 'https://dev.to/kemi/payments-guide-404', summary: 'My guide covers the payments API in Python: authentication, creating a payment, checking it and refunding it, with code for each step and notes on the errors I hit along the way.' }), 70],
        ['shorty', fill({ link: 'https://medium.com/@shorty/payments', summary: 'Wrote a quick guide, see link.' }), 80],
        ['copycat', fill({ link: 'https://dev.to/copycat/payments-guide', summary: WRITE_A.replace('beginner', 'beginners') }), 90],
      ];
  if (task.deadline) {
    const late = Math.round((Date.parse(task.deadline) - base) / 60_000) + 60;
    subs.push(
      isDev
        ? ['late_lara', fill({ pr: `${repo}/41`, notes: notes('Retry support, sorry this is late, my laptop broke during the week.') }), late]
        : ['late_lara', fill({ link: 'https://dev.to/lara/payments', summary: `${WRITE_B} Sorry this is late, my laptop broke during the week.` }), late],
    );
  }
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
