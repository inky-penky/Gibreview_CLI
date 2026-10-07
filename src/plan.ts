import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Mainnet USDC. Override per plan with reward.mintAddress. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'must be an amount like "2" or "2.50"');

const CaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][\w.-]*$/, 'case id may use letters, digits, ".", "_" and "-"'),
  title: z.string().min(3),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  preconditions: z.string().optional(),
  steps: z.array(z.string().min(1)).min(1),
  expected: z.string().min(3),
  devices: z.array(z.string()).optional(),
});

const DeviceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'device id must be lowercase-kebab-case'),
  label: z.string().min(2),
  notes: z.string().optional(),
});

export const PlanSchema = z
  .object({
    name: z.string().min(3),
    release: z.string().optional(),
    build: z.object({
      url: z.string().url(),
      notes: z.string().optional(),
    }),
    reward: z.object({
      mintAddress: z.string().default(USDC_MINT),
      symbol: z.string().default('USDC'),
      perTester: money,
      testersPerBatch: z.number().int().min(1).max(20).default(2),
    }),
    batchSize: z.number().int().min(1).max(25).default(6),
    deadlineHours: z.number().int().min(1).max(24 * 30).optional(),
    tags: z.array(z.string()).default(['QA', 'Testing']),
    verifiedTestersOnly: z.boolean().default(false),
    gate: z
      .object({
        failOn: z.array(z.enum(['high', 'medium', 'low'])).default(['high']),
        requireCoverageOn: z.array(z.enum(['high', 'medium', 'low'])).default(['high']),
      })
      .default({ failOn: ['high'], requireCoverageOn: ['high'] }),
    devices: z.array(DeviceSchema).min(1),
    cases: z.array(CaseSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `duplicate case id ${c.id}` });
      seen.add(c.id);
      for (const d of c.devices ?? []) {
        if (!plan.devices.some((dev) => dev.id === d)) {
          ctx.addIssue({ code: 'custom', path: ['cases', i, 'devices'], message: `unknown device "${d}"` });
        }
      }
    });
    const devIds = new Set<string>();
    plan.devices.forEach((d, i) => {
      if (devIds.has(d.id)) ctx.addIssue({ code: 'custom', path: ['devices', i, 'id'], message: `duplicate device id ${d.id}` });
      devIds.add(d.id);
    });
  });

export type TestPlan = z.infer<typeof PlanSchema>;
export type TestCase = TestPlan['cases'][number];
export type Device = TestPlan['devices'][number];

export interface Batch {
  id: string;
  deviceId: string;
  part: number;
  parts: number;
  caseIds: string[];
}

export class PlanError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'PlanError';
  }
}

export function validatePlan(raw: unknown): TestPlan {
  const result = PlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new PlanError('Test plan is invalid', issues);
  }
  return result.data;
}

export async function loadPlan(path: string): Promise<TestPlan> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new PlanError(`Cannot read test plan at ${path}`);
  }
  let raw: unknown;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new PlanError(`Cannot parse ${path}: ${(err as Error).message}`);
  }
  return validatePlan(raw);
}

/** One bounty per device per chunk of cases, so each tester gets a focused, finishable job. */
export function buildBatches(plan: TestPlan): Batch[] {
  const batches: Batch[] = [];
  for (const device of plan.devices) {
    const ids = plan.cases.filter((c) => !c.devices || c.devices.includes(device.id)).map((c) => c.id);
    if (ids.length === 0) continue;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += plan.batchSize) chunks.push(ids.slice(i, i + plan.batchSize));
    chunks.forEach((caseIds, i) => {
      batches.push({ id: `${device.id}-${i + 1}`, deviceId: device.id, part: i + 1, parts: chunks.length, caseIds });
    });
  }
  return batches;
}

/** Decimal-safe money helpers in cents. */
export function toCents(amount: string): number {
  const [whole, frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function fromCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function poolPerBatch(plan: TestPlan): string {
  return fromCents(toCents(plan.reward.perTester) * plan.reward.testersPerBatch);
}
