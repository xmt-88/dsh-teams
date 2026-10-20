/**
 * DSH Teams — 调度器
 *
 * 流程：计划（生成任务图）→ 审批闸门 → 调度循环（按依赖并行派发）→ 收口。
 *
 * 几条刻意的设计决定：
 *
 *   1. **计划与执行分离**。`plan` 只生成任务图并停在 `staged`，必须显式 `approve`
 *      才允许派发。旧 skill 把用户确认塞在流水线中间、靠 5/10 分钟超时兜底；
 *      这里做成硬闸门，没有超时竞态，且用户批准的是"可执行任务图"而非一段文本方案。
 *
 *   2. **调度在后台跑**。`run` 立刻返回，不等所有子代理跑完——否则一个工具调用会挂
 *      几十分钟，把队长会话的上下文与超时全拖垮。进度由任务图与事件流承载。
 *
 *   3. **失败不静默**。失败信息、stopReason、重试次数都写进任务记录与事件流；
 *      依赖失败的任务转为 blocked，而不是继续往下跑。
 *
 *   4. **锁内读改写**。每次状态变更都在 `mutateTasks` 的锁里重读，避免并发派发互相覆盖。
 */

import { createHash } from 'node:crypto';

import { route } from './router.js';
import { loadRoles, resolveRole } from './roles.js';
import {
  stateRootOf,
  ensureStateDirs,
  ensureTeam,
  mutateTeam,
  readTeam,
  readTasks,
  mutateTasks,
  appendEvent,
  userRolesDir,
} from './state.js';
import { buildTaskGraph, pickReady, collectDependencyOutputs, summarize, truncate } from './tasks.js';
import { hasEvidence, isGateKind, parseVerdict } from './verdict.js';
import { runTask, TIMEOUT_MS, resolveTimeoutMs } from './runner.js';
import { readField, resolveGates, resolveRouting, resolveStateDir, resolveScheduler, resolveUi, watchOverrides } from './config.js';
import { readDisabledRoles } from './role-state.js';
import { appendRunRecord } from './state.js';

/** 单进程内正在运行的调度循环，按状态根 + 队伍 id 去重，避免重复调度。 */
const activeLoops = new Map();

/** 僵尸循环的判定窗口：超过这么久没有心跳就允许重新起跑（进程卡死后的自救）。 */
const LOOP_STALE_MS = 60 * 60 * 1000;

/**
 * 任务图指纹。
 *
 * 批准的必须是**这一张图**，而不是"这个阶段"。没有指纹时，批准后往图里追加一个任务
 * 会照样被执行（审计 H5）——闸门看着在，实际拦不住。
 *
 * @param {{tasks?:object[]}} graph
 * @returns {string}
 */
export function graphFingerprint(graph) {
  const tasks = Array.isArray(graph?.tasks) ? graph.tasks : [];
  // 哈希范围要覆盖"改变执行含义"的一切：漏掉哪个字段，改它就等于绕过审批（审计二轮问题 6）。
  const canonical = tasks
    .map((task) =>
      [
        task.id,
        task.role,
        task.kind,
        task.order ?? '',
        task.subject ?? '',
        task.objective ?? '',
        task.workspace ?? '',
        // 用**计划期**依赖：质量门驳回时会给门补依赖（task.deps），那是运行期事实，
        // 不该让已批准的图指纹失效（审计 R6-09：随后 run 和 retry 全被指纹挡住，假续跑）。
        [...(task.plannedDeps ?? task.deps ?? [])].sort().join('+'),
        [...(task.acceptance ?? [])].join('|'),
        task.optional === true ? 'opt' : '',
      ].join('~'),
    )
    .sort()
    .join(';');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** 循环键。 */
function loopKey(stateRoot, teamId) {
  return `${stateRoot}::${teamId}`;
}

/**
 * 生成或重建任务图（计划阶段）。
 *
 * 已有任务图时默认不覆盖——用户可能已经手工调整过；要重建必须显式 `rebuild`。
 *
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.config
 * @param {Agent} input.agent
 * @param {string} input.captainSessionId
 * @param {string} input.workspace
 * @param {string} input.task           - 用户任务描述
 * @param {string} [input.brief]
 * @param {string[]} [input.acceptance]
 * @param {string[]} [input.inScope]
 * @param {string[]} [input.outOfScope]
 * @param {string} [input.forcePath]
 * @param {number} [input.filesTouched]
 * @param {number} [input.linesTouched]
 * @param {boolean} [input.crossModule]
 * @param {boolean} [input.touchesShared]
 * @param {boolean} [input.rebuild]
 * @returns {Promise<object>}
 */
export async function planTeam(input) {
  const {
    config,
    captainSessionId,
    workspace,
    task,
    brief,
    acceptance,
    inScope,
    outOfScope,
    forcePath,
    filesTouched,
    linesTouched,
    crossModule,
    touchesShared,
    rebuild,
  } = input;

  const stateRoot = stateRootOf(workspace, resolveStateDir(config));
  await ensureStateDirs(stateRoot);
  await ensureTeam({ stateRoot, captainSessionId, workspace, purpose: task });

  // 角色库要在路由**之前**读：停用角色要被剪掉，命中触发词的自定义专家要被插进来。
  const disabledRoles = await readDisabledRoles(stateRoot);
  const library = await loadRoles(userRolesDir(stateRoot), { disabled: disabledRoles });
  const decision = route({
    taskText: task,
    filesTouched,
    linesTouched,
    crossModule,
    touchesShared,
    forcePath: forcePath ?? 'auto',
    roles: library.roles,
    locale: resolveUi(config).locale === 'en' ? 'en' : undefined,
    routing: resolveRouting(config),
  });

  // 审计 H1：调度循环运行中重建任务图，新图会被**旧循环**执行（批准只在入口查一次）。
  // 与其在循环里到处加判据，不如在源头拒绝：要重建就先停。
  if (activeLoops.has(loopKey(stateRoot, captainSessionId))) {
    return {
      rebuilt: false,
      reason: '调度循环正在运行，不能重建任务图。先调用 teams_stop 停止，或等它收口',
      phase: 'running',
    };
  }

  const existing = await readTasks(stateRoot, captainSessionId);
  // 重建前先把上一轮归档：状态目录只保留最新一轮，而面板要按"每次任务"折叠展示历史。
  if (existing.tasks.length > 0 && rebuild === true) {
    await archiveRun(stateRoot, captainSessionId, existing).catch(() => {});
  }
  if (existing.tasks.length > 0 && rebuild !== true) {
    const team = await readTeam(stateRoot, captainSessionId);
    return {
      rebuilt: false,
      reason: '已存在任务图；如需重建请传 rebuild=true',
      phase: String(team?.phase ?? 'idle'),
      decision,
      graph: existing,
    };
  }

  const graph = buildTaskGraph({
    steps: decision.steps,
    teamId: captainSessionId,
    subject: task,
    brief,
    acceptance,
    scope: { inScope: inScope ?? [], outOfScope: outOfScope ?? [] },
    workspace,
    roleOf: (roleId) => resolveRole(library, roleId),
  });

  await mutateTasks(stateRoot, captainSessionId, () => graph);
  await mutateTeam(stateRoot, captainSessionId, (team) => {
    team.phase = 'staged';
    // 新任务图 = 新一轮：上一轮的审批/收口时间必须清掉，
    // 否则面板会在「待审批」状态下显示上一轮的 finishedAt，让人以为这一轮已经跑完了。
    delete team.approvedAt;
    delete team.finishedAt;
    team.decision = {
      ...(team.decision ?? {}),
      path: decision.path,
      label: decision.label,
      score: decision.score,
      total: decision.total,
      reasons: decision.reasons,
      notes: decision.notes,
      needsUiDesign: decision.needsUiDesign,
      escalated: decision.escalated,
      task,
      roleChain: decision.steps.map((step) => step.role),
      stepIds: decision.steps.map((step) => step.id),
      decidedAt: new Date().toISOString(),
    };
    team.members = decision.steps.map((step) => {
      const role = resolveRole(library, step.role);
      return {
        name: step.role,
        role: step.role,
        emoji: role?.emoji ?? '🤖',
        roleName: role?.name ?? step.role,
        status: 'idle',
      };
    });
    return team;
  });

  await appendEvent({
    stateRoot,
    type: 'plan',
    team: captainSessionId,
    data: {
      path: decision.path,
      steps: decision.steps.length,
      tasks: graph.tasks.map((item) => ({ id: item.id, role: item.role, deps: item.deps })),
    },
  });

  return { rebuilt: true, phase: 'staged', decision, graph };
}

/**
 * 批准计划，进入可执行状态。
 * @returns {Promise<{approved:boolean, reason?:string, phase?:string}>}
 */
export async function approveTeam({ config, captainSessionId, workspace }) {
  const stateRoot = stateRootOf(workspace, resolveStateDir(config));
  const team = await readTeam(stateRoot, captainSessionId);
  if (team === undefined) return { approved: false, reason: '当前会话还没有团队计划' };

  const graph = await readTasks(stateRoot, captainSessionId);
  if (graph.tasks.length === 0) return { approved: false, reason: '任务图为空，无法批准' };

  // ⚠️ 批准**不改 phase**：以前这里直接写 running，导致
  //   ① 批准后面板立即显示"运行中"（其实还没跑）；
  //   ② 跑过一轮后 phase 变成 done，`teams_run` 的 `!== 'staged'` 判据放行，闸门等于消失（审计 H2/D）。
  // 现在批准只记 approvedAt + 任务图指纹，run 时比对。
  const fingerprint = graphFingerprint(graph);
  await mutateTeam(stateRoot, captainSessionId, (current) => {
    current.approvedAt = new Date().toISOString();
    current.approvedGraph = fingerprint;
    return current;
  });
  await appendEvent({
    stateRoot,
    type: 'gate',
    team: captainSessionId,
    data: { action: 'approve', fingerprint },
  });
  return { approved: true, phase: 'staged', graph: fingerprint };
}

/**
 * 启动调度循环（立即返回，后台执行）。
 *
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.config
 * @param {Agent} input.agent
 * @param {string} input.captainSessionId
 * @param {string} input.workspace
 * @param {string} [input.providerName]
 * @param {string} [input.model]
 * @returns {Promise<{started:boolean, reason?:string, tasks?:number, running?:number}>}
 */
export async function startTeamRun(input) {
  const { ctx, config, agent, captainSessionId, workspace, providerName, model } = input;
  const stateRoot = stateRootOf(workspace, resolveStateDir(config));

  const team = await readTeam(stateRoot, captainSessionId);
  if (team === undefined) return { started: false, reason: '还没有团队计划，请先调用 teams_plan' };

  const graph = await readTasks(stateRoot, captainSessionId);
  if (graph.tasks.length === 0) return { started: false, reason: '任务图为空' };

  // ---- 闸门：批准过 + 批准的就是这一张图 ----
  // 白名单而非黑名单：以前用 `phase === 'staged'` 拒绝，凡是"不是 staged"的状态
  // （idle / done / failed，或记录损坏后被重建成 idle）都放行（审计 H2 / D / D6）。
  if (team.approvedAt === undefined) {
    return { started: false, reason: '计划尚未批准。请先确认任务图，再调用 teams_approve' };
  }
  const fingerprint = graphFingerprint(graph);
  if (team.approvedGraph !== fingerprint) {
    return {
      started: false,
      reason: '任务图在批准之后被改动过（或来自上一轮），需要重新批准',
      approvedGraph: team.approvedGraph,
      currentGraph: fingerprint,
    };
  }

  // ⚠️ 崩溃残留：进程重启后 activeLoops 是空的内存表，但磁盘上的任务还停在 running。
  // 以前这种任务永远没人管：新循环挑不到它（不是 pending）→ 零派发判 failed；
  // teams_retry 只认 failed/blocked → 报"没有可续跑的"；teams_stop 又无循环可停。
  // 唯一出路是 rebuild 从头再来（审计 R6-08，探针 probe-lost-on-crash 复现）。
  // 这里在所有闸门通过之后、真正起循环之前，把遗留的 running 复位。
  const orphanReason = await resetOrphanRunning(stateRoot, captainSessionId);

  const key = loopKey(stateRoot, captainSessionId);
  const existing = activeLoops.get(key);
  if (existing !== undefined) {
    const stale = Date.now() - (existing.touchedAt ?? 0) > LOOP_STALE_MS;
    if (!stale) {
      return { started: false, reason: '调度循环已在运行中', running: existing.running };
    }
    // 僵尸循环（进程卡死/异常退出但 .finally 没跑到）：允许接管，否则 run 与 retry 会永久互斥。
    // ⚠️ 接管必须三件事一起做，少一件就会重复派发：
    //   ① 让旧循环停（cancelled + abort）——否则它醒了还会继续挑任务
    //   ② 作废在飞任务（epoch+1）——否则它们的结果会覆盖新一轮
    //   ③ 把在飞的 running 改回 pending——否则新循环永远等不到它们
    const staleHandle = existing;
    staleHandle.cancelled = true;
    try {
      staleHandle.controller?.abort?.();
    } catch {
      /* abort 失败不影响后续接管 */
    }
    await mutateTasks(stateRoot, captainSessionId, (current) => {
      for (const item of current.tasks) {
        if (item.status !== 'running') continue;
        item.epoch = (item.epoch ?? 0) + 1;
        item.status = 'pending';
        item.updatedAt = new Date().toISOString();
      }
      return current;
    });
    if (activeLoops.get(key) === staleHandle) activeLoops.delete(key);
    await appendEvent({
      stateRoot,
      type: 'note',
      team: captainSessionId,
      data: { level: 'warn', message: '检测到僵尸调度循环（超时无心跳），已接管并作废在飞任务' },
    });
  }

  const controller = new AbortController();
  // runId：僵尸锁接管后，旧循环的 .finally 不能把**新**循环的锁删掉（审计二轮问题 3）
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = { running: 0, controller, cancelled: false, touchedAt: Date.now(), runId };
  // ⚠️ 占位必须是同步的、紧跟检查之后：中间只要有一个 await，
  // 并发两次 teams_run 就会各起一条循环，同一个任务被派发两次（审计 H4）。
  activeLoops.set(key, handle);

  // 新一轮开跑：清掉上一轮的收口时间，并把 phase 真正置为 running
  // （以前只在 approveTeam 里写 running，复跑期间面板会一直显示上一轮的终态）。
  await mutateTeam(stateRoot, captainSessionId, (current) => {
    delete current.finishedAt;
    current.phase = 'running';
    return current;
  });

  // 后台跑：不 await，让工具调用立刻返回
  runLoop({
    ctx,
    config,
    agent,
    captainSessionId,
    workspace,
    stateRoot,
    providerName,
    model,
    handle,
  })
    .catch(async (error) => {
      // 异常退出必须收口，否则 phase 停在 running（审计 I8）
      await appendEvent({
        stateRoot,
        type: 'note',
        team: captainSessionId,
        data: { level: 'error', message: `调度循环异常退出：${String(error?.message ?? error)}` },
      }).catch(() => {});
      await finalizeRun(stateRoot, captainSessionId).catch(() => {});
    })
    .finally(() => {
      // 只删自己那一把锁：接管发生时，旧循环的 finally 绝不能删掉新循环的句柄
      if (activeLoops.get(key)?.runId === runId) activeLoops.delete(key);
    });

  const pending = graph.tasks.filter((item) => item.status === 'pending').length;
  return { started: true, tasks: graph.tasks.length, pending };
}

/**
 * 续跑：把**失败**与**受阻**的任务重新排上，并把上一次的部分产出作为「续写起点」注入。
 *
 * 为什么需要它：一轮运行里最贵的不是"某一步做错了"，而是"某一步被预算砍掉后整轮作废"。
 * 实测里 executor 在 30 分钟预算上被砍过一次（当时交付物其实已经写完、测试全绿），
 * 而重跑整条标准路径要 87 分钟。续跑只重跑失败的那一步与它的下游，并把已经写下的内容带回去。
 *
 * 语义边界：
 *   - 只重新排 `failed` 与 `blocked`；**已完成的一律不动**（不重做已验证的步骤）
 *   - `resumeFrom` 取自上一次的部分产出，并明确告诉成员"先核对工作区实际状态、别信自述"——
 *     历史产出可能已经过时（真实事故：成员把历史日志当成现状）
 *   - 清掉 `failure` 让任务重新待派发，但失败记录仍留在 `attempts` 与 `evidence` 里
 *
 * @param {{config: object, captainSessionId: string, workspace: string}} input
 * @returns {Promise<{started: boolean, reason?: string, retried?: number, resumed?: number}>}
 */
export async function retryFailedTeam({ config, captainSessionId, workspace }) {
  const stateRoot = stateRootOf(workspace, resolveStateDir(config));
  const team = await readTeam(stateRoot, captainSessionId);
  if (team === undefined) return { started: false, reason: '还没有团队计划，请先调用 teams_plan' };
  const key = loopKey(stateRoot, captainSessionId);
  if (activeLoops.has(key)) return { started: false, reason: '调度循环仍在运行中，等它收口再续跑' };

  // 与 teams_run 同一套判据：看 approvedAt（而不是 phase）。
  // 顺序：先答"能不能现在跑"（循环在跑已排除），再答"有没有活可干"，最后才是批准。
  const pendingGraph = await readTasks(stateRoot, captainSessionId);
  const hasRetryable = pendingGraph.tasks.some((task) => task.status === 'failed' || task.status === 'blocked');
  if (!hasRetryable) return { started: false, reason: '没有失败或受阻的任务可续跑' };
  if (team.approvedAt === undefined) return { started: false, reason: '计划尚未批准，无从续跑' };

  let retried = 0;
  let resumed = 0;
  await mutateTasks(stateRoot, captainSessionId, (current) => {
    for (const task of current.tasks) {
      if (task.status !== 'failed' && task.status !== 'blocked') continue;
      const seed = typeof task.output === 'string' ? task.output.trim() : '';
      task.status = 'pending';
      delete task.failure;
      delete task.resumeFrom;
      if (seed !== '') {
        task.resumeFrom = seed.length > RESUME_SEED_LIMIT ? seed.slice(0, RESUME_SEED_LIMIT) : seed;
        resumed += 1;
      }
      task.updatedAt = new Date().toISOString();
      retried += 1;
    }
    return current;
  });

  if (retried === 0) return { started: false, reason: '没有失败或受阻的任务可续跑' };
  return { started: true, retried, resumed };
}

/**
 * 把一轮任务图压成一条运行历史（面板的"每次任务"折叠项）。
 *
 * 只留展示与排查需要的字段：角色身份、状态、耗时、子会话 id、看门狗判定、用量统计。
 * 产出正文不进历史（它可能很长，且面板只显示预览）。
 */
async function archiveRun(stateRoot, captainSessionId, graph) {
  const steps = (graph.tasks ?? []).map((task) => {
    const evidence = Array.isArray(task.evidence) ? task.evidence : [];
    const last = [...evidence].reverse().find((entry) => entry?.childId !== undefined) ?? evidence[evidence.length - 1];
    return {
      id: task.id,
      role: task.role,
      roleName: task.roleName,
      emoji: task.emoji,
      status: task.status,
      deps: task.deps ?? [],
      durationMs: last?.durationMs,
      childId: last?.childId,
      watch: last?.watch,
      metrics: task.metrics,
      failure: typeof task.failure === 'string' ? task.failure : undefined,
    };
  });
  const team = await readTeam(stateRoot, captainSessionId);
  await appendRunRecord(stateRoot, captainSessionId, {
    runId: `${captainSessionId}-${Date.now()}`,
    at: new Date().toISOString(),
    // ⚠️ 优先用**被归档这张图**自己的 subject：`teams_plan` 会在调 planTeam 之前
    // 就把 team.purpose 换成新任务，读它会让历史归档顶着新任务的标题（真实踩过）。
    subject: graph.subject || team?.decision?.task || team?.purpose || '',
    path: team?.decision?.path,
    pathLabel: team?.decision?.label,
    finishedAt: team?.finishedAt,
    phase: team?.phase,
    steps,
  });
}

/** 续写起点的长度上限：够它判断"做到哪了"，又不至于把任务卡撑爆。 */
const RESUME_SEED_LIMIT = 4_000;

/**
 * 调度主循环。
 *
 * 每轮：挑出就绪任务 → 并行派发 → 等这一批结束 → 落盘 → 再挑。
 * 直到没有 running、也没有 ready 为止（即全部完成/失败/阻塞）。
 */
async function runLoop({
  ctx,
  config,
  agent,
  captainSessionId,
  workspace,
  stateRoot,
  providerName,
  model,
  handle,
}) {
  const maxParallel = Math.max(1, resolveScheduler(config).maxParallel);
  const maxRetries = Math.max(0, resolveScheduler(config).maxRetries);
  // 质量门驳回预算：门类任务判 FAIL 时，最多把实现步骤退回重做几轮
  const maxReviewRounds = Math.max(0, resolveScheduler(config).maxReviewRounds);
  const gates = resolveGates(config);
  const library = await loadRoles(userRolesDir(stateRoot));

  for (;;) {
    if (handle.cancelled) {
      // 以前这里直接 return，phase 就永远停在 running（停止后界面一直显示"运行中"）
      await finalizeRun(stateRoot, captainSessionId, { halted: true });
      return;
    }
    handle.touchedAt = Date.now();

    const graph = await readTasks(stateRoot, captainSessionId);
    const { ready, blocked: blockedCandidates } = pickReady(graph.tasks, handle.running, maxParallel);

    // 依赖失败的 pending 任务转为 blocked，并把"谁挡住了它"记进事件
    if (blockedCandidates.length > 0) {
      const newlyBlocked = [];
      await mutateTasks(stateRoot, captainSessionId, (current) => {
        const byId = new Map(current.tasks.map((item) => [item.id, item]));
        for (const item of current.tasks) {
          if (item.status !== 'pending') continue;
          const failedDeps = item.deps.filter((depId) => {
            const dep = byId.get(depId);
            return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked');
          });
          if (failedDeps.length > 0) {
            item.status = 'blocked';
            newlyBlocked.push({ id: item.id, by: failedDeps });
            item.updatedAt = new Date().toISOString();
          }
        }
        return current;
      });
      for (const entry of newlyBlocked) {
        await appendEvent({
          stateRoot,
          type: 'gate',
          team: captainSessionId,
          data: { task: entry.id, event: 'blocked', by: entry.by },
        }).catch(() => {});
      }
    }

    if (ready.length === 0) {
      if (handle.running === 0) break; // 收口
      await new Promise((resolve) => setTimeout(resolve, 800));
      continue;
    }

    // 并行派发这一批
    const batch = ready.map((task) => {
      handle.running += 1;
      return dispatchOne({
        ctx,
        config,
        agent,
        captainSessionId,
        stateRoot,
        workspace,
        library,
        task,
        maxRetries,
        maxReviewRounds,
        gates,
        providerName,
        model,
        signal: handle.controller.signal,
      })
        .catch(async (error) => {
          // ⚠️ 零进展护栏：dispatchOne 里任何未预料的异常都不能让任务停在 pending。
          // 停在那里 → 下一轮又被挑中 → 再炸 → 事件流无界增长、phase 永停 running
          // （第四轮审计实测：6 秒 3438 条"派发异常"）。
          await settleTask(
            stateRoot,
            captainSessionId,
            task.id,
            { ok: false, error: `派发期异常：${String(error?.message ?? error)}` },
            { ...gates, maxReviewRounds, epoch: Number(task.epoch ?? 0) },
          ).catch(() => {});
          await appendEvent({
            stateRoot,
            type: 'member',
            team: captainSessionId,
            data: { task: task.id, role: task.role, event: 'failed', error: `派发期异常：${String(error?.message ?? error)}` },
          }).catch(() => {});
        })
        .finally(() => {
          handle.running -= 1;
        });
    });
    const settled = await Promise.allSettled(batch);
    // 审计 I1：以前这里的 rejection 被完全吞掉，任务停在 running、团队却判 done。
    // dispatchOne 内部已有兜底，这里只做最后一道记录（真出现了说明兜底也没兜住）。
    for (const item of settled) {
      if (item.status !== 'rejected') continue;
      await appendEvent({
        stateRoot,
        type: 'note',
        team: captainSessionId,
        data: { level: 'error', message: `派发异常：${String(item.reason?.message ?? item.reason)}` },
      }).catch(() => {});
    }
  }

  await finalizeRun(stateRoot, captainSessionId);
}

/**
 * 收口：汇总最终状态。
 *
 * 三条出口都走这里（正常结束 / 被停止 / 异常退出），保证 phase 不会停在 running。
 * @param {string} stateRoot
 * @param {string} captainSessionId
 * @param {{halted?:boolean}} [options]
 */
/**
 * 把遗留的 `running` 任务复位成 `pending`（进程崩溃/重启后的残留）。
 *
 * 与"僵尸循环接管"不同：那条路是内存里还有句柄；这里是内存表为空、磁盘有残留。
 * 复位时 `epoch+1`，让可能迟到的旧结果被丢弃。
 *
 * @returns {Promise<number>} 复位了几个任务
 */
async function resetOrphanRunning(stateRoot, captainSessionId) {
  let count = 0;
  await mutateTasks(stateRoot, captainSessionId, (current) => {
    for (const item of current.tasks) {
      if (item.status !== 'running') continue;
      item.epoch = (item.epoch ?? 0) + 1;
      item.status = 'pending';
      item.updatedAt = new Date().toISOString();
      count += 1;
    }
    return current;
  });
  if (count > 0) {
    await appendEvent({
      stateRoot,
      type: 'note',
      team: captainSessionId,
      data: {
        level: 'warn',
        message: `发现 ${count} 个遗留的运行中任务（上次调度异常退出），已复位为待派发`,
      },
    }).catch(() => {});
  }
  return count;
}

async function finalizeRun(stateRoot, captainSessionId, options = {}) {
  // 被停止时，在飞的任务要改回 pending 并作废它们的结果——
  // 否则它们会永远停在 running，下次 teams_run 立刻"零派发"收口（实测过）。
  if (options.halted === true) {
    await mutateTasks(stateRoot, captainSessionId, (current) => {
      for (const item of current.tasks) {
        if (item.status !== 'running') continue;
        item.epoch = (item.epoch ?? 0) + 1;
        item.status = 'pending';
        item.updatedAt = new Date().toISOString();
      }
      return current;
    });
  }

  const graph = await readTasks(stateRoot, captainSessionId);
  const stats = summarize(graph.tasks);
  // ⚠️ 残留的 running/pending 也必须算失败：以前判据只看 failed/blocked，
  // 于是"派发期崩溃 → 任务卡住 → 团队判 done"（审计 P0-3 / I5）。
  const residual = stats.running > 0 || stats.pending > 0;
  const halted = options.halted === true;
  const failed = !halted && (stats.failed > 0 || stats.blocked > 0 || residual);
  await mutateTeam(stateRoot, captainSessionId, (team) => {
    team.phase = halted ? 'halted' : failed ? 'failed' : 'done';
    team.finishedAt = new Date().toISOString();
    for (const member of team.members ?? []) member.status = 'idle';
    return team;
  });
  await appendEvent({
    stateRoot,
    type: 'note',
    team: captainSessionId,
    data: {
      level: halted || failed ? 'warn' : 'info',
      message: halted ? '调度已停止（用户请求）' : failed ? '调度收口（有未完成或失败的任务）' : '调度收口',
      stats,
    },
  });
}

/**
 * 判断一次失败是否值得重试。
 *
 * 只重试「自己有可能好起来」的失败。预算类与参数类失败（超时、派发期报错、
 * 模型拒绝、输出截断）在同样的输入与预算下会稳定复现——重试三次只是把同一面墙
 * 撞三次：既白烧额度，又在任务板上留下 attemptCount=3 的假象，让人误以为
 * "试过很多种办法"，而实际上三次都是同一个原因。
 *
 * @param {{error?:string, stopReason?:string}} outcome - runTask 的失败返回
 * @param {{attempt:number, maxRetries:number}} budget - 当前尝试序号与重试预算
 * @returns {{retry:boolean, reason:string}}
 */
export function classifyFailure(outcome, { attempt, maxRetries }) {
  const error = typeof outcome?.error === 'string' ? outcome.error : '';
  const stopReason = typeof outcome?.stopReason === 'string' ? outcome.stopReason : '';

  if (attempt > maxRetries) return { retry: false, reason: '重试次数已用尽' };
  if (error.startsWith('超时')) return { retry: false, reason: '预算未变，重试会再撞同一面墙' };
  if (error.startsWith('派发失败')) return { retry: false, reason: '派发期确定性错误（提供者/深度/参数）' };
  if (error.startsWith('找不到角色')) return { retry: false, reason: '角色解析失败，重试不会改变结果' };
  if (error.includes('不支持 persona')) return { retry: false, reason: '提供者缺少 persona 能力' };
  if (stopReason === 'refusal') return { retry: false, reason: '模型拒绝执行该任务' };
  if (stopReason === 'max-tokens') return { retry: false, reason: '输出达到 token 上限，同一预算下会再次截断' };
  if (stopReason === 'aborted') return { retry: false, reason: '运行被中断/取消，重试无意义' };

  // 运行期错误（stopReason=error）与空产出往往是瞬态的：限流、抖动、模型偶尔没写文本
  return { retry: true, reason: '疑似瞬态失败（运行期错误/空产出），值得重试' };
}

/**
 * 派发单个任务（含重试）。
 */
async function dispatchOne({
  ctx,
  config,
  agent,
  captainSessionId,
  stateRoot,
  workspace,
  library,
  task,
  maxRetries,
  maxReviewRounds = 0,
  gates = {},
  providerName,
  model,
  signal,
}) {
  // ⚠️ 必须在任何早退路径之前声明：下面"找不到角色"的分支也要用它结算，
  // 声明晚一行就是 TDZ ReferenceError —— 而这个异常会被循环吞掉，变成
  // "任务恒 pending + 事件流每轮刷一条异常"的**无限热循环**（第三轮审计实测 3 秒 7395 条）。
  const dispatchEpoch = Number(task.epoch ?? 0);

  const role = resolveRole(library, task.role);
  if (role === undefined) {
    await settleTask(
      stateRoot,
      captainSessionId,
      task.id,
      { ok: false, error: `找不到角色 "${task.role}"，无法派发` },
      { ...gates, maxReviewRounds, epoch: dispatchEpoch },
    );
    return;
  }

  const graph = await readTasks(stateRoot, captainSessionId);
  const dependencyOutputs = collectDependencyOutputs(task, graph.tasks);
  const team = await readTeam(stateRoot, captainSessionId);
  const teamGoal = team?.purpose ?? '';

  // 编号从已有的 attempts 续：以前每轮从 1 重算，面板上分不清"第 1 轮的 2 次"和"第 3 轮的 2 次"
  let attempt = Array.isArray(task.attempts) ? task.attempts.length : 0;
  for (;;) {
    attempt += 1;

    // 标记为 running，UI 立即能看到
    await mutateTasks(stateRoot, captainSessionId, (current) => {
      const target = current.tasks.find((item) => item.id === task.id);
      if (target !== undefined) {
        if (!Array.isArray(target.attempts)) target.attempts = [];
        target.status = 'running';
        target.updatedAt = new Date().toISOString();
        target.attempts.push({ attempt, startedAt: new Date().toISOString(), status: 'running' });
      }
      return current;
    });
    await mutateTeam(stateRoot, captainSessionId, (current) => {
      const member = (current.members ?? []).find((item) => item.role === task.role);
      if (member !== undefined) {
        member.status = 'working';
        member.currentTask = task.id;
        member.startedAt = new Date().toISOString();
      }
      return current;
    });
    await appendEvent({
      stateRoot,
      type: 'member',
      team: captainSessionId,
      data: { task: task.id, role: task.role, event: 'start', attempt },
    });

    const outcome = await runTask({
      ctx,
      parent: agent,
      task: { ...task, teamId: captainSessionId },
      role,
      teamGoal,
      dependencyOutputs,
      providerName,
      model,
      // 配置要传进去：墙钟闸门的开关（timeouts.enabled）与看门狗参数都由它决定
      config,
      // 墙钟预算（秒→毫秒）；`timeouts.enabled` 为 false 时返回 undefined = 不设上限
      timeoutMs: resolveTimeoutMs(config, role),
      // 看门狗参数（毫秒）：动态停滞判定与空闲宽限
      watchLimits: watchOverrides(config),
      // 团队 stop 的中止信号：真正能打断在跑的子代理
      signal,
    });

    // 用户停止：不能判失败（判了就让"停止 → 续跑"断掉——halted 只重置 running）
    if (outcome.ok !== true && outcome.stopped === true) {
      await mutateTasks(stateRoot, captainSessionId, (current) => {
        const target = current.tasks.find((item) => item.id === task.id);
        if (target === undefined) return current;
        target.status = 'pending';
        const last = Array.isArray(target.attempts) ? target.attempts[target.attempts.length - 1] : undefined;
        if (last !== undefined) {
          last.status = 'stopped';
          last.finishedAt = new Date().toISOString();
        }
        target.updatedAt = new Date().toISOString();
        return current;
      });
      await appendEvent({
        stateRoot,
        type: 'member',
        team: captainSessionId,
        data: { task: task.id, role: task.role, event: 'stopped', attempt },
      }).catch(() => {});
      return;
    }

    if (outcome.ok) {
      await settleTask(stateRoot, captainSessionId, task.id, outcome, { ...gates, maxReviewRounds, epoch: dispatchEpoch });
      // ⚠️ 事件写失败不能往上抛：抛出去会被零进展护栏接住，再 settle 一次（把已 done 的任务翻成 failed）
      await appendEvent({
        stateRoot,
        type: 'member',
        team: captainSessionId,
        data: { task: task.id, role: task.role, event: 'done', durationMs: outcome.durationMs },
      }).catch(() => {});
      return;
    }

    const verdict = classifyFailure(outcome, { attempt, maxRetries });
    await appendEvent({
      stateRoot,
      type: 'member',
      team: captainSessionId,
      data: {
        task: task.id,
        role: task.role,
        event: 'failed',
        attempt,
        error: outcome.error,
        retry: verdict.retry,
        ...(verdict.retry ? {} : { no_retry_reason: verdict.reason }),
      },
    });

    if (verdict.retry) {
      // 收掉这一次的 attempt 条目：不回填的话面板上「第 N 次尝试」会永远显示"进行中"（审计 I6）
      await mutateTasks(stateRoot, captainSessionId, (current) => {
        const target = current.tasks.find((item) => item.id === task.id);
        const last = target?.attempts?.[target.attempts.length - 1];
        if (last !== undefined) {
          last.status = 'failed';
          last.finishedAt = new Date().toISOString();
          last.error = outcome.error;
          last.retried = true;
        }
        return current;
      });
      // 退避后重试：给瞬时限流/网络抖动留出恢复窗口
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }

    // 不重试时把原因一起落进任务记录：面板上能直接看出「为什么没有再来一次」
    await settleTask(
      stateRoot,
      captainSessionId,
      task.id,
      {
        ...outcome,
        error: `${String(outcome.error ?? '未知失败')}（未重试：${verdict.reason}）`,
      },
      { ...gates, maxReviewRounds, epoch: dispatchEpoch },
    );
    return;
  }
}

/**
 * 把一次运行结果写入任务记录。
 *
 * 角色直接从任务图里读回来——不靠 `team.decision` 的下标反查（那种写法一旦
 * 步骤列表与任务 id 不同步就会静默错配到别的成员）。
 */
async function settleTask(stateRoot, captainSessionId, taskId, outcome, gateOptions = {}) {
  const now = new Date().toISOString();
  let settledRole;
  let discarded = false;

  await mutateTasks(stateRoot, captainSessionId, (current) => {
    const task = current.tasks.find((item) => item.id === taskId);
    if (task === undefined) return current;
    settledRole = task.role;
    task.updatedAt = now;
    // 任务记录可能来自旧版本或被外部改坏：缺数组时补齐，而不是让 settleTask 自己抛错
    // （它一抛，兜底也失效，任务永远停在 pending → 热循环）
    if (!Array.isArray(task.attempts)) task.attempts = [];
    if (!Array.isArray(task.evidence)) task.evidence = [];

    // 幂等：任务已经成功收口后，一次迟到的失败（例如事件写失败触发的重复 settle）
    // 不能把它翻成 failed —— 第五轮审计实测过这个反写。
    if (task.status === 'done' && outcome.ok !== true) return current;

    // ---- 终局判定（审计 P0-1/P0-2）----
    // 门类任务：产出里必须有 `VERDICT: PASS|FAIL|BLOCKED`。
    // 缺这行按 fail-closed 处理——"没写"不能当"通过"。
    // 派发世代：驳回/接管会把 epoch 加一，**上一代**的在飞结果必须丢弃。
    // 不这么做的话，驳回瞬间正在跑的门会用旧代码的结论落盘，而且不会重跑（审计二轮问题 2）。
    const epoch = Number(gateOptions.epoch ?? 0);
    if ((task.epoch ?? 0) !== epoch) {
      // 世代不符 = 这是"上一代"的产物（驳回/停止/接管之后才回来）。丢弃并留痕。
      task.discarded = (task.discarded ?? 0) + 1;
      task.updatedAt = now;
      discarded = true;
      return current;
    }

    const gateKind = isGateKind(task.kind);
    const verdict = gateKind ? parseVerdict(outcome.output) : undefined;
    const maxReviewRounds = Math.max(0, Number(gateOptions.maxReviewRounds ?? 0));
    let reopenForRework = false;

    if (!outcome.ok) {
      task.status = 'failed';
    } else if (!gateKind) {
      task.status = 'done';
    } else if (verdict === 'PASS') {
      // 证据门：PASS 也要能复核。没有命令/退出码/文件:行号/「不适用」说明的
      // PASS 等于"我看到了"，审计要求（gates.requireEvidence）不认。
      if (gateOptions.requireEvidence === true && !hasEvidence(outcome.output)) {
        task.status = 'failed';
        outcome = {
          ...outcome,
          ok: false,
          error: '判定 PASS，但产出里没有可复核的证据（命令+退出码 / 文件:行号 / 明确的"不适用"说明）',
        };
      } else {
        task.status = 'done';
      }
    } else {
      const round = (task.reviewRound ?? 0) + 1;
      // 只有明确的 FAIL 才值得退回重做；BLOCKED 与"缺判定"是确定性结论，重做无意义。
      // 安全阻断：security 任务判 FAIL 时不走"退回重做"，直接阻断整轮
      const blockedBySecurity =
        gateOptions.securityBlock === true && task.role === 'security-reviewer' && verdict !== 'PASS';
      if (verdict === 'FAIL' && round <= maxReviewRounds && !blockedBySecurity) {
        task.reviewRound = round;
        task.status = 'pending';
        reopenForRework = true;
      } else {
        task.status = 'failed';
        outcome = {
          ...outcome,
          ok: false,
          error: blockedBySecurity
            ? `安全审查未通过（${verdict ?? '缺判定'}），已按「安全项阻断」直接终止`
            : verdict === undefined
            ? '门类任务缺少 VERDICT 行（fail-closed）：产出里既没有 PASS 也没有 FAIL/BLOCKED'
            : `判定为 ${verdict}${verdict === 'FAIL' ? `（已用完 ${maxReviewRounds} 轮驳回预算）` : ''}`,
        };
      }
    }
    if (verdict !== undefined) task.verdict = verdict;

    if (reopenForRework) {
      // 驳回：把实现步骤退回 pending，并把门自己的结论挂到它身上，
      // 让执行者知道"上一轮为什么被打回"，而不是盲改一遍。
      const note = truncate(String(outcome.output ?? ''), 4000);
      const reopened = [];
      for (const other of current.tasks) {
        if (other === task) continue;
        if (other.kind !== 'implementation') continue;
        reopened.push(other.id);
      }

      // 传递依赖闭包：实现变了，**所有**后置步骤（简化 / 审查 / 测试 / 验证）的结论都过期。
      // 以前只重开 implementation 与"已 done 的门"，于是：
      //   · 正在跑的门会用旧代码的结论落盘（现在靠 epoch 丢弃）
      //   · simplify 这种 kind=work 的步骤从来不重做
      const stale = new Set(reopened);
      let grew = true;
      while (grew) {
        grew = false;
        for (const other of current.tasks) {
          if (other === task || stale.has(other.id)) continue;
          if ((other.deps ?? []).some((dep) => stale.has(dep))) {
            stale.add(other.id);
            grew = true;
          }
        }
      }
      stale.delete(task.id);

      for (const other of current.tasks) {
        if (!stale.has(other.id)) continue;
        other.epoch = (other.epoch ?? 0) + 1; // 作废在飞结果
        if (other.status === 'done' || other.status === 'running') {
          other.status = 'pending';
        }
        if (other.kind === 'implementation') {
          other.reviewFrom = note;
          other.reviewRound = task.reviewRound;
          delete other.failure;
          delete other.output;
        }
        if (isGateKind(other.kind)) delete other.verdict;
        other.updatedAt = now;
      }
      // 本门自己也要重跑（它自己也进了 stale 集，这里只是显式保证）
      task.epoch = (task.epoch ?? 0) + 1;

      // ⚠️ 让门**依赖**被退回的实现步骤。
      // full 路径里 security 只依赖 architect——不修这条，门会与重做的执行者并行开跑，
      // 在缺陷还没修好时再判一次 FAIL，把驳回预算白烧掉。
      if (reopened.length > 0) {
        task.deps = [...new Set([...(task.deps ?? []), ...reopened])];
      }
    }
    // 看门狗的观察结果一并留档：事后能回答"这一步到底是跑完的、被超时砍的，
    // 还是被判定卡死/空转的"，也是"宿主有没有给 localAgent"的实测记录。
    const watch = outcome.watch === undefined
      ? {}
      : {
          watch: {
            hadLocalAgent: outcome.watch.hadLocalAgent === true,
            // 走的是哪条宿主契约（startActivation / start）——0.2.1 换过接口，排查时第一眼看它
            api: outcome.watch.api,
            sawRunning: outcome.watch.sawRunning === true,
            lastSeq: outcome.watch.lastSeq,
            verdict: outcome.watch.verdict,
            cancelVia: outcome.watch.cancelVia,
            harvested: outcome.watch.harvested === true,
            // 判死时的动态阈值与已观测最长间隔：事后能复核"这个阈值是不是误杀"
            stallWindowMs: outcome.watch.stallWindowMs,
            maxGapMs: outcome.watch.maxGapMs,
            // 曾长时间静默（只用于观测，不参与判死）——runner 里一直在写，这里补上读
            silent: outcome.watch.silent === true,
          },
        };
    // 用量统计：面板每张卡片要显示步数 / token / 缓存命中
    if (outcome.metrics !== undefined) task.metrics = outcome.metrics;
    if (task.status === 'done') {
      task.output = outcome.output ?? '';
      task.evidence.push({
        kind: 'run',
        at: now,
        childId: outcome.childId,
        durationMs: outcome.durationMs,
        stopReason: outcome.stopReason,
        ...watch,
      });
    } else if (task.status === 'failed') {
      task.failure = outcome.error ?? '未知失败';
      // 超时/中断时子代理往往已经写了不少东西：把部分产出留下，
      // 否则 8 分钟的工作在面板上只剩「超时」两个字，连排查都无从下手。
      // 下游不会误用：依赖失败的任务一律转 blocked，永远不会被派发。
      if (typeof outcome.output === 'string' && outcome.output.trim() !== '') {
        task.output = outcome.output;
      }
      task.evidence.push({
        kind: 'run',
        at: now,
        childId: outcome.childId,
        durationMs: outcome.durationMs,
        stopReason: outcome.stopReason,
        error: outcome.error,
        ...watch,
      });
    }
    const last = task.attempts[task.attempts.length - 1];
    if (last !== undefined) {
      last.status = task.status === 'done' ? 'done' : task.status === 'pending' ? 'rework' : 'failed';
      last.finishedAt = now;
      last.durationMs = outcome.durationMs;
      if (task.status === 'failed') last.error = outcome.error;
    }
    return current;
  });

  // 丢弃要留痕：以前只在内层加个计数，事件流与面板都看不到，
  // 用户只会觉得"这一步怎么又跑了一遍"（第三轮审计）。
  if (discarded) {
    await appendEvent({
      stateRoot,
      type: 'note',
      team: captainSessionId,
      data: {
        level: 'warn',
        message: `丢弃了 ${taskId} 的过期结果（驳回/停止/接管后返回）`,
        task: taskId,
      },
    }).catch(() => {});
    return;
  }

  if (settledRole !== undefined) {
    await mutateTeam(stateRoot, captainSessionId, (team) => {
      const member = (team.members ?? []).find((item) => item.role === settledRole);
      if (member !== undefined) {
        member.status = 'idle';
        delete member.currentTask;
        member.finishedAt = now;
      }
      return team;
    });
  }
}

/** 当前是否有调度循环在跑（供状态查询）。 */
export function isRunning(stateRoot, captainSessionId) {
  return activeLoops.has(loopKey(stateRoot, captainSessionId));
}

/**
 * 请求停止：不再挑新任务，并中断正在等待的子代理。
 *
 * 已派发任务的产出会照常落盘（不丢工作），只是不会再有下一步。
 * @returns {boolean} 是否真的停了一条循环
 */
export function stopRun(stateRoot, captainSessionId) {
  const handle = activeLoops.get(loopKey(stateRoot, captainSessionId));
  if (handle === undefined) return false;
  handle.cancelled = true;
  handle.touchedAt = Date.now();
  try {
    handle.controller.abort();
  } catch {
    /* abort 失败不影响"不再派发"这一核心语义 */
  }
  return true;
}

export { TIMEOUT_MS, truncate };
