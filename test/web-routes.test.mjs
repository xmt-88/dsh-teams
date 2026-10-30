/**
 * DSH Teams — Web 路由测试
 *
 * 覆盖状态快照路由的四条关键路径，其中三条是安全边界：
 *   1. 有团队   → 200 且返回正确快照
 *   2. 无团队   → 200 且 team=null（空态不是错误）
 *   3. 未鉴权   → 闸门拒绝，且**处理器正文绝不执行**
 *   4. 连接缺失 → 503（装配失败不得泄露工作区状态）
 *
 * 运行：node --test test/web-routes.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authenticatedWebRoutes, registerStateRoutes, buildSnapshot } from '../lib/web-routes.js';
import { ensureStateDirs, ensureTeam, mutateTeam, appendEvent, writeTasks, appendRunRecord, readEvents, readTeam } from '../lib/state.js';

/** 最小 ServerResponse 替身：记录状态码、头与正文。 */
function fakeResponse() {
  const record = { status: undefined, headers: undefined, body: undefined, ended: false };
  return {
    record,
    writeHead(status, headers) {
      record.status = status;
      record.headers = headers;
      return this;
    },
    end(body) {
      record.body = body;
      record.ended = true;
      return this;
    },
  };
}

/** 最小 IncomingMessage 替身。 */
function fakeRequest(url, method = 'GET') {
  return { url, method, headers: {} };
}

/** 带 JSON 请求体的 IncomingMessage 替身（路由用 on('data'/'end') 读体）。 */
function fakeJsonRequest(url, body, method = 'POST') {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    url,
    method,
    headers: {},
    destroy() {},
    on(event, handler) {
      if (event === 'data') handler(payload);
      if (event === 'end') handler();
      return this;
    },
  };
}

/** 注册路由并取回它（便于直接调用 handler）。 */
function captureRoutes(config, connection, workspaceRegistry, stopRun, startRun) {
  const registered = [];
  const rawServer = {
    register(route) {
      registered.push(route);
      return () => {};
    },
  };
  const webServer = authenticatedWebRoutes(rawServer, () => connection());
  registerStateRoutes({ webServer, config, workspaceRegistry, stopRun, startRun });
  return registered;
}

/** 取状态路由（插件同时注册了精灵图资源路由，所以按 path 找而不是取第一个）。 */
function captureRoute(config, connection, workspaceRegistry) {
  const routes = captureRoutes(config, connection, workspaceRegistry);
  const state = routes.find((route) => route.path === '/plugins/dsh-teams/state');
  assert.ok(state, '应注册状态路由');
  return state;
}

/** 取停止路由。 */
function captureStopRoute(config, connection, workspaceRegistry, stopRun) {
  const routes = captureRoutes(config, connection, workspaceRegistry, stopRun);
  const stop = routes.find((route) => route.path === '/plugins/dsh-teams/stop');
  assert.ok(stop, '应注册停止路由');
  return stop;
}

async function withWorkspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-web-'));
  try {
    await run({ dir, stateRoot: join(dir, '.dsh-teams') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 造一个已有决策的团队。 */
async function seedTeam(stateRoot, sessionId, workspace) {
  await ensureStateDirs(stateRoot);
  await ensureTeam({ stateRoot, captainSessionId: sessionId, workspace, purpose: '测试目标' });
  await mutateTeam(stateRoot, sessionId, (team) => {
    team.decision = {
      path: 'debug',
      label: '调试',
      score: { scale: 1, impact: 0, risk: 0 },
      total: 1,
      roleChain: ['debugger', 'executor', 'code-reviewer', 'verifier'],
      reasons: ['规模=1'],
      notes: [],
      needsUiDesign: false,
      decidedAt: new Date().toISOString(),
    };
    return team;
  });
  await appendEvent({ stateRoot, type: 'route', team: sessionId, data: { path: 'debug' } });
}

test('快照：按"每次任务"折叠的 runs —— 当前轮在前，每步带用量与子会话', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-runs';
    await seedTeam(stateRoot, sessionId, dir);
    await writeTasks(stateRoot, sessionId, {
      seq: 3,
      tasks: [
        {
          id: 't1',
          subject: '分析',
          role: 'analyst',
          roleName: '需求分析师',
          emoji: '🔍',
          kind: 'requirements',
          status: 'done',
          deps: [],
          attempts: [{ attempt: 1, status: 'done' }],
          output: '结论',
          metrics: { steps: 9, turns: 1, inputTokens: 21900, cacheReadTokens: 128500, outputTokens: 3800 },
          evidence: [{ kind: 'run', at: new Date().toISOString(), childId: 'child-a', durationMs: 406000, stopReason: 'completed' }],
        },
        {
          id: 't2',
          subject: '实现',
          role: 'executor',
          roleName: '开发执行者',
          emoji: '🔨',
          kind: 'implementation',
          status: 'running',
          deps: ['t1'],
          attempts: [{ attempt: 1, status: 'running' }],
        },
      ],
    });
    // 一条历史轮次（上一轮归档）
    await appendRunRecord(stateRoot, sessionId, {
      runId: 'old-1',
      at: new Date(Date.now() - 3600_000).toISOString(),
      subject: '上一轮的任务',
      path: 'fast',
      pathLabel: '快速',
      phase: 'done',
      steps: [{ id: 't-executor', role: 'executor', roleName: '开发执行者', status: 'done', deps: [], durationMs: 346000 }],
    });

    const snapshot = await buildSnapshot({ stateRoot, captainSessionId: sessionId, config: { stateDir: '.dsh-teams' } });

    assert.ok(Array.isArray(snapshot.runs), '快照应带 runs（面板按每次任务折叠）');
    assert.equal(snapshot.runs.length, 2, '当前轮 + 一条历史');
    const current = snapshot.runs[0];
    assert.equal(current.current, true, '当前轮在最前并标记 current');
    // 计划指纹：面板靠它区分"新的一轮计划"，重置上一轮批准按钮的乐观隐藏态
    assert.equal(current.planId, snapshot.decidedAt, '当前轮要带 planId（= decision.decidedAt）');
    assert.equal(current.subject, '测试目标');
    assert.equal(current.steps.length, 2);
    const analyst = current.steps.find((step) => step.id === 't1');
    assert.equal(analyst.childId, 'child-a', '步骤要带子会话 id（点卡片进会话）');
    assert.equal(analyst.metrics.steps, 9, '步骤要带步数');
    assert.equal(analyst.metrics.cacheReadTokens, 128500, '步骤要带缓存命中量');
    assert.equal(analyst.metrics.inputTokens, 21900, '步骤要带 token');

    const archived = snapshot.runs[1];
    assert.equal(archived.subject, '上一轮的任务', '历史轮次要保留目标');
    assert.equal(archived.current, undefined, '历史轮次不是 current');
    assert.equal(archived.planId, undefined, '历史轮次没有当前计划指纹');
    assert.equal(archived.steps[0].role, 'executor');

    // 任务视图也带上用量（旧的"任务板"标签页同样受益）
    const taskView = snapshot.tasks.find((task) => task.id === 't1');
    assert.equal(taskView.metrics.steps, 9);
    assert.equal(taskView.childId, 'child-a');
  });
});

test('子会话也能看到团队：按成员子会话反查队长团队，并标记 viewingAsChild', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const captain = 'session-captain';
    const child = 'b7c1e2d3-child-session';
    await seedTeam(stateRoot, captain, dir);
    // 任务证据里记着子会话 id（这是反查的唯一依据，不依赖任何宿主 API）
    await writeTasks(stateRoot, captain, {
      seq: 2,
      tasks: [
        {
          id: 't1',
          subject: '实现',
          role: 'executor',
          roleName: '开发执行者',
          emoji: '🔨',
          kind: 'implementation',
          status: 'done',
          deps: [],
          attempts: [{ attempt: 1, status: 'done' }],
          output: '产出',
          evidence: [{ kind: 'run', at: new Date().toISOString(), childId: child, durationMs: 1000, stopReason: 'completed' }],
        },
      ],
    });
    await mutateTeam(stateRoot, captain, (team) => {
      team.members = [{ name: 'executor', role: 'executor', roleName: '开发执行者', emoji: '🔨', status: 'idle' }];
      return team;
    });

    const route = captureRoute({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir, title: 'ws' }],
    }));

    // ① 队长会话：正常路径，不带 viewingAsChild
    const asCaptain = fakeResponse();
    await route.handler(fakeRequest(`/plugins/dsh-teams/state?session=${captain}`), asCaptain);
    const captainBody = JSON.parse(asCaptain.record.body);
    assert.equal(captainBody.team.viewingAsChild, undefined, '队长会话不应标记为子会话');
    assert.equal(captainBody.team.tasks[0].childId, child, '任务应带子会话 id（供"会话"入口跳转）');
    assert.equal(captainBody.team.members[0].sessionId, child, '成员应带子会话 id（供成员卡片点击进入）');

    // ② 子会话：必须回退到队长团队，而不是空白
    // 真实缺陷：用户从成员卡片点进子代理后，团队面板变成空白，只能返回主会话才看得到。
    const asChild = fakeResponse();
    await route.handler(fakeRequest(`/plugins/dsh-teams/state?session=${child}`), asChild);
    assert.equal(asChild.record.status, 200);
    const childBody = JSON.parse(asChild.record.body);
    assert.ok(childBody.team, '子会话必须能看到它所属的团队，而不是 null');
    assert.equal(childBody.team.captainSessionId, captain, '返回的应是队长会话的团队');
    assert.equal(childBody.team.viewingAsChild, true, '应标记"正在看子代理会话"，面板据此显示返回入口');

    // ③ 完全无关的会话：仍然是空态，不是错误
    const stranger = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/state?session=session-nobody'), stranger);
    assert.equal(stranger.record.status, 200);
    assert.equal(JSON.parse(stranger.record.body).team, null);
  });
});

test('角色矢量路由：白名单放行 svg、拒绝路径穿越', async () => {
  await withWorkspace(async ({ dir }) => {
    const routes = captureRoutes({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir, title: 'ws' }],
    }));
    const asset = routes.find((route) => route.path === '/plugins/dsh-teams/asset');
    assert.ok(asset, '应有资源路由');

    // ① 正常取矢量：200 + image/svg+xml + 长缓存
    const ok = fakeResponse();
    await asset.handler(fakeRequest('/plugins/dsh-teams/asset?name=girl-vector.svg'), ok);
    assert.equal(ok.record.status, 200);
    assert.equal(ok.record.headers['content-type'], 'image/svg+xml');
    assert.match(String(ok.record.headers['cache-control']), /max-age=\d+/, '矢量要能长缓存');
    assert.match(String(ok.record.body), /<svg/, '返回的应是 SVG');

    // ② 路径穿越与白名单外的一律拒绝（这是唯一对外暴露文件的路由）
    for (const bad of ['../index.js', '..%2Findex.js', 'girl-vector.svg/../../index.js', 'index.js', 'girl-vector.txt', '']) {
      const res = fakeResponse();
      await asset.handler(fakeRequest(`/plugins/dsh-teams/asset?name=${encodeURIComponent(bad)}`), res);
      assert.ok(res.record.status === 400 || res.record.status === 404, `应拒绝：${bad}（实际 ${res.record.status}）`);
    }

    // ③ 非 GET
    const post = fakeResponse();
    await asset.handler(fakeRequest('/plugins/dsh-teams/asset?name=girl-vector.svg', 'POST'), post);
    assert.equal(post.record.status, 405);
  });
});

test('有团队：返回 200 与完整快照', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-alpha';
    await seedTeam(stateRoot, sessionId, dir);

    const route = captureRoute({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir, title: 'ws' }],
    }));

    const res = fakeResponse();
    await route.handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), res);

    assert.equal(res.record.status, 200);
    assert.equal(res.record.headers['cache-control'], 'no-store', '状态不得被缓存');
    const body = JSON.parse(res.record.body);
    assert.equal(body.team.captainSessionId, sessionId);
    assert.equal(body.team.path, 'debug');
    assert.equal(body.team.pathLabel, '调试');
    assert.equal(body.team.purpose, '测试目标');
    assert.deepEqual(body.team.roleChain, ['debugger', 'executor', 'code-reviewer', 'verifier']);
    assert.equal(body.team.events.length, 1);
    assert.equal(body.team.stats.total, 0);
  });
});

test('无团队：返回 200 与 team=null，空态不是错误', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureRoute({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir, title: 'ws' }],
    }));

    const res = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/state?session=session-unknown'), res);

    assert.equal(res.record.status, 200);
    assert.equal(JSON.parse(res.record.body).team, null);
  });
});

test('缺少 session 参数：400，不去猜任何会话', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureRoute({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir }],
    }));

    const res = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/state'), res);
    assert.equal(res.record.status, 400);
    assert.match(res.record.body, /missing session/);
  });
});

test('未鉴权：闸门拒绝，且处理器正文绝不执行', async () => {
  for (const rejection of [401, 403]) {
    await withWorkspace(async ({ dir, stateRoot }) => {
      const sessionId = 'session-secret';
      await seedTeam(stateRoot, sessionId, dir);

      let bodyExecuted = false;
      const rawServer = {
        register(route) {
          // 包一层探针，确认被拒时业务正文没有被触碰
          const inner = route.handler;
          route.handler = async (req, res) => {
            bodyExecuted = true;
            return inner(req, res);
          };
          return () => {};
        },
      };
      const webServer = authenticatedWebRoutes(rawServer, () => ({ requestRejection: () => rejection }));
      registerStateRoutes({ webServer, config: { stateDir: '.dsh-teams' }, workspaceRegistry: () => ({ list: () => [{ path: dir }] }) });

      // 直接取回被包装后的处理器
      const captured = [];
      const server2 = {
        register(route) {
          captured.push(route);
          return () => {};
        },
      };
      const wrapped = authenticatedWebRoutes(server2, () => ({ requestRejection: () => rejection }));
      registerStateRoutes({ webServer: wrapped, config: { stateDir: '.dsh-teams' }, workspaceRegistry: () => ({ list: () => [{ path: dir }] }) });

      const res = fakeResponse();
      await captured[0].handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), res);

      assert.equal(res.record.status, rejection, `应返回 ${rejection}`);
      assert.match(res.record.body, rejection === 401 ? /unauthorized/ : /forbidden/);
      assert.equal(bodyExecuted, false, '被拒请求不得执行业务正文');
    });
  }
});

test('Connection 缺失：503，不得因为拿不到门就放行', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-secret';
    await seedTeam(stateRoot, sessionId, dir);

    const captured = [];
    const server = {
      register(route) {
        captured.push(route);
        return () => {};
      },
    };
    // 闸门取值为 undefined —— 装配失败
    const wrapped = authenticatedWebRoutes(server, () => undefined);
    registerStateRoutes({
      webServer: wrapped,
      config: { stateDir: '.dsh-teams' },
      workspaceRegistry: () => ({ list: () => [{ path: dir }] }),
    });

    const res = fakeResponse();
    await captured[0].handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), res);

    assert.equal(res.record.status, 503);
    assert.match(res.record.body, /authentication unavailable/);
    // 关键：正文绝不能泄露团队内容
    assert.ok(!res.record.body.includes(sessionId), '503 响应不得包含会话信息');
  });
});

test('非 GET 方法：405', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureRoute({ stateDir: '.dsh-teams' }, () => ({ requestRejection: () => undefined }), () => ({
      list: () => [{ path: dir }],
    }));

    const res = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/state?session=x', 'POST'), res);
    assert.equal(res.record.status, 405);
  });
});

test('工作区注册表不可用时退回进程 cwd，不抛错', async () => {
  await withWorkspace(async () => {
    const route = captureRoute(
      { stateDir: '.dsh-teams' },
      () => ({ requestRejection: () => undefined }),
      () => {
        throw new Error('registry unavailable');
      },
    );

    const res = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/state?session=session-none'), res);
    assert.equal(res.record.status, 200, '注册表不可用不应导致 500');
    assert.equal(JSON.parse(res.record.body).team, null);
  });
});

test('快照：下发审批与排查所需的字段，但不泄露契约内部实现细节', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-fields';
    await seedTeam(stateRoot, sessionId, dir);
    await writeTasks(stateRoot, sessionId, {
      seq: 1,
      tasks: [
        {
          id: 't1',
          subject: '实现',
          role: 'executor',
          kind: 'implementation',
          status: 'running',
          deps: [],
          attempts: [{ attempt: 1 }],
          acceptance: ['应由验收标准决定'],
          // 以下为契约内部字段，不应出现在视图快照里
          verify: ['npm test'],
          inScope: ['src/**'],
        },
        {
          id: 't2',
          subject: '审查',
          role: 'code-reviewer',
          kind: 'review',
          status: 'pending',
          deps: ['t1'],
          attempts: [],
        },
        {
          id: 't3',
          subject: '并行测试',
          role: 'verifier',
          kind: 'verification',
          status: 'pending',
          deps: [],
          attempts: [],
        },
      ],
    });

    const snapshot = await buildSnapshot({ stateRoot, captainSessionId: sessionId, config: { stateDir: '.dsh-teams' } });
    const task = snapshot.tasks[0];
    assert.equal(task.id, 't1');
    assert.equal(task.status, 'running');
    assert.equal(task.attemptCount, 1);
    // 验收标准必须下发：审批闸门要用户看着它决定批不批（真实需求）
    assert.deepEqual(task.acceptance, ['应由验收标准决定'], '视图快照必须带验收标准');
    // 契约内部字段仍然不下发
    assert.equal(task.verify, undefined, '视图快照不应带验证命令');
    assert.equal(task.inScope, undefined, '视图快照不应带改动范围');

    // 派生字段：依赖层级、并行批次、角色预算（面板缩进 / 并行标记 / 预算条都靠它们）
    assert.equal(task.depth, 0, '无依赖的任务层级为 0');
    assert.equal(snapshot.tasks[1].depth, 1, '依赖 t1 的任务层级为 1');
    assert.equal(typeof task.batch, 'number', '应给出并行批次号');
    assert.notEqual(task.batch, snapshot.tasks[1].batch, '依赖不同即不同批次');
    // 墙钟闸门默认关闭 → 没有"预算"可显示（面板就不画进度条，而不是画一条假的）
    assert.equal(task.budgetMs, undefined, '默认不设墙钟上限时不应给出预算');

    // 显式开启后才按角色档位给出预算（executor=heavy）
    const withBudget = await buildSnapshot({
      stateRoot,
      captainSessionId: sessionId,
      config: { stateDir: '.dsh-teams', timeouts: { enabled: true } },
    });
    assert.ok(withBudget.tasks[0].budgetMs >= 60_000, '开启墙钟后应按角色档位给出预算（executor=heavy）');

    assert.equal(snapshot.stats.total, 3);
    assert.equal(snapshot.stats.running, 1);
    // ready 是算出来的，不是状态位：依赖已满足的 pending 任务（复核 #3：以前恒为 0）
    assert.equal(snapshot.stats.ready, 1, `ready 应等于 1，实际 ${JSON.stringify(snapshot.stats)}`);
    assert.equal(snapshot.stats.skipped, undefined, 'skipped 从未有写入者，不应再出现在契约里');
  });
});

test('快照：不得留 undefined 自有属性（否则整份输出会被宿主判为非无损 JSON）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-lossless';
    await seedTeam(stateRoot, sessionId, dir);
    // 刻意造出「可选字段缺失」的现实场景：任务一次都没跑过（没有 attempts），成员空闲（没有 currentTask）
    await mutateTeam(stateRoot, sessionId, (team) => {
      team.members = [{ name: 'executor', role: 'executor', roleName: '开发执行者', emoji: '🔨', status: 'idle' }];
      return team;
    });
    await writeTasks(stateRoot, sessionId, {
      seq: 1,
      tasks: [
        {
          id: 't1',
          subject: '实现',
          role: 'executor',
          roleName: '开发执行者',
          kind: 'implementation',
          status: 'pending',
          deps: [],
          attempts: [],
        },
      ],
    });

    const snapshot = await buildSnapshot({ stateRoot, captainSessionId: sessionId });

    const collect = (value, path, out) => {
      if (value === null || typeof value !== 'object') return out;
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) out.push(`${path}.${key}`);
        else collect(value[key], `${path}.${key}`, out);
      }
      return out;
    };
    const offenders = collect(snapshot, 'team', []);
    assert.deepEqual(offenders, [], `快照里不得有 undefined 属性：${offenders.join(', ')}`);

    // 缺失字段的表现应是「没有这个 key」，而不是「值是 undefined」
    assert.ok(!('startedAt' in snapshot.tasks[0]), '没跑过的任务不应带 startedAt');
    assert.ok(!('failure' in snapshot.tasks[0]), '没失败的任务不应带 failure');
    assert.ok(!('currentTask' in snapshot.members[0]), '空闲成员不应带 currentTask');

    // 无损性：JSON 往返后必须逐字节一致（深比较在宿主里也走这条路径）
    const encoded = JSON.stringify(snapshot);
    assert.equal(JSON.stringify(JSON.parse(encoded)), encoded, '快照必须无损通过 JSON 往返');
  });
});

/* ================================================================== *
 * 停止路由（POST /plugins/dsh-teams/stop）
 *
 * 这是面板唯一的写操作：鉴权必须与读路由同款，且只有"确认"才真的落到 stopRun。
 * ================================================================== */

test('停止路由：POST 调 stopRun 并落 gate 审计事件（有循环 / 没循环都幂等）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-stop';
    await seedTeam(stateRoot, sessionId, dir);

    let running = true;
    const calls = [];
    const route = captureStopRoute(
      { stateDir: '.dsh-teams' },
      () => ({ requestRejection: () => undefined }),
      () => ({ list: () => [{ path: dir }] }),
      (root, session) => {
        calls.push({ root, session });
        return running;
      },
    );

    const ok = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', { session: sessionId }), ok);

    assert.equal(ok.record.status, 200);
    assert.equal(ok.record.headers['cache-control'], 'no-store', '写结果不得被缓存');
    assert.deepEqual(JSON.parse(ok.record.body), { stopped: true, captainSessionId: sessionId });
    assert.equal(calls.length, 1, '应调用一次 stopRun');
    assert.equal(calls[0].root, stateRoot, '应把定位到的状态根传给 stopRun');
    assert.equal(calls[0].session, sessionId, '应把队长会话 id 传给 stopRun');

    let events = await readEvents(stateRoot, 20);
    let audit = events.filter((event) => event.type === 'gate' && event.data?.action === 'stop');
    assert.equal(audit.length, 1, '停止要留审计事件');
    assert.equal(audit[0].team, sessionId);
    assert.equal(audit[0].data.stopped, true);
    assert.equal(audit[0].data.source, 'panel', '要能区分面板停止与工具停止');

    // 循环已经结束：stopped=false 是幂等结果，不是错误；审计照记
    running = false;
    const idle = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', { session: sessionId }), idle);
    assert.equal(idle.record.status, 200);
    assert.deepEqual(JSON.parse(idle.record.body), { stopped: false, captainSessionId: sessionId });

    events = await readEvents(stateRoot, 20);
    audit = events.filter((event) => event.type === 'gate' && event.data?.action === 'stop');
    assert.equal(audit.length, 2);
    assert.equal(audit[1].data.stopped, false);
  });
});

test('停止路由：从未见过这个会话 → 200 stopped=false，且不碰任何循环', async () => {
  await withWorkspace(async ({ dir }) => {
    const calls = [];
    const route = captureStopRoute(
      { stateDir: '.dsh-teams' },
      () => ({ requestRejection: () => undefined }),
      () => ({ list: () => [{ path: dir }] }),
      (...args) => {
        calls.push(args);
        return true;
      },
    );

    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', { session: 'session-nobody' }), res);

    assert.equal(res.record.status, 200);
    assert.deepEqual(JSON.parse(res.record.body), { stopped: false });
    assert.equal(calls.length, 0, '定位不到团队时不得调用 stopRun');
  });
});

test('停止路由：400（坏 JSON / 缺 session）与 405（非 POST）', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureStopRoute(
      { stateDir: '.dsh-teams' },
      () => ({ requestRejection: () => undefined }),
      () => ({ list: () => [{ path: dir }] }),
      () => true,
    );

    const badJson = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', '{not json'), badJson);
    assert.equal(badJson.record.status, 400);
    assert.match(badJson.record.body, /invalid json body/);

    for (const body of [{}, { session: '' }, { session: '   ' }, { session: 42 }]) {
      const missing = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', body), missing);
      assert.equal(missing.record.status, 400, `缺 session 应 400：${JSON.stringify(body)}`);
      assert.match(missing.record.body, /missing session parameter/);
    }

    const get = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/stop', 'GET'), get);
    assert.equal(get.record.status, 405);
  });
});

test('停止路由：鉴权与读路由同款（503/401/403），被拒时绝不执行 stopRun', async () => {
  await withWorkspace(async ({ dir }) => {
    const gates = [
      [() => undefined, 503, /authentication unavailable/],
      [() => ({ requestRejection: () => 401 }), 401, /unauthorized/],
      [() => ({ requestRejection: () => 403 }), 403, /forbidden/],
    ];
    for (const [connection, status, pattern] of gates) {
      const calls = [];
      const route = captureStopRoute(
        { stateDir: '.dsh-teams' },
        connection,
        () => ({ list: () => [{ path: dir }] }),
        (...args) => {
          calls.push(args);
          return true;
        },
      );
      const res = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', { session: 'session-any' }), res);

      assert.equal(res.record.status, status, `应返回 ${status}`);
      assert.match(res.record.body, pattern);
      assert.equal(calls.length, 0, '被拒请求不得执行 stopRun');
    }
  });
});

test('停止路由：不注入实现时走真正的 stopRun（没有循环 → stopped=false，不抛错）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-real-stop';
    await seedTeam(stateRoot, sessionId, dir);

    // 不传 stopRun：验证默认绑定到真正的调度器函数，而不是一个永远返回 undefined 的占位
    const routes = captureRoutes(
      { stateDir: '.dsh-teams' },
      () => ({ requestRejection: () => undefined }),
      () => ({ list: () => [{ path: dir }] }),
    );
    const route = routes.find((item) => item.path === '/plugins/dsh-teams/stop');
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/stop', { session: sessionId }), res);

    assert.equal(res.record.status, 200);
    assert.deepEqual(JSON.parse(res.record.body), { stopped: false, captainSessionId: sessionId });
  });
});

/* ================================================================== *
 * 批准并启动路由（POST /plugins/dsh-teams/approve-start）
 *
 * 用户实测缺陷：`teams_approve` 之后面板仍显示「待审批」——因为批准故意不改 phase，
 * 而面板此前只认 phase。这条路由把批准 + 启动合成一次点击，并且必须把
 * 「批准了」与「启动了」分开回报：宿主没启动能力时不能假装已启动。
 * ================================================================== */

/** 取批准并启动路由。 */
function captureApproveStartRoute(config, connection, workspaceRegistry, startRun) {
  const routes = captureRoutes(config, connection, workspaceRegistry, undefined, startRun);
  const route = routes.find((item) => item.path === '/plugins/dsh-teams/approve-start');
  assert.ok(route, '应注册批准并启动路由');
  return route;
}

const APPROVE_CONFIG = { stateDir: '.dsh-teams' };
const OK_CONNECTION = () => ({ requestRejection: () => undefined });

/** 造一张只有一个待派发任务的图（批准要求任务图非空）。 */
async function seedGraph(stateRoot, sessionId) {
  await writeTasks(stateRoot, sessionId, {
    seq: 1,
    tasks: [{ id: 't1', subject: '实现', role: 'executor', roleName: '开发执行者', status: 'pending', deps: [] }],
  });
}

test('快照：批准后 /state 透出 approvedAt，而 phase 不变（面板只能从这里知道批准成功）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-snapshot-approve';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);
    const registry = () => ({ list: () => [{ path: dir }] });
    const stateRoute = captureRoute(APPROVE_CONFIG, OK_CONNECTION, registry);

    const before = fakeResponse();
    await stateRoute.handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), before);
    const beforeTeam = JSON.parse(before.record.body).team;
    assert.equal(beforeTeam.approvedAt, undefined, '未批准时不下发 approvedAt');

    // 走真实用户路径：面板点一次「批准并启动」
    const approveRoute = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, registry, () => ({ started: true }));
    await approveRoute.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), fakeResponse());

    const after = fakeResponse();
    await stateRoute.handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), after);
    const afterTeam = JSON.parse(after.record.body).team;
    assert.ok(afterTeam.approvedAt, '批准后快照必须带 approvedAt——面板只能靠它显示「已批准 · 待启动」');
    assert.equal(afterTeam.phase, beforeTeam.phase, '批准不改 phase（否则面板会假装在跑、闸门也会失效）');
    assert.equal(afterTeam.runs[0].phase, afterTeam.phase, '运行行 phase 同样不变');
  });
});

test('批准并启动：POST 先批准（写 approvedAt）再调注入的启动实现，两个结果分开回报', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);
    const phaseBefore = (await readTeam(stateRoot, sessionId)).phase;

    const calls = [];
    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), (input) => {
      calls.push(input);
      return { started: true };
    });

    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

    assert.equal(res.record.status, 200);
    assert.equal(res.record.headers['cache-control'], 'no-store', '写结果不得被缓存');
    assert.deepEqual(JSON.parse(res.record.body), { approved: true, started: true, captainSessionId: sessionId });

    // 批准真的落盘了，而且**没有**改 phase（改了会让 teams_run 的闸门失效）
    const team = await readTeam(stateRoot, sessionId);
    assert.ok(team.approvedAt, '批准必须写 approvedAt——面板靠它显示「已批准 · 待启动」');
    assert.equal(team.phase, phaseBefore, '批准完全不改 phase（否则面板会假装在跑，闸门也会失效）');
    assert.ok(team.approvedGraph, '批准要记下任务图指纹');

    assert.equal(calls.length, 1, '应调用一次启动实现');
    assert.equal(calls[0].captainSessionId, sessionId);
    assert.equal(calls[0].workspace, dir, '必须把工作区（而不是状态根）交给启动实现');
    assert.equal(calls[0].stateRoot, stateRoot, '定位到的状态根一并给出');

    const events = await readEvents(stateRoot, 20);
    assert.equal(
      events.filter((event) => event.type === 'gate' && event.data?.action === 'approve').length,
      1,
      '批准要留审计事件（且只留一条，不重复记）',
    );
  });
});

test('批准并启动：宿主没提供启动能力时如实回 started=false，绝不假装已启动', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve-nostart';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);

    // 不传 startRun：模拟旧宿主（index.js 未接线）
    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }));
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

    assert.equal(res.record.status, 200);
    const body = JSON.parse(res.record.body);
    assert.equal(body.approved, true, '批准仍然生效');
    assert.equal(body.started, false, '没有启动能力就必须回 false');
    assert.match(body.reason, /未提供启动能力/, '要给出可显示的原因');
    assert.equal(body.reasonCode, 'host-not-wired', '机器可读原因：面板据此区分"宿主没接线"与"没有活 Agent"');
    // 批准是真实的：面板刷新后应显示「已批准 · 待启动」而不是「运行中」
    assert.ok((await readTeam(stateRoot, sessionId)).approvedAt);
  });
});

test('批准并启动：启动实现回 reasonCode 时原样透传（否则真机失败只能靠猜）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve-reason';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);

    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), () => ({
      started: false,
      reasonCode: 'miss',
      reason: '该会话当前没有活动的 Agent，无法启动调度（请回到会话后重试）',
    }));
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

    assert.equal(res.record.status, 200);
    const body = JSON.parse(res.record.body);
    assert.equal(body.approved, true, '批准已经落盘，要如实回报');
    assert.equal(body.started, false);
    assert.equal(body.reasonCode, 'miss', '启动失败的分支原因必须透传到面板');
    assert.match(body.reason, /没有活动的 Agent/);
  });
});

test('批准并启动：任务图为空 → approved=false 并给出原因，且不调用启动实现', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve-empty';
    await seedTeam(stateRoot, sessionId, dir); // 故意不写任务图

    const calls = [];
    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), (input) => {
      calls.push(input);
      return { started: true };
    });
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

    assert.equal(res.record.status, 200);
    const body = JSON.parse(res.record.body);
    assert.equal(body.approved, false);
    assert.equal(body.started, false);
    assert.match(body.reason, /任务图为空/);
    assert.equal(calls.length, 0, '没批准就绝不启动');
    assert.equal((await readTeam(stateRoot, sessionId)).approvedAt, undefined, '被拒时不得写批准时间');
  });
});

test('批准并启动：定位不到团队 → 200 approved=false，且不启动', async () => {
  await withWorkspace(async ({ dir }) => {
    const calls = [];
    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), (input) => {
      calls.push(input);
      return { started: true };
    });
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: 'session-nobody' }), res);

    assert.equal(res.record.status, 200);
    assert.deepEqual(JSON.parse(res.record.body), { approved: false, started: false, reason: '当前会话还没有团队计划' });
    assert.equal(calls.length, 0);
  });
});

test('批准并启动：400（坏 JSON / 缺 session）与 405（非 POST）', async () => {
  await withWorkspace(async ({ dir }) => {
    const calls = [];
    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), (input) => {
      calls.push(input);
      return { started: true };
    });

    const badJson = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', '{not json'), badJson);
    assert.equal(badJson.record.status, 400);
    assert.match(badJson.record.body, /invalid json body/);

    for (const body of [{}, { session: '' }, { session: '   ' }, { session: 42 }]) {
      const missing = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', body), missing);
      assert.equal(missing.record.status, 400, `缺 session 应 400：${JSON.stringify(body)}`);
      assert.match(missing.record.body, /missing session parameter/);
    }

    const get = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/approve-start', 'GET'), get);
    assert.equal(get.record.status, 405);

    assert.equal(calls.length, 0, '非法请求不得启动任何东西');
  });
});

test('批准并启动：鉴权与读路由同款（503/401/403），被拒时绝不批准也不启动', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve-gate';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);

    const gates = [
      [() => undefined, 503, /authentication unavailable/],
      [() => ({ requestRejection: () => 401 }), 401, /unauthorized/],
      [() => ({ requestRejection: () => 403 }), 403, /forbidden/],
    ];
    for (const [connection, status, pattern] of gates) {
      const calls = [];
      const route = captureApproveStartRoute(APPROVE_CONFIG, connection, () => ({ list: () => [{ path: dir }] }), (input) => {
        calls.push(input);
        return { started: true };
      });
      const res = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

      assert.equal(res.record.status, status, `应返回 ${status}`);
      assert.match(res.record.body, pattern);
      assert.equal(calls.length, 0, '被拒请求不得启动');
    }
    // 三次被拒都没批准：写操作必须挡在业务正文之前
    assert.equal((await readTeam(stateRoot, sessionId)).approvedAt, undefined, '被拒请求不得写批准时间');
  });
});

test('批准并启动：启动实现抛错 → 500 且如实带原因（已批准的事实不被抹掉）', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-approve-throw';
    await seedTeam(stateRoot, sessionId, dir);
    await seedGraph(stateRoot, sessionId);

    const route = captureApproveStartRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }), () => {
      throw new Error('agent offline');
    });
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/approve-start', { session: sessionId }), res);

    assert.equal(res.record.status, 500);
    assert.match(res.record.body, /approve-start failed/);
    assert.match(res.record.body, /agent offline/);
    // reason 必须是**真实原因**：前端只读 reason，常量文案会让面板永远只剩「启动失败」
    const body500 = JSON.parse(res.record.body);
    assert.equal(body500.approved, true, '批准已落盘的事实要带回去');
    assert.equal(body500.started, false);
    assert.equal(body500.reason, 'agent offline', '真实异常要进 reason（面板直接展示）');
    assert.equal(body500.detail, 'agent offline', 'detail 保留，便于排查');
    // 批准先于启动完成，所以它已经落盘——面板刷新后显示「已批准 · 待启动」
    assert.ok((await readTeam(stateRoot, sessionId)).approvedAt);
  });
});

/* ================================================================== *
 * 记录补充要求路由（POST /plugins/dsh-teams/note）
 *
 * 用户需求：「不批准，再商议」写下的修改意见要落地，并在下一次派发时带给子代理。
 * 这条路由只写 team.notes：不批准（不写 approvedAt）、不改 phase、不动在跑的任务。
 * ================================================================== */

/** 取记录补充要求的路由。 */
function captureNoteRoute(config, connection, workspaceRegistry) {
  const routes = captureRoutes(config, connection, workspaceRegistry);
  const route = routes.find((item) => item.path === '/plugins/dsh-teams/note');
  assert.ok(route, '应注册记录补充要求的路由');
  return route;
}

test('note 路由：写入 team.notes、快照回传、且不改批准与阶段', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-note';
    await seedTeam(stateRoot, sessionId, dir);
    const registry = () => ({ list: () => [{ path: dir }] });
    const route = captureNoteRoute(APPROVE_CONFIG, OK_CONNECTION, registry);
    const stateRoute = captureRoute(APPROVE_CONFIG, OK_CONNECTION, registry);

    const res = fakeResponse();
    await route.handler(
      fakeJsonRequest('/plugins/dsh-teams/note', { session: sessionId, text: '  按钮再大一点  ' }),
      res,
    );
    assert.equal(res.record.status, 200);
    const body = JSON.parse(res.record.body);
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
    assert.ok(body.id && body.at);

    const team = await readTeam(stateRoot, sessionId);
    assert.deepEqual(team.notes.map((note) => note.text), ['按钮再大一点'], '原文 trim 后落盘');
    assert.equal(team.approvedAt, undefined, '记录要求不等于批准');

    // 面板要能看见：快照带上 notes（提交后刷新即可显示）
    const stateRes = fakeResponse();
    await stateRoute.handler(fakeRequest(`/plugins/dsh-teams/state?session=${sessionId}`), stateRes);
    const snapshot = JSON.parse(stateRes.record.body).team;
    assert.equal(snapshot.notes.length, 1);
    assert.equal(snapshot.notes[0].text, '按钮再大一点');
    assert.equal(snapshot.phase, team.phase, '不改阶段');

    // 审计：事件流留痕
    const events = await readEvents(stateRoot, 50);
    assert.ok(
      events.some((event) => event.type === 'note' && event.data?.action === 'team-note'),
      '写入要留 event',
    );
  });
});

test('note 路由：空内容 → 200 ok=false + 原因，不落盘', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-note-empty';
    await seedTeam(stateRoot, sessionId, dir);
    const route = captureNoteRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }));

    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/note', { session: sessionId, text: '   ' }), res);
    assert.equal(res.record.status, 200);
    const body = JSON.parse(res.record.body);
    assert.equal(body.ok, false);
    assert.match(body.reason, /不能为空/);
    assert.equal((await readTeam(stateRoot, sessionId)).notes, undefined, '被拒时不得落盘');
  });
});

test('note 路由：定位不到团队 → 200 ok=false（不凭空建团队）', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureNoteRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }));
    const res = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/note', { session: 'session-nobody', text: 'x' }), res);
    assert.equal(res.record.status, 200);
    assert.deepEqual(JSON.parse(res.record.body), { ok: false, reason: '当前会话还没有团队' });
  });
});

test('note 路由：400（坏 JSON / 缺 session）与 405（非 POST）', async () => {
  await withWorkspace(async ({ dir }) => {
    const route = captureNoteRoute(APPROVE_CONFIG, OK_CONNECTION, () => ({ list: () => [{ path: dir }] }));

    const badJson = fakeResponse();
    await route.handler(fakeJsonRequest('/plugins/dsh-teams/note', '{not json'), badJson);
    assert.equal(badJson.record.status, 400);
    assert.match(badJson.record.body, /invalid json body/);

    for (const body of [{}, { session: '' }, { session: '   ' }, { session: 42 }]) {
      const missing = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/note', body), missing);
      assert.equal(missing.record.status, 400, `缺 session 应 400：${JSON.stringify(body)}`);
      assert.match(missing.record.body, /missing session parameter/);
    }

    const get = fakeResponse();
    await route.handler(fakeRequest('/plugins/dsh-teams/note', 'GET'), get);
    assert.equal(get.record.status, 405);
  });
});

test('note 路由：鉴权与读路由同款（503/401/403），被拒时绝不写盘', async () => {
  await withWorkspace(async ({ dir, stateRoot }) => {
    const sessionId = 'session-note-gate';
    await seedTeam(stateRoot, sessionId, dir);

    const gates = [
      [() => undefined, 503, /authentication unavailable/],
      [() => ({ requestRejection: () => 401 }), 401, /unauthorized/],
      [() => ({ requestRejection: () => 403 }), 403, /forbidden/],
    ];
    for (const [connection, status, pattern] of gates) {
      const route = captureNoteRoute(APPROVE_CONFIG, connection, () => ({ list: () => [{ path: dir }] }));
      const res = fakeResponse();
      await route.handler(fakeJsonRequest('/plugins/dsh-teams/note', { session: sessionId, text: '被拒的请求' }), res);
      assert.equal(res.record.status, status, `应返回 ${status}`);
      assert.match(res.record.body, pattern);
    }
    assert.equal((await readTeam(stateRoot, sessionId)).notes, undefined, '被拒请求不得写盘');
  });
});
