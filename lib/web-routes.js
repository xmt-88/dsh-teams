/**
 * DSH Teams — Web 路由
 *
 * 团队视图的宿主持久化契约：客户端 `fetch` 读、宿主负责鉴权与组装。
 *
 * 安全要点（遵循 Harness 实践）：
 *   原始 WebServer 路由**不继承** Connection 的鉴权围栏，因此每条路由都必须自己过门。
 *   Connection 缺失 = 装配失败，返回 503，绝不因为"拿不到门"就把工作区状态暴露出去。
 *
 * 路由表：
 *   GET  /plugins/dsh-teams/state?session=<sessionId>   团队快照（含成员、任务、最近事件）
 *   GET  /plugins/dsh-teams/roles?session=<sessionId>   角色库（内置 + 自定义，含启停状态）
 *   POST /plugins/dsh-teams/roles                       角色写操作（启停 / 删除 / 保存）
 *   POST /plugins/dsh-teams/stop                        停止当前团队的调度循环（面板唯一的团队写操作）
 *   POST /plugins/dsh-teams/note                        记录用户中途补充的要求（之后每次派发都进任务卡）
 */

import { readFile, rm } from 'node:fs/promises';

import { stateRootOf, readTeam, readTasks, readEvents, listTeamIds, readRunRecords, userRolesDir, appendEvent, appendTeamNote } from './state.js';
import { resolveStateDir, resolveTimeouts } from './config.js';
import { loadRoles, validateCustomRole } from './roles.js';
import { CORE_ROLES, readDisabledRoles, setRoleEnabled, validateToggle } from './role-state.js';
import { ensureStateDirs, writeFileAtomic } from './state.js';
import { join } from 'node:path';
import { resolveTimeoutMs } from './runner.js';
import { route as routeDecision } from './router.js';
import { summarize } from './tasks.js';
import { stopRun, approveTeam } from './scheduler.js';

/** 快照里回传的事件条数上限。 */
const EVENT_TAIL = 80;

/**
 * 把一个原始 WebServer 包装成带鉴权的路由注册器。
 * @param {{register:Function}} server - ctx.webServer
 * @param {() => object|undefined} connection - 惰性取 ctx.connection
 */
export function authenticatedWebRoutes(server, connection) {
  return {
    register(route) {
      return server.register({
        ...route,
        async handler(req, res) {
          const gate = connection();
          const rejection = gate === undefined ? 503 : gate.requestRejection(req);
          if (rejection !== undefined) {
            res.writeHead(rejection, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
              }),
            );
            return;
          }
          await route.handler(req, res);
        },
      });
    },
  };
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 定位候选状态根。
 *
 * 快照路由是 HTTP 请求，没有工具执行上下文，拿不到队长会话的 cwd。
 * 已注册工作区是可靠来源（`ctx.workspaceRegistry.list()`），因此按工作区逐个找该会话的团队记录；
 * 找不到任何工作区时退回进程工作目录，让状态根仍有可能命中。
 *
 * @param {object|undefined} workspaceRegistry
 * @param {string} stateDir
 * @returns {string[]} 候选状态根（去重后）
 */
function candidateStateRoots(workspaceRegistry, stateDir) {
  return candidateWorkspaceRoots(workspaceRegistry, stateDir).map((pair) => pair.stateRoot);
}

/**
 * 候选「工作区 → 状态根」对。
 *
 * 定位团队只需要状态根，但 `approveTeam` 要的是 **workspace**（它自己再拼一次状态根），
 * 所以在建候选时就把两边的对应关系留住，避免从状态根字符串反推工作区。
 * 配了绝对 stateDir 时所有工作区共用一个状态根，此时任取一个都是等价解。
 * @returns {{stateRoot:string, workspace:string}[]}
 */
function candidateWorkspaceRoots(workspaceRegistry, stateDir) {
  const pairs = new Map();
  try {
    const workspaces = workspaceRegistry?.list?.() ?? [];
    for (const workspace of workspaces) {
      const path = workspace?.path;
      if (typeof path !== 'string' || path === '') continue;
      pairs.set(stateRootOf(path, stateDir), path);
    }
  } catch {
    /* 注册表不可用时退回 cwd */
  }
  const cwdRoot = stateRootOf(process.cwd(), stateDir);
  if (!pairs.has(cwdRoot)) pairs.set(cwdRoot, process.cwd());
  return [...pairs].map(([stateRoot, workspace]) => ({ stateRoot, workspace }));
}

/**
 * 在候选状态根中找出该会话的团队记录所在的状态根。
 * @returns {Promise<string|undefined>}
 */
async function locateStateRoot(candidateRoots, captainSessionId) {
  for (const root of candidateRoots) {
    const team = await readTeam(root, captainSessionId);
    if (team !== undefined) return root;
  }
  return undefined;
}

/**
 * 找出「这个会话属于哪支团队」——包含**它是不是某个成员的子会话**。
 *
 * 真实缺陷：用户从成员卡片点进子代理后，团队面板变成空白，必须返回主会话才能看到。
 * 根因就是这里只按队长会话 id 找：子会话自己没有团队，于是返回 null。
 *
 * 反查不依赖任何宿主 API——用的是我们自己的任务证据（每条 evidence 都记着 childId）。
 *
 * @param {string[]} candidateRoots - 候选状态根
 * @param {string} sessionId - 当前正在查看的会话（可能是队长，也可能是成员子会话）
 * @returns {Promise<{stateRoot: string, captainSessionId: string, viewingAsChild: boolean}|undefined>}
 */
async function locateTeam(candidateRoots, sessionId) {
  for (const root of candidateRoots) {
    const team = await readTeam(root, sessionId);
    if (team !== undefined) return { stateRoot: root, captainSessionId: sessionId, viewingAsChild: false };
  }
  for (const root of candidateRoots) {
    const captain = await findCaptainOwningChild(root, sessionId);
    if (captain !== undefined) return { stateRoot: root, captainSessionId: captain, viewingAsChild: true };
  }
  return undefined;
}

/** 扫这个状态根下的团队，找出哪个团队跑过这个子会话。 */
async function findCaptainOwningChild(stateRoot, childSessionId) {
  if (typeof childSessionId !== 'string' || childSessionId === '') return undefined;
  for (const captainSessionId of await listTeamIds(stateRoot)) {
    const graph = await readTasks(stateRoot, captainSessionId);
    const hit = (graph.tasks ?? []).some((task) =>
      (task.evidence ?? []).some((entry) => entry?.childId === childSessionId),
    );
    if (hit) return captainSessionId;
  }
  return undefined;
}

/** 任务最近一次运行的子会话 id（成员卡片点进去看的就是它）。 */
function lastChildId(task) {
  const list = Array.isArray(task?.evidence) ? task.evidence : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const childId = list[index]?.childId;
    if (typeof childId === 'string' && childId !== '') return childId;
  }
  return undefined;
}

/**
 * 组装团队快照：把团队记录、任务图、事件流合成一个供 UI 直接渲染的对象。
 *
 * 刻意在宿主侧组装：客户端不做折叠、不做 join，只渲染。
 * @param {object} input
 * @returns {Promise<object|null>} 无团队时返回 null
 */
export async function buildSnapshot({ stateRoot, captainSessionId, config, viewingAsChild = false }) {
  const team = await readTeam(stateRoot, captainSessionId);
  if (team === undefined) return null;

  const graph = await readTasks(stateRoot, captainSessionId);
  const events = await readEvents(stateRoot, EVENT_TAIL);
  const decision = team.decision ?? {};

  const members = Array.isArray(team.members) ? team.members : [];
  const layout = deriveLayout(graph.tasks);
  const budgets = config === undefined ? new Map() : await budgetByRole(stateRoot, config);

  // 角色 → 它最近一次跑出来的子会话 id：成员卡片点进去看的就是它
  const childByRole = new Map();
  for (const task of graph.tasks) {
    const childId = lastChildId(task);
    if (childId !== undefined && !childByRole.has(task.role)) childByRole.set(task.role, childId);
  }

  // 运行历史：当前轮（活的任务图）+ 归档的历史轮次，最新在前。
  // 面板按"用户每次的任务"折叠展示，所以每轮都要有：目标、路径、阶段、每步的角色身份与用量。
  const archived = await readRunRecords(stateRoot, captainSessionId);
  const currentRun = {
    runId: `${captainSessionId}#current`,
    // 本轮计划指纹：runId 在同一会话里恒定，面板要按它判断"这是新的一轮计划"，
    // 从而重置上一轮的审批乐观态（否则第二轮审批区永远不渲染）。
    planId: decision.decidedAt,
    current: true,
    at: team.approvedAt ?? decision.decidedAt,
    subject: typeof decision.task === 'string' && decision.task !== '' ? decision.task : team.purpose,
    path: decision.path,
    pathLabel: decision.label,
    phase: team.phase,
    finishedAt: team.finishedAt,
    steps: graph.tasks.map((task) => ({
      id: task.id,
      role: task.role,
      roleName: task.roleName,
      emoji: task.emoji,
      status: task.status,
      deps: Array.isArray(task.deps) ? task.deps : [],
      durationMs: (Array.isArray(task.evidence) ? task.evidence[task.evidence.length - 1] : undefined)?.durationMs,
      childId: lastChildId(task),
      // 这一轮用的模型（派发时写进任务记录；老记录没有就留空，面板显示"—"）
      model: typeof task.model === 'string' ? task.model : undefined,
      watch: (Array.isArray(task.evidence) ? task.evidence[task.evidence.length - 1] : undefined)?.watch,
      metrics: task.metrics,
      failure: typeof task.failure === 'string' ? task.failure : undefined,
      // 待队长决策：返工预算耗尽的评审门（blocked + needsDecision），面板要区别于普通失败
      needsDecision: task.needsDecision,
      findings: compactFindings(task.findings),
    // 过期结果丢弃次数：面板上能看出"这一步被驳回后重跑过"
    discarded: task.discarded,
    })),
  };
  const runs = [currentRun, ...[...archived].reverse()].map(compactRun);

  // 顶层同样过一遍 withoutUndefined：未批准/未跑完时 approvedAt、finishedAt、
  // decidedAt 都可能是 undefined，而一个 undefined 就足以让整份输出被宿主拒收。
  return withoutUndefined({
    schemaVersion: 1,
    captainSessionId,
    // 当前看的会话是某个成员的子会话（团队视图来自队长会话）——面板据此显示返回入口
    viewingAsChild: viewingAsChild === true ? true : undefined,
    workspace: team.workspace ?? '',
    purpose: team.purpose ?? '',
    phase: team.phase ?? 'idle',
    path: decision.path,
    pathLabel: decision.label,
    score: decision.score,
    total: decision.total,
    roleChain: Array.isArray(decision.roleChain) ? decision.roleChain : [],
    needsUiDesign: decision.needsUiDesign === true,
    escalated: decision.escalated === true,
    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    decidedAt: decision.decidedAt,
    approvedAt: team.approvedAt,
    finishedAt: team.finishedAt,
    runs,
    tasks: graph.tasks.map((task) =>
      compactTask(task, {
        depth: layout.depth.get(task.id),
        batch: layout.batch.get(task.id),
        budgetMs: budgets.get(task.role),
        childId: lastChildId(task),
      }),
    ),
    members: members.map((member) => compactMember(member, { sessionId: childByRole.get(member.role) })),
    // 用户中途补充的要求：面板要能看见「已经记下了什么」（派发不消费，之后每次派发都会进任务卡）
    notes: (Array.isArray(team.notes) ? team.notes : []).map((note) =>
      withoutUndefined({
        id: typeof note?.id === 'string' ? note.id : undefined,
        text: typeof note?.text === 'string' ? note.text : '',
        at: typeof note?.at === 'string' ? note.at : undefined,
      }),
    ),
    events: events.filter((event) => event.team === null || event.team === captainSessionId),
    stats: summarize(graph.tasks),
  });
}

/**
 * 依赖层级与并行批次：面板要按依赖缩进，并标出「这几步可以同时跑」。
 *
 * 并行批次的口径与 `teams_plan` 的 `parallel_hint` 一致：**依赖集合相同**即同一批。
 * @param {object[]} tasks
 * @returns {{depth: Map<string, number>, batch: Map<string, number>}}
 */
function deriveLayout(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map();
  const depthOf = (task, seen) => {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    if (seen.has(task.id)) return 0; // 环：按 0 处理，别把快照拖死
    seen.add(task.id);
    const deps = (task.deps ?? []).map((id) => byId.get(id)).filter((dep) => dep !== undefined);
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep, seen))) + 1;
    depth.set(task.id, value);
    return value;
  };
  for (const task of tasks) depthOf(task, new Set());

  const batch = new Map();
  const groups = new Map();
  for (const task of tasks) {
    const key = [...(task.deps ?? [])].sort().join(',') || '(无依赖)';
    if (!groups.has(key)) groups.set(key, groups.size + 1);
    batch.set(task.id, groups.get(key));
  }
  return { depth, batch };
}

/**
 * 角色 slug → 该角色档位的超时预算（毫秒）。
 *
 * 面板要显示「已用 / 预算」——实测里 executor 用掉 22.8 分钟、预算 45 分钟，
 * 这个比值是判断"要不要调档"的唯一依据。角色文件读取带 60 秒缓存：
 * 快照路由是秒级轮询的，不能每次都去读 16 个角色文件。
 */
const budgetCache = new Map();
const BUDGET_TTL_MS = 60_000;

/**
 * 缓存键必须带上影响预算的配置——只按 stateRoot 缓存会串味：
 * 先以"墙钟关闭"渲染一次，之后即使把 `timeouts.enabled` 打开，60 秒内拿到的还是旧映射
 * （实测踩过：测试里刚开启就断言预算，拿到的是缓存的 undefined）。
 *
 * ⚠️ 键里必须放**解包后的值**：配置叶子是 volatile 引用，直接 `JSON.stringify` 只会得到
 * `{}`，于是"开了墙钟"和"没开"会算成同一个键——缓存串味的老毛病原样复发。
 */
function budgetCacheKey(stateRoot, config) {
  const timeouts = resolveTimeouts(config);
  return `${stateRoot}|${timeouts.enabled ? 'on' : 'off'}|${JSON.stringify(timeouts)}`;
}

async function budgetByRole(stateRoot, config) {
  const key = budgetCacheKey(stateRoot, config);
  const cached = budgetCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < BUDGET_TTL_MS) return cached.map;
  const map = new Map();
  try {
    const library = await loadRoles(userRolesDir(stateRoot));
    for (const role of library.roles) {
      // 墙钟关闭时 resolveTimeoutMs 返回 undefined：面板据此不画进度条（而不是画一条假的）
      const budget = resolveTimeoutMs(config, role);
      if (budget !== undefined) map.set(role.slug, budget);
    }
  } catch {
    /* 角色读不到就不显示预算，不影响快照本身 */
  }
  budgetCache.set(key, { at: Date.now(), map });
  return map;
}

/**
 * 丢弃值为 undefined 的字段。
 *
 * 这不是洁癖：宿主对工具输出做「无损 JSON」校验，只要有**一个** undefined 自有属性，
 * 整份输出就会被拒（JSON.stringify 会静默丢掉它，属于有损转换）。HTTP 路由今天靠
 * JSON.stringify 侥幸无事，但只要这个对象哪天被当作工具输出返回，就会当场炸——
 * teams_plan 的 `reason: result.reason` 就是这么炸的。
 * @param {object} value
 * @returns {object}
 */
function withoutUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/** 用量统计 → 视图对象（缺字段就不下发，避免面板显示 undefined）。 */
function compactMetrics(metrics) {
  if (metrics === null || typeof metrics !== 'object') return undefined;
  return withoutUndefined({
    steps: typeof metrics.steps === 'number' ? metrics.steps : undefined,
    inputTokens: typeof metrics.inputTokens === 'number' ? metrics.inputTokens : undefined,
    cacheReadTokens: typeof metrics.cacheReadTokens === 'number' ? metrics.cacheReadTokens : undefined,
    outputTokens: typeof metrics.outputTokens === 'number' ? metrics.outputTokens : undefined,
  });
}

/**
 * 待队长决策标记 → 视图对象。
 *
 * 返工预算耗尽时评审门会被记成 blocked + needsDecision；面板要靠它显示
 * 「需队长决策」与 findings，而不是把这一轮显示成普通失败。
 */
function compactNeedsDecision(marker) {
  if (marker === null || typeof marker !== 'object') return undefined;
  return withoutUndefined({
    kind: typeof marker.kind === 'string' ? marker.kind : undefined,
    round: typeof marker.round === 'number' ? marker.round : undefined,
    maxRounds: typeof marker.maxRounds === 'number' ? marker.maxRounds : undefined,
    gate: typeof marker.gate === 'string' ? marker.gate : undefined,
    findings: Array.isArray(marker.findings) ? marker.findings.map((item) => String(item)) : undefined,
  });
}

/** findings 数组 → 视图数组（空数组不下发）。 */
function compactFindings(findings) {
  return Array.isArray(findings) && findings.length > 0 ? findings.map((item) => String(item)) : undefined;
}

/** 一轮运行 → 视图对象（面板按"每次任务"折叠展示的那一项）。 */
function compactRun(run) {
  return withoutUndefined({
    runId: run.runId,
    planId: run.planId,
    current: run.current === true ? true : undefined,
    at: run.at,
    subject: typeof run.subject === 'string' && run.subject !== '' ? run.subject : undefined,
    path: run.path,
    pathLabel: run.pathLabel,
    phase: run.phase,
    finishedAt: run.finishedAt,
    steps: (Array.isArray(run.steps) ? run.steps : []).map((step) =>
      withoutUndefined({
        id: step.id,
        role: step.role,
        roleName: step.roleName,
        emoji: step.emoji,
        status: step.status,
        deps: Array.isArray(step.deps) ? step.deps : [],
        durationMs: step.durationMs,
        childId: step.childId,
        model: typeof step.model === 'string' ? step.model : undefined,
        watch: step.watch === undefined ? undefined : compactWatch([{ watch: step.watch }]),
        metrics: compactMetrics(step.metrics),
        failure: typeof step.failure === 'string' ? step.failure : undefined,
        needsDecision: compactNeedsDecision(step.needsDecision),
        findings: compactFindings(step.findings),
      }),
    ),
  });
}

/**
 * 从任务证据里取最近一次运行的看门狗摘要。
 *
 * 这是本插件特有的可观测性：面板上要能直接看出"这一步是正常跑完的、被回收救回来的，
 * 还是被取消的"——排查时这三个词的区别就是几十分钟。
 */
function compactWatch(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  const last = [...list].reverse().find((entry) => entry?.watch !== undefined);
  if (last === undefined) return undefined;
  return withoutUndefined({
    verdict: last.watch.verdict,
    harvested: last.watch.harvested === true ? true : undefined,
    cancelVia: last.watch.cancelVia,
    hadLocalAgent: last.watch.hadLocalAgent === true ? true : undefined,
    lastSeq: typeof last.watch.lastSeq === 'number' ? last.watch.lastSeq : undefined,
  });
}

/**
 * 任务 → 视图对象。
 *
 * 刻意**不下发**契约内部字段（verify / inScope / 完整 evidence），
 * 但下发做展示与**审批判断**所必需的：状态、依赖、尝试次数、耗时、失败原因、
 * 验收标准（用户要在批准任务图之前看清"这一步会被怎么验收"）、
 * 看门狗摘要（回收/取消/正常），以及截断后的产出预览。
 *
 * @param {object} task - 任务记录
 * @param {object} [extra] - 快照侧算出来的派生字段（批次、预算）
 */
function compactTask(task, extra = {}) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const lastAttempt = attempts[attempts.length - 1];
  return withoutUndefined({
    id: task.id,
    subject: task.subject,
    role: task.role,
    roleName: task.roleName,
    emoji: task.emoji,
    kind: task.kind,
    status: task.status,
    deps: Array.isArray(task.deps) ? task.deps : [],
    assignee: task.assignee,
    attemptCount: attempts.length,
    startedAt: attempts[0]?.startedAt,
    finishedAt: lastAttempt?.finishedAt,
    durationMs: lastAttempt?.durationMs,
    failure: typeof task.failure === 'string' ? task.failure : undefined,
    // 待队长决策（返工预算耗尽）与 findings：面板要显示「需队长决策」并列出评审发现了什么
    needsDecision: compactNeedsDecision(task.needsDecision),
    findings: compactFindings(task.findings),
    // 验收标准：审批闸门要用户看着它决定批不批，所以它必须出现在面板上
    acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
    // 派生：依赖层级（缩进用）、并行批次号（同批次可并行）、角色档位预算
    depth: extra.depth,
    batch: extra.batch,
    budgetMs: extra.budgetMs,
    // 这一步跑出来的子会话 id：面板上点任务卡就能进去看它自己的对话
    childId: extra.childId,
    // 用量：步数 / 输入 token / 缓存命中 / 输出 token（卡片上直接显示）
    metrics: compactMetrics(task.metrics),
    watch: compactWatch(task.evidence),
    // 产出预览：面板要能看出这一步交付了什么；完整产出留在磁盘上
    outputPreview: typeof task.output === 'string' ? preview(task.output, 600) : undefined,
    updatedAt: task.updatedAt,
  });
}

/** 成员 → 视图对象。 */
function compactMember(member, extra = {}) {
  return withoutUndefined({
    name: member.name,
    role: member.role,
    roleName: member.roleName,
    emoji: member.emoji,
    status: member.status ?? 'idle',
    currentTask: member.currentTask,
    startedAt: member.startedAt,
    finishedAt: member.finishedAt,
    // 该成员最近一次运行所在的子会话：点成员卡片直接进它的对话
    sessionId: extra.sessionId,
  });
}

/** 取文本前 N 字作为预览，保留原始长度供 UI 提示。 */
function preview(text, limit) {
  const value = String(text ?? '');
  return { text: value.length <= limit ? value : `${value.slice(0, limit)}…`, truncated: value.length > limit, total: value.length };
}

/**
 * 注册团队状态路由。
 * @param {object} input
 * @param {object} input.webServer - 已包装的鉴权路由注册器（或原始 ctx.webServer）
 * @param {object} input.config   - 已解析的插件配置
 * @param {() => object|undefined} [input.workspaceRegistry] - 惰性取 ctx.workspaceRegistry
 * @param {Function} [input.stopRun] - 停止实现（默认真正的 stopRun；测试注入替身，不启动真循环）
 * @param {Function} [input.startRun] - 启动实现。启动必须持活的队长 Agent（runLoop → startActivation），
 *   而路由层拿不到 ctx/agent，所以由宿主注入；缺省时批准照做但如实返回 started:false
 * @returns {() => void} disposer
 */
export function registerStateRoutes({
  webServer,
  config,
  workspaceRegistry,
  stopRun: stopTeamRun = stopRun,
  startRun: startTeamRun,
}) {
  const routes = [];
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/asset',
      async handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        // 角色形象资源（Q 版鲸鱼娘）。客户端插件不能读文件，所以由宿主按白名单发出去。
        //   girl-vector.svg —— 描摹出来的矢量（裙子两层是 CSS 变量，一个文件服务所有角色）
        //   girl-*.png      —— 旧的位图精灵图（保留兼容；新代码只用 SVG）
        const url = new URL(req.url ?? '/', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        // 白名单：只允许 assets/ 下的 girl-*.svg|png，杜绝路径穿越
        if (!/^girl-[a-z-]+\.(svg|png)$/.test(name)) {
          sendJson(res, 400, { error: 'bad asset name' });
          return;
        }
        try {
          const body = await readFile(new URL(`../assets/${name}`, import.meta.url));
          res.writeHead(200, {
            'content-type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
            // 资源随插件版本变，长缓存即可
            'cache-control': 'public, max-age=86400',
          });
          res.end(body);
        } catch {
          sendJson(res, 404, { error: 'asset not found' });
        }
      },
    }),
  );
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/state',
      async handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        const url = new URL(req.url ?? '/', 'http://localhost');
        const captainSessionId = url.searchParams.get('session');
        if (typeof captainSessionId !== 'string' || captainSessionId === '') {
          sendJson(res, 400, { error: 'missing session parameter' });
          return;
        }

        let registry;
        try {
          registry = typeof workspaceRegistry === 'function' ? workspaceRegistry() : workspaceRegistry;
        } catch {
          registry = undefined;
        }

        const roots = candidateStateRoots(registry, resolveStateDir(config));
        try {
          const located = await locateTeam(roots, captainSessionId);
          if (located === undefined) {
            // 会话还没有团队，不是错误：UI 显示空态而不是报错
            sendJson(res, 200, { team: null });
          return;
        }
        const team = await buildSnapshot({
          stateRoot: located.stateRoot,
          captainSessionId: located.captainSessionId,
          config,
          viewingAsChild: located.viewingAsChild,
        });
        sendJson(res, 200, { team });
      } catch (error) {
        sendJson(res, 500, { error: 'snapshot failed', detail: String(error?.message ?? error) });
      }
    },
    }),
  );

  /* ---------------- 停止当前团队（面板唯一的团队写操作） ---------------- */
  //
  // 面板此前只读，停止只能走 `teams_stop` 工具。这条路由补上"在运行行上点停止"的入口：
  //   · 鉴权/装配失败（503/401/403）由包装器统一挡在业务正文之前，与既有路由同款
  //   · 400/405 在这里判；定位不到团队按幂等语义回 stopped=false，不当成错误
  //   · 语义与 `teams_stop` 完全一致：调用同一个 stopRun，不碰调度循环与闸门逻辑
  //   · 已派发任务的产出照常落盘；没有循环在跑时返回 stopped=false
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/stop',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const sessionId = typeof body?.session === 'string' ? body.session.trim() : '';
        if (sessionId === '') {
          sendJson(res, 400, { error: 'missing session parameter' });
          return;
        }

        const roots = candidateStateRoots(safeRegistry(workspaceRegistry), resolveStateDir(config));
        try {
          // 与状态快照同一条定位规则：从成员子会话也能停它所属的团队
          const located = await locateTeam(roots, sessionId);
          if (located === undefined) {
            sendJson(res, 200, { stopped: false });
            return;
          }
          const stopped = stopTeamRun(located.stateRoot, located.captainSessionId);
          // 审计：与 teams_stop 工具同款 gate 事件；写事件失败不得把已完成的停止变成 500
          await appendEvent({
            stateRoot: located.stateRoot,
            type: 'gate',
            team: located.captainSessionId,
            data: { action: 'stop', stopped, source: 'panel' },
          }).catch(() => {});
          sendJson(res, 200, { stopped, captainSessionId: located.captainSessionId });
        } catch (error) {
          sendJson(res, 500, { error: 'stop failed', detail: String(error?.message ?? error) });
        }
      },
    }),
  );

  /* ---------------- 批准并启动（面板的第二个写操作） ---------------- */
  //
  // 用户实测的痛点：`teams_approve` 批准后没有任何反馈，面板还显示「待审批」——
  // 因为批准**故意不改 phase**（改了会让 run 的闸门放行），而面板此前只认 phase。
  // 这条路由把"批准"和"启动"合成一次点击：
  //   · 批准纯记录（approvedAt + 图指纹），不需要活的 Agent → 路由自己调 approveTeam
  //   · 启动必须持活的队长 Agent（runLoop → startActivation({ parent })），路由拿不到
  //     ctx/agent，因此经注入委托给宿主，与 stopRun 同构
  //   · 鉴权/装配失败（503/401/403）由包装器统一挡在业务正文之前，与既有路由同款
  //   · 宿主没提供启动能力时：照常批准，但如实回 started:false + reason，绝不假装已启动
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/approve-start',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const sessionId = typeof body?.session === 'string' ? body.session.trim() : '';
        if (sessionId === '') {
          sendJson(res, 400, { error: 'missing session parameter' });
          return;
        }

        const pairs = candidateWorkspaceRoots(safeRegistry(workspaceRegistry), resolveStateDir(config));
        try {
          // 与状态快照同一条定位规则：从成员子会话也能批准它所属的团队
          const located = await locateTeam(
            pairs.map((pair) => pair.stateRoot),
            sessionId,
          );
          if (located === undefined) {
            sendJson(res, 200, { approved: false, started: false, reason: '当前会话还没有团队计划' });
            return;
          }
          // approveTeam 要 workspace 自己再拼状态根，所以按状态根反查回工作区
          const workspace = pairs.find((pair) => pair.stateRoot === located.stateRoot)?.workspace ?? process.cwd();
          const approval = await approveTeam({ config, captainSessionId: located.captainSessionId, workspace });
          if (approval?.approved !== true) {
            sendJson(res, 200, {
              approved: false,
              started: false,
              reason: approval?.reason ?? '批准失败',
              captainSessionId: located.captainSessionId,
            });
            return;
          }

          let started = false;
          let reason;
          if (typeof startTeamRun === 'function') {
            const result = await startTeamRun({
              captainSessionId: located.captainSessionId,
              workspace,
              stateRoot: located.stateRoot,
            });
            started = result?.started === true;
            reason = typeof result?.reason === 'string' ? result.reason : undefined;
          } else {
            reason = '宿主未提供启动能力（插件版本过旧），已批准但未启动';
          }
          sendJson(
            res,
            200,
            withoutUndefined({
              approved: true,
              started,
              reason,
              captainSessionId: located.captainSessionId,
            }),
          );
        } catch (error) {
          // ⚠️ 走到这里时批准**可能已经落盘**（approveTeam 成功、startTeamRun 抛错）。
          // 以前一律回 500 + 裸错误，前端只能显示「批准失败，请重试」——与磁盘事实矛盾，
          // 而且用户重试会重复写 approvedAt。所以带上磁盘真相：approved 字段由重新读盘决定。
          let approvedOnDisk = false;
          try {
            const again = await locateTeam(
              candidateWorkspaceRoots(safeRegistry(workspaceRegistry), resolveStateDir(config))
                .map((pair) => pair.stateRoot),
              sessionId,
            );
            if (again !== undefined) {
              const team = await readTeam(again.stateRoot, again.captainSessionId);
              approvedOnDisk = typeof team?.approvedAt === 'string' && team.approvedAt !== '';
            }
          } catch {
            /* 读盘失败就按"未知"处理，不冒充成功 */
          }
          // reason 只放**原因本身**：批准是否已落盘由 approved 字段表达，面板按事实拼文案。
          // 以前这里是常量、真实异常只在 detail 里，而前端只读 reason —— 面板永远只剩「启动失败」。
          const message = error instanceof Error ? error.message : String(error ?? '');
          const detail = message.trim();
          sendJson(res, 500, {
            error: 'approve-start failed',
            approved: approvedOnDisk,
            started: false,
            reason: detail === '' ? undefined : detail,
            detail,
          });
        }
      },
    }),
  );

  /* ---------------- 记录一条「用户中途补充的要求」（面板的第三个写操作） ---------------- */
  //
  // 用户实测需求：「不批准，再商议」写下的修改意见要有地方落地，并且下一次派发能带给子代理。
  //   · 写入 `team.notes[]`：`dispatchOne` 派发时读的就是 team，天然带得走
  //   · 只写 team.json，不碰 approvedAt / 闸门 / 现有任务状态（完成或在跑的任务不受影响）
  //   · 鉴权/装配失败（503/401/403）由包装器统一挡在业务正文之前，与既有路由同款
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/note',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const sessionId = typeof body?.session === 'string' ? body.session.trim() : '';
        if (sessionId === '') {
          sendJson(res, 400, { error: 'missing session parameter' });
          return;
        }
        const text = typeof body?.text === 'string' ? body.text : '';
        const roots = candidateStateRoots(safeRegistry(workspaceRegistry), resolveStateDir(config));
        try {
          // 与状态快照同一条定位规则：从成员子会话也能给它所属的团队记录要求
          const located = await locateTeam(roots, sessionId);
          if (located === undefined) {
            sendJson(res, 200, { ok: false, reason: '当前会话还没有团队' });
            return;
          }
          const result = await appendTeamNote(located.stateRoot, located.captainSessionId, { text, sessionId });
          if (result.ok !== true) {
            // 内容问题（空 / 超长）是 400 语义：重试同一个请求不会变好
            sendJson(res, 200, { ok: false, reason: result.reason });
            return;
          }
          // 审计：与工具同款事件；写事件失败不得把已经落盘的要求变成 500
          await appendEvent({
            stateRoot: located.stateRoot,
            type: 'note',
            team: located.captainSessionId,
            data: { action: 'team-note', count: result.count, noteId: result.id, source: 'panel' },
          }).catch(() => {});
          sendJson(res, 200, { ok: true, count: result.count, id: result.id, at: result.at });
        } catch (error) {
          sendJson(res, 500, { error: 'note failed', detail: String(error?.message ?? error) });
        }
      },
    }),
  );

  /* ---------------- 角色契约正文（查看/复制用） ---------------- */
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/roles/body',
      async handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const slug = String(url.searchParams.get('role') ?? '').trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(slug)) {
          sendJson(res, 400, { error: 'bad role id' });
          return;
        }
        const resolved = stateRootFor(workspaceRegistry, resolveStateDir(config), String(url.searchParams.get('workspace') ?? ''));
        if (resolved.stateRoot === undefined) {
          sendJson(res, 400, { error: 'unknown workspace', detail: resolved.reason });
          return;
        }
        const library = await loadRoles(userRolesDir(resolved.stateRoot));
        const role = library.bySlug.get(slug);
        if (role === undefined) {
          sendJson(res, 404, { error: 'role not found' });
          return;
        }
        const raw = (await readRoleFileText(role.path)) ?? '';
        // 只回**正文**：frontmatter 是元数据，复制角色时不该被当成契约内容
        const body = raw.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        sendJson(res, 200, { slug, body });
      },
    }),
  );

  /* ---------------- 角色库：读 ---------------- */
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-teams/roles',
      async handler(req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const workspace = url.searchParams.get('workspace') ?? '';
          // 角色是**工作区级**的：即使这个会话还没有团队，也要能列出来（角色页不受团队存在与否影响）
          const resolved = stateRootFor(workspaceRegistry, resolveStateDir(config), workspace);
          if (resolved.stateRoot === undefined) {
            sendJson(res, 400, { error: 'unknown workspace', detail: resolved.reason });
            return;
          }
          try {
            // 供设置页显示/切换：当前工作区 + 全部候选工作区
            const candidates = candidateStateRoots(safeRegistry(workspaceRegistry), resolveStateDir(config))
              .map((root) => workspaceOfStateRoot(root, resolveStateDir(config)))
              .filter((path) => typeof path === 'string' && path !== '');
            const payload = await buildRolesPayload(resolved.stateRoot, {
              workspace: workspaceOfStateRoot(resolved.stateRoot, resolveStateDir(config)),
              workspaces: candidates,
            });
            sendJson(res, 200, payload);
          } catch (error) {
            sendJson(res, 500, { error: 'roles failed', detail: String(error?.message ?? error) });
          }
          return;
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        // 写操作：从请求体读指令，逐项校验后落盘。
        const body = await readJsonBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const resolved = stateRootFor(workspaceRegistry, resolveStateDir(config), String(body?.workspace ?? ''));
        if (resolved.stateRoot === undefined) {
          sendJson(res, 400, { error: 'unknown workspace', detail: resolved.reason });
          return;
        }
        try {
          const result = await applyRoleAction({ stateRoot: resolved.stateRoot, body });
          sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          sendJson(res, 500, { error: 'role action failed', detail: String(error?.message ?? error) });
        }
      },
    }),
  );

  return routes;
}

/** 读请求体并解析 JSON（上限 256KB，够放角色契约）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * 角色接口的状态根。
 *
 * 角色是**工作区级**的：以前固定取 roots[0]，多工作区时用户在一个工作区里
 * 启停的角色会写到另一个工作区（审计二轮问题 5）。现在优先用请求带来的
 * workspace，并且必须能在候选根里匹配上（不做任意路径访问）。
 *
 * @param {object|Function|undefined} workspaceRegistry
 * @param {string} stateDir
 * @param {string} requested - 请求里的 workspace 路径
 * @returns {{stateRoot?:string, reason?:string}}
 */
function stateRootFor(workspaceRegistry, stateDir, requested) {
  const roots = candidateStateRoots(safeRegistry(workspaceRegistry), stateDir);
  const raw = typeof requested === 'string' ? requested.trim() : '';
  // 没带 workspace（老客户端 / 单工作区）：退回第一个候选根
  if (raw === '') return roots.length === 0 ? { reason: '没有可用的工作区' } : { stateRoot: roots[0] };

  const target = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  // ⚠️ 必须按**路径分隔符边界**比对：单纯 startsWith 会让 `C:/work/a` 误匹配 `C:/work/ab/...`
  // 只接受**精确**匹配：传什么工作区就操作什么工作区。
  // 接受前缀会让"传入父目录"落到某个子工作区上，等于写错地方（第四轮审计）。
  // 候选根是 `<workspace>/<stateDir>`，所以要把 stateDir 后缀剥掉再比。
  const suffix = `/${String(stateDir ?? '.dsh-teams').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()}`;
  const match = roots.find((root) => {
    const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const workspace = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
    return workspace === target;
  });
  // ⚠️ 匹配不上就拒绝，绝不回落 roots[0]：
  // 带着"别的工作区"来请求却写进第一个工作区，是静默写错地方（第三轮审计实测复现）。
  if (match === undefined) return { reason: `工作区不在可访问列表里：${raw}` };
  return { stateRoot: match };
}

/** 从 `<workspace>/<stateDir>` 反推工作区路径。 */
function workspaceOfStateRoot(stateRoot, stateDir) {
  const normalized = String(stateRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const suffix = `/${String(stateDir ?? '.dsh-teams').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
}

function safeRegistry(workspaceRegistry) {
  try {
    return typeof workspaceRegistry === 'function' ? workspaceRegistry() : workspaceRegistry;
  } catch {
    return undefined;
  }
}

/**
 * 角色库快照：内置 + 自定义，带启停状态与分类。
 *
 * 只回传面板需要展示的字段——契约正文可以很长（几 KB），列表里用不到，
 * 查看详情时再单独取（见 `readRoleFileText`）。
 *
 * @param {string} stateRoot
 */
export async function buildRolesPayload(stateRoot, extra = {}) {
  const disabled = await readDisabledRoles(stateRoot);
  const library = await loadRoles(userRolesDir(stateRoot), { disabled });
  return {
    schemaVersion: 1,
    coreRoles: [...CORE_ROLES],
    // 角色属于工作区：设置页要能显示"当前在编辑哪个工作区"，多工作区时还要能切换
    ...(typeof extra.workspace === 'string' ? { workspace: extra.workspace } : {}),
    ...(Array.isArray(extra.workspaces) ? { workspaces: extra.workspaces } : {}),
    roles: library.roles.map((role) => ({
      slug: role.slug,
      name: role.name,
      emoji: role.emoji,
      description: role.description,
      category: role.category,
      builtin: role.builtin === true,
      enabled: role.enabled !== false,
      triggers: Array.isArray(role.triggers) ? role.triggers : [],
      permissions: role.permissions,
      tier: role.tier,
      readBudget: role.readBudget,
      outputBudget: role.outputBudget,
      ...(role.overridden === true ? { overridden: true } : {}),
      ...(role.overrides === true ? { overrides: true } : {}),
      ...(Array.isArray(role.errors) ? { errors: role.errors } : {}),
    })),
  };
}

/**
 * 执行一次角色写操作。
 * @param {{stateRoot:string, body:object}} input
 * @returns {Promise<{ok:boolean, reason?:string, roles?:object[]}>}
 */
export async function applyRoleAction({ stateRoot, body }) {
  const action = String(body?.action ?? '');
  const slug = String(body?.role ?? body?.role_id ?? '').trim().toLowerCase();

  if (action === 'toggle') {
    const enabled = body?.enabled === true;
    const allowed = validateToggle(slug, enabled);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    const library = await loadRoles(userRolesDir(stateRoot));
    if ((library.allBySlug ?? library.bySlug).get(slug) === undefined) {
      return { ok: false, reason: `找不到角色：${slug || '（空）'}` };
    }
    // 原子读-改-写（并发停用不再互相覆盖）
    await setRoleEnabled(stateRoot, slug, enabled);
    return { ok: true, ...sanitizeForRoles(await buildRolesPayload(stateRoot)) };
  }

  if (action === 'delete') {
    const library = await loadRoles(userRolesDir(stateRoot));
    const role = library.allBySlug?.get(slug) ?? library.bySlug.get(slug);
    if (role === undefined) return { ok: false, reason: `找不到角色：${slug}` };
    if (role.builtin === true) return { ok: false, reason: '内置角色不可删除（只能停用）' };
    await rm(role.path, { force: true });
    await setRoleEnabled(stateRoot, slug, true);
    return { ok: true, ...sanitizeForRoles(await buildRolesPayload(stateRoot)) };
  }

  if (action === 'save') {
    const validation = validateCustomRole({
      slug,
      name: body?.name,
      description: body?.description,
      prompt: body?.prompt,
      emoji: body?.emoji,
      permissions: body?.permissions,
      tier: body?.tier,
      readBudget: body?.read_budget ?? body?.readBudget,
      outputBudget: body?.output_budget ?? body?.outputBudget,
      triggers: body?.triggers,
      category: body?.category,
    });
    if (!validation.ok) return { ok: false, reason: validation.errors.join('；'), errors: validation.errors };
    await ensureStateDirs(stateRoot);
    await writeFileAtomic(join(userRolesDir(stateRoot), `${slug}.md`), validation.markdown);
    return { ok: true, ...sanitizeForRoles(await buildRolesPayload(stateRoot)) };
  }

  return { ok: false, reason: `未知操作：${action || '（空）'}` };
}

/** 只保留前端需要的键（防止把内部字段漏出去）。 */
function sanitizeForRoles(payload) {
  return { roles: payload.roles, coreRoles: payload.coreRoles };
}

/** 供离线调试：直接从磁盘读一个状态根的快照。 */
export async function snapshotFromDisk(stateRoot, captainSessionId) {
  return buildSnapshot({ stateRoot, captainSessionId });
}

/**
 * 读取自定义角色文件的原始文本（设置页编辑用）。
 * @param {string} file
 * @returns {Promise<string|undefined>}
 */
export async function readRoleFileText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export { routeDecision };
