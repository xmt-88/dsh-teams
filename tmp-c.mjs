// 临时二次审计探针 C：僵尸锁接管 / 残留 running / 续跑死路
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTeam, approveTeam, startTeamRun, retryFailedTeam, isRunning, stopRun } from './lib/scheduler.js';
import { readTeam, readTasks } from './lib/state.js';

const PASS = '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
function fakeHangFirst() {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
  return {
    calls,
    release: () => release(),
    ctx: {
      get: (key) => (key === 'subagents' ? {
        getProvider: () => provider,
        list: () => ['spawn'],
        startActivation: async (spec) => {
          calls.push(spec.label);
          const hang = calls.length === 1;
          return {
            childId: `c${calls.length}`,
            result: hang ? gate.then(() => ({ output: [{ type: 'text', text: PASS }], stopReason: 'completed' })) : Promise.resolve({ output: [{ type: 'text', text: PASS }], stopReason: 'completed' }),
            dispose: async () => {},
          };
        },
      } : undefined),
      logger: { warn() {}, info() {}, debug() {} },
    },
  };
}

const dir = await mkdtemp(join(tmpdir(), 'p-c-'));
const f = fakeHangFirst();
const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 1 }, gates: { requireEvidence: true, securityBlock: true }, timeouts: { enabled: false } };
const base = { ctx: f.ctx, config, agent: { id: 'cap' }, captainSessionId: 'lk', workspace: dir };
await planTeam({ ...base, task: '改个按钮颜色' });
await approveTeam(base);
await startTeamRun(base);
await new Promise((r) => setTimeout(r, 150));
console.log('C1 首次派发:', f.calls.map((l) => l.split(':').slice(2).join(':')).join(','), '| isRunning=', isRunning(join(dir, '.dsh-teams'), 'lk'));

const realNow = Date.now;
Date.now = () => realNow() + 2 * 60 * 60 * 1000; // 模拟 1 小时无心跳
const second = await startTeamRun(base);
await new Promise((r) => setTimeout(r, 300));
const team = await readTeam(join(dir, '.dsh-teams'), 'lk');
const graph = await readTasks(join(dir, '.dsh-teams'), 'lk');
console.log('C2 僵尸接管:', JSON.stringify(second), '| phase=', team?.phase, '| isRunning=', isRunning(join(dir, '.dsh-teams'), 'lk'));
console.log('C2 任务状态:', graph.tasks.map((t) => `${t.id}:${t.status}`).join(','));
const retry = await retryFailedTeam({ config, captainSessionId: 'lk', workspace: dir });
console.log('C3 续跑结果:', JSON.stringify(retry));
const again = await startTeamRun(base);
console.log('C4 再 run:', JSON.stringify(again));
Date.now = realNow;
f.release();
await new Promise((r) => setTimeout(r, 800));
const team2 = await readTeam(join(dir, '.dsh-teams'), 'lk');
console.log('C5 旧循环恢复后 phase=', team2?.phase, '| 派发:', f.calls.map((l) => l.split(':').slice(2).join(':')).join(','));
stopRun(join(dir, '.dsh-teams'), 'lk');
await new Promise((r) => setTimeout(r, 200));
await rm(dir, { recursive: true, force: true });
