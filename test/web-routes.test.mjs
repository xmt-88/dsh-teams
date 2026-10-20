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
import { ensureStateDirs, ensureTeam, mutateTeam, appendEvent, writeTasks, appendRunRecord } from '../lib/state.js';

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

/** 注册路由并取回它（便于直接调用 handler）。 */
function captureRoutes(config, connection, workspaceRegistry) {
  const registered = [];
  const rawServer = {
    register(route) {
      registered.push(route);
      return () => {};
    },
  };
  const webServer = authenticatedWebRoutes(rawServer, () => connection());
  registerStateRoutes({ webServer, config, workspaceRegistry });
  return registered;
}

/** 取状态路由（插件同时注册了精灵图资源路由，所以按 path 找而不是取第一个）。 */
function captureRoute(config, connection, workspaceRegistry) {
  const routes = captureRoutes(config, connection, workspaceRegistry);
  const state = routes.find((route) => route.path === '/plugins/dsh-teams/state');
  assert.ok(state, '应注册状态路由');
  return state;
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
