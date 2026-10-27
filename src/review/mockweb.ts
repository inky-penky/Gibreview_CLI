import type { FetchLike } from './checks.js';

/**
 * Offline stand-in for the web, used by review checks in mock runs so demos and tests are repeatable.
 * Matches the simulated submissions in mock.ts: links with "404" or "dead" in them are gone, and a
 * small fake GitHub repo (acme/payments-sdk) has pull requests in each interesting state.
 */

const PULLS: Record<string, { state: string; merged: boolean; sha: string }> = {
  '41': { state: 'open', merged: false, sha: 'sha41' },
  '43': { state: 'closed', merged: true, sha: 'sha43' },
  '45': { state: 'open', merged: false, sha: 'sha45' },
  '39': { state: 'closed', merged: false, sha: 'sha39' },
};

const CHECK_RUNS: Record<string, Array<{ name: string; status: string; conclusion: string | null }>> = {
  sha41: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }],
  sha43: [{ name: 'test', status: 'completed', conclusion: 'success' }],
  sha45: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }],
  sha39: [{ name: 'test', status: 'completed', conclusion: 'success' }],
};

const respond = (status: number, body: unknown = {}, page = '') => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => page, body: null });

export const mockFetch: FetchLike = async (url) => {
  const api = /^https:\/\/api\.github\.com\/repos\/acme\/payments-sdk\/(pulls\/(\d+)|commits\/(\w+)\/check-runs)$/.exec(url);
  if (api) {
    if (api[2]) {
      const pr = PULLS[api[2]];
      return pr ? respond(200, { state: pr.state, merged: pr.merged, head: { sha: pr.sha } }) : respond(404);
    }
    return respond(200, { check_runs: CHECK_RUNS[api[3]] ?? [] });
  }
  if (url.startsWith('https://api.github.com/')) return respond(404);
  if (/404|dead/i.test(url)) return respond(404);
  return respond(200, {}, `<html><body><h1>Simulated page</h1><p>Content published at ${url}.</p></body></html>`);
};
