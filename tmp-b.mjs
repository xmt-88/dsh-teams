// 临时二次审计探针 B：驳回重做路径 / 收口 / 零轮预算
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTeam, approveTeam, startTeamRun } from './lib/scheduler.js';
import { readTeam, readTasks } from './lib/state.js';

const PASS = '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
const FAIL = 'CRITICAL src/app.js:12 证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL';

function fake(reply) {
  const calls = [];
  const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
  return {
    calls,
    ctx: {
      get: (key) => (key === 'subagents' ? {
        getProvider: () => provider,
        list: () => ['spawn'],
        startActivation: async (spec) => {
          calls.push(spec.label);
          const text = reply(spec.label, calls);
          return { childId: `c${calls.length}`, result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }), dispose: async () => {} };
        },
      } : undefined),
      logger: { warn() {}, info() {}, debug() {} },
    },
  };
}

async function drain(dir, name) {
  for (let i = 0; i < 400; i += 1) {
    const team = await readTeam(join(dir, '.dsh-teams'), name);
    if (team?.phase === 'done' || team?.phase === 'failed' || team?.phase === 'halted') return team;
    await new Promise((r) => setTimeout(r, 20));
  }
  return readTeam(join(dir, '.dsh-teams'), name);
}

const short = (label) => label.split(':').slice(2).join(':');

/* 1) maxReviewRounds=0：门判 FAIL 不应重做 */
{
  const dir = await mkdtemp(join(tmpdir(), 'p-b0-'));
  const f = fake((label) => (label.includes('code-reviewer') ? FAIL : PASS));
  const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 0 }, gates: { requireEvidence: true, securityBlock: true }, timeouts: { enabled: false } };
  const base = { ctx: f.ctx, config, agent: { id: 'cap' }, captainSessionId: 'z', workspace: dir };
  await planTeam({ ...base, task: '改个按钮颜色' });
  await approveTeam(base);
  await startTeamRun(base);
  const team = await drain(dir, 'z');
  console.log('B1 零轮预算:', team?.phase, '| 派发:', f.calls.map(short).join(' , '));
  await rm(dir, { recursive: true, force: true });
}

/* 2) full 路径：security FAIL 一次 → 看 simplify/critic 是否重跑、是否成环 */
{
  const dir = await mkdtemp(join(tmpdir(), 'p-bf-'));
  let sec = 0;
  const f = fake((label) => {
    if (label.includes('security-reviewer')) {
      sec += 1;
      return sec === 1 ? FAIL : PASS;
    }
    return PASS;
  });
  const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 1 }, gates: { requireEvidence: true, securityBlock: false }, timeouts: { enabled: false } };
  const base = { ctx: f.ctx, config, agent: { id: 'cap' }, captainSessionId: 'fu', workspace: dir };
  await planTeam({ ...base, task: '重构认证模块，跨模块大改', filesTouched: 9, crossModule: true });
  await approveTeam(base);
  await startTeamRun(base);
  const team = await drain(dir, 'fu');
  console.log('B2 full 路径:', team?.phase, '| 派发顺序:', f.calls.map(short).join(' -> '));
  const counts = {};
  for (const label of f.calls) { const k = short(label); counts[k] = (counts[k] ?? 0) + 1; }
  console.log('B2 每步次数:', JSON.stringify(counts));
  const graph = await readTasks(join(dir, '.dsh-teams'), 'fu');
  const ids = new Set(graph.tasks.map((t) => t.id));
  console.log('B2 悬空依赖:', graph.tasks.flatMap((t) => t.deps.filter((d) => !ids.has(d)).map((d) => `${t.id}->${d}`)).join(',') || '无');
  // 环检测
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const state = new Map();
  const cyclic = [];
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { cyclic.push(stack.join('->')); return; }
    state.set(id, 1);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep, [...stack, dep]);
    state.set(id, 2);
  };
  for (const t of graph.tasks) visit(t.id, [t.id]);
  console.log('B2 环:', cyclic.join(' | ') || '无');
  await rm(dir, { recursive: true, force: true });
}

/* 3) deploy 路径：门判 FAIL（无 implementation 可退回）会怎样 */
{
  const dir = await mkdtemp(join(tmpdir(), 'p-bd-'));
  const f = fake((label) => (label.includes('deploy-auditor') ? FAIL : PASS));
  const config = { stateDir: '.dsh-teams', scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 2 }, gates: { requireEvidence: true, securityBlock: true }, timeouts: { enabled: false } };
  const base = { ctx: f.ctx, config, agent: { id: 'cap' }, captainSessionId: 'dp', workspace: dir };
  await planTeam({ ...base, task: '打包发布到生产环境', filesTouched: 2 });
  console.log('B3 路径:', (await (await import('./lib/state.js')).readTeam(join(dir, '.dsh-teams'), 'dp'))?.decision?.path);
  await approveTeam(base);
  await startTeamRun(base);
  const team = await drain(dir, 'dp');
  console.log('B3 deploy 无实现可退回:', team?.phase, '| 派发:', f.calls.map(short).join(' , '));
  const graph = await readTasks(join(dir, '.dsh-teams'), 'dp');
  console.log('B3 门轮次:', graph.tasks.map((t) => `${t.id}:${t.status}/round=${t.reviewRound ?? '-'}`).join(' '));
  await rm(dir, { recursive: true, force: true });
}
