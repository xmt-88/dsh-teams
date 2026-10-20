/**
 * 探针：watch.stallFloorMs / stallFactor 是否真的能从配置走到看门狗。
 *
 * 观察点（这是本探针的要点，不要退化）：
 *   1. Config.parse 之后两个键还在不在（schema 层是否丢键）；
 *   2. 经过插件的 apply 期配置视图（index.js:1101-1110）后，看门狗是否仍拿得到；
 *   3. 对照组：直接把原始 config 交给 scheduler，看门狗是否能拿到。
 *
 * 假设：即使 Config.parse 保留了键，apply 期视图只暴露 3 个 watch getter，
 * 所以 runner 永远用默认 stallFloorMs=900000，配置的 120ms 不生效。
 * 若 apply 组 900ms 内没有判死、而对照组 ~120ms 判死，假设成立（reproduced=true）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config, apply } from '../../index.js';
import { stateRootOf, readTasks, readTeam, mutateTasks } from '../../lib/state.js';
import { planTeam, approveTeam, startTeamRun, stopRun, isRunning } from '../../lib/scheduler.js';

export const id = 'probe-watch-keys';
export const dim = 'hardcoded';
export const title = 'watch.stallFloorMs/stallFactor 被 apply 期配置视图截断';

const SESSION = 'probe-watch-session';

function rawConfig() {
  return {
    stateDir: '.dsh-teams',
    routing: { riskShortCircuit: true, fastMax: 1, standardMax: 4 },
    scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 0 },
    timeouts: { enabled: false, heavy: 2700, medium: 1200, light: 900, infrastructure: 300 },
    // 故意给一个远小于默认 900s 的停滞下限：生效的话 120ms 内就会判死。
    watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000, stallFloorMs: 120, stallFactor: 2 },
    gates: { requireEvidence: true, securityBlock: true },
    ui: { locale: 'zh-CN' },
  };
}

/** 一个永不返回结果、会话游标不前进的子代理；收到 abort 才让 result 失败。 */
function stuckChild(cancels) {
  return {
    status: 'running',
    session: { get seq() { return 1; } },
    cancel: (cause) => { cancels.push(cause); },
  };
}

function fakeSubagents() {
  const agents = new Map();
  const calls = [];
  const cancels = [];
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
  };
  const child = stuckChild(cancels);
  const startActivation = async (spec) => {
    const childId = `child-${calls.length + 1}`;
    calls.push({ label: spec.label, childId });
    agents.set(childId, child);
    const result = new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted by probe'), { name: 'AbortError' }));
      if (spec.signal?.aborted === true) abort();
      else spec.signal?.addEventListener('abort', abort, { once: true });
    });
    return { childId, messageId: `msg-${calls.length}`, result, dispose: async () => {} };
  };
  const subagents = { getProvider: () => provider, list: () => ['spawn'], startActivation };
  return { subagents, agents, calls, cancels };
}

function fakeCtxForApply(host, tools) {
  return {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
    systemPrompt: { section: () => ({}) },
    effect: (fn) => { fn(); },
    on: () => {},
    get(name) {
      if (name === 'subagents') return host.subagents;
      if (name === 'agents') return { get: (childId) => host.agents.get(childId) };
      return undefined;
    },
    logger: { debug() {}, info() {}, warn() {} },
  };
}

function fakeCtxForDispatch(host) {
  return {
    get(name) {
      if (name === 'subagents') return host.subagents;
      if (name === 'agents') return { get: (childId) => host.agents.get(childId) };
      return undefined;
    },
    logger: { debug() {}, info() {}, warn() {} },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGone(stateRoot, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(stateRoot, SESSION)) return true;
    await sleep(20);
  }
  return !isRunning(stateRoot, SESSION);
}

async function runApplied(dir, parsed, host) {
  const tools = new Map();
  apply(fakeCtxForApply(host, tools), parsed);
  for (const name of ['teams_plan', 'teams_approve', 'teams_run', 'teams_stop']) {
    if (!tools.has(name)) throw new Error(`apply 未注册工具 ${name}`);
  }
  const exec = { agent: { id: SESSION, session: { header: { cwd: dir } } }, callId: 'probe' };
  const stateRoot = stateRootOf(dir, '.dsh-teams');

  await tools.get('teams_plan').execute({ task: '改个按钮颜色', force_path: 'fast' }, exec);
  await tools.get('teams_approve').execute({}, exec);
  const started = await tools.get('teams_run').execute({}, exec);
  if (started.started !== true) throw new Error(`apply 组启动失败：${started.reason}`);

  // 默认 stallFloor=900s，120ms 的配置若没被截断，这里早该判死。
  await sleep(900);
  const before = (await readTasks(stateRoot, SESSION)).tasks.find((task) => task.id === 't-executor');
  const statusBeforeStop = before?.status;
  const failureBeforeStop = before?.failure;

  stopRun(stateRoot, SESSION);
  await waitGone(stateRoot);
  return { statusBeforeStop, failureBeforeStop, calls: host.calls.length };
}

async function runRaw(dir) {
  const config = rawConfig();
  const host = fakeSubagents();
  const ctx = fakeCtxForDispatch(host);
  const stateRoot = stateRootOf(dir, '.dsh-teams');
  const base = { ctx, config, agent: { id: SESSION, session: { header: { cwd: dir } } }, captainSessionId: SESSION, workspace: dir };

  await planTeam({ ...base, task: '改个按钮颜色', forcePath: 'fast' });
  await approveTeam(base);
  const started = await startTeamRun({ ...base, providerName: 'spawn' });
  if (started.started !== true) throw new Error(`对照组启动失败：${started.reason}`);
  const gone = await waitGone(stateRoot, 5000);
  const task = (await readTasks(stateRoot, SESSION)).tasks.find((item) => item.id === 't-executor');
  return { gone, status: task?.status, failure: task?.failure, calls: host.calls.length };
}

export async function run() {
  const dirApply = await mkdtemp(join(tmpdir(), 'dsh-teams-probe-watch-apply-'));
  const dirRaw = await mkdtemp(join(tmpdir(), 'dsh-teams-probe-watch-raw-'));
  try {
    const raw = rawConfig();
    const parsed = new Config(raw);
    const schemaKept = {
      stallFloorMs: parsed?.watch?.stallFloorMs,
      stallFactor: parsed?.watch?.stallFactor,
    };
    const parsedView = {
      probeMs: typeof parsed?.watch?.probeMs?.get === 'function' ? parsed.watch.probeMs.get() : parsed?.watch?.probeMs,
      stallFloorMs: parsed?.watch?.stallFloorMs,
    };

    const applied = await runApplied(dirApply, parsed, fakeSubagents());
    const control = await runRaw(dirRaw);

    const applyViewBlocked = applied.statusBeforeStop !== 'failed';
    const controlWorks = control.status === 'failed' && /没有任何进展|卡死/.test(String(control.failure));
    const reproduced = applyViewBlocked && controlWorks;

    return {
      reproduced,
      observed: {
        configParseKeepsKeys: schemaKept,
        parsedView,
        applyView: {
          statusAfter900ms: applied.statusBeforeStop,
          failure: applied.failureBeforeStop,
          childStarted: applied.calls,
          killedWithin900ms: applied.statusBeforeStop === 'failed',
        },
        rawConfigControl: {
          settled: control.gone,
          status: control.status,
          failure: control.failure,
          childStarted: control.calls,
          killedWithin900ms: control.status === 'failed',
        },
      },
      expected: 'apply 期配置视图应把 stallFloorMs/stallFactor 一并暴露；配置 120ms 时看门狗应在 ~120ms 判死（与 raw config 对照组一致）',
      note: '若 Config.parse 保留键而 apply 组不判死、对照组判死，则根因在 apply 期 getter 视图（index.js:1101-1110），不是 schema。',
    };
  } finally {
    await rm(dirApply, { recursive: true, force: true }).catch(() => {});
    await rm(dirRaw, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('probe-watch-keys.mjs')) {
  run().then((result) => {
    console.log(JSON.stringify({ id, dim, title, ...result }, null, 2));
    if (result.reproduced !== true) console.log('（假设未复现）');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
