// 临时二次审计探针 D2：review 快 FAIL、test 仍在跑 → test 旧代码的 PASS 不被重跑
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTeam, approveTeam, startTeamRun } from './lib/scheduler.js';
import { readTeam, readTasks } from './lib/state.js';

const PASS = '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
const FAIL = 'CRITICAL src/app.js:12 证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = [];
let reviewRounds = 0;
const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
const ctx = {
  get: (key) => (key === 'subagents' ? {
    getProvider: () => provider,
    list: () => ['spawn'],
    startActivation: async (spec) => {
      calls.push(spec.label);
      let text = PASS;
      let slow = false;
      if (spec.label.includes('code-reviewer')) {
        reviewRounds += 1;
        if (reviewRounds === 1) text = FAIL;
      }
      if (spec.label.includes('test-engineer')) slow = true;
      const out = () => ({ output: [{ type: 'text', text }], stopReason: 'completed' });
      return { childId: `c${calls.length}`, result: slow ? sleep(600).then(out) : Promise.resolve(out()), dispose: async () => {} };
    },
  } : undefined),
  logger: { warn() {}, info() {}, debug() {} },
};

const dir = await mkdtemp(join(tmpdir(), 'p-d2-'));
const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 4, maxRetries: 0, maxReviewRounds: 1 }, gates: { requireEvidence: true, securityBlock: false }, timeouts: { enabled: false } };
const base = { ctx, config, agent: { id: 'cap' }, captainSessionId: 'race2', workspace: dir };
await planTeam({ ...base, task: '重构认证模块，跨模块大改', filesTouched: 9, crossModule: true });
await approveTeam(base);
await startTeamRun(base);
let team;
for (let i = 0; i < 500; i += 1) {
  team = await readTeam(join(dir, '.dsh-teams'), 'race2');
  if (team?.phase === 'done' || team?.phase === 'failed') break;
  await sleep(20);
}
const graph = await readTasks(join(dir, '.dsh-teams'), 'race2');
const short = (label) => label.split(':').slice(2).join(':');
const counts = {};
for (const c of calls) counts[short(c)] = (counts[short(c)] ?? 0) + 1;
console.log('D2-1 phase=', team?.phase);
console.log('D2-2 派发顺序:', calls.map(short).join(' -> '));
console.log('D2-3 每步次数:', JSON.stringify(counts));
console.log('D2-4 终态:', graph.tasks.map((t) => `${t.id}:${t.status}${t.verdict ? '/' + t.verdict : ''}`).join(' '));
console.log('D2-5 test 是否重跑:', (counts['t-test:test-engineer'] ?? 0) > 1 ? '是' : '否（旧代码结论保留）');
await rm(dir, { recursive: true, force: true });
