// 临时验证：驳回 → 退回执行者 → 重做 → 门重跑，这一圈能不能闭合
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planTeam, approveTeam, startTeamRun } from '../lib/scheduler.js';
import { readTasks, readTeam } from '../lib/state.js';

const dir = await mkdtemp(join(tmpdir(), 'rework-'));
const calls = [];
let reviewRounds = 0;

const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
const startActivation = async (spec) => {
  const label = spec.label;
  calls.push(label);
  let text = '实现完成。证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
  if (label.includes('code-reviewer')) {
    reviewRounds += 1;
    text =
      reviewRounds <= 2
        ? '发现 CRITICAL：src/app.js:12 越权。证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL'
        : '复审通过。证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
  }
  return {
    childId: `c${calls.length}`,
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    dispose: async () => {},
  };
};
const ctx = {
  get: (key) => (key === 'subagents' ? { getProvider: () => provider, list: () => ['spawn'], startActivation } : undefined),
  logger: { warn() {}, info() {}, debug() {} },
};
const config = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 3 },
  gates: { requireEvidence: true, securityBlock: true },
  timeouts: { enabled: false },
};
const b = { ctx, config, captainSessionId: 'rw', workspace: dir, agent: { id: 'cap' } };

await planTeam({ ...b, task: '改个按钮颜色' });
await approveTeam(b);
await startTeamRun(b);
for (let i = 0; i < 200; i += 1) {
  const team = await readTeam(join(dir, '.dsh-teams'), 'rw');
  if (team?.phase === 'done' || team?.phase === 'failed') break;
  await new Promise((r) => setTimeout(r, 25));
}

const team = await readTeam(join(dir, '.dsh-teams'), 'rw');
const graph = await readTasks(join(dir, '.dsh-teams'), 'rw');
console.log('phase =', team?.phase);
console.log('派发顺序 =', calls.map((c) => c.split(':').slice(2).join(':')).join(' → '));
for (const task of graph.tasks) {
  console.log(`  ${task.id.padEnd(10)} ${String(task.status).padEnd(8)} reviewRound=${task.reviewRound ?? 0} verdict=${task.verdict ?? '-'}`);
}
await rm(dir, { recursive: true, force: true });
