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
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, Config } from '../index.js';
import { buildSnapshot } from '../lib/web-routes.js';
import { readField } from '../lib/config.js';

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
  return definition.execute(args, exec);
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
      'teams_role_save',
      'teams_roles',
      'teams_route',
      'teams_run',
      'teams_status',
    ]);

    assert.equal(ctx.__sections.length, 1, '应注册一段系统提示');
    assert.equal(ctx.__sections[0].name, 'dsh-teams');
    assert.ok(ctx.__sections[0].text.includes('teams_route'), '提示段应提到工具名');
    assert.ok(ctx.__sections[0].text.includes('teams_approve'), '提示段应说明审批闸门');

    assert.equal(ctx.__routes.length, 2, '应注册两条路由：状态快照 + 角色精灵图');
    assert.ok(
      ctx.__routes.some((route) => String(route.path).includes('/state')),
      '应有状态路由',
    );
    assert.ok(
      ctx.__routes.some((route) => String(route.path).includes('/asset')),
      '应有精灵图资源路由',
    );
    assert.equal(ctx.__routes[0].path, '/plugins/dsh-teams/asset');
    assert.equal(ctx.__routes[0].kind, 'exact');
    assert.equal(ctx.__routes[1].path, '/plugins/dsh-teams/state');
    assert.equal(ctx.__routes[1].kind, 'exact');
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

test('工作区无 cwd 时退回进程工作目录，不抛错', async () => {
  await withWorkspace(async ({ ctx }) => {
    const result = await callTool(ctx, 'teams_route', { task: '调一下按钮颜色' }, { agent: { id: 's1', session: { header: {} } } });
    assert.equal(result.path, 'fast');
  });
});
