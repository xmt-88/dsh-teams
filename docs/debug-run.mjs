// 临时调试：跑一次快速路径，把事件流与异常打出来
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planTeam, approveTeam, startTeamRun } from '../lib/scheduler.js';
import { readTasks } from '../lib/state.js';

const dir = await mkdtemp(join(tmpdir(), 'dbg-'));
const calls = [];
const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
const startActivation = async (spec) => {
  calls.push(spec.label);
  return {
    childId: `c${calls.length}`,
    result: Promise.resolve({ output: [{ type: 'text', text: 'ok\n\nVERDICT: PASS' }], stopReason: 'completed' }),
    dispose: async () => {},
  };
};
const ctx = {
  get: (key) => (key === 'subagents' ? { getProvider: () => provider, list: () => ['spawn'], startActivation } : undefined),
  logger: { warn: console.warn, info() {}, debug() {} },
};
const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 3 }, timeouts: { enabled: false } };
const b = { ctx, config, captainSessionId: 'dbg', workspace: dir, agent: { id: 'cap' } };

await planTeam({ ...b, task: '改个按钮颜色' });
await approveTeam(b);
await startTeamRun(b);
await new Promise((r) => setTimeout(r, 800));

const g = await readTasks(join(dir, '.dsh-teams'), 'dbg');
console.log('任务状态:', g.tasks.map((t) => `${t.id}:${t.status}${t.failure ? `(${t.failure.slice(0, 60)})` : ''}`).join(' | '));
console.log('调用:', calls.join(','));
try {
  const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
  console.log('--- 事件 ---');
  for (const line of events.trim().split('\n')) {
    const e = JSON.parse(line);
    if (e.type === 'note' || e.data?.event === 'failed') console.log(JSON.stringify(e.data).slice(0, 220));
  }
} catch (error) {
  console.log('读事件失败:', String(error));
}
await rm(dir, { recursive: true, force: true });
