/**
 * 门控行为探针（审计产物 · 手动运行 · 不参与自动测试）
 *
 * 用法：node docs/gate-probe-standalone.mjs
 *
 * 存在的意义：这些行为（FAIL 判绿、阶段绕过、批准后改图、并发双跑）现有测试一个都没覆盖，
 * 只能靠实证观察。修完 P0/P1 后，本探针的期望值应全部翻转为 PASS——
 * 届时请把其中关键几条转成正式测试。
 *
 * 标注含义：
 *   ✓  期望行为已成立
 *   ✗  期望行为未成立（缺陷）
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planTeam, approveTeam, startTeamRun } from '../lib/scheduler.js';
import { readTeam, readTasks, mutateTasks, mutateTeam } from '../lib/state.js';
import { route } from '../lib/router.js';

const CONFIG = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 3 },
  gates: { requireEvidence: true, securityBlock: true },
  timeouts: { enabled: false },
};
const AGENT = { id: 'session-captain' };

const log = (label, detail) => console.log(`${label.padEnd(44)} ${detail}`);

/** 假子代理服务：按 label 决定应答文本，用来模拟 review/verify 的结论。 */
function fakeSubagents(replyFor = () => '产出') {
  const calls = [];
  const agents = new Map();
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
  };
  const startActivation = async (spec) => {
    const label = spec.label;
    calls.push(label);
    const childId = `child-${calls.length}`;
    return {
      childId,
      messageId: `msg-${calls.length}`,
      result: Promise.resolve({
        output: [{ type: 'text', text: String(replyFor(label)) }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    };
  };
  return {
    calls,
    ctx: {
      get: (key) => (key === 'subagents' ? { getProvider: (n) => (n === 'spawn' ? provider : undefined), list: () => ['spawn'], startActivation } : key === 'agents' ? { get: (id) => agents.get(id) } : undefined),
      logger: { warn() {}, info() {}, debug() {} },
    },
  };
}

const emptyCtx = { get: () => undefined, logger: { warn() {}, info() {}, debug() {} } };

async function ws(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-probe-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const base = (dir, suffix, extra = {}) => ({
  config: CONFIG,
  captainSessionId: suffix,
  workspace: dir,
  agent: AGENT,
  ...extra,
});

/* ---- A：缺 subagents 服务时的报错质量 ---- */
await ws(async (dir) => {
  const b = base(dir, 'a', { ctx: emptyCtx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  await approveTeam(b);
  const run = await startTeamRun(b);
  await new Promise((r) => setTimeout(r, 300));
  const team = await readTeam(join(dir, '.dsh-teams'), 'a');
  log('A 缺 subagents 服务', `started=${run.started} phase=${team?.phase} → 期望：明确报错，不留 running`);
});

/* ---- B：未批准不能跑 ---- */
await ws(async (dir) => {
  const b = base(dir, 'b', { ctx: fakeSubagents().ctx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  const run = await startTeamRun(b);
  log('B 未批准直接 run', `started=${run.started} reason=${run.reason ?? ''}`);
});

/* ---- D：phase 非 staged 但从未批准 ---- */
await ws(async (dir) => {
  const b = base(dir, 'd', { ctx: fakeSubagents().ctx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  const root = join(dir, '.dsh-teams');
  await mutateTeam(root, 'd', (t) => {
    t.phase = 'done';
    delete t.approvedAt;
    return t;
  });
  const run = await startTeamRun(b);
  log('D phase=done 且无 approvedAt', `started=${run.started} → 期望：false（闸门应看 approvedAt）`);
  await new Promise((r) => setTimeout(r, 200));
});

/* ---- E：rebuild 撤销批准 ---- */
await ws(async (dir) => {
  const b = base(dir, 'e', { ctx: fakeSubagents().ctx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  await approveTeam(b);
  await planTeam({ ...b, task: '改成另一件事', rebuild: true });
  const run = await startTeamRun(b);
  log('E rebuild 后', `started=${run.started} reason=${run.reason ?? ''}`);
});

/* ---- F：批准后往图里追加任务 ---- */
await ws(async (dir) => {
  const fake = fakeSubagents();
  const b = base(dir, 'f', { ctx: fake.ctx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  await approveTeam(b);
  const root = join(dir, '.dsh-teams');
  await mutateTasks(root, 'f', (g) => {
    g.tasks.push({ id: 't-injected', role: 'security-reviewer', roleName: '安全审查员', kind: 'review', deps: [], status: 'pending', acceptance: [], evidence: [], attempts: [], order: 9 });
    return g;
  });
  const run = await startTeamRun(b);
  await new Promise((r) => setTimeout(r, 400));
  const g = await readTasks(root, 'f');
  log('F 批准后追加任务', `started=${run.started} 派发=${fake.calls.join(',')} → 期望：拒绝或至少重批`);
});

/* ---- G：gates.requireEvidence 有没有差别（同一条"PASS 但无证据"的产出） ---- */
const noEvidenceReply = () => '做完了，都通过。\n\nVERDICT: PASS';
for (const [label, gates] of [['开', { requireEvidence: true, securityBlock: true }], ['关', { requireEvidence: false, securityBlock: false }]]) {
  await ws(async (dir) => {
    const fake = fakeSubagents(noEvidenceReply);
    const b = base(dir, `g-${label}`, { ctx: fake.ctx, config: { ...CONFIG, gates } });
    await planTeam({ ...b, task: '改个按钮颜色' });
    await approveTeam(b);
    await startTeamRun(b);
    for (let i = 0; i < 60; i += 1) {
      const team = await readTeam(join(dir, '.dsh-teams'), `g-${label}`);
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const team = await readTeam(join(dir, '.dsh-teams'), `g-${label}`);
    console.log(`G requireEvidence=${label}  phase=${team?.phase} → 期望：开=failed（无证据不算通过），关=done`);
  });
}

/* ---- H：verifier 报 FAIL / review 报 CRITICAL ---- */
await ws(async (dir) => {
  const fake = fakeSubagents((label) => {
    if (label.includes('code-reviewer')) return 'CRITICAL: src/auth.js:42 越权。结论：REJECT';
    if (label.includes('verifier')) return '必查项「构建或类型检查零错误」：FAIL。结论：FAIL';
    return '产出';
  });
  const b = base(dir, 'h', { ctx: fake.ctx });
  await planTeam({ ...b, task: '改个按钮颜色' });
  await approveTeam(b);
  await startTaskRunAll(b);
  const root = join(dir, '.dsh-teams');
  const team = await readTeam(root, 'h');
  const g = await readTasks(root, 'h');
  log('H verifier 报 FAIL', `phase=${team?.phase} 状态=${g.tasks.map((t) => `${t.id}:${t.status}`).join(',')} → 期望：failed`);
});

/* ---- I/J：风险词命中 ---- */
const routeOf = (taskText, extra = {}) => route({ taskText, ...extra });
const RISK_CASES = [
  ['支付回调签名校验失败', 'full'],
  ['用户 token 过期后一直 401', 'full'],
  ['rotate the credentials of the worker', 'full'],
  ['store secrets in the vault', 'full'],
  ['update user permissions', 'full'],
  ['退款流程改造', 'full'],
];
for (const [text, expected] of RISK_CASES) {
  const d = routeOf(text);
  const ok = d.path === expected;
  console.log(`J ${ok ? '✓' : '✗'} ${text.padEnd(38)} path=${String(d.path).padEnd(9)} 期望=${expected}`);
}
// 显式降级也必须被风险覆盖压住
const forced = routeOf('支付回调签名校验失败', { forcePath: 'fast' });
console.log(`I ${forced.path === 'full' ? '✓' : '✗'} 支付+force_path=fast → path=${forced.path}（期望 full）`);

async function startTaskRunAll(b) {
  await startTeamRun(b);
  // 等调度循环收口（本探针里的子代理是即时的）
  for (let i = 0; i < 60; i += 1) {
    const team = await readTeam(join(b.workspace, '.dsh-teams'), b.captainSessionId);
    if (team?.phase === 'done' || team?.phase === 'failed') return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
