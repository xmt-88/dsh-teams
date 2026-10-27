/**
 * DSH Teams — 调度器与任务图测试
 *
 * 这里锁的是新引入的高风险逻辑：
 *   - 审批闸门：未批准绝不能派发（这是"用户确认"的硬保证）
 *   - 任务图组装：依赖、验收标准、并行组
 *   - 调度循环：就绪挑选、失败阻塞下游、收口状态
 *   - 子代理运行器：persona/任务卡构造、输出提取、stopReason 映射
 *
 * 用一个**假 subagents 服务**驱动，不真的调用模型——调度逻辑与模型解耦，
 * 这样才能快速、确定地覆盖失败路径。
 *
 * 运行：node --test test/scheduler.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTaskGraph,
  pickReady,
  collectDependencyOutputs,
  depsSatisfied,
  summarize,
  truncateForHandoff,
  DEP_OUTPUT_LIMIT,
  DEP_TOTAL_LIMIT,
} from '../lib/tasks.js';
import { planTeam, approveTeam, startTeamRun, retryFailedTeam, isRunning, classifyFailure, extractFindings } from '../lib/scheduler.js';
import { buildPersona, buildTaskPrompt, extractOutput, describeStopReason, resolveChildDelegationDepth, resolveTimeoutMs, TIMEOUT_MS } from '../lib/runner.js';
import { readTasks, readTeam, stateRootOf, mutateTasks, appendTeamNote } from '../lib/state.js';
import { PATH_TEMPLATES } from '../lib/router.js';

/** 默认配置（与插件 Config 默认值一致）。 */
const CONFIG = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 4, maxRetries: 0, maxReviewRounds: 3 },
  gates: { requireEvidence: true, securityBlock: true },
};

/**
 * 假 subagents 服务。
 *
 * @param {object} [options]
 * @param {(label:string)=>object} [options.reply] - 按 label 决定这次运行的结果
 * @param {number} [options.delayMs] - 模拟耗时，用于观察并行
 */
/**
 * 假 subagents 服务。
 *
 * **默认模拟 0.2.1-rc.2 的契约**：`startActivation(spec)`，spec 里 `label`/`signal` 在外层、
 * `request` 里只有 prompt/parent/agentOptions/maxDepth；返回 `{ childId, result, dispose }`
 * ——**没有 localAgent**。子代理 Agent 由假 `agents` 服务按 childId 提供（runner 会去那里取）。
 *
 * `legacy: true` 时改模拟旧契约（`start(provider, request)` 且返回值带 localAgent），
 * 用来锁住"旧宿主也能跑"的兜底路径。
 */
function fakeSubagents({ reply, delayMs = 0, resultDelayMs = 0, child, legacy = false } = {}) {
  const calls = [];
  let active = 0;
  let peakActive = 0;
  // 可换的应答策略：续跑测试要"第一次失败、第二次成功"
  let currentReply = reply;
  const agents = new Map();

  const provider = {
    name: 'spawn',
    // 0.2.1 的能力表：没有 persona / toolFilter，多了 agentPreset
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
    ...(legacy
      ? {
          start: async (request) => {
            calls.push(request);
            active += 1;
            peakActive = Math.max(peakActive, active);
            const outcome = (currentReply ?? (() => ({ ok: true })))(request.label, request);
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            active -= 1;
            return {
              id: `child-${calls.length}`,
              localAgent: typeof child === 'function' ? child(calls.length) : child,
              result: buildResult(outcome, request, resultDelayMs),
              dispose: async () => {},
            };
          },
        }
      : {}),
  };

  const buildResult = (outcome, request, delay) => {
    const settle = () => (outcome.ok === false
      ? {
          // 真实宿主在中断/超时时仍会带回已经产出的文本块；这里按需模拟
          output: outcome.text === undefined ? [] : [{ type: 'text', text: outcome.text }],
          stopReason: outcome.stopReason ?? 'error',
        }
      : {
          // 门类任务（review / verification）必须带机器可读判定，否则宿主按 fail-closed 判失败。
          // 夹具统一补一行 PASS，让"调度机制"类测试不被质量门干扰。
          // 门类任务要带**可复核的证据**（gates.requireEvidence 默认开）：
          // 文件:行号 + 退出码，否则 PASS 也会被判失败。
          output: [
            {
              type: 'text',
              text: outcome.text ?? `产出：${request.label}\n证据：src/app.js:12（命令退出码 0）\n\nVERDICT: PASS`,
            },
          ],
          stopReason: 'completed',
        });
    if (outcome.hold === true) return new Promise(() => {}); // 永不返回：模拟卡死/空转
    // ⚠️ 延迟的是 **result**（子代理跑着不交结果），看门狗才会真的工作起来。
    // delayMs 延迟的是派发返回本身，看门狗根本没机会跑。
    if (delay > 0) return new Promise((resolve) => setTimeout(() => resolve(settle()), delay));
    return Promise.resolve(settle());
  };

  let lastSpec;
  const startActivation = async (spec) => {
    lastSpec = spec;
    const request = { ...spec.request, label: spec.label };
    calls.push(request);
    active += 1;
    peakActive = Math.max(peakActive, active);
    const outcome = (currentReply ?? (() => ({ ok: true })))(spec.label, request);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    const childId = `child-${calls.length}`;
    // 真实宿主把子代理登记在 agents 服务里，runner 就靠这个拿 Agent 做看门狗
    if (child !== undefined) agents.set(childId, typeof child === 'function' ? child(calls.length) : child);
    return {
      childId,
      messageId: `msg-${calls.length}`,
      result: buildResult(outcome, request, resultDelayMs),
      dispose: async () => {},
    };
  };

  return {
    service: {
      getProvider: (name) => (name === provider.name ? provider : undefined),
      list: () => [provider.name],
      // 旧宿主**只有** start；新宿主**只有** startActivation（这正是两条路径的判别依据）
      ...(legacy ? { start: async (name, request) => provider.start(request) } : { startActivation }),
    },
    // runner 通过 ctx.get('agents').get(childId) 解析子代理 Agent
    agents: { get: (id) => agents.get(id) },
    calls,
    peak: () => peakActive,
    /** 最近一次 startActivation 的原始 spec（用来断言 delivery/provider 等外层字段）。 */
    get lastSpec() {
      return lastSpec;
    },
    /** 换掉应答策略（续跑测试：第一次失败、第二次成功）。 */
    setReply(next) {
      currentReply = next;
    },
  };
}

/**
 * 假插件上下文，只提供调度器用到的服务。
 *
 * 既接受 `fakeSubagents()` 的整套返回值，也接受裸 service——前者会一并接上 `agents`
 * 服务（0.2.1 起子代理 Agent 要从 `ctx.agents.get(childId)` 取，看门狗靠它）。
 */
function fakeCtx(subagents) {
  const service = subagents?.service ?? subagents;
  const agents = subagents?.agents;
  return {
    get: (key) => (key === 'subagents' ? service : key === 'agents' ? agents : undefined),
    logger: { warn() {}, info() {}, debug() {} },
  };
}

/** 假队长 agent（只需有 id）。 */
const FAKE_AGENT = { id: 'session-captain' };

async function withWorkspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-sched-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ================================================================== *
 * 任务图组装
 * ================================================================== */

test('任务图：依赖被正确映射为任务 id，且与模板一致', async () => {
  const graph = buildTaskGraph({
    steps: PATH_TEMPLATES.fast,
    teamId: 'session-1',
    subject: '改个按钮颜色',
  });

  assert.equal(graph.tasks.length, 3);
  assert.deepEqual(graph.tasks.map((task) => task.id), ['t-executor', 't-review', 't-verify']);
  assert.deepEqual(graph.tasks[1].deps, ['t-executor']);
  assert.deepEqual(graph.tasks[2].deps, ['t-review']);
  assert.ok(graph.tasks.every((task) => task.status === 'pending'));
});

test('任务图：实现类任务带上全局验收标准，并自带基础标准', async () => {
  const graph = buildTaskGraph({
    steps: PATH_TEMPLATES.fast,
    teamId: 'session-1',
    subject: '实现登录',
    acceptance: ['用户可以登录', '错误密码有提示'],
  });

  const executor = graph.tasks.find((task) => task.id === 't-executor');
  assert.ok(executor.acceptance.some((item) => item.includes('用户可以登录')), '应带上用户验收标准');
  // 验收项必须与语言/平台无关：不能写死"构建或类型检查"（纯 Python / 文档项目无此环节）
  assert.ok(
    executor.acceptance.some((item) => item.includes('项目自身可用的验证手段')),
    '应自带与技术栈无关的基础标准',
  );
  assert.ok(
    !executor.acceptance.some((item) => /^构建或类型检查/.test(item)),
    '不得写死构建/类型检查环节',
  );

  // 审查类任务不重复携带用户验收标准（它审查的是变更，不是需求）
  const review = graph.tasks.find((task) => task.id === 't-review');
  assert.ok(review.acceptance.some((item) => item.includes('文件与行号')));
  assert.ok(!review.acceptance.some((item) => item.includes('用户可以登录')));
});

test('任务图：完整路径的并行组被正确识别', async () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.full, teamId: 's', subject: '大改造' });
  const review = graph.tasks.find((task) => task.id === 't-review');
  const security = graph.tasks.find((task) => task.id === 't-security');
  const testTask = graph.tasks.find((task) => task.id === 't-test');

  // 三者都依赖 executor → 同一批可并行（安全门也必须审"这次改动"，见审计 R6-15）
  assert.deepEqual(review.deps, ['t-executor']);
  assert.deepEqual(security.deps, ['t-executor']);
  assert.deepEqual(testTask.deps, ['t-executor']);
  // verify 依赖它们全部
  const verify = graph.tasks.find((task) => task.id === 't-verify');
  assert.deepEqual([...verify.deps].sort(), ['t-review', 't-security', 't-simplify', 't-test']);
});

/* ================================================================== *
 * 就绪挑选
 * ================================================================== */

test('就绪挑选：无依赖的先跑，依赖未满足的等待', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.fast, teamId: 's', subject: 'x' });
  const { ready } = pickReady(graph.tasks, 0, 4);
  assert.deepEqual(ready.map((task) => task.id), ['t-executor'], '只有无依赖任务就绪');
});

test('就绪挑选：遵守并行上限', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.full, teamId: 's', subject: 'x' });
  // 让所有任务都无依赖，便于测上限
  for (const task of graph.tasks) task.deps = [];
  assert.equal(pickReady(graph.tasks, 0, 2).ready.length, 2, '上限 2 时只挑 2 个');
  assert.equal(pickReady(graph.tasks, 1, 2).ready.length, 1, '已有 1 个在跑时只再挑 1 个');
  assert.equal(pickReady(graph.tasks, 2, 2).ready.length, 0, '满了不再挑');
});

test('就绪挑选：依赖失败的任务转为阻塞而不是继续跑', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.fast, teamId: 's', subject: 'x' });
  graph.tasks[0].status = 'failed';
  const { ready, blocked } = pickReady(graph.tasks, 0, 4);
  assert.equal(ready.length, 0, '下游不应就绪');
  assert.deepEqual(blocked.map((task) => task.id), ['t-review'], '直接下游应被标为阻塞');
});

test('依赖产物汇总：逐条与总量都受截断保护', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.fast, teamId: 's', subject: 'x' });
  graph.tasks[0].status = 'done';
  graph.tasks[0].output = 'A'.repeat(DEP_OUTPUT_LIMIT + 3000);

  const text = collectDependencyOutputs(graph.tasks[1], graph.tasks);
  assert.ok(text.includes('t-executor') || text.includes('开发执行者'), '应带来源标注');
  assert.ok(text.length < graph.tasks[0].output.length, '超长输出应被截断');
  assert.ok(text.length <= DEP_TOTAL_LIMIT, '总量不得超上限');
});

test('交接截断：超限时保留开头 + 全部文件:行号 + 结尾 VERDICT', () => {
  const body = Array.from({ length: 60 }, (_, index) => `第 ${index} 行正文，用来把报告撑长。`).join('\n');
  const report = [
    '## 代码审查报告',
    body,
    '发现：',
    '- HIGH lib/a.js:12 路径穿越：未校验 ..',
    '- MEDIUM lib/b.js:34 缺少长度限制',
    '证据：`lib/a.js:12`、`lib/b.js:34`，退出码 0。',
    Array.from({ length: 60 }, (_, index) => `附录 ${index}：无关正文。`).join('\n'),
    '',
    '结论：存在 HIGH 问题，需返工。',
    '',
    'VERDICT: FAIL',
  ].join('\n');
  assert.ok(report.length > 1200);

  const cut = truncateForHandoff(report, 1200);
  assert.ok(cut.length <= 1200, `截断后不得超过上限，实际 ${cut.length}`);
  assert.ok(cut.includes('## 代码审查报告'), '必须保留开头');
  assert.ok(cut.includes('lib/a.js:12'), '必须保留文件:行号证据');
  assert.ok(cut.includes('lib/b.js:34'), '所有文件:行号都要保留');
  assert.match(cut, /VERDICT: FAIL\s*$/, '结尾的判定行不能被切掉');

  // 极端：正文没有换行、结尾几行很长——仍然必须保留开头（结尾块不能把额度吃光）
  const flat = `${'正文'.repeat(1500)}\n发现：HIGH lib/x.js:7 越权\n\nVERDICT: FAIL`;
  const flatCut = truncateForHandoff(flat, 2000);
  assert.ok(flatCut.startsWith('正文'), '开头必须保留');
  assert.ok(flatCut.includes('lib/x.js:7'), '文件:行号必须保留');
  assert.match(flatCut, /VERDICT: FAIL\s*$/, '判定行必须保留');
});

test('交接截断：不超限时原样返回，恰好等于上限也不截断', () => {
  const text = 'a'.repeat(100);
  assert.equal(truncateForHandoff(text, 200), text);
  assert.equal(truncateForHandoff(text, 100), text, '恰好等于上限不应被视为超限');
  assert.equal(truncateForHandoff('', 10), '');
  assert.equal(truncateForHandoff('abc', 0), '');
});

test('交接截断：收集依赖产物时不丢结论（VERDICT 仍在）', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.fast, teamId: 's', subject: 'x' });
  graph.tasks[0].status = 'done';
  graph.tasks[0].output = `${'正文'.repeat(3000)}\n\n问题：CRITICAL lib/x.js:9 越权\n\nVERDICT: FAIL`;
  const text = collectDependencyOutputs(graph.tasks[1], graph.tasks);
  assert.match(text, /VERDICT: FAIL\s*$/, '交接文本结尾必须仍能解析到判定');
  assert.ok(text.includes('lib/x.js:9'), 'findings 的文件:行号要留下');
  assert.ok(text.length <= DEP_TOTAL_LIMIT, '总量不得超上限');
});

test('findings 提取：挑带严重等级的行并截短，跳过 VERDICT 行', () => {
  const findings = extractFindings(
    [
      '# 审查报告',
      '- HIGH lib/a.js:12 路径穿越',
      '- **HIGH** `lib/c.js:5` 加粗写法也要认',
      '- 无关正文',
      'VERDICT: FAIL',
    ].join('\n'),
  );
  assert.deepEqual(findings, ['HIGH lib/a.js:12 路径穿越', 'HIGH `lib/c.js:5` 加粗写法也要认']);
  assert.equal(extractFindings('不过。\n\nVERDICT: FAIL').length, 0, '没有 finding 时不臆造');
  const long = `HIGH lib/a.js:1 ${'很长的描述'.repeat(60)}`;
  assert.ok(extractFindings(long)[0].length <= 160, '单条 findings 必须截短');
});

test('依赖产物汇总：没有产物时返回空串，不产生空小节', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.fast, teamId: 's', subject: 'x' });
  assert.equal(collectDependencyOutputs(graph.tasks[0], graph.tasks), '', '无依赖应返回空串');
});

/* ================================================================== *
 * 调度器：审批闸门
 * ================================================================== */

test('闸门：没有计划时 teams_run 拒绝启动', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const result = await startTeamRun({
      ctx: fakeCtx(fake),
      config: CONFIG,
      agent: FAKE_AGENT,
      captainSessionId: 'session-1',
      workspace: dir,
    });
    assert.equal(result.started, false);
    assert.match(result.reason, /teams_plan/);
  });
});

test('闸门：计划生成后停在 staged，未批准时 teams_run 拒绝执行', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const ctx = fakeCtx(fake);

    const planned = await planTeam({
      ctx,
      config: CONFIG,
      agent: FAKE_AGENT,
      captainSessionId: 'session-1',
      workspace: dir,
      task: '改个按钮颜色',
    });
    assert.equal(planned.rebuilt, true);
    assert.equal(planned.phase, 'staged', '计划生成后必须处于待审批');

    const refused = await startTeamRun({
      ctx,
      config: CONFIG,
      agent: FAKE_AGENT,
      captainSessionId: 'session-1',
      workspace: dir,
    });
    assert.equal(refused.started, false, '未批准绝不能启动');
    assert.match(refused.reason, /尚未批准/);
    assert.equal(fake.calls.length, 0, '拒绝启动时不得派发任何子代理');
  });
});

test('闸门：批准后才允许派发', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 'session-1', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    const approval = await approveTeam(base);
    assert.equal(approval.approved, true);
    // 批准只记 approvedAt + 图指纹，不改运行状态（改了会让"跑过一轮"绕过闸门）
    assert.equal(approval.phase, 'staged');

    const started = await startTeamRun(base);
    assert.equal(started.started, true);
    assert.ok(started.tasks > 0);
  });
});

test('闸门：任务图为空时不允许批准', async () => {
  await withWorkspace(async (dir) => {
    const result = await approveTeam({ config: CONFIG, captainSessionId: 'session-none', workspace: dir });
    assert.equal(result.approved, false);
  });
});

/* ================================================================== *
 * 调度器：执行
 * ================================================================== */

test('调度：按依赖顺序跑完快速路径，任务全部完成', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 'session-1', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);

    // 等后台循环收口
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 'session-1'), 8000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 'session-1');
    const stats = summarize(graph.tasks);
    assert.equal(stats.total, 3);
    assert.equal(stats.done, 3, `应全部完成，实际 ${JSON.stringify(stats)}`);
    assert.equal(fake.calls.length, 3, '三个任务各派发一次');

    // 下游必须拿到上游产出
    const reviewCall = fake.calls.find((call) => call.label.includes('t-review'));
    assert.ok(reviewCall, '代码审查任务应被派发');
    const reviewText = reviewCall.prompt[0].text;
    assert.ok(reviewText.includes('上游产出'), '下游任务卡应包含上游产出小节');
  });
});

test('补充要求：下一次派发随任务卡下发给子代理（每个任务都带）', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 'session-1', workspace: dir };
    const stateRoot = stateRootOf(dir, CONFIG.stateDir);

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    // 用户在派发前补充了要求：它必须随任务卡走下去，而不是只躺在 team.json 里
    const noted = await appendTeamNote(stateRoot, 'session-1', { text: 'Windows 上请用 win_bash' });
    assert.equal(noted.ok, true);

    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRoot, 'session-1'), 8000);

    assert.ok(fake.calls.length >= 1, '应有派发');
    for (const call of fake.calls) {
      const text = call.prompt[0].text;
      assert.ok(text.includes('用户中途补充的要求'), '每张任务卡都要带补充要求小节');
      assert.ok(text.includes('Windows 上请用 win_bash'), '原文要带进任务卡');
      // 固定环境说明走的是默认 platform=process.platform：这条断言覆盖「派发 → runTask →
      // buildTaskPrompt」的真实路径，而不是只直接调 buildTaskPrompt（用户的原问题就在这里）
      assert.equal(
        text.includes('运行环境与工具（固定）'),
        process.platform === 'win32',
        'Windows 派发时任务卡必须带固定环境说明，非 Windows 不带',
      );
      if (process.platform === 'win32') {
        assert.ok(text.includes('不要用 `bash`'), 'Windows 上要明确禁用 bash 配 /f/ 路径');
      }
    }
  });
});

test('调度：无依赖任务并行执行（峰值并发 > 1）', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({ delayMs: 60 });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: { ...CONFIG, scheduler: { ...CONFIG.scheduler, maxParallel: 4 } }, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    // 完整路径里 executor 之后有三个互不依赖的审查/测试
    await planTeam({ ...base, task: '跨模块重构整个架构' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    assert.ok(fake.peak() > 1, `并行度应大于 1，实际峰值 ${fake.peak()}`);
  });
});

test('调度：任务失败会阻塞下游，并把队伍标为失败', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({
      reply: (label) => (label.includes('t-executor') ? { ok: false, stopReason: 'error' } : { ok: true }),
    });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 10000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    const executor = graph.tasks.find((task) => task.id === 't-executor');
    const review = graph.tasks.find((task) => task.id === 't-review');
    assert.equal(executor.status, 'failed');
    assert.ok(executor.failure, '失败任务应记录失败原因');
    assert.equal(review.status, 'blocked', '下游应被阻塞而不是继续跑');
  });
});

test('调度：重试次数耗尽后标记失败（maxRetries=1 时共派发 2 次）', async () => {
  await withWorkspace(async (dir) => {
    let attempts = 0;
    const fake = fakeSubagents({
      reply: (label) => {
        if (!label.includes('t-executor')) return { ok: true };
        attempts += 1;
        return { ok: false, stopReason: 'error' };
      },
    });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: { ...CONFIG, scheduler: { ...CONFIG.scheduler, maxRetries: 1 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    assert.equal(attempts, 2, '应重试 1 次（共 2 次尝试）');
    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.find((task) => task.id === 't-executor').status, 'failed');
  });
});

test('调度：重复调用 teams_run 不会起第二个循环', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({ delayMs: 100 });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    const first = await startTeamRun(base);
    assert.equal(first.started, true);

    const second = await startTeamRun(base);
    assert.equal(second.started, false, '第二个循环必须被拒绝');
    assert.match(second.reason, /已在运行/);

    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 10000);
  });
});

test('调度：并发两次 teams_run 只起一条循环，任务不重复派发（复核 HIGH）', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({ delayMs: 30 });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };
    const stateRoot = stateRootOf(dir, CONFIG.stateDir);

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);

    // 两次调用必须同时在飞：检查点与同步占位之间只要有一个 await（复位崩溃残留），
    // 两次调用就都能通过检查、各起一条循环 → 同一任务被派发两次（复核实测 3 个任务派发 6 次）。
    const results = await Promise.all([startTeamRun(base), startTeamRun(base)]);
    const started = results.filter((item) => item.started === true);
    assert.equal(started.length, 1, `应只有一次 startTeamRun 成功，实际 ${JSON.stringify(results)}`);

    await waitFor(async () => !isRunning(stateRoot, 's'), 15000);

    const labels = fake.calls.map((call) => call.label);
    assert.equal(new Set(labels).size, labels.length, `每个任务只能被派发一次，实际 ${JSON.stringify(labels)}`);
    assert.equal(labels.length, 3, `快速路径应派发 3 次，实际 ${labels.length} 次`);
    const graph = await readTasks(stateRoot, 's');
    assert.equal(graph.tasks.every((task) => task.status === 'done'), true, '全部任务应完成');
  });
});

test('调度：运行中重复 teams_run 不得复位在飞任务（R6-08 复核回归）', async () => {
  await withWorkspace(async (dir) => {
    // result 延迟 300ms：确保第二次调用时任务真的停在 running
    const fake = fakeSubagents({ resultDelayMs: 300 });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };
    const stateRoot = stateRootOf(dir, CONFIG.stateDir);

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    const first = await startTeamRun(base);
    assert.equal(first.started, true);

    // 等某个任务真正进入 running（派发是异步的）
    let before;
    for (let i = 0; i < 200; i += 1) {
      const graph = await readTasks(stateRoot, 's');
      before = graph.tasks.find((task) => task.status === 'running');
      if (before !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(before !== undefined, '应能观察到在飞任务');

    const second = await startTeamRun(base);
    assert.equal(second.started, false, '第二个循环必须被拒绝');

    const after = (await readTasks(stateRoot, 's')).tasks.find((task) => task.id === before.id);
    assert.equal(after.status, 'running', '在飞任务不得被复位成 pending（否则结果会被 epoch 丢弃并重复派发）');
    assert.equal(after.epoch ?? 0, before.epoch ?? 0, '在飞任务的世代不得被加一');

    await waitFor(async () => !isRunning(stateRoot, 's'), 10000);
  });
});

test('计划：已有任务图时不覆盖，除非显式 rebuild', async () => {
  await withWorkspace(async (dir) => {
    const ctx = fakeCtx(fakeSubagents().service);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    const first = await planTeam({ ...base, task: '改个按钮颜色' });
    assert.equal(first.rebuilt, true);

    const second = await planTeam({ ...base, task: '另一个任务' });
    assert.equal(second.rebuilt, false, '默认不覆盖既有计划');
    assert.match(second.reason, /rebuild/);

    const third = await planTeam({ ...base, task: '另一个任务', rebuild: true });
    assert.equal(third.rebuilt, true, '显式 rebuild 应重建');
  });
});

/* ================================================================== *
 * 失败分类与派发深度（回归：两轮真实运行暴露的问题）
 * ================================================================== */

test('失败分类：预算类与参数类失败不重试，只有瞬态失败才重试', () => {
  const retryOf = (outcome, attempt = 1, maxRetries = 3) => classifyFailure(outcome, { attempt, maxRetries }).retry;

  assert.equal(retryOf({ error: '超时（300 秒）：运行被中断（可能是超时或被上层取消）' }), false, '超时不该重试：预算没变');
  assert.equal(retryOf({ error: '派发失败：subagent depth 1 exceeds maxDepth 0' }), false, '派发期参数错误不该重试');
  assert.equal(retryOf({ error: '找不到角色 "ghost"，无法派发' }), false);
  assert.equal(retryOf({ error: '提供者 "spawn" 不支持 persona，无法注入角色契约' }), false);
  assert.equal(retryOf({ stopReason: 'refusal' }), false);
  assert.equal(retryOf({ stopReason: 'max-tokens' }), false);
  assert.equal(retryOf({ stopReason: 'aborted' }), false);
  assert.equal(retryOf({ stopReason: 'error' }), true, '运行期错误可能是抖动，值得重试');
  assert.equal(retryOf({ error: '子代理正常结束但没有产出任何文本——无法作为交接内容' }), true);
  assert.equal(retryOf({ stopReason: 'error' }, 3, 2), false, '预算用尽后不再重试');
  assert.match(
    classifyFailure({ error: '超时（300 秒）：x' }, { attempt: 1, maxRetries: 3 }).reason,
    /预算未变/,
    '不重试的理由要说清是"预算没变"而不是含糊的"失败"',
  );
});

test('调度：中断类失败只派发一次，不再空烧两次预算', async () => {
  await withWorkspace(async (dir) => {
    let attempts = 0;
    const fake = fakeSubagents({
      reply: (label) => {
        if (!label.includes('t-executor')) return { ok: true };
        attempts += 1;
        return { ok: false, stopReason: 'aborted' };
      },
    });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: { ...CONFIG, scheduler: { ...CONFIG.scheduler, maxRetries: 3 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    assert.equal(attempts, 1, '中断/取消类失败不该重试（旧行为会跑满 4 次）');
    const executor = (await readTasks(stateRootOf(dir, CONFIG.stateDir), 's')).tasks.find((task) => task.id === 't-executor');
    assert.equal(executor.status, 'failed');
    assert.match(executor.failure, /未重试/, '失败原因里要写清为什么没有再来一次');
  });
});

test('运行器：派发深度按队长真实深度现算（写死 1 会误拒深层队长）', () => {
  assert.equal(resolveChildDelegationDepth(FAKE_AGENT), 1, '顶层队长：子代理深度 1');
  assert.equal(resolveChildDelegationDepth(undefined), 1, '读不到深度时退回 1');
  // 队长自己也是子代理：深度 1 → 子代理是 2。写死 1 会被宿主以 depth 2 > maxDepth 1 拒掉。
  assert.equal(resolveChildDelegationDepth({ id: 'a', session: { header: { delegationDepth: 1 } }, options: {} }), 2);
  assert.equal(resolveChildDelegationDepth({ id: 'a', options: { subagentDepth: 2 } }), 3);
  // 会话头是单调下限：运行时 options 只能加深，不能变浅（与宿主 delegationDepthOf 一致）
  assert.equal(
    resolveChildDelegationDepth({ id: 'a', session: { header: { delegationDepth: 1 } }, options: { subagentDepth: 3 } }),
    4,
  );
});

test('调度：派发给宿主的请求带上算好的 maxDepth', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents();
    const ctx = fakeCtx(fake);
    const deepCaptain = { id: 'session-captain', session: { header: { delegationDepth: 1 } }, options: {} };
    const base = { ctx, config: CONFIG, agent: deepCaptain, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    assert.ok(fake.calls.length > 0, '应当真的派发过');
    for (const call of fake.calls) {
      assert.equal(call.maxDepth, 2, '深度 1 的队长，子代理上限必须是 2（写死 1 会被宿主拒绝）');
    }
  });
});

test('计划/调度：新一轮会清掉上一轮的审批与收口时间（面板不显示陈旧时间）', async () => {
  await withWorkspace(async (dir) => {
    const ctx = fakeCtx(fakeSubagents().service);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };
    const stateRoot = stateRootOf(dir, CONFIG.stateDir);

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRoot, 's'), 15000);

    const finished = await readTeam(stateRoot, 's');
    assert.ok(finished.finishedAt, '跑完应记录收口时间');
    assert.ok(finished.approvedAt, '批准应记录审批时间');

    const replanned = await planTeam({ ...base, task: '另一个任务', rebuild: true });
    assert.equal(replanned.rebuilt, true);
    const afterReplan = await readTeam(stateRoot, 's');
    assert.equal(afterReplan.phase, 'staged');
    assert.equal(afterReplan.approvedAt, undefined, '重建后不得残留上一轮的审批时间');
    assert.equal(afterReplan.finishedAt, undefined, '重建后不得残留上一轮的收口时间');
  });
});

test('运行器：墙钟闸门默认关闭；开启后优先取配置（秒），缺省回档位默认值', () => {
  const role = { tier: 'medium' };
  // 默认关闭：返回 undefined = 不设上限（判死交给动态停滞判定）
  assert.equal(resolveTimeoutMs(undefined, role), undefined, '无配置时不得设墙钟上限');
  assert.equal(resolveTimeoutMs({}, role), undefined);
  assert.equal(resolveTimeoutMs({ timeouts: { medium: 900 } }, role), undefined, '没显式开启就仍不设上限');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: false, medium: 900 } }, role), undefined, '显式关闭');

  // 开启后：配置优先，缺省回档位
  const on = { timeouts: { enabled: true } };
  assert.equal(resolveTimeoutMs(on, role), TIMEOUT_MS.medium, '开启后无该档配置时用档位默认值');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: true, medium: 900 } }, role), 900_000, '配置以秒为单位');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: true, heavy: 600 } }, role), TIMEOUT_MS.medium, '配置缺该档时回退');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: true, medium: 0 } }, role), TIMEOUT_MS.medium, '非正数视为未配置');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: true, medium: 'abc' } }, role), TIMEOUT_MS.medium, '非数字视为未配置');
  assert.equal(resolveTimeoutMs({ timeouts: { enabled: true, medium: 1 } }, {}), 1000, '缺 tier 时按 medium 默认档取配置');
});

test('超时档：整表单调，且按实测上界留出余量', () => {
  assert.ok(TIMEOUT_MS.infrastructure <= TIMEOUT_MS.light, 'infrastructure ≤ light');
  assert.ok(TIMEOUT_MS.light <= TIMEOUT_MS.medium, 'light ≤ medium');
  assert.ok(TIMEOUT_MS.medium <= TIMEOUT_MS.heavy, 'medium ≤ heavy');

  // 实测上界（毫秒）：executor 1152、test-engineer 1493
  assert.ok(TIMEOUT_MS.heavy >= 1_600_000, 'heavy 要覆盖实测 1493 秒并留出余量');
  // 实测：要跑测试/验证的角色普遍超过 10 分钟（verifier 撞穿 600 秒，code-reviewer 用到 617 秒）
  assert.ok(TIMEOUT_MS.light >= 900_000, 'light 是「要跑测试的活」的下限，不得低于 15 分钟');
  assert.ok(TIMEOUT_MS.medium >= 1_200_000, 'medium 要覆盖审查/分析并留出余量，不得低于 20 分钟');
});

test('调度：失败时保留部分产出（超时不该让工作全部蒸发）', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({
      reply: (label) =>
        label.includes('t-executor')
          ? { ok: false, stopReason: 'aborted', text: '我已经写了一半的设计说明……' }
          : { ok: true },
    });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const executor = (await readTasks(stateRootOf(dir, CONFIG.stateDir), 's')).tasks.find((task) => task.id === 't-executor');
    assert.equal(executor.status, 'failed');
    assert.ok(executor.failure, '仍要记录失败原因');
    assert.match(String(executor.output ?? ''), /写了一半/, '失败任务也要留下超时前的部分产出');

    // 但下游绝不能把这份"半成品"当成完成的交接物
    const review = (await readTasks(stateRootOf(dir, CONFIG.stateDir), 's')).tasks.find((task) => task.id === 't-review');
    assert.equal(
      collectDependencyOutputs(review, [executor, review]),
      '',
      '未完成依赖的产出不得注入下游任务卡',
    );
  });
});

test('续跑：失败任务的半成品被注入重派任务卡，并明确要求"先核对现状、只补缺口"', async () => {
  await withWorkspace(async (dir) => {
    // 第一步就失败（模拟预算耗尽），产出里留下"写到一半"的内容
    const fake = fakeSubagents({
      reply: (label) =>
        label.includes('t-executor')
          ? { ok: false, text: '我已经改完 lib/digest.mjs 的聚合部分，还没动 CLI 与测试。' }
          : { ok: true },
    });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: CONFIG,
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const before = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    const failedExecutor = before.tasks.find((task) => task.id === 't-executor');
    assert.equal(failedExecutor.status, 'failed');
    assert.match(String(failedExecutor.output ?? ''), /还没动 CLI/, '失败任务应保留部分产出');

    // 续跑：失败与受阻的任务重新排上
    const retry = await retryFailedTeam(base);
    assert.equal(retry.started, true, `续跑应启动（reason=${retry.reason ?? ''}）`);
    assert.equal(retry.resumed, 1, '应恰好有一个任务带上续写起点');

    const after = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    const rearmed = after.tasks.find((task) => task.id === 't-executor');
    assert.equal(rearmed.status, 'pending', '失败任务应重新待派发');
    assert.equal(rearmed.failure, undefined, '重新待派发时不应还挂着失败原因');
    assert.match(rearmed.resumeFrom, /还没动 CLI/, '续写起点应取自上一次的部分产出');

    // 让第二次派发成功，检查它收到的任务卡里真的带了续跑段
    fake.calls.length = 0;
    fake.setReply(() => ({ ok: true }));
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const dispatched = fake.calls.find((call) => String(call.label ?? '').includes('t-executor'));
    assert.ok(dispatched, '续跑应重新派发 executor');
    // prompt 是内容块数组（与宿主契约一致），取文本块拼起来
    const card = (Array.isArray(dispatched.prompt) ? dispatched.prompt : []).map((block) => block?.text ?? '').join('\n');
    assert.match(card, /这是一次「续跑」，不是新任务/, '任务卡必须标明这是续跑');
    assert.match(card, /还没动 CLI/, '任务卡必须带上上一次的半成品');
    assert.match(card, /亲自核对工作区的当前实际状态/, '必须要求它先核对现状，别信自述');

    const final = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(final.tasks.filter((task) => task.status === 'failed').length, 0, '续跑后不应再有失败任务');
  });
});

test('续跑：没有失败或受阻任务时明确拒绝，不空跑', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({});
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    const retry = await retryFailedTeam(base);
    assert.equal(retry.started, false);
    assert.match(retry.reason, /没有失败或受阻的任务/, '应说清为什么不能续跑');
  });
});

test('续跑：调度循环还在跑时拒绝（避免同一队两条循环）', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({ delayMs: 200 });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    const retry = await retryFailedTeam(base);
    assert.equal(retry.started, false);
    assert.match(retry.reason, /仍在运行中/, '运行中不得再起一条循环');
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);
  });
});

test('派发：把工作区作为 cwd 交给子代理（0.2.1 新增字段），并走 caller 投递', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({});
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    assert.ok(fake.calls.length > 0, '应有派发');
    assert.equal(fake.calls[0].cwd, dir, '子代理应在正确的工作区里启动');
    assert.equal(fake.lastSpec.delivery, 'caller', '结果要回到我们手里（我们自己 await），而不是投递到父会话收件箱');
    assert.equal(fake.lastSpec.provider, 'spawn');
    assert.equal(fake.lastSpec.label.startsWith('teams:'), true, 'label 应能看出是团队派发');
    // 角色契约必须出现在首条消息里（0.2.1 起 persona 通道已移除）
    const text = String(fake.calls[0].prompt?.[0]?.text ?? '');
    assert.match(text, /## 你的角色契约|角色契约/, '角色契约应注入任务卡');
    assert.match(text, /## 任务/, '任务卡本身也要在');
  });
});

test('派发兼容：旧宿主契约（start + localAgent）仍能跑通，且证据里记下走的是哪条', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    const child = {
      status: 'running',
      session: { get seq() { return 3; } },
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({ legacy: true, child });
    const ctx = fakeCtx(fake);
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status !== 'done').length, 0, '旧契约下也应全部完成');
    const first = graph.tasks[0];
    assert.equal(first.evidence.at(-1).watch.api, 'start', '证据应记下走的是旧契约');
    assert.equal(first.evidence.at(-1).watch.hadLocalAgent, true, '旧契约会直接给 localAgent');
    assert.equal(cancels.length, 0, '正常完成不应取消任何子代理');
  });
});

test('派发：宿主两套接口都没有时，明确失败而不是静默', async () => {
  await withWorkspace(async (dir) => {
    const fake = fakeSubagents({});
    const ctx = {
      get: (key) =>
        key === 'subagents' ? { ...fake.service, startActivation: undefined, start: undefined } : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: FAKE_AGENT, captainSessionId: 's', workspace: dir };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    const failed = graph.tasks.filter((task) => task.status === 'failed');
    assert.ok(failed.length > 0, '应明确失败');
    assert.match(String(failed[0].failure), /派发失败/, '失败原因应说明派发失败');
  });
});

test('判死只靠进展：墙钟关闭时，跑得再久也不掐（哪怕档位预算只有 1 秒）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    let seq = 0;
    const child = {
      status: 'running',
      // 游标持续推进 = 它在干活
      session: { get seq() { seq += 1; return seq; } },
      cancel: (cause) => { cancels.push(cause); },
    };
    // 结果 1.5 秒后才回来，而档位预算只有 1 秒——墙钟若还生效，这里必被砍
    const fake = fakeSubagents({ child, resultDelayMs: 1500, reply: () => ({ ok: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: {
        ...CONFIG,
        timeouts: { enabled: false, medium: 1, light: 1, heavy: 1, infrastructure: 1 },
        watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000, stallFloorMs: 200, stallFactor: 2 },
      },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status !== 'done').length, 0, '持续有进展就不得被掐');
    assert.equal(cancels.length, 0, '不得取消一个还在推进的子代理');
  });
});

test('判死只靠进展：游标长时间不前进 → 按动态停滞判定取消（不再是墙钟）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    const child = {
      status: 'running', // ⚠️ 故意报 running：判据是"游标不动"，与 status 无关
      session: { get seq() { return 7; } }, // 恒定 → 永不推进
      cancel: (cause) => { cancels.push(cause); },
    };
    // 结果永不返回：模拟驱动卡死
    const fake = fakeSubagents({ child, reply: () => ({ ok: false, hold: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: {
        ...CONFIG,
        // 墙钟刻意关掉：这一步必须由动态停滞判定收尾，而不是靠"跑了多久"
        timeouts: { enabled: false },
        watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000, stallFloorMs: 80, stallFactor: 2 },
      },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    const failed = graph.tasks.filter((task) => task.status === 'failed');
    assert.ok(failed.length > 0, '长时间无进展应判失败');
    assert.match(String(failed[0].failure), /没有任何进展|卡死/, '失败原因应说清是"没进展"，而不是含糊的超时');
    assert.equal(cancels.length, 1, '应带原因取消一次');
    assert.equal(cancels[0].kind, 'hook', '取消要带原因（原因会写进子代理自己的会话日志）');
    const watch = failed[0].evidence.at(-1).watch;
    assert.equal(watch.verdict, 'stalled', '证据里应记下判定是 stalled');
    assert.ok(watch.stallWindowMs >= 80, '应记下当时生效的停滞窗口（自适应结果）');
  });
});

test('看门狗：回合已完成但宿主迟迟不交回结果 → 回收产出，绝不误杀（真实事故回归）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    let reads = 0;
    // 真实事故的形态：analyst 在 288 秒时 turn/end=completed、3280 字答复已落进会话日志，
    // 而 run.result 26 秒后仍未返回。此时必须"接住产出"，而不是判空转杀掉。
    const child = {
      get status() {
        reads += 1;
        return reads <= 2 ? 'running' : 'idle';
      },
      session: {
        get seq() { return 47; },
        ownEvents: () => [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '### 结论\n需求可落地。' }] } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      },
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({
      child,
      reply: (label) => (label.includes('t-executor') ? { ok: false, hold: true } : { ok: true }),
    });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000 }, timeouts: { heavy: 600 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const executor = (await readTasks(stateRootOf(dir, CONFIG.stateDir), 's')).tasks.find((task) => task.id === 't-executor');
    assert.equal(executor.status, 'done', '回合已完成时不得判失败');
    assert.match(String(executor.output ?? ''), /需求可落地/, '应把会话日志里的最终答复回收为产出');
    assert.equal(cancels.length, 0, '不得取消一个已经干完的子代理');
    assert.equal(executor.evidence.at(-1).watch.harvested, true, '证据里应记录这次是"回收"而非"取消"');
  });
});

test('看门狗：回合以 error 结束且无结果 → 照实报错，不冒充超时', async () => {
  await withWorkspace(async (dir) => {
    let reads = 0;
    const child = {
      get status() {
        reads += 1;
        return reads <= 2 ? 'running' : 'idle';
      },
      session: {
        get seq() { return 12; },
        ownEvents: () => [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '写到一半就报错了' }] } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
        ],
      },
      cancel: () => {},
    };
    const fake = fakeSubagents({
      child,
      reply: (label) => (label.includes('t-executor') ? { ok: false, hold: true } : { ok: true }),
    });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const executor = (await readTasks(stateRootOf(dir, CONFIG.stateDir), 's')).tasks.find((task) => task.id === 't-executor');
    assert.equal(executor.status, 'failed');
    assert.match(executor.failure, /运行期发生错误/, '应把回合结束原因照实报出来');
    assert.match(String(executor.output ?? ''), /写到一半/, '回合内的部分产出仍要留下');
  });
});

test('看门狗：idle 但没有回合结束记录 → 绝不判死（工具执行空档不是"干完了"）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    let reads = 0;
    // 真实形态：status 在工具执行期间也会报 idle，但会话里**没有 turn/end**——它还在干活。
    // 判据若落在 status 上，这里就会把正在干活的子代理取消掉（真实事故：误杀 analyst）。
    const child = {
      get status() {
        reads += 1;
        return reads <= 2 ? 'running' : 'idle';
      },
      session: { get seq() { return 7; } }, // 没有 ownEvents → 拿不到 turn/end
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({ child, resultDelayMs: 200, reply: () => ({ ok: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      // 宽限压到 20ms：若判据还看 status，这里必然在 1~2 个采样内误杀
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status === 'failed').length, 0, '没有 turn/end 就不得判死');
    assert.equal(cancels.length, 0, '不得取消一个回合还没结束的子代理');
  });
});

test('看门狗：游标长时间不动只记一笔静默，绝不据此判死（游标平可能只是在长模型调用里）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    // 一直 running，但 seq 恒定 → 静默；结果稍后才返回
    const child = {
      status: 'running',
      session: { get seq() { return 42; } },
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({ child, resultDelayMs: 200, reply: () => ({ ok: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      // 静默阈值压到 60ms：若实现还拿静默判死，这里必然误杀
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status === 'failed').length, 0, '静默不得判死');
    assert.equal(cancels.length, 0, '不得因游标不动而取消子代理');
  });
});

test('看门狗：干活的子代理（游标持续推进）绝不被误杀', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    let seq = 0;
    const child = {
      status: 'running',
      session: { get seq() { seq += 1; return seq; } }, // 每次采样都在前进
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({ child, resultDelayMs: 120, reply: () => ({ ok: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      // 静默阈值极小：如果实现看的是"跑多久"而不是"游标动不动"，这里必然误杀
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 40 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status === 'failed').length, 0, '不该有任务被误杀');
    assert.equal(cancels.length, 0, '持续推进的子代理不得被取消');
  });
});

test('看门狗：派发瞬间就 idle 的 Agent 不被误判为空转（whenIdle 守卫）', async () => {
  await withWorkspace(async (dir) => {
    const cancels = [];
    const child = {
      status: 'running',
      session: { get seq() { return 5; } },
      whenIdle: () => Promise.resolve(), // 立刻解析：模拟"调用时它本来就是 idle"
      cancel: (cause) => { cancels.push(cause); },
    };
    const fake = fakeSubagents({ child, resultDelayMs: 60, reply: () => ({ ok: true }) });
    const ctx = fakeCtx(fake);
    const base = {
      ctx,
      config: { ...CONFIG, watch: { probeMs: 20, idleGraceMs: 20, silenceLimitMs: 60_000 } },
      agent: FAKE_AGENT,
      captainSessionId: 's',
      workspace: dir,
    };

    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await waitFor(async () => !isRunning(stateRootOf(dir, CONFIG.stateDir), 's'), 15000);

    const graph = await readTasks(stateRootOf(dir, CONFIG.stateDir), 's');
    assert.equal(graph.tasks.filter((task) => task.status === 'failed').length, 0, '瞬时 idle 边沿必须被忽略');
    assert.equal(cancels.length, 0);
  });
});

/* ================================================================== *
 * 运行器
 * ================================================================== */

test('运行器：输出只取文本块，忽略推理与工具块', () => {
  const output = extractOutput({
    output: [
      { type: 'reasoning', text: '这是推理' },
      { type: 'text', text: '这是结论' },
      { type: 'tool-call', id: 'x', name: 'read', arguments: '{}' },
      { type: 'text', text: '这是证据' },
    ],
  });
  assert.equal(output, '这是结论\n\n这是证据');
});

test('运行器：stopReason 映射为可读原因，completed 无原因', () => {
  assert.equal(describeStopReason('completed'), undefined);
  assert.match(describeStopReason('aborted'), /中断/);
  assert.match(describeStopReason('max-tokens'), /token/);
  assert.match(describeStopReason('refusal'), /拒绝/);
  assert.match(describeStopReason('error'), /错误/);
  assert.match(describeStopReason('something-new'), /未预期/);
});

test('运行器：persona 用角色契约 + 角色专属预算', () => {
  const role = {
    slug: 'executor',
    name: '开发执行者',
    prompt: '## 你是 开发执行者\n一句话职责：写代码。',
    readBudget: 9,
    outputBudget: 800,
  };
  const persona = buildPersona(role, { id: 't-executor' });
  assert.ok(persona.includes('你是 开发执行者'));
  assert.ok(persona.includes('最多 9 个文件'), '应写入读取预算');
  assert.ok(persona.includes('800 字以内'), '应写入输出预算');
  assert.ok(persona.includes('未确认项'), '应强调不确定项纪律');
});

test('运行器：任务卡在 Windows 上写明用 win_bash、不要用 bash 配 /f/ 路径', () => {
  const task = { id: 't-exec', role: 'executor', roleName: '开发执行者' };
  const win = buildTaskPrompt({ task, platform: 'win32' });
  assert.ok(win.includes('运行环境与工具（固定）'), 'Windows 上要有固定环境节');
  assert.ok(win.includes('win_bash'), '要说清用 win_bash');
  assert.ok(win.includes('不要用 `bash`'), '要明确禁用 bash');
  assert.ok(win.includes('F:\\MT'), 'Windows 路径写法要给出示范');
  assert.ok(win.includes('/f/MT'), '要指出 /f/ 写法在本机是错的');
  assert.ok(win.includes('Set-Location'), '要附上实测报错，才知道这不是随便写的');
  assert.ok(win.includes('pwsh'), '要说清 pwsh 什么时候用');
  assert.ok(win.includes('`read`') && win.includes('`glob`'), '读文件/找文件用 read 与 glob/grep');

  // 非 Windows 不下发这套说明：否则子代理会以为本机命令名也是 win_bash
  const posix = buildTaskPrompt({ task, platform: 'darwin' });
  assert.ok(!posix.includes('win_bash'), '非 Windows 不应提 win_bash');
  assert.ok(!posix.includes('运行环境与工具（固定）'), '非 Windows 不出环境节');
});

test('运行器：任务卡带上用户中途补充的要求（按时间序，最新在后）', () => {
  const task = { id: 't-exec', role: 'executor' };
  const base = buildTaskPrompt({ task, platform: 'linux' });
  assert.ok(!base.includes('用户中途补充的要求'), '没有补充要求时不出这一节');

  const prompt = buildTaskPrompt({
    task,
    platform: 'linux',
    notes: [
      { id: 'n1', text: '按钮做大一点', at: '2026-10-26T01:00:00.000Z' },
      { id: 'n2', text: '这次别动 lib/scheduler.js', at: '2026-10-26T02:00:00.000Z' },
    ],
  });
  assert.ok(prompt.includes('用户中途补充的要求'), '有补充要求时要出小节');
  assert.ok(prompt.includes('优先于上面的原始描述'), '要说明优先级');
  assert.ok(
    prompt.indexOf('按钮做大一点') < prompt.indexOf('这次别动 lib/scheduler.js'),
    '按时间序，最新在后',
  );

  // 空/纯空白条目跳过，不留空行噪声
  const sparse = buildTaskPrompt({
    task,
    platform: 'linux',
    notes: [{ id: 'x', text: '   ' }, { id: 'y', text: '只留这条' }],
  });
  assert.equal((sparse.match(/只留这条/g) ?? []).length, 1, '只渲染一次');
});

test('运行器：补充要求超出预算时保留最新的，并写明较早几条未展开', () => {
  const big = 'x'.repeat(3000);
  const notes = [0, 1, 2].map((index) => ({ id: `n${index}`, text: `条目${index}-${big}` }));
  const prompt = buildTaskPrompt({ task: { id: 't', role: 'executor' }, platform: 'linux', notes });
  assert.ok(prompt.includes('条目2'), '最新一条必须保留');
  assert.ok(!prompt.includes('条目0'), '最早的应被省略');
  assert.match(prompt, /较早 2 条未展开/, '省略了几条要写清楚，不能静默丢');
});

test('运行器：任务卡包含目标、验收标准、范围与上游产出', () => {
  const prompt = buildTaskPrompt({
    task: {
      id: 't-review',
      role: 'code-reviewer',
      roleName: '代码审查员',
      objective: '总目标：改按钮\n本步骤聚焦：审查变更',
      acceptance: ['每个 finding 有行号'],
      inScope: ['src/**'],
      outOfScope: ['package.json'],
    },
    teamGoal: '把按钮颜色改深',
    dependencyOutputs: '### 开发执行者\nt-executor 的产出',
  });
  assert.ok(prompt.includes('t-review'));
  assert.ok(prompt.includes('每个 finding 有行号'), '应含验收标准');
  assert.ok(prompt.includes('src/**'), '应含允许改动范围');
  assert.ok(prompt.includes('package.json'), '应含禁止改动范围');
  assert.ok(prompt.includes('上游产出'), '应含上游产出小节');
  assert.ok(prompt.includes('把按钮颜色改深'), '应含团队总目标');
});

test('运行器：评审任务卡的硬规则——范围外发现单列，不作 FAIL 依据', () => {
  const graph = buildTaskGraph({
    steps: PATH_TEMPLATES.fast,
    teamId: 's',
    subject: '改个按钮颜色',
    scope: { inScope: ['src/**'], outOfScope: ['package.json'] },
  });
  const review = graph.tasks.find((task) => task.kind === 'review');
  assert.ok(
    review.acceptance.some((item) => item.includes('范围外发现单列')),
    '评审验收项必须写明范围外发现不作为 FAIL 依据',
  );
  const prompt = buildTaskPrompt({ task: review, teamGoal: '改个按钮颜色' });
  assert.ok(prompt.includes('评审范围（硬规则'), '任务卡要写清评审范围的硬规则');
  assert.ok(prompt.includes('不作 FAIL 依据'), '范围外发现不得作为 FAIL 依据');
  assert.ok(prompt.includes('是否为本次改动引入'), '安全类范围外发现要注明是否本次引入');
});

/* ================================================================== *
 * 工具函数
 * ================================================================== */

/** 轮询等待条件成立，超时抛错——避免用固定 sleep 造成偶发失败。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('depsSatisfied：done 与 skipped 都算满足', () => {
  const tasks = [
    { id: 'a', deps: [], status: 'done' },
    { id: 'b', deps: [], status: 'skipped' },
    { id: 'c', deps: ['a', 'b'], status: 'pending' },
  ];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(depsSatisfied(tasks[2], byId), true);
  tasks[1].status = 'running';
  assert.equal(depsSatisfied(tasks[2], byId), false);
});

/* ================================================================== *
 * 根因回归（测试工程师补充的验收用例）
 *   ① 返工死锁：例外路径的恢复（续跑清标记）+ 评审范围规则
 *   ② 交接截断：2000/12000 → 6000/24000，超限保留开头 + 全部文件:行号 + 结尾
 * ================================================================== */

test('交接上限：单条 6000、总量 24000（旧的 2000/12000 已失效）', () => {
  assert.equal(DEP_OUTPUT_LIMIT, 6000, '单条依赖产物上限必须是 6000');
  assert.equal(DEP_TOTAL_LIMIT, 24000, '总量上限必须是 24000');
});

test('交接截断：用户实测的 2610 / 2924 字报告不再被切掉 VERDICT', () => {
  for (const size of [2610, 2924]) {
    const report = `${'报告正文。'.repeat(600).slice(0, size - 15)}\n\nVERDICT: FAIL`;
    assert.ok(report.length <= DEP_OUTPUT_LIMIT, '前提：老报告长度应落进新单条上限');
    const out = truncateForHandoff(report, DEP_OUTPUT_LIMIT);
    assert.equal(out, report, `${report.length} 字报告在新上限内应原样交接，不得截断`);
    assert.match(out, /VERDICT: FAIL\s*$/, '结尾 VERDICT 必须可见');
  }
});

test('交接截断：超过单条上限时保留开头 + 全部文件:行号 + 结尾 VERDICT', () => {
  const filler = (count, tag) =>
    Array.from({ length: count }, (_, index) => `${tag} 第 ${index} 行：无关正文，用于把报告撑长。`).join('\n');
  const report = [
    '## 代码审查报告',
    filler(220, '前段'),
    '- HIGH lib/a.js:12 路径穿越',
    '- HIGH lib/b.js:34 越权',
    '- MEDIUM lib/c.js:56 长度限制',
    '证据链：lib/d.js:78、lib/e.js:90',
    filler(120, '后段'),
    '## 结论',
    '存在 HIGH 问题，需返工。',
    '',
    'VERDICT: FAIL',
  ].join('\n');
  assert.ok(report.length > DEP_OUTPUT_LIMIT, '前提：报告必须超过 6000 字才会触发截断');

  const out = truncateForHandoff(report, DEP_OUTPUT_LIMIT);
  assert.ok(out.length <= DEP_OUTPUT_LIMIT, `截断后不得超过上限，实际 ${out.length}`);
  assert.ok(out.startsWith('## 代码审查报告'), '必须保留开头');
  for (const ref of ['lib/a.js:12', 'lib/b.js:34', 'lib/c.js:56', 'lib/d.js:78', 'lib/e.js:90']) {
    assert.ok(out.includes(ref), `必须保留文件:行号证据 ${ref}`);
  }
  assert.match(out, /VERDICT: FAIL\s*$/, '结尾 VERDICT 不能被切掉');
});

test('依赖产物汇总：总量用尽时不静默丢弃后续来源', () => {
  const tasks = [
    { id: 't', deps: ['a', 'b', 'c', 'd', 'e'], status: 'pending' },
    { id: 'a', roleName: '甲', status: 'done', output: 'A'.repeat(6000) },
    { id: 'b', roleName: '乙', status: 'done', output: 'B'.repeat(6000) },
    { id: 'c', roleName: '丙', status: 'done', output: 'C'.repeat(6000) },
    { id: 'd', roleName: '丁', status: 'done', output: 'D'.repeat(5800) },
    { id: 'e', roleName: '戊', status: 'done', output: 'E'.repeat(1500) },
  ];
  const text = collectDependencyOutputs(tasks[0], tasks);
  for (const name of ['甲', '乙', '丙', '丁', '戊']) {
    assert.ok(text.includes(`### ${name}`), `依赖来源 ${name} 必须保留小节标题`);
  }
  assert.match(text, /未交接|已智能截断/, '被省略的来源必须明确标注，不能静默丢弃');
});

test('运行器：评审范围硬规则只加在评审/验证任务卡，普通实现卡不加', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.full, teamId: 's', subject: '跨模块重构' });
  const impl = graph.tasks.find((task) => task.kind === 'implementation');
  const verify = graph.tasks.find((task) => task.kind === 'verification');
  assert.ok(impl && verify, 'full 路径应同时有实现与验证任务');
  assert.ok(
    verify.acceptance.some((item) => item.includes('范围外问题单列')),
    '验证任务的验收项必须包含范围外单列规则',
  );
  assert.ok(
    buildTaskPrompt({ task: verify }).includes('评审范围（硬规则'),
    '验证任务卡必须写明只对本次改动范围判 FAIL',
  );
  assert.ok(
    !buildTaskPrompt({ task: impl }).includes('评审范围（硬规则'),
    '实现任务卡不应出现评审范围规则（避免与 in_scope 禁令重复冲突）',
  );
});

test('续跑：待决策的评审门重置为 pending，并清掉 needsDecision/findings', async () => {
  await withWorkspace(async (dir) => {
    const base = {
      ctx: fakeCtx(fakeSubagents()),
      config: CONFIG,
      agent: FAKE_AGENT,
      captainSessionId: 'retry-nd',
      workspace: dir,
    };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    const stateRoot = stateRootOf(dir, CONFIG.stateDir);
    await mutateTasks(stateRoot, 'retry-nd', (graph) => {
      const review = graph.tasks.find((task) => task.kind === 'review');
      review.status = 'blocked';
      review.needsDecision = {
        kind: 'review-budget',
        round: 3,
        maxRounds: 3,
        gate: review.id,
        at: new Date().toISOString(),
        findings: ['HIGH lib/a.js:12'],
      };
      review.findings = ['HIGH lib/a.js:12'];
      review.failure = '需队长决策';
      return graph;
    });

    const result = await retryFailedTeam(base);
    assert.equal(result.started, true, '有待决策任务时应允许续跑');
    const graph = await readTasks(stateRoot, 'retry-nd');
    const review = graph.tasks.find((task) => task.kind === 'review');
    assert.equal(review.status, 'pending', '续跑后应重新排队');
    assert.equal(review.needsDecision, undefined, '旧决策标记必须清除，否则收口仍是待决策');
    assert.equal(review.findings, undefined, '旧 findings 必须清除');
    assert.equal(review.failure, undefined, '旧失败说明必须清除');
  });
});

test('交接截断：只剩 200 字额度时结尾 VERDICT 仍必须保留（边界）', () => {
  const report = `${'正文内容。'.repeat(200)}\n\n发现 HIGH lib/z.js:9\n\nVERDICT: FAIL`;
  const out = truncateForHandoff(report, 200);
  assert.ok(out.length <= 200, `截断后不得超过上限，实际 ${out.length}`);
  assert.match(out, /VERDICT: FAIL\s*$/, '即使只剩 200 字，结尾结论也不能被切掉');
});

test('交接截断：上限小到省略说明都放不下时，优先保结论而不是说明', () => {
  const report = `${'正文内容。'.repeat(100)}\n\n发现 HIGH lib/z.js:9\n\nVERDICT: FAIL`;
  for (const limit of [200, 120, 60, 50, 44, 20]) {
    const out = truncateForHandoff(report, limit);
    assert.ok(out.length <= limit, `limit=${limit}：截断后不得超过上限，实际 ${out.length}`);
    assert.match(out, /VERDICT: FAIL\s*$/, `limit=${limit}：省略说明不能把结尾结论挤掉`);
  }
});

test('依赖产物汇总：第 5 条依赖只剩 200 字额度时，它的 VERDICT 不被切掉（端到端）', () => {
  const tasks = [
    { id: 't', deps: ['a', 'b', 'c', 'd', 'e'], status: 'pending' },
    { id: 'a', roleName: '甲', status: 'done', output: 'A'.repeat(6000) },
    { id: 'b', roleName: '乙', status: 'done', output: 'B'.repeat(6000) },
    { id: 'c', roleName: '丙', status: 'done', output: 'C'.repeat(6000) },
    { id: 'd', roleName: '丁', status: 'done', output: 'D'.repeat(5800) },
    {
      id: 'e',
      roleName: '戊',
      status: 'done',
      output: `${'审查正文。'.repeat(150)}\n\n发现 HIGH lib/z.js:9\n\nVERDICT: FAIL`,
    },
  ];
  const text = collectDependencyOutputs(tasks[0], tasks);
  assert.ok(text.includes('### 戊'), '第 5 条依赖不能被静默丢弃');
  assert.match(text, /VERDICT: FAIL\s*$/, '只剩 200 字额度时也不能切断第 5 条的结论');
});

test('评审范围规则：review 与 verification 两类门卡都写「只判本次改动范围」，实现卡不写', () => {
  const graph = buildTaskGraph({ steps: PATH_TEMPLATES.full, teamId: 's', subject: '跨模块重构' });
  const review = graph.tasks.find((task) => task.kind === 'review');
  assert.ok(review, 'full 路径应有代码评审任务');
  assert.ok(
    review.acceptance.some((item) => item.includes('范围外发现单列')),
    '评审任务的验收项必须包含「范围外发现单列」',
  );
  const prompt = buildTaskPrompt({ task: review });
  assert.ok(prompt.includes('评审范围（硬规则'), '评审任务卡必须写明判定范围');
  assert.ok(prompt.includes('不作 FAIL 依据'), '范围外发现不得作为 FAIL 依据');
  assert.ok(prompt.includes('是否为本次改动引入'), '范围外安全问题要注明是否本次引入');
  const impl = graph.tasks.find((task) => task.kind === 'implementation');
  assert.ok(!buildTaskPrompt({ task: impl }).includes('不作 FAIL 依据'), '实现卡不应出现评审口径');
});

test('findings 提取：最多 5 条、识别中文严重等级、无等级时退回文件:行号行', () => {
  const many = Array.from({ length: 9 }, (_, index) => `- HIGH lib/a${index}.js:${index + 1} 问题 ${index}`).join('\n');
  assert.equal(extractFindings(many).length, 5, 'findings 条数必须封顶 5');
  const zh = extractFindings('严重 lib/a.js:1 越权\n高危 lib/b.js:2 注入\nVERDICT: FAIL');
  assert.equal(zh.length, 2, '中文严重等级（严重/高危）也要识别');
  const fallback = extractFindings('- 缺少校验 lib/c.js:3\n- 无关正文\nVERDICT: FAIL');
  assert.deepEqual(fallback, ['缺少校验 lib/c.js:3'], '没有严重等级时退回带文件:行号的行');
  assert.equal(extractFindings('VERDICT: FAIL\n# 标题').length, 0, '只有判定行与标题时不臆造 finding');
});

test('交接截断：多上限 × 多形态扫描——永不越界，额度够时 VERDICT 必定保留', () => {
  const shapes = [
    `${'正文。'.repeat(2000)}\n\nVERDICT: FAIL`,
    `${'正文。'.repeat(300)}\n- HIGH lib/a.js:12 越权\n- HIGH lib/b.js:34 注入\n${'附录。'.repeat(300)}\n\n结论：需返工\nVERDICT: FAIL`,
    `无换行的长正文${'x'.repeat(3000)}\n\nVERDICT: FAIL`,
  ];
  for (const report of shapes) {
    for (let limit = 1; limit <= 400; limit += 7) {
      const out = truncateForHandoff(report, limit);
      assert.ok(out.length <= limit, `limit=${limit}：截断后 ${out.length} 字越界`);
      if (limit >= 15) {
        assert.ok(out.includes('VERDICT: FAIL'), `limit=${limit}：结论行必须保留：${JSON.stringify(out)}`);
      }
    }
    for (const limit of [800, 1200, 2000, 6000]) {
      const out = truncateForHandoff(report, limit);
      assert.ok(out.length <= limit, `limit=${limit}：截断后 ${out.length} 字越界`);
      assert.ok(out.includes('VERDICT: FAIL'), `limit=${limit}：结论行必须保留`);
    }
  }
});

test('统计：待决策与失败分开计数，blocked 不混进 failed', () => {
  const stats = summarize([
    { id: 'a', status: 'blocked', needsDecision: { kind: 'review-budget', round: 3 } },
    { id: 'b', status: 'blocked' },
    { id: 'c', status: 'failed' },
    { id: 'd', status: 'done' },
  ]);
  assert.equal(stats.failed, 1, '真失败只数真失败');
  assert.equal(stats.blocked, 2, 'blocked 单独计数');
  assert.equal(stats.needsDecision, 1, '待决策单独计数');
  assert.equal(stats.total, 4);
});
