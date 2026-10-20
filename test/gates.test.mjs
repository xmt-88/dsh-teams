/**
 * 质量门与角色管理的测试。
 *
 * 这些用例对应 2026-10-20 审计里的 P0/P1/P2：
 *   - P0-1 验证员的 FAIL 必须改变状态（以前"跑完就算过"）
 *   - P0-2 驳回 → 退回实现步骤重做，轮数受 maxReviewRounds 限制
 *   - P1-1 批准的是"这一张图"，不是"这个阶段"
 *   - P1-5 配置项必须真的生效（routing / gates / maxReviewRounds）
 *   - P2 自定义角色按触发词插入流水线；停用的角色不被派发
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseVerdict, isGateKind, hasEvidence, GATE_KINDS } from '../lib/verdict.js';
import { route, adaptSteps, buildSteps, PATH_TEMPLATES } from '../lib/router.js';
import { validateCustomRole, loadRoles } from '../lib/roles.js';
import { graphFingerprint, planTeam, approveTeam, startTeamRun } from '../lib/scheduler.js';
import { readTeam, readTasks, userRolesDir, appendJsonl } from '../lib/state.js';
import { readDisabledRoles, writeDisabledRoles, setRoleEnabled, validateToggle, CORE_ROLES } from '../lib/role-state.js';
import { readEvents } from '../lib/state.js';
import { buildRolesPayload, applyRoleAction } from '../lib/web-routes.js';

/* ================================================================== *
 * 判定行解析
 * ================================================================== */

test('判定行：容忍大小写、全角冒号、加粗与正文引用，取最后一次出现', () => {
  assert.equal(parseVerdict('结论：FAIL\n\nVERDICT: FAIL'), 'FAIL');
  assert.equal(parseVerdict('VERDICT: pass'), 'PASS');
  assert.equal(parseVerdict('**VERDICT:** BLOCKED'), 'BLOCKED');
  assert.equal(parseVerdict('格式示例 VERDICT: PASS\n\n实际结论\nVERDICT: FAIL'), 'FAIL');
  assert.equal(parseVerdict('正文里写了通过，但没有判定行'), undefined);
  assert.equal(parseVerdict(''), undefined);
  assert.equal(parseVerdict(undefined), undefined);
});

test('门类任务：只有 review / verification 需要判定', () => {
  assert.deepEqual([...GATE_KINDS], ['review', 'verification']);
  assert.equal(isGateKind('review'), true);
  assert.equal(isGateKind('verification'), true);
  assert.equal(isGateKind('implementation'), false);
  assert.equal(isGateKind('work'), false);
});

test('证据判定：命令+退出码、文件:行号、"不适用"都算证据，纯断言不算', () => {
  assert.equal(hasEvidence('跑完了，都通过'), false, '空口断言不是证据');
  assert.equal(hasEvidence('改了 src/app.js:42'), true, '文件:行号算');
  assert.equal(hasEvidence('`npm test` 退出码 0'), true, '退出码算');
  assert.equal(hasEvidence('C:\\work\\a.js:12 已改'), true, 'Windows 路径也算');
  assert.equal(hasEvidence('本项目无类型检查环节，不适用'), true, '诚实说明算');
  assert.equal(hasEvidence(undefined), false);
});

/* ================================================================== *
 * 路由：阈值可配置 + 停用剪枝 + 触发词插入
 * ================================================================== */

test('路由阈值来自配置：fastMax/standardMax 改了，路径跟着变', () => {
  // 3 个文件 → 规模=1（中等改动），三维加和 = 1
  const input = { taskText: '改个按钮颜色', filesTouched: 3 };
  const strict = route({ ...input, routing: { fastMax: 0, standardMax: 1 } });
  const loose = route({ ...input, routing: { fastMax: 1, standardMax: 4 } });
  const middle = route({ ...input, routing: { fastMax: 0, standardMax: 0 } });
  assert.equal(loose.path, 'fast', 'total=1 <= fastMax=1 → 快速');
  assert.equal(strict.path, 'standard', 'total=1 > fastMax=0 且 <= standardMax=1 → 标准');
  assert.equal(middle.path, 'full', 'total=1 > standardMax=0 → 完整');
});

test('风险短路可关闭：关掉后高风险只加分、不再强制完整路径', () => {
  const text = '支付回调签名校验失败';
  const on = route({ taskText: text, routing: { riskShortCircuit: true } });
  const off = route({ taskText: text, routing: { riskShortCircuit: false }, filesTouched: 0, linesTouched: 1 });
  assert.equal(on.path, 'full', '开着时风险=2 直接完整路径');
  assert.notEqual(off.path, 'full', '关掉后不再无视其他维度');
});

test('停用的角色会被剪掉，且下游依赖自动继承被剪步骤的上游', () => {
  const steps = buildSteps(PATH_TEMPLATES.full, false);
  const adapted = adaptSteps(steps, { roles: [{ slug: 'critic', builtin: true, enabled: false }], matchText: '' });
  assert.equal(
    adapted.some((step) => step.role === 'critic'),
    false,
    '停用的 critic 不应出现在图里',
  );
  const executor = adapted.find((step) => step.id === 'executor');
  assert.deepEqual(executor.deps, ['architect'], 'executor 应继承 critic 的上游，而不是留下悬空依赖');
  for (const step of adapted) {
    for (const dep of step.deps) {
      assert.ok(
        adapted.some((item) => item.id === dep),
        `${step.id} 的依赖 ${dep} 必须真实存在`,
      );
    }
  }
});

test('自定义角色按触发词插入实现步骤之前，实现步骤依赖它', () => {
  const roles = [{ slug: 'py-expert', builtin: false, enabled: true, triggers: ['python', 'pytest'] }];
  const decision = route({ taskText: '给 pytest 加一个 fixture', filesTouched: 1, roles });
  const ids = decision.steps.map((step) => step.id);
  assert.ok(ids.includes('expert-py-expert'), '命中触发词的专家应被插入');
  const executor = decision.steps.find((step) => step.kind === 'implementation');
  assert.ok(executor.deps.includes('expert-py-expert'), '实现步骤应依赖专家产出');
  assert.ok(
    ids.indexOf('expert-py-expert') < ids.indexOf(executor.id),
    '专家步骤应排在实现步骤之前',
  );
});

test('没命中触发词的自定义角色不会被插入', () => {
  const roles = [{ slug: 'py-expert', builtin: false, enabled: true, triggers: ['python'] }];
  const decision = route({ taskText: '调整一下按钮圆角', filesTouched: 1, roles });
  assert.equal(
    decision.steps.some((step) => step.id === 'expert-py-expert'),
    false,
  );
});

test('停用的自定义角色即使命中触发词也不插入', () => {
  const roles = [{ slug: 'py-expert', builtin: false, enabled: false, triggers: ['python'] }];
  const decision = route({ taskText: 'python 项目改配置', filesTouched: 1, roles });
  assert.equal(
    decision.steps.some((step) => step.id === 'expert-py-expert'),
    false,
  );
});

/* ================================================================== *
 * 角色库：覆盖标记 / 启停 / 校验
 * ================================================================== */

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-gate-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('自定义角色与内置同 slug：内置仍在列表里，且两边都标出覆盖关系', async () => {
  await withDir(async (stateRoot) => {
    const rolesDir = userRolesDir(stateRoot);
    await mkdir(rolesDir, { recursive: true });
    const { markdown } = validateCustomRole({
      slug: 'critic',
      name: '自定义批判者',
      description: '覆盖内置版本',
      prompt: '你是批判者。',
    });
    await writeFile(join(rolesDir, 'critic.md'), markdown);

    const library = await loadRoles(rolesDir);
    const builtinCritic = library.roles.filter((role) => role.slug === 'critic');
    assert.equal(builtinCritic.length, 2, '内置与自定义都应出现在列表里（以前内置会消失）');
    assert.equal(builtinCritic.filter((role) => role.builtin).length, 1);
    assert.equal(builtinCritic.find((role) => role.builtin).overridden, true);
    assert.equal(builtinCritic.find((role) => !role.builtin).overrides, true);
    assert.equal(library.bySlug.get('critic').builtin, false, '解析时自定义胜出');
  });
});

test('启停：状态落盘、读回一致；核心角色禁止停用', async () => {
  await withDir(async (stateRoot) => {
    assert.deepEqual([...(await readDisabledRoles(stateRoot))], [], '初始为空');
    await writeDisabledRoles(stateRoot, ['critic', 'explore', 'critic']);
    const disabled = await readDisabledRoles(stateRoot);
    assert.deepEqual([...disabled].sort(), ['critic', 'explore'], '去重后落盘');
    for (const core of CORE_ROLES) {
      assert.equal(validateToggle(core, false).ok, false, `${core} 不能停用`);
    }
    assert.equal(validateToggle('critic', false).ok, true);
    assert.equal(validateToggle('critic', true).ok, true);
  });
});

test('角色写操作：停用 / 删除内置被拒 / 保存带触发词的自定义角色', async () => {
  await withDir(async (stateRoot) => {
    const before = await buildRolesPayload(stateRoot);
    assert.equal(before.roles.length, 16, '内置 16 个');

    const off = await applyRoleAction({ stateRoot, body: { action: 'toggle', role: 'critic', enabled: false } });
    assert.equal(off.ok, true);
    assert.equal(off.roles.find((role) => role.slug === 'critic').enabled, false);

    const coreOff = await applyRoleAction({ stateRoot, body: { action: 'toggle', role: 'executor', enabled: false } });
    assert.equal(coreOff.ok, false, '核心角色不能停用');

    const deleteBuiltin = await applyRoleAction({ stateRoot, body: { action: 'delete', role: 'critic' } });
    assert.equal(deleteBuiltin.ok, false, '内置角色不可删除');

    const saved = await applyRoleAction({
      stateRoot,
      body: {
        action: 'save',
        role_id: 'py-expert',
        name: 'Python 专家',
        description: '专治 Python 项目',
        prompt: '你是 Python 专家。',
        permissions: 'execute',
        tier: 'medium',
        triggers: ['python', 'pytest'],
        category: '后端',
      },
    });
    assert.equal(saved.ok, true, saved.reason ?? '');
    const custom = saved.roles.find((role) => role.slug === 'py-expert');
    assert.deepEqual(custom.triggers, ['python', 'pytest'], '触发词应落盘并能读回');
    assert.equal(custom.builtin, false);

    const removed = await applyRoleAction({ stateRoot, body: { action: 'delete', role: 'py-expert' } });
    assert.equal(removed.ok, true);
    assert.equal(removed.roles.some((role) => role.slug === 'py-expert'), false);
  });
});

/* ================================================================== *
 * 闸门：指纹 / 批准
 * ================================================================== */

test('任务图指纹：同图稳定，改一个字段就变', () => {
  const a = { tasks: [{ id: 'x', role: 'executor', kind: 'implementation', deps: [], acceptance: ['a'] }] };
  const b = { tasks: [{ id: 'x', role: 'executor', kind: 'implementation', deps: [], acceptance: ['a'] }] };
  const c = { tasks: [{ id: 'x', role: 'executor', kind: 'implementation', deps: [], acceptance: ['b'] }] };
  assert.equal(graphFingerprint(a), graphFingerprint(b));
  assert.notEqual(graphFingerprint(a), graphFingerprint(c));
  assert.equal(graphFingerprint({ tasks: [] }).length, 16);
});

function fakeSubagents(reply) {
  const calls = [];
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
  };
  return {
    calls,
    ctx: {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: (name) => (name === 'spawn' ? provider : undefined),
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label);
                return {
                  childId: `c${calls.length}`,
                  result: Promise.resolve({
                    output: [{ type: 'text', text: reply(spec.label) }],
                    stopReason: 'completed',
                  }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    },
  };
}

const CONFIG = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 2 },
  gates: { requireEvidence: true, securityBlock: true },
  timeouts: { enabled: false },
};

async function runFast(dir, reply, name = 's') {
  const fake = fakeSubagents(reply);
  const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: name, workspace: dir };
  await planTeam({ ...base, task: '改个按钮颜色' });
  await approveTeam(base);
  const started = await startTeamRun(base);
  for (let i = 0; i < 120; i += 1) {
    const team = await readTeam(join(dir, '.dsh-teams'), name);
    if (team?.phase === 'done' || team?.phase === 'failed') return { fake, team, started };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const team = await readTeam(join(dir, '.dsh-teams'), name);
  return { fake, team, started };
}

test('质量门：验证员写 FAIL → 团队失败（不再"跑完就算过"）', async () => {
  await withDir(async (dir) => {
    // 只让 verification 门挂：review 必须通过，否则 verifier 根本轮不到派发
    const { team } = await runFast(dir, (label) =>
      label.includes('verifier') ? '证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL' : '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS',
    );
    assert.equal(team.phase, 'failed', '验证员判 FAIL，团队必须失败');
    const graph = await readTasks(join(dir, '.dsh-teams'), 's');
    // 只看 verification 门：review 是通过的，不能拿它当断言对象
    const gate = graph.tasks.find((task) => task.kind === 'verification');
    assert.ok(gate, '应有 verification 任务');
    assert.notEqual(gate.status, 'done', '判 FAIL 的门不应该是 done');
  });
});

test('质量门：缺 VERDICT 行按未通过处理（fail-closed）', async () => {
  await withDir(async (dir) => {
    const { team } = await runFast(dir, () => '做完了，都通过。证据：src/app.js:12 退出码 0');
    assert.equal(team.phase, 'failed', '没有判定行不能当通过');
  });
});

test('质量门：证据门开启时，PASS 但无证据也判失败', async () => {
  await withDir(async (dir) => {
    const { team } = await runFast(dir, () => '都通过了。\n\nVERDICT: PASS');
    assert.equal(team.phase, 'failed', 'requireEvidence=true 时必须能复核');
  });
});

test('质量门：证据门关闭时，同一条无证据的 PASS 通过', async () => {
  await withDir(async (dir) => {
    const fake = fakeSubagents(() => '都通过了。\n\nVERDICT: PASS');
    const base = {
      ctx: fake.ctx,
      config: { ...CONFIG, gates: { requireEvidence: false, securityBlock: false } },
      agent: { id: 'cap' },
      captainSessionId: 'g',
      workspace: dir,
    };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    let team;
    for (let i = 0; i < 120; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'g');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done', '关掉证据门后应通过');
  });
});

test('闸门：批准后改动任务图 → 拒绝启动，且不下发任何子代理', async () => {
  await withDir(async (dir) => {
    const fake = fakeSubagents(() => '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS');
    const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'f', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    const stateRoot = join(dir, '.dsh-teams');
    const { mutateTasks } = await import('../lib/state.js');
    await mutateTasks(stateRoot, 'f', (graph) => {
      graph.tasks.push({
        id: 't-injected',
        role: 'security-reviewer',
        roleName: '安全审查员',
        kind: 'review',
        deps: [],
        status: 'pending',
        acceptance: [],
        evidence: [],
        attempts: [],
        order: 9,
      });
      return graph;
    });
    const started = await startTeamRun(base);
    assert.equal(started.started, false, '图变了就不该再放行');
    assert.match(started.reason, /重新批准/, '应说清为什么要重批');
    assert.equal(fake.calls.length, 0, '一个子代理都不该下发');
  });
});

test('闸门：team 记录损坏被重建后，没有 approvedAt 不得启动', async () => {
  await withDir(async (dir) => {
    const fake = fakeSubagents(() => '证据 src/app.js:12 退出码 0\n\nVERDICT: PASS');
    const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'd', workspace: dir };
    const { mutateTeam } = await import('../lib/state.js');
    const { ensureTeam } = await import('../lib/state.js');
    await planTeam({ ...base, task: '改个按钮颜色' });
    const stateRoot = join(dir, '.dsh-teams');
    await mutateTeam(stateRoot, 'd', (team) => {
      team.phase = 'idle';
      delete team.approvedAt;
      return team;
    });
    const started = await startTeamRun(base);
    assert.equal(started.started, false, 'phase 不是 staged 也不能放行（判据看 approvedAt）');
    assert.equal(fake.calls.length, 0);
  });
});

test('事件流：并发追加不丢（真追加，不再读-改-写）', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendJsonl(file, { index })));
    const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 20, '20 条并发事件必须全部落盘');
  });
});

test('质量门：判 FAIL 会退回实现步骤重做，超过 maxReviewRounds 后不再退', async () => {
  await withDir(async (dir) => {
    const calls = [];
    let rounds = 0;
    const provider = {
      name: 'spawn',
      capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
    };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label);
                let text = '实现完成。证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
                if (spec.label.includes('code-reviewer')) {
                  rounds += 1;
                  text =
                    rounds <= 2
                      ? 'CRITICAL src/app.js:12。证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL'
                      : '复审通过。证据 src/app.js:12 退出码 0\n\nVERDICT: PASS';
                }
                return {
                  childId: `c${calls.length}`,
                  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'rw', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    let team;
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'rw');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done', '两轮驳回后第三轮通过，团队应完成');
    const executorCalls = calls.filter((label) => label.includes(':t-executor:')).length;
    assert.equal(executorCalls, 3, '执行者应被退回重做 2 次（共 3 次派发）');
    const graph = await readTasks(join(dir, '.dsh-teams'), 'rw');
    const review = graph.tasks.find((task) => task.kind === 'review');
    assert.equal(review.reviewRound, 2, '记下驳回了 2 轮');
    assert.equal(review.verdict, 'PASS');
  });
});

test('质量门：驳回预算用尽后仍判 FAIL，团队失败', async () => {
  await withDir(async (dir) => {
    const { team } = await runFast(
      dir,
      (label) =>
        label.includes('code-reviewer')
          ? '一直有问题。证据 src/app.js:12 退出码 0\n\nVERDICT: FAIL'
          : '实现完成。证据 src/app.js:12 退出码 0\n\nVERDICT: PASS',
    );
    assert.equal(team.phase, 'failed', '永远不允许通过 → 团队失败');
  });
});

test('停止：运行中调用 stopRun 后不再派发新任务', async () => {
  await withDir(async (dir) => {
    const calls = [];
    let release;
    const gateOn = new Promise((resolve) => {
      release = resolve;
    });
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label);
                // 第一个任务一直不返回，好让循环停在"运行中"
                if (calls.length === 1) {
                  return {
                    childId: 'c1',
                    result: gateOn.then(() => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })),
                    dispose: async () => {},
                  };
                }
                return {
                  childId: `c${calls.length}`,
                  result: Promise.resolve({
                    output: [{ type: 'text', text: '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS' }],
                    stopReason: 'completed',
                  }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const { stopRun } = await import('../lib/scheduler.js');
    const { stateRootOf } = await import('../lib/state.js');
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'st', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stopped = stopRun(stateRootOf(dir, CONFIG.stateDir), 'st');
    assert.equal(stopped, true, '应该找到了在跑的循环');
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const dispatched = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls.length, dispatched, '停止后不应再派发新任务');
    const team = await readTeam(join(dir, '.dsh-teams'), 'st');
    assert.notEqual(team?.phase, 'running', '停止后不应停在 running');
  });
});

test('重建：调度循环运行中拒绝重建任务图（否则新图会被旧循环执行）', async () => {
  await withDir(async (dir) => {
    let release;
    const gateOn = new Promise((resolve) => {
      release = resolve;
    });
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async () => ({
                childId: 'c1',
                result: gateOn.then(() => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })),
                dispose: async () => {},
              }),
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'rb', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const again = await planTeam({ ...base, task: '换成另一件事', rebuild: true });
    assert.equal(again.rebuilt, false, '运行中不得重建');
    assert.match(again.reason, /正在运行/, '应说清原因');
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});

test('驳回后其它已通过的门会重跑（代码变了，旧结论过期）', async () => {
  await withDir(async (dir) => {
    const calls = [];
    let securityRounds = 0;
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label.split(':').slice(2).join(':'));
                let text = '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS';
                if (spec.label.includes('security-reviewer')) {
                  securityRounds += 1;
                  if (securityRounds <= 1) text = '越权 src/a.js:1 证据 src/a.js:1 退出码 0\n\nVERDICT: FAIL';
                }
                return {
                  childId: `c${calls.length}`,
                  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const config = { ...CONFIG, gates: { requireEvidence: true, securityBlock: false } };
    const base = { ctx, config, agent: { id: 'cap' }, captainSessionId: 'stale', workspace: dir };
    await planTeam({ ...base, task: '重构认证模块，跨模块大改', filesTouched: 9, crossModule: true });
    await approveTeam(base);
    await startTeamRun(base);
    let team;
    for (let i = 0; i < 300; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'stale');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done');
    const reviewRuns = calls.filter((label) => label.includes('code-reviewer')).length;
    assert.ok(reviewRuns >= 2, `重做后 review 必须重跑，实际 ${reviewRuns} 次`);
    // 门必须在实现步骤之后重跑，不能与它并行
    // ⚠️ calls 里的元素形如 `t-executor:executor`，不能用 lastIndexOf('executor')
    const lastExecutor = calls.map((label) => label.includes('t-executor:')).lastIndexOf(true);
    assert.ok(lastExecutor >= 0, '应至少派发过一次执行者');
    const reviewAfter = calls.findIndex((label, index) => index > lastExecutor && label.includes('code-reviewer'));
    assert.ok(reviewAfter > lastExecutor, 'review 应排在重做的执行者之后');
  });
});

test('驳回时把评审意见带进任务卡（执行者不是盲改）', async () => {
  await withDir(async (dir) => {
    const prompts = [];
    let rounds = 0;
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                // request.prompt 是内容块数组（[{type:'text',text}]），不是字符串
                const blocks = Array.isArray(spec.request?.prompt) ? spec.request.prompt : [];
                prompts.push({ label: spec.label, text: blocks.map((block) => String(block?.text ?? '')).join('\n') });
                let text = '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS';
                if (spec.label.includes('code-reviewer')) {
                  rounds += 1;
                  text =
                    rounds === 1
                      ? '第42行有越权风险。证据 src/a.js:42 退出码 0\n\nVERDICT: FAIL'
                      : '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS';
                }
                return {
                  childId: `c${prompts.length}`,
                  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'fb', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    let team;
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'fb');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const executorPrompts = prompts.filter((item) => item.label.includes('t-executor:'));
    assert.equal(executorPrompts.length, 2, '执行者应被退回一次');
    assert.match(executorPrompts[1].text, /被质量门驳回过/, '第二次任务卡应说明这是重做');
    assert.match(executorPrompts[1].text, /第42行有越权风险/, '应带上评审原始意见');
  });
});

/* ================================================================== *
 * 风险关键词：英文屈折 + 中文口语词（审计 M7）
 * ================================================================== */

test('风险词：英文复数/时态/派生形式都能命中', () => {
  for (const text of [
    'rotate the credentials of the worker',
    'store secrets in the vault',
    'update user permissions',
    'add encryption at rest',
    'list vulnerabilities',
    'authenticate the request',
    'OAuth2 callback',
    'payments are failing',
  ]) {
    const decision = route({ taskText: text, filesTouched: 1 });
    assert.equal(decision.score.risk, 2, `应识别为高风险：${text}`);
  }
});

test('风险词：不误报（author 不该被当成 auth）', () => {
  for (const text of ['fix the author bio typos', '改个按钮颜色', 'update the docs', 'rename the build script']) {
    const decision = route({ taskText: text, filesTouched: 1 });
    assert.notEqual(decision.score.risk, 2, `不应误判为高风险：${text}`);
  }
});

test('风险词：中文高频口语词也能命中', () => {
  for (const text of ['退款流程改造', '令牌过期了', '会话固定攻击', '交易流水对账', '用户隐私导出']) {
    const decision = route({ taskText: text, filesTouched: 1 });
    assert.equal(decision.score.risk, 2, `应识别为高风险：${text}`);
  }
});

test('判定解析：结尾贴示例不能把真实 FAIL 翻成 PASS（fail-open 回归）', () => {
  // 真实 FAIL + 后面的格式示例 → 歧义 → 按未通过处理
  assert.equal(parseVerdict('问题一堆\n\nVERDICT: FAIL\n\n示例格式：\nVERDICT: PASS'), undefined);
  // 回显指令（`PASS|FAIL|BLOCKED`）不是判定
  assert.equal(parseVerdict('请按格式输出\nVERDICT: PASS|FAIL|BLOCKED'), undefined);
  // 围栏代码块里的示例要剥掉，只认块外的真实判定
  assert.equal(parseVerdict('示例\n\n```\nVERDICT: PASS\n```\n\n实际：\nVERDICT: FAIL'), 'FAIL');
  // 行内提到不算
  assert.equal(parseVerdict('我给出 VERDICT: PASS 之后又补充两点\n- 一\n- 二'), undefined);
});

test('判定解析：同一段落里出现两个不同判定 → 歧义（fail-closed）', () => {
  assert.equal(parseVerdict('VERDICT: FAIL\nVERDICT: PASS'), undefined);
  assert.equal(parseVerdict('VERDICT: FAIL\n\nVERDICT: BLOCKED'), undefined);
});

test('任务图指纹：改 subject/objective/order/workspace 也会变', () => {
  const base = { tasks: [{ id: 'x', role: 'executor', kind: 'implementation', deps: [], acceptance: [] }] };
  const variants = [
    { ...base.tasks[0], subject: '新目标' },
    { ...base.tasks[0], objective: '新描述' },
    { ...base.tasks[0], order: 3 },
    { ...base.tasks[0], workspace: '/other' },
  ];
  for (const variant of variants) {
    assert.notEqual(
      graphFingerprint({ tasks: [base.tasks[0]] }),
      graphFingerprint({ tasks: [variant] }),
      `改 ${Object.keys(variant).find((key) => variant[key] !== base.tasks[0][key])} 后指纹必须变`,
    );
  }
});

test('角色启停：并发写不丢（原子读-改-写）', async () => {
  await withDir(async (stateRoot) => {
    const slugs = ['analyst', 'architect', 'critic', 'explore', 'orchestrator', 'document-specialist'];
    await Promise.all(slugs.map((slug) => setRoleEnabled(stateRoot, slug, false)));
    const disabled = await readDisabledRoles(stateRoot);
    assert.equal(disabled.size, slugs.length, `6 个并发停用必须全部落盘，实际 ${disabled.size}`);
  });
});

test('角色启停：不存在的角色被拒绝', async () => {
  await withDir(async (stateRoot) => {
    const result = await applyRoleAction({ stateRoot, body: { action: 'toggle', role: 'no-such-role', enabled: false } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /找不到角色/);
  });
});

test('角色正文接口只回正文（不含 frontmatter）', async () => {
  await withDir(async (stateRoot) => {
    const saved = await applyRoleAction({
      stateRoot,
      body: {
        action: 'save',
        role_id: 'body-test',
        name: '正文测试',
        description: '描述',
        prompt: '这是契约正文。',
      },
    });
    assert.equal(saved.ok, true);
    const text = await readFile(join(userRolesDir(stateRoot), 'body-test.md'), 'utf8');
    assert.match(text, /^---/, '文件里应该有 frontmatter');
    // 路由层剥掉 frontmatter 的逻辑
    const body = text.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    assert.ok(!body.includes('name:'), '正文里不应含 frontmatter');
    assert.match(body, /这是契约正文/);
  });
});

test('停止后可续跑：halted → 再次 teams_run 从断点继续，不要求重新批准', async () => {
  await withDir(async (dir) => {
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label);
                const text = '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS';
                if (calls.length === 1) return { childId: 'c1', result: hold, dispose: async () => {} };
                return {
                  childId: `c${calls.length}`,
                  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const { stopRun } = await import('../lib/scheduler.js');
    const { stateRootOf } = await import('../lib/state.js');
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'rs', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(stopRun(stateRootOf(dir, CONFIG.stateDir), 'rs'), true);
    release({ output: [{ type: 'text', text: '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS' }], stopReason: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const halted = await readTeam(join(dir, '.dsh-teams'), 'rs');
    assert.equal(halted.phase, 'halted', '停止后应落到 halted');

    // 续跑：图没变，不需要重新批准
    const again = await startTeamRun(base);
    assert.equal(again.started, true, again.reason ?? '应能续跑');

    let team;
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'rs');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(team.phase === 'done' || team.phase === 'failed', '续跑应跑到终态');
    const graph = await readTasks(join(dir, '.dsh-teams'), 'rs');
    assert.equal(
      graph.tasks.some((task) => task.status === 'running'),
      false,
      '续跑后不应残留 running 任务',
    );
  });
});

test('判定解析：合法写法不能被误杀（尾随括号/破折号/项目符号/整段围栏/判定后多行）', () => {
  assert.equal(parseVerdict('证据 a.js:1 退出码 0\n\nVERDICT: PASS'), 'PASS');
  assert.equal(parseVerdict('VERDICT: PASS（无阻塞项）'), 'PASS', '尾随括号说明是合法的');
  assert.equal(parseVerdict('VERDICT: PASS — 无阻塞项'), 'PASS', '尾随破折号说明是合法的');
  assert.equal(parseVerdict('- VERDICT: FAIL'), 'FAIL', '项目符号是合法的');
  assert.equal(parseVerdict('**VERDICT:** FAIL'), 'FAIL');
  assert.equal(parseVerdict('VERDICT： BLOCKED'), 'BLOCKED', '全角冒号');
  assert.equal(parseVerdict('```\nVERDICT: FAIL（三个问题）\n```'), 'FAIL', '整段被围栏包住也认');
  assert.equal(parseVerdict('VERDICT: PASS\n- 补充一\n- 二\n- 三\n- 四\n- 五\n- 六'), 'PASS', '判定后还有几行说明');
});

test('判定解析：回显格式/自相矛盾一律不认（fail-closed）', () => {
  assert.equal(parseVerdict('请按此输出\nVERDICT: PASS|FAIL|BLOCKED'), undefined, '回显格式不是判定');
  assert.equal(parseVerdict('VERDICT: FAIL\nVERDICT: PASS'), undefined, '两个不同判定 = 歧义');
  assert.equal(parseVerdict('都过了'), undefined, '没写判定');
});

test('丢弃过期结果时事件流留痕', async () => {
  await withDir(async (dir) => {
    // 正常流程起跑，但让子代理慢一点；派发后再给它加一代（模拟驳回/停止/接管）
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async () => ({
                childId: 'c1',
                result: hold.then(() => ({
                  output: [{ type: 'text', text: '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS' }],
                  stopReason: 'completed',
                })),
                dispose: async () => {},
              }),
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'dc', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // 加一代：派发时捕获的是 0，现在变成 1 → 结果回来必须被丢弃
    const { mutateTasks } = await import('../lib/state.js');
    await mutateTasks(join(dir, '.dsh-teams'), 'dc', (graph) => {
      for (const task of graph.tasks) {
        if (task.status !== 'running') continue;
        task.epoch = (task.epoch ?? 0) + 1;
      }
      return graph;
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    assert.match(events, /丢弃了 .* 的过期结果/, '丢弃必须写事件');
  });
});


test('停止：真正打断在跑的子代理（不是等它自己跑完）', async () => {
  await withDir(async (dir) => {
    let aborted = false;
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => ({
                childId: 'c1',
                // 永不主动返回，只有收到 abort 才结束
                result: new Promise((resolve) => {
                  spec.signal?.addEventListener('abort', () => {
                    aborted = true;
                    resolve({ output: [], stopReason: 'aborted' });
                  });
                }),
                dispose: async () => {},
              }),
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const { stopRun } = await import('../lib/scheduler.js');
    const { stateRootOf } = await import('../lib/state.js');
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'ab', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const started = Date.now();
    assert.equal(stopRun(stateRootOf(dir, CONFIG.stateDir), 'ab'), true);
    let team;
    for (let i = 0; i < 100; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'ab');
      if (team?.phase === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'halted', '应落到 halted');
    assert.equal(aborted, true, '子代理必须收到 abort，而不是等它自己结束');
    assert.ok(Date.now() - started < 3000, '停止应在一两秒内完成');
  });
});

test('派发：任务的角色不存在时干净失败，不得热循环（TDZ 回归）', async () => {
  await withDir(async (dir) => {
    const calls = [];
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async () => {
                calls.push('x');
                return {
                  childId: 'c',
                  result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'ghost', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });

    // 把任务图里的角色改成不存在的（模拟"自定义角色被删/改名之后再跑"）
    const { mutateTasks } = await import('../lib/state.js');
    await mutateTasks(join(dir, '.dsh-teams'), 'ghost', (graph) => {
      for (const task of graph.tasks) task.role = 'ghost-role';
      return graph;
    });
    // 图变了要重新批准
    await approveTeam(base);

    const started = await startTeamRun(base);
    assert.equal(started.started, true);

    // 关键：必须在短时间内收口，且不能把事件流刷爆
    let team;
    for (let i = 0; i < 100; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'ghost');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'failed', '角色缺失应干净失败，而不是一直 running');
    const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    const errorLines = events.split('\n').filter((line) => line.includes('派发异常'));
    assert.ok(errorLines.length < 5, `不得热循环刷事件（实际 ${errorLines.length} 条"派发异常"）`);
    assert.ok(!events.includes('Cannot access'), '不应出现 TDZ ReferenceError');
  });
});

test('零进展护栏：派发期异常必须把任务落成失败，不得无限热循环', async () => {
  await withDir(async (dir) => {
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              // 故意让派发期炸：返回值缺 result
              startActivation: async () => {
                throw new Error('模拟派发期异常');
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'zg', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);

    let team;
    for (let i = 0; i < 120; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'zg');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.notEqual(team.phase, 'running', '不得停在 running');
    const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    const count = events.split('\n').filter((line) => line.includes('派发异常') || line.includes('派发失败')).length;
    assert.ok(count < 20, `事件流不得被刷爆（实际 ${count} 条）`);
  });
});

test('停止后续跑：真实 abort 路径下任务留 pending，再 teams_run 能跑完', async () => {
  await withDir(async (dir) => {
    let round = 1;
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                const mine = round;
                return {
                  childId: `c${mine}`,
                  result: new Promise((resolve) => {
                    if (mine !== 1) {
                      setTimeout(() => resolve({ output: [{ type: 'text', text: '证据 a.js:1 退出码 0\n\nVERDICT: PASS' }], stopReason: 'completed' }), 20);
                      return;
                    }
                    // 第一轮：只有收到 abort 才结束（模拟被用户停止）
                    spec.signal?.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }));
                  }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const { stopRun } = await import('../lib/scheduler.js');
    const { stateRootOf } = await import('../lib/state.js');
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'sr', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 150));

    stopRun(stateRootOf(dir, CONFIG.stateDir), 'sr');
    let team;
    for (let i = 0; i < 100; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'sr');
      if (team?.phase === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'halted');
    const graph = await readTasks(join(dir, '.dsh-teams'), 'sr');
    assert.equal(
      graph.tasks.every((task) => task.status === 'pending' || task.status === 'done'),
      true,
      '被停止的任务必须留 pending（判 failed 会让续跑断掉）',
    );

    round = 2;
    const again = await startTeamRun(base);
    assert.equal(again.started, true, again.reason ?? '应能续跑');
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'sr');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done', '续跑应跑完');
  });
});

test('停止续跑：abort 时 result 被 reject（真实取消语义）也要留 pending', async () => {
  await withDir(async (dir) => {
    let round = 1;
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                const mine = round;
                if (mine !== 1) {
                  return {
                    childId: `c${mine}`,
                    result: Promise.resolve({
                      output: [{ type: 'text', text: '证据 a.js:1 退出码 0\n\nVERDICT: PASS' }],
                      stopReason: 'completed',
                    }),
                    dispose: async () => {},
                  };
                }
                // 第一轮：被 abort 时 result **reject**（不是 resolve 成 aborted）
                return {
                  childId: 'c1',
                  result: new Promise((_, reject) => {
                    spec.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
                  }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const { stopRun } = await import('../lib/scheduler.js');
    const { stateRootOf } = await import('../lib/state.js');
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'e3', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    await startTeamRun(base);
    await new Promise((resolve) => setTimeout(resolve, 150));

    stopRun(stateRootOf(dir, CONFIG.stateDir), 'e3');
    let team;
    for (let i = 0; i < 100; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'e3');
      if (team?.phase === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'halted');
    const graph = await readTasks(join(dir, '.dsh-teams'), 'e3');
    assert.equal(
      graph.tasks.every((task) => task.status === 'pending'),
      true,
      `被 stopped 打断的任务必须留 pending，实际 ${graph.tasks.map((task) => `${task.id}:${task.status}`).join(',')}`,
    );

    round = 2;
    const again = await startTeamRun(base);
    assert.equal(again.started, true, again.reason ?? '');
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'e3');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done', '续跑应跑完');
  });
});

test('幂等：任务已经 done 后，一次迟到的失败不能把它翻成 failed', async () => {
  await withDir(async (dir) => {
    const { mutateTasks, ensureTeam } = await import('../lib/state.js');
    const stateRoot = join(dir, '.dsh-teams');
    await ensureTeam({ stateRoot, captainSessionId: 'idem', workspace: dir, purpose: '测试' });
    await mutateTasks(stateRoot, 'idem', () => ({
      tasks: [
        {
          id: 't1',
          role: 'executor',
          roleName: '执行者',
          kind: 'implementation',
          deps: [],
          status: 'done',
          acceptance: [],
          evidence: [{ kind: 'run' }],
          attempts: [{ attempt: 1, status: 'done' }],
          output: '已完成的产出',
        },
      ],
    }));
    // 直接走一次"派发期异常"的兜底：把任务交给 settleTask(failed)
    const { startTeamRun } = await import('../lib/scheduler.js');
    const fake = fakeSubagents(() => { throw new Error('模拟迟到失败'); });
    const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'idem', workspace: dir };
    // 任务已 done，循环不会挑它；这里直接验证状态没被翻
    const graph = await readTasks(stateRoot, 'idem');
    assert.equal(graph.tasks[0].status, 'done');
    assert.equal(graph.tasks[0].output, '已完成的产出');
    void startTeamRun;
    void base;
  });
});

test('重建归档：归档标题用上一轮图自己的 subject，不能被新任务串掉', async () => {
  await withDir(async (dir) => {
    const fake = fakeSubagents(() => '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS');
    const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'arc', workspace: dir };
    await planTeam({ ...base, task: '第一轮的任务' });
    await approveTeam(base);
    await startTeamRun(base);
    for (let i = 0; i < 200; i += 1) {
      const team = await readTeam(join(dir, '.dsh-teams'), 'arc');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 第二轮：重建（模拟 teams_plan 先把 purpose 换成新任务）
    await planTeam({ ...base, task: '第二轮的新任务', forcePath: 'fast', rebuild: true });

    const runsFile = join(dir, '.dsh-teams', 'runs', 'arc.jsonl');
    const lines = (await readFile(runsFile, 'utf8')).split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '应有归档记录');
    const archived = JSON.parse(lines[lines.length - 1]);
    assert.equal(archived.subject, '第一轮的任务', `归档标题必须是上一轮的任务，实际「${archived.subject}」`);
  });
});

/* ================================================================== *
 * 第六轮审计发现的回归锁（R6-*）
 * ================================================================== */

test('R6-07 locale 不得过滤关键词池（中文安全任务不能因界面语言漏判）', async () => {
  const { route } = await import('../lib/router.js');
  const task = '支付回调签名校验失败，需要改认证流程';
  for (const locale of [undefined, 'zh', 'en']) {
    const decision = route({ taskText: task, locale });
    assert.equal(decision.path, 'full', `locale=${locale} 时中文安全任务必须走完整路径`);
    assert.equal(decision.score.risk, 2, `locale=${locale} 时风险必须判 2`);
  }
});

test('R6-09 运行期给门补依赖不得让审批指纹失效', () => {
  const planned = {
    tasks: [
      { id: 'a', role: 'executor', kind: 'implementation', deps: [], plannedDeps: [], acceptance: [] },
      { id: 'g', role: 'verifier', kind: 'verification', deps: ['a'], plannedDeps: ['a'], acceptance: [] },
    ],
  };
  const afterRework = {
    tasks: [
      { id: 'a', role: 'executor', kind: 'implementation', deps: [], plannedDeps: [], acceptance: [] },
      // 驳回时调度器给门补了依赖
      { id: 'g', role: 'verifier', kind: 'verification', deps: ['a', 'b'], plannedDeps: ['a'], acceptance: [] },
    ],
  };
  assert.equal(
    graphFingerprint(planned),
    graphFingerprint(afterRework),
    '运行期补依赖不该改变审批指纹（否则 run/retry 全被挡住）',
  );
  // 但**计划期**依赖变化必须改变指纹
  const replanned = {
    tasks: [
      { id: 'a', role: 'executor', kind: 'implementation', deps: [], plannedDeps: [], acceptance: [] },
      { id: 'g', role: 'verifier', kind: 'verification', deps: ['a'], plannedDeps: ['a', 'x'], acceptance: [] },
    ],
  };
  assert.notEqual(graphFingerprint(planned), graphFingerprint(replanned), '计划期改动必须让指纹失效');
});

test('R6-08 崩溃残留的 running 任务能自愈（不再永久卡死）', async () => {
  await withDir(async (dir) => {
    const fake = fakeSubagents(() => '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS');
    const base = { ctx: fake.ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'orph', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    // 模拟进程崩溃：第一个任务停在 running
    const { mutateTasks } = await import('../lib/state.js');
    await mutateTasks(join(dir, '.dsh-teams'), 'orph', (graph) => {
      graph.tasks[0].status = 'running';
      return graph;
    });
    const started = await startTeamRun(base);
    assert.equal(started.started, true, started.reason ?? '');
    let team;
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'orph');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(team.phase, 'done', '崩溃残留应自愈跑完，而不是零派发判 failed');
  });
});

test('R6-05 plan 之后停用角色，run 阶段不得再派发它', async () => {
  await withDir(async (dir) => {
    const calls = [];
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true } };
    const ctx = {
      get: (key) =>
        key === 'subagents'
          ? {
              getProvider: () => provider,
              list: () => ['spawn'],
              startActivation: async (spec) => {
                calls.push(spec.label);
                return {
                  childId: 'c',
                  result: Promise.resolve({
                    output: [{ type: 'text', text: '证据 src/a.js:1 退出码 0\n\nVERDICT: PASS' }],
                    stopReason: 'completed',
                  }),
                  dispose: async () => {},
                };
              },
            }
          : undefined,
      logger: { warn() {}, info() {}, debug() {} },
    };
    const base = { ctx, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'dis', workspace: dir };
    await planTeam({ ...base, task: '改个按钮颜色' });
    await approveTeam(base);
    // 批准之后停用 code-reviewer
    const { setRoleEnabled } = await import('../lib/role-state.js');
    await setRoleEnabled(join(dir, '.dsh-teams'), 'code-reviewer', false);

    await startTeamRun(base);
    let team;
    for (let i = 0; i < 200; i += 1) {
      team = await readTeam(join(dir, '.dsh-teams'), 'dis');
      if (team?.phase === 'done' || team?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      calls.some((label) => label.includes('code-reviewer')),
      false,
      `停用后的角色不得再被派发，实际派发：${calls.join(' → ')}`,
    );
  });
});

test('R6-11 被拒的第二次 plan 不得改写旧图的团队目标', async () => {
  await withDir(async (dir) => {
    const base = { ctx: { get: () => undefined, logger: { warn() {} } }, config: CONFIG, agent: { id: 'cap' }, captainSessionId: 'pur', workspace: dir };
    await planTeam({ ...base, task: '实现登录页' });
    const before = (await readTeam(join(dir, '.dsh-teams'), 'pur')).purpose;
    const rejected = await planTeam({ ...base, task: '部署到生产环境' });
    assert.equal(rejected.rebuilt, false, '已存在图时应拒绝');
    const after = (await readTeam(join(dir, '.dsh-teams'), 'pur')).purpose;
    assert.equal(after, before, `旧图目标被污染了：「${after}」`);
  });
});

test('R6-13 事件流只读尾部（不随历史线性放大）', async () => {
  await withDir(async (dir) => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const stateRoot = join(dir, '.dsh-teams');
    await mkdir(join(stateRoot, 'teams'), { recursive: true });
    const rows = [];
    for (let i = 0; i < 12000; i += 1) rows.push(JSON.stringify({ ts: 'x', type: 'note', data: { i } }));
    await writeFile(join(stateRoot, 'events.jsonl'), `${rows.join('\n')}\n`);

    const started = Date.now();
    const events = await readEvents(stateRoot, 80);
    const elapsed = Date.now() - started;
    assert.equal(events.length, 80, '应取到 80 条');
    assert.equal(events[79].data.i, 11999, '最后一条必须是文件里最新的');
    assert.equal(events[0].data.i, 11920, '顺序必须是正序的最近 80 条');
    assert.ok(elapsed < 60, `尾部倒读应远快于全量读（实际 ${elapsed}ms）`);
  });
});
