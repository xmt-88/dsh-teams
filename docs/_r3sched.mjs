/** 第三轮临时探针：调度器行为（用完删除）。 */
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planTeam, approveTeam, startTeamRun, isRunning } from '../lib/scheduler.js';
import { readTasks, readTeam, mutateTasks, stateRootOf, appendJsonl } from '../lib/state.js';

const CONFIG = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 4, maxRetries: 0, maxReviewRounds: 3 },
  gates: { requireEvidence: true, securityBlock: true },
};

function makeFake({ reply } = {}) {
  const calls = [];
  let currentReply = reply;
  const buildResult = (outcome, request) =>
    outcome.ok === false
      ? { output: [{ type: 'text', text: outcome.text ?? 'boom' }], stopReason: outcome.stopReason ?? 'error' }
      : {
          output: [
            {
              type: 'text',
              text: outcome.text ?? `产出：${request.label}\n证据：src/app.js:12（命令退出码 0）\n\nVERDICT: PASS`,
            },
          ],
          stopReason: 'completed',
        };
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
  };
  const startActivation = async (spec) => {
    const request = { ...spec.request, label: spec.label };
    calls.push(request);
    const outcome = (currentReply ?? (() => ({ ok: true })))(spec.label, request);
    const childId = `child-${calls.length}`;
    return { childId, messageId: `msg-${calls.length}`, result: Promise.resolve(buildResult(outcome, request)), dispose: async () => {} };
  };
  return {
    service: { getProvider: (n) => (n === 'spawn' ? provider : undefined), list: () => ['spawn'], startActivation },
    agents: { get: () => ({ cancel: async () => {} }) },
    calls,
    setReply(next) {
      currentReply = next;
    },
  };
}
const fakeCtx = (fake) => ({ get: (k) => (k === 'subagents' ? fake.service : k === 'agents' ? fake.agents : undefined), logger: { warn() {}, info() {}, debug() {} } });
const AGENT = { id: 'session-captain' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function eventText(dir) {
  const root = stateRootOf(dir, '.dsh-teams');
  const files = await readdir(root).catch(() => []);
  const out = [];
  for (const f of files.filter((n) => n.endsWith('.jsonl'))) {
    const raw = await readFile(join(root, f), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) if (line.trim() !== '') out.push(line);
  }
  return out;
}

const dir = await mkdtemp(join(tmpdir(), 'r3-tdz-'));
const fake = makeFake();
const ctx = fakeCtx(fake);
const root = stateRootOf(dir, '.dsh-teams');
const planned = await planTeam({ ctx, config: CONFIG, agent: AGENT, captainSessionId: 's1', workspace: dir, task: '改个按钮颜色' });
console.log('[A] path =', planned.decision?.path);

await mutateTasks(root, 's1', (cur) => {
  for (const t of cur.tasks) if (t.kind === 'implementation') t.role = 'ghost-role';
  return cur;
});
await approveTeam({ config: CONFIG, captainSessionId: 's1', workspace: dir });
const started = await startTeamRun({ ctx, config: CONFIG, agent: AGENT, captainSessionId: 's1', workspace: dir });
console.log('[A] started =', JSON.stringify(started));

for (const wait of [800, 2000, 3000]) {
  await sleep(wait);
  const ev = await eventText(dir);
  const throws = ev.filter((l) => l.includes('dispatchEpoch')).length;
  const team = await readTeam(root, 's1');
  console.log(`[A] +${wait}ms  派发异常事件=${throws}  phase=${team?.phase}  isRunning=${isRunning(root, 's1')}`);
}
const graph = await readTasks(root, 's1');
console.log('[A] 任务状态 =', graph.tasks.map((t) => `${t.id}:${t.status}`).join(' '));
console.log('[A] 是否记下 找不到角色 =', (await eventText(dir)).some((l) => l.includes('找不到角色')));
console.log('[A] 子代理调用次数 =', fake.calls.length);

// 让进程能退出：手动打断（模拟人工介入）
process.exit(0);
