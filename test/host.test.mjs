/**
 * DSH Teams — 宿主插件离线测试
 *
 * 用一个假 cordis 上下文驱动真实的 apply()，验证：
 *   - 工具注册的 schema 能通过 defineTool 的真实校验（这是最容易踩坑的地方）
 *   - teams_route / teams_status / teams_roles 的端到端行为
 *   - 状态真的落盘，且能被快照路由读回
 *
 * 运行：node --test test/host.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { apply, Config } from '../index.js';
import { buildSnapshot } from '../lib/web-routes.js';
import { readField } from '../lib/config.js';
import { readTasks, stateRootOf } from '../lib/state.js';
import { isRunning } from '../lib/scheduler.js';

/** 造一个最小的假 cordis 上下文：只提供插件实际使用的成员。 */
function fakeContext({ workspace }) {
  const tools = new Map();
  const sections = [];
  const routes = [];
  const effects = [];

  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') return ctx.__webServer;
      if (key === 'workspaceRegistry' || key === 'workspace') return ctx.__workspaceRegistry;
      if (key === 'connection') return { requestRejection: () => undefined };
      if (key === 'approval') return ctx.__approval;
      if (key === 'subagents') return ctx.__subagents;
      return undefined;
    },
    on() {
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    logger: { debug() {}, warn() {}, info() {} },
    __webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    __workspaceRegistry: {
      list: () => [{ path: workspace, title: 'test' }],
    },
    __approval: undefined,
    __subagents: undefined,
    __tools: tools,
    __sections: sections,
    __routes: routes,
    __effects: effects,
  };
  return ctx;
}

/** 构造 exec：工具用一个 agent 对象解析工作区与队长会话。 */
function fakeExec(workspace, sessionId = 'session-test-1') {
  return { agent: { id: sessionId, session: { header: { cwd: workspace } } }, signal: undefined };
}

/** 调一个已注册工具，返回其规范化结果。 */
async function callTool(ctx, name, args, exec) {
  const definition = ctx.__tools.get(name);
  assert.ok(definition, `工具 ${name} 应已注册`);
  const value = await definition.execute(args, exec);
  // ⚠️ 返回值必须满足工具自己声明的 output schema。宿主是在调用期做这件事的：
  // 多返回一个未声明的字段，整个工具结果会被 additionalProperties:false 拒掉，
  // 模型只看到一句 "invalid output"（真实踩过：给 teams_route 加了 ambiguous 却忘了声明）。
  const violations = validateJsonSchemaValue(definition.output.schema, value);
  assert.deepEqual(
    violations,
    [],
    `工具 ${name} 的返回值不符合自己的 output schema：${violations.map((item) => item.message ?? String(item)).join('；')}`,
  );
  return value;
}

/** 每个用例一个临时工作区，避免互相污染。 */
async function withWorkspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-test-'));
  try {
    const ctx = fakeContext({ workspace: dir });
    apply(ctx, { stateDir: '.dsh-teams' });
    await run({ dir, ctx });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('插件注册了工具、提示段与状态路由', async () => {
  await withWorkspace(async ({ ctx }) => {
    const names = [...ctx.__tools.keys()].sort();
    assert.deepEqual(names, [
      'teams_approve',
      'teams_plan',
      'teams_retry',
      'teams_role_manage',
      'teams_role_save',
      'teams_roles',
      'teams_route',
      'teams_run',
      'teams_status',
      'teams_stop',
    ]);

    assert.equal(ctx.__sections.length, 1, '应注册一段系统提示');
    assert.equal(ctx.__sections[0].name, 'dsh-teams');
    assert.ok(ctx.__sections[0].text.includes('teams_route'), '提示段应提到工具名');
    assert.ok(ctx.__sections[0].text.includes('teams_approve'), '提示段应说明审批闸门');

    const paths = ctx.__routes.map((route) => String(route.path));
    assert.deepEqual(paths, [
      '/plugins/dsh-teams/asset',
      '/plugins/dsh-teams/state',
      '/plugins/dsh-teams/roles/body',
      '/plugins/dsh-teams/roles',
    ]);
    for (const route of ctx.__routes) assert.equal(route.kind, 'exact');
    assert.ok(paths.some((path) => path.endsWith('/state')), '应有团队快照路由');
    assert.ok(paths.some((path) => path.endsWith('/asset')), '应有精灵图资源路由');
    assert.ok(paths.some((path) => path.endsWith('/roles')), '应有角色库路由（GET/POST）');
    assert.ok(paths.some((path) => path.endsWith('/roles/body')), '应能取角色契约正文');
  });
});

test('工具参数 schema 真实生效：必填、枚举、未知字段', async () => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');

  await withWorkspace(async ({ ctx }) => {
    for (const definition of ctx.__tools.values()) {
      assert.equal(definition.parameters.type, 'object', `${definition.name} 的参数应是 object`);
      assert.ok(definition.output.schema, `${definition.name} 必须声明输出 schema`);
      assert.equal(typeof definition.output.render, 'function');
    }

    // 编译产物是标准 JSON Schema；补上 additionalProperties:false 后做黑盒校验
    const strict = (tool) => ({ ...tool.parameters, additionalProperties: false });

    const routeTool = ctx.__tools.get('teams_route');
    assert.deepEqual(validateJsonSchemaValue(strict(routeTool), { task: '改个颜色' }, ''), []);
    assert.deepEqual(validateJsonSchemaValue(strict(routeTool), { task: '改个颜色', files_touched: 2 }, ''), []);

    assert.ok(
      validateJsonSchemaValue(strict(routeTool), {}, '').length > 0,
      'task 是必填，缺失应被拒',
    );
    assert.ok(
      validateJsonSchemaValue(strict(routeTool), { task: 'x', force_path: 'turbo' }, '').length > 0,
      'force_path 只允许声明的枚举值',
    );
    assert.ok(
      validateJsonSchemaValue(strict(routeTool), { task: 'x', bogus: 1 }, '').length > 0,
      '未知参数应被拒（防止模型臆造参数）',
    );

    const statusTool = ctx.__tools.get('teams_status');
    assert.deepEqual(validateJsonSchemaValue(strict(statusTool), {}, ''), []);
  });
});

test('teams_route 决策并落盘，teams_status 能读回', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);

    const decision = await callTool(ctx, 'teams_route', { task: '重构登录认证流程' }, exec);
    assert.equal(decision.path, 'full', '认证相关应走完整路径');
    assert.equal(decision.risk, 2);
    assert.ok(Array.isArray(decision.role_chain) && decision.role_chain.length > 0);
    assert.ok(decision.notes.some((note) => note.includes('风险优先短路')));

    // 状态文件真的存在
    const teamFile = join(dir, '.dsh-teams', 'teams', 'session-test-1.json');
    const raw = JSON.parse(await readFile(teamFile, 'utf8'));
    assert.equal(raw.decision.path, 'full');
    assert.equal(raw.captainSessionId, 'session-test-1');

    // teams_status 读回同一决策
    const status = await callTool(ctx, 'teams_status', {}, exec);
    assert.equal(status.has_team, true);
    assert.equal(status.path, 'full');
    assert.equal(status.path_label, '完整');
    assert.ok(Array.isArray(status.role_chain) && status.role_chain.includes('executor'));
  });
});

test('teams_status 在无团队时如实返回 has_team=false，而不是报错', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const status = await callTool(ctx, 'teams_status', {}, fakeExec(dir));
    assert.equal(status.has_team, false);
    assert.ok(status.state_dir.includes('.dsh-teams'));
  });
});

test('teams_route 记录事件流，供运行日志视图使用', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    await callTool(ctx, 'teams_route', { task: '修一下这个报错' }, exec);

    const eventsRaw = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    const events = eventsRaw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'route');
    assert.equal(events[0].data.path, 'debug');
    assert.equal(events[0].team, 'session-test-1');
  });
});

test('teams_roles 列出 16 个内置角色，且标记为只读', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const result = await callTool(ctx, 'teams_roles', {}, fakeExec(dir));
    assert.equal(result.count, 16, '内置角色应为 16 个');
    assert.equal(result.builtin_count, 16);
    assert.equal(result.custom_count, 0);
    assert.ok(result.roles.every((role) => role.builtin === true));
    const slugs = result.roles.map((role) => role.slug);
    for (const expected of ['analyst', 'architect', 'executor', 'verifier', 'debugger', 'devops']) {
      assert.ok(slugs.includes(expected), `缺少内置角色 ${expected}`);
    }
  });
});

test('teams_roles 可查看单个角色的契约正文', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    const summary = await callTool(ctx, 'teams_roles', { role: 'executor' }, exec);
    assert.equal(summary.count, 1);
    assert.equal(summary.roles[0].slug, 'executor');
    assert.equal(summary.prompt, undefined, '默认不带正文');

    const detail = await callTool(ctx, 'teams_roles', { role: 'executor', include_prompt: true }, exec);
    assert.ok(detail.prompt.includes('你是 开发执行者'));
    assert.ok(detail.prompt.includes('输出契约'), '契约应包含固定输出小节');
  });
});

test('teams_roles 对未知角色给出可用清单，而不是静默失败', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    await assert.rejects(
      () => callTool(ctx, 'teams_roles', { role: 'no-such-role' }, fakeExec(dir)),
      (error) => {
        assert.ok(error.message.includes('未找到角色'));
        assert.ok(error.message.includes('executor'), '错误信息应列出可用角色');
        return true;
      },
    );
  });
});

test('快照路由组装出 UI 可直接渲染的对象', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    await callTool(ctx, 'teams_route', { task: '新增一个设置页面，需要界面布局' }, fakeExec(dir));

    const stateRoot = join(dir, '.dsh-teams');
    const snapshot = await buildSnapshot({ stateRoot, captainSessionId: 'session-test-1' });

    assert.ok(snapshot, '应能组装快照');
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.captainSessionId, 'session-test-1');
    assert.equal(snapshot.needsUiDesign, true);
    assert.ok(snapshot.pathLabel);
    assert.ok(snapshot.roleChain.includes('ui-designer'), 'UI 任务的角色链应含 ui-designer');
    assert.deepEqual(snapshot.stats.total, 0, '尚未生成任务图时任务数为 0');
    assert.equal(snapshot.events.length, 1, '应带一条路由事件');
  });
});

test('快照路由：无团队时返回 null', async () => {
  await withWorkspace(async ({ dir }) => {
    const snapshot = await buildSnapshot({
      stateRoot: join(dir, '.dsh-teams'),
      captainSessionId: 'session-does-not-exist',
    });
    assert.equal(snapshot, null);
  });
});

test('重复决策会覆盖上一次，而不是堆积', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    await callTool(ctx, 'teams_route', { task: '修一下这个报错' }, exec);
    const first = await callTool(ctx, 'teams_status', {}, exec);
    assert.equal(first.path, 'debug');

    await callTool(ctx, 'teams_route', { task: '调一下按钮颜色' }, exec);
    const second = await callTool(ctx, 'teams_status', {}, exec);
    assert.equal(second.path, 'fast', '第二次决策应生效');

    const snapshot = await buildSnapshot({ stateRoot: join(dir, '.dsh-teams'), captainSessionId: 'session-test-1' });
    assert.equal(snapshot.events.length, 2, '事件流累积两条，作为审计线索');
  });
});

test('Config 提供全部默认值，可被 patch 覆盖（且字段是 volatile——设置卡片的前提）', async () => {
  const resolved = new Config({});
  // ⚠️ 叶子字段标了 .volatile() 之后，宿主会把它解析成 cosmokit 的只读引用
  // （Object.freeze({ get })），必须经 readField 取值；直接把引用当值用会得到 [object Object]。
  assert.equal(readField(resolved.stateDir, '.dsh-teams'), '.dsh-teams');
  assert.equal(readField(resolved.scheduler.maxParallel, 4), 4);
  assert.equal(readField(resolved.gates.securityBlock, true), true);
  assert.equal(readField(resolved.ui.locale, 'zh-CN'), 'zh-CN');

  const overridden = new Config({ stateDir: '.my-teams', scheduler: { maxParallel: 2 } });
  assert.equal(readField(overridden.stateDir, '.dsh-teams'), '.my-teams');
  assert.equal(readField(overridden.scheduler.maxParallel, 4), 2);
  // 未覆盖的字段保留默认值（patch 层叠语义）
  assert.equal(readField(overridden.scheduler.maxReviewRounds, 3), 3);

  // volatile 是硬要求：宿主 dsh-settings 的 volatileForm() 只认带 volatile 元数据的字段，
  // 一个都没有的话插件条目根本不会出现在设置页（而且不报错）。这里锁住"每个叶子都标了"。
  const form = volatileForm(Config);
  assert.ok(form !== undefined, 'Config 必须能被 volatileForm 投影出表单，否则设置卡片不会出现');
  assert.ok(Object.keys(form.dict ?? {}).length >= 6, '至少要有 stateDir/routing/scheduler/timeouts/watch/gates/ui 这些组');
});

/** 与宿主 dsh-settings 同名的判定：只有带 volatile 元数据的字段才进表单。 */
function volatileForm(schema) {
  if (schema?.meta?.volatile === true) return schema;
  if (schema?.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {})
        .map(([key, child]) => [key, volatileForm(child)])
        .filter(([, child]) => child !== undefined),
    );
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict };
  }
  return undefined;
}

test('工具在缺少会话上下文时明确报错，而不是猜一个工作区', async () => {
  await withWorkspace(async ({ ctx }) => {
    await assert.rejects(
      () => callTool(ctx, 'teams_route', { task: 'x' }, { agent: undefined }),
      /需要在会话内调用/,
    );
  });
});

test('teams_roles 能加载用户自定义角色，且不覆盖内置的只读标记', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);

    // 写入一个自定义角色（走状态目录，必须是平台正确的路径拼接）
    const rolesDir = join(dir, '.dsh-teams', 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(
      join(rolesDir, 'db-tuning.md'),
      [
        '---',
        'name: 数据库调优工程师',
        'description: 分析慢查询并给出索引方案',
        'emoji: 🗄️',
        'permissions: readonly',
        'tier: light',
        '---',
        '',
        '## 你是 数据库调优工程师',
        '',
        '### 结论',
        '### 证据（文件路径:行号）',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await callTool(ctx, 'teams_roles', {}, exec);
    assert.equal(result.count, 17, '16 内置 + 1 自定义');
    assert.equal(result.builtin_count, 16);
    assert.equal(result.custom_count, 1, '自定义角色必须被加载到（Windows 路径拼接回归）');

    const custom = result.roles.find((role) => role.slug === 'db-tuning');
    assert.ok(custom, '应能找到自定义角色 db-tuning');
    assert.equal(custom.builtin, false, '自定义角色不应被标记为内置');
    assert.equal(custom.name, '数据库调优工程师');

    const detail = await callTool(ctx, 'teams_roles', { role: 'db-tuning', include_prompt: true }, exec);
    assert.ok(detail.prompt.includes('数据库调优工程师'));
  });
});

test('自定义角色可覆盖同名内置角色', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const rolesDir = join(dir, '.dsh-teams', 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(
      join(rolesDir, 'executor.md'),
      ['---', 'name: 我的执行者', 'description: 自定义实现者', '---', '', '## 你是 我的执行者', ''].join('\n'),
      'utf8',
    );

    const result = await callTool(ctx, 'teams_roles', { role: 'executor' }, fakeExec(dir));
    assert.equal(result.roles[0].name, '我的执行者', '同名时自定义胜出');
    assert.equal(result.roles[0].builtin, false);
  });
});

test('损坏的自定义角色被如实报错，而不是静默忽略或崩溃', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const rolesDir = join(dir, '.dsh-teams', 'roles');
    await mkdir(rolesDir, { recursive: true });
    // 缺少 name/description 且正文为空
    await writeFile(join(rolesDir, 'broken.md'), '---\nemoji: 💥\n---\n', 'utf8');

    const result = await callTool(ctx, 'teams_roles', {}, fakeExec(dir));
    // 损坏角色仍应出现在列表里（便于用户看到并修复），但带 errors 信息
    const broken = result.roles.find((role) => role.slug === 'broken');
    assert.ok(broken, '损坏的角色也应被列出以便修复');
    assert.equal(broken.name, 'broken', '缺 name 时退回 slug，不崩');

    const { loadRoles } = await import('../lib/roles.js');
    const library = await loadRoles(rolesDir);
    assert.ok(library.errors.length >= 1, '库应报告格式错误');
    assert.ok(library.errors[0].errors.some((message) => message.includes('name')));
  });
});

test('teams_role_save 写入自定义角色，随即可被 teams_roles 读到', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);

    const saved = await callTool(
      ctx,
      'teams_role_save',
      {
        role_id: 'perf-auditor',
        name: '性能审计员',
        description: '分析热点路径并给出优化优先级',
        prompt: '## 你是 性能审计员\n\n### 结论\n### 证据（文件路径:行号）\n',
        emoji: '⚡',
        permissions: 'readonly',
        tier: 'light',
      },
      exec,
    );
    assert.equal(saved.saved, true);
    assert.ok(saved.file.endsWith('perf-auditor.md'));

    // 角色缓存必须失效，否则新角色要等重启才可见
    const listed = await callTool(ctx, 'teams_roles', { role: 'perf-auditor' }, exec);
    assert.equal(listed.roles[0].name, '性能审计员');
    assert.equal(listed.roles[0].permissions, 'readonly');
    assert.equal(listed.roles[0].builtin, false);
  });
});

test('teams_role_save 拒绝非法输入，并且不落盘', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);

    // 非法 slug（路径穿越）——由处理器兜住
    const badSlug = await callTool(
      ctx,
      'teams_role_save',
      { role_id: '../escape', name: 'x', description: 'y', prompt: 'z' },
      exec,
    );
    assert.equal(badSlug.saved, false);
    assert.ok(badSlug.errors.some((message) => message.includes('slug')));

    // 缺正文
    const noPrompt = await callTool(
      ctx,
      'teams_role_save',
      { role_id: 'ok-id', name: 'x', description: 'y', prompt: '   ' },
      exec,
    );
    assert.equal(noPrompt.saved, false);
    assert.ok(noPrompt.errors.some((message) => message.includes('prompt')));

    // 非法权限档在 schema 层就被拒（比处理器更早，这是更好的防线）
    await assert.rejects(
      () =>
        callTool(
          ctx,
          'teams_role_save',
          { role_id: 'ok-id', name: 'x', description: 'y', prompt: 'z', permissions: 'root' },
          exec,
        ),
      (error) => error.name === 'ToolArgsError' && /permissions/.test(error.message),
      '枚举外的权限档应由参数校验拦截',
    );

    // 目录里不应出现任何文件
    const listed = await callTool(ctx, 'teams_roles', {}, exec);
    assert.equal(listed.custom_count, 0, '非法输入不得写入任何角色文件');
  });
});

test('teams_role_save 覆盖同名内置角色时会如实标记', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    const saved = await callTool(
      ctx,
      'teams_role_save',
      { role_id: 'executor', name: '我的执行者', description: '自定义实现者', prompt: '## 你是 我的执行者\n' },
      exec,
    );
    assert.equal(saved.saved, true);
    assert.equal(saved.overrode_builtin, true, '覆盖内置角色必须明确告知');
  });
});

test('工作区无 cwd 时退回状态根，不抛错（且不写进真实工作区）', async () => {
  // ⚠️ 这条用例的回退目标是"解析后的状态根"，以前它等于 process.cwd()，
  // 于是测试把事件写进了运行者的真实工作区（真实踩过：污染了用户的 .dsh-teams）。
  // 这里把 stateDir 指到临时目录，回退目标就被隔离了。
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-nocwd-'));
  try {
    const ctx = fakeContext({ workspace: undefined });
    apply(ctx, { stateDir: dir });
    const result = await callTool(ctx, 'teams_route', { task: '调一下按钮颜色' }, { agent: { id: 's1', session: { header: {} } } });
    assert.equal(result.path, 'fast');
    // 事件必须落在临时目录，而不是真实工作区
    const written = await readdir(dir).catch(() => []);
    assert.ok(written.includes('events.jsonl'), '事件应写在临时状态根里');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('批准闸门：有审批通道时，用户拒绝则计划不被批准', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const { definitions } = { definitions: ctx.__tools };
    const plan = definitions.get('teams_plan');
    const approve = definitions.get('teams_approve');

    // 工作区来自 agent.session.header.cwd，假 agent 必须带上，否则状态会落到进程 cwd
    const exec = { agent: { id: 'cap', session: { header: { cwd: dir } } }, callId: 'call-1', signal: undefined };
    await plan.execute({ task: '改个按钮颜色' }, exec);

    // 用户拒绝
    ctx.__approval = { request: async () => 'rejected' };
    const rejected = await approve.execute({}, exec);
    assert.equal(rejected.approved, false);
    assert.match(rejected.reason, /拒绝/, '应说明是用户拒绝');

    // 用户同意
    ctx.__approval = { request: async () => 'allowed-once' };
    const allowed = await approve.execute({}, exec);
    assert.equal(allowed.approved, true, '同意后应批准');

    // 没有审批通道：照常批准，但要留下"未经人工确认"的记录
    ctx.__approval = undefined;
    const plan2 = await plan.execute({ task: '换成另一件事', rebuild: true }, exec);
    assert.ok(plan2);
    const unconfirmed = await approve.execute({}, exec);
    assert.equal(unconfirmed.approved, true);
    const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    assert.match(events, /approve-unconfirmed/, '无通道时应记录未经人工确认');
  });
});

test('批准闸门：没有会话上下文时直接拒绝（captainOf 先于审批通道）', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    ctx.__approval = { request: async () => 'allowed-once' };
    const plan = ctx.__tools.get('teams_plan');
    const approve = ctx.__tools.get('teams_approve');
    const exec = { agent: { id: 'cap', session: { header: { cwd: dir } } }, callId: 'c1' };
    await plan.execute({ task: '改个按钮颜色' }, exec);
    await assert.rejects(() => approve.execute({}, { callId: 'c2' }), /无法确定队长会话/);
  });
});

/* ================================================================== *
 * 角色路由的 HTTP 契约（直接调 handler，用假 req/res）
 * ================================================================== */

/** 假的 Node 请求：够 EventEmitter 那套用。 */
function fakeReq({ method = 'GET', url = '/', body } = {}) {
  const handlers = new Map();
  const req = {
    method,
    url,
    on(event, handler) {
      handlers.set(event, handler);
      return req;
    },
    destroy() {},
  };
  // 延后触发 data/end，模拟流式读体
  setTimeout(() => {
    if (body !== undefined) handlers.get('data')?.(Buffer.from(JSON.stringify(body)));
    handlers.get('end')?.();
  }, 0);
  return req;
}

/** 假的 Node 响应：捕获状态码与 JSON。 */
function fakeRes() {
  const out = { status: 0, headers: undefined, body: undefined };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(chunk) {
      out.body = chunk === undefined ? undefined : JSON.parse(String(chunk));
    },
  };
}

async function callRoute(ctx, path, options) {
  const route = ctx.__routes.find((item) => item.path === path);
  assert.ok(route, `应注册路由 ${path}`);
  const res = fakeRes();
  await route.handler(fakeReq(options), res);
  return res.out;
}

test('HTTP：GET /roles 返回内置 16 个角色与核心角色清单', async () => {
  await withWorkspace(async ({ ctx }) => {
    const out = await callRoute(ctx, '/plugins/dsh-teams/roles', { method: 'GET', url: '/plugins/dsh-teams/roles' });
    assert.equal(out.status, 200);
    assert.equal(out.body.roles.length, 16);
    assert.deepEqual(out.body.coreRoles, ['executor', 'verifier']);
    assert.equal(out.body.roles.every((role) => typeof role.enabled === 'boolean'), true);
    assert.equal(out.headers['cache-control'], 'no-store');
  });
});

test('HTTP：POST /roles 停用角色并返回新列表；不存在的角色 400', async () => {
  await withWorkspace(async ({ ctx }) => {
    const ok = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'POST',
      url: '/plugins/dsh-teams/roles',
      body: { action: 'toggle', role: 'critic', enabled: false },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.roles.find((role) => role.slug === 'critic').enabled, false);

    const bad = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'POST',
      url: '/plugins/dsh-teams/roles',
      body: { action: 'toggle', role: 'no-such', enabled: false },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.reason, /找不到角色/);
  });
});

test('HTTP：POST /roles 保存自定义角色（含触发词）后能在列表里看到', async () => {
  await withWorkspace(async ({ ctx }) => {
    const saved = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'POST',
      url: '/plugins/dsh-teams/roles',
      body: {
        action: 'save',
        role_id: 'db-expert',
        name: '数据库专家',
        description: '慢查询与索引',
        prompt: '你是数据库专家。',
        permissions: 'readonly',
        tier: 'light',
        triggers: ['sql', '索引'],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const role = saved.body.roles.find((item) => item.slug === 'db-expert');
    assert.ok(role);
    assert.deepEqual(role.triggers, ['sql', '索引']);
    assert.equal(role.builtin, false);
  });
});

test('HTTP：GET /roles/body 只回正文；非法 role 参数 400', async () => {
  await withWorkspace(async ({ ctx }) => {
    const out = await callRoute(ctx, '/plugins/dsh-teams/roles/body', {
      method: 'GET',
      url: '/plugins/dsh-teams/roles/body?role=verifier',
    });
    assert.equal(out.status, 200);
    assert.ok(!out.body.body.includes('permissions:'), '正文里不应含 frontmatter');
    assert.match(out.body.body, /验证|VERDICT/);

    const bad = await callRoute(ctx, '/plugins/dsh-teams/roles/body', {
      method: 'GET',
      url: '/plugins/dsh-teams/roles/body?role=..%2F..%2Fetc',
    });
    assert.equal(bad.status, 400, '非法角色 id 必须拒绝');
  });
});

test('HTTP：GET /roles 与 /roles/body 只允许 GET/POST 对应方法', async () => {
  await withWorkspace(async ({ ctx }) => {
    const wrong = await callRoute(ctx, '/plugins/dsh-teams/roles/body', { method: 'POST', url: '/plugins/dsh-teams/roles/body' });
    assert.equal(wrong.status, 405);
  });
});

test('HTTP：未知 workspace 返回 400，不静默写到第一个工作区', async () => {
  await withWorkspace(async ({ ctx }) => {
    const out = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'GET',
      url: '/plugins/dsh-teams/roles?workspace=D%3A%5Cother%5Cproject',
    });
    assert.equal(out.status, 400, '未知工作区必须拒绝');
    assert.equal(out.body.error, 'unknown workspace');

    const post = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'POST',
      url: '/plugins/dsh-teams/roles',
      body: { action: 'toggle', role: 'critic', enabled: false, workspace: 'D:\\other\\project' },
    });
    assert.equal(post.status, 400, '写操作同样拒绝');
  });
});

test('HTTP：带正确 workspace 时读写落在同一工作区', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const out = await callRoute(ctx, '/plugins/dsh-teams/roles', {
      method: 'GET',
      url: `/plugins/dsh-teams/roles?workspace=${encodeURIComponent(dir)}`,
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.roles.length, 16);
  });
});

test('审批策略=never 时不弹窗、按「未确认」放行并留痕（不能误判成用户拒绝）', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    // 宿主在 policy=never 时不会去问任何人，request() 直接返回 'rejected'
    // （dsh-user-approval 的 decide() 就是这么实现的）。把它当成"用户拒绝"是误判：
    // 关掉审批弹窗的人将永远批不了计划。
    let asked = 0;
    ctx.__approval = {
      effectivePolicy: () => 'never',
      request: async () => {
        asked += 1;
        return 'rejected';
      },
    };
    const exec = fakeExec(dir);
    await callTool(ctx, 'teams_plan', { task: '给 README 补一节说明', force_path: 'fast' }, exec);
    const result = await callTool(ctx, 'teams_approve', {}, exec);

    assert.equal(result.approved, true, `policy=never 应放行，实际：${JSON.stringify(result)}`);
    assert.equal(asked, 0, 'policy=never 时根本不应该去问（问了宿主也只会回 rejected）');
    const events = await readFile(join(dir, '.dsh-teams', 'events.jsonl'), 'utf8');
    assert.match(events, /approve-unconfirmed/, '必须留下"未经弹窗确认"的痕迹');
    assert.match(events, /never/, '原因要写清楚是策略 never');
  });
});

test('审批策略=ask 且用户拒绝时不批准', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    ctx.__approval = { effectivePolicy: () => 'ask', request: async () => 'rejected' };
    const exec = fakeExec(dir);
    await callTool(ctx, 'teams_plan', { task: '给 README 补一节说明', force_path: 'fast' }, exec);
    const result = await callTool(ctx, 'teams_approve', {}, exec);
    assert.equal(result.approved, false);
    assert.match(result.reason, /拒绝/);
  });
});

test('全部 10 个工具的返回值都满足各自声明的 output schema', async () => {
  // 宿主在调用期用 additionalProperties:false 校验工具输出，多一个未声明字段
  // 整个结果就会被拒（模型只看到 "invalid output"）。这条用例把每个工具
  // 都实际调用一遍，再让 callTool 用真 schema 校验。
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);

    // 1) route / plan
    await callTool(ctx, 'teams_route', { task: '调整按钮颜色和间距' }, exec);
    await callTool(ctx, 'teams_plan', { task: '调整按钮颜色和间距', force_path: 'fast' }, exec);
    // 2) status
    await callTool(ctx, 'teams_status', {}, exec);
    // 3) approve（有审批通道时会问，这里让它放行）
    ctx.__approval = { effectivePolicy: () => 'never', request: async () => 'allowed-once' };
    await callTool(ctx, 'teams_approve', {}, exec);
    // 4) run 之后立刻 stop（不等待子代理）
    ctx.__approval = undefined;
    await callTool(ctx, 'teams_run', {}, exec);
    await callTool(ctx, 'teams_stop', {}, exec);
    // 5) retry / 角色三件套
    await callTool(ctx, 'teams_retry', {}, exec);
    await callTool(ctx, 'teams_roles', {}, exec);
    const saved = await callTool(
      ctx,
      'teams_role_save',
      { role_id: 'schema-probe', name: 'Schema 探针', description: '用于校验输出契约', prompt: '正文' },
      exec,
    );
    assert.equal(saved.saved, true);
    await callTool(ctx, 'teams_role_manage', { action: 'disable', role: 'schema-probe' }, exec);
  });
});

test('运行中的拒绝分支：重复 teams_run / teams_plan 都满足 output schema 且不伤在飞任务', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    const stateRoot = stateRootOf(dir, '.dsh-teams');
    // 永不返回结果的子代理：让调度循环稳定停在“有任务在飞”的状态
    ctx.__subagents = {
      getProvider: () => ({
        name: 'spawn',
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
      }),
      list: () => ['spawn'],
      startActivation: async (spec) => ({
        childId: 'hold',
        // 一直不交结果，直到被 abort（模拟真实宿主：stop 会打断子代理）
        result: new Promise((resolve) => {
          const finish = () => resolve({ output: [], stopReason: 'aborted' });
          if (spec.signal?.aborted === true) finish();
          else spec.signal?.addEventListener('abort', finish, { once: true });
        }),
        dispose: async () => {},
      }),
    };

    await callTool(ctx, 'teams_plan', { task: '改个按钮颜色' }, exec);
    await callTool(ctx, 'teams_approve', {}, exec);
    const started = await callTool(ctx, 'teams_run', {}, exec);
    assert.equal(started.started, true);

    // 等某个任务真正进入 running（派发是异步的）
    let before;
    for (let i = 0; i < 200; i += 1) {
      before = (await readTasks(stateRoot, 'session-test-1')).tasks.find((task) => task.status === 'running');
      if (before !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(before !== undefined, '应能观察到在飞任务');

    // 重复 teams_run：callTool 会用真 schema 校验（拒绝分支含 running 字段）
    const second = await callTool(ctx, 'teams_run', {}, exec);
    assert.equal(second.started, false);
    const after = (await readTasks(stateRoot, 'session-test-1')).tasks.find((task) => task.id === before.id);
    assert.equal(after.status, 'running', '重复调用不得复位在飞任务');
    assert.equal(after.epoch ?? 0, before.epoch ?? 0, '重复调用不得给在飞任务加世代');

    // 运行中 teams_plan：必须干净拒绝，不能因为 result.decision/graph 缺失抛 TypeError
    const plan = await callTool(ctx, 'teams_plan', { task: '运行中重建' }, exec);
    assert.equal(plan.rebuilt, false);
    assert.match(plan.reason, /运行/);

    const stopped = await callTool(ctx, 'teams_stop', {}, exec);
    assert.equal(stopped.stopped, true);
    for (let i = 0; i < 200 && isRunning(stateRoot, 'session-test-1'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isRunning(stateRoot, 'session-test-1'), false, '停止后循环必须退出');
  });
});

test('运行中拒绝 teams_plan 时，decision 必须描述正在跑的那张图（不能新旧混搭）', async () => {
  await withWorkspace(async ({ dir, ctx }) => {
    const exec = fakeExec(dir);
    // 先用 fast 建图并开跑
    await callTool(ctx, 'teams_plan', { task: '调整按钮颜色和间距', force_path: 'fast' }, exec);
    ctx.__approval = { effectivePolicy: () => 'never', request: async () => 'allowed-once' };
    await callTool(ctx, 'teams_approve', {}, exec);
    await callTool(ctx, 'teams_run', {}, exec);

    // 运行中用一条安全任务去 plan：应被拒，且回的是**旧图**的路径标签
    const rejected = await callTool(
      ctx,
      'teams_plan',
      { task: '支付回调签名校验失败，需要改认证流程', rebuild: true },
      exec,
    );
    assert.equal(rejected.rebuilt, false, '运行中必须拒绝重建');
    assert.equal(rejected.path, 'fast', `拒绝时 path 必须描述正在跑的旧图，实际 ${rejected.path}`);
    assert.ok(
      rejected.tasks.every((task) => task.id.startsWith('t-') && !['t-analyst', 't-architect', 't-critic'].includes(task.id)),
      '回的任务清单必须是旧图（fast 三件套），不能混入新算的完整路径',
    );

    await callTool(ctx, 'teams_stop', {}, exec);
  });
});
