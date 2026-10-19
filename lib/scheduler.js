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
import { runTask, TIMEOUT_MS, resolveTimeoutMs } from './runner.js';
import { readField, resolveStateDir, resolveScheduler, watchOverrides } from './config.js';
import { appendRunRecord } from './state.js';

/** 单进程内正在运行的调度循环，按状态根 + 队伍 id 去重，避免重复调度。 */
const activeLoops = new Map();

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

  const decision = route({
    taskText: task,
    filesTouched,
    linesTouched,
    crossModule,
    touchesShared,
    forcePath: forcePath ?? 'auto',
  });

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

  const library = await loadRoles(userRolesDir(stateRoot));
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

  await mutateTeam(stateRoot, captainSessionId, (current) => {
    current.phase = 'running';
    current.approvedAt = new Date().toISOString();
    return current;
  });
  await appendEvent({ stateRoot, type: 'gate', team: captainSessionId, data: { action: 'approve' } });
  return { approved: true, phase: 'running' };
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
  if (team.phase === 'staged') {
    return { started: false, reason: '计划尚未批准。请先确认任务图，再调用 teams_approve' };
  }

  const graph = await readTasks(stateRoot, captainSessionId);
  if (graph.tasks.length === 0) return { started: false, reason: '任务图为空' };

  const key = loopKey(stateRoot, captainSessionId);
  if (activeLoops.has(key)) {
    return { started: false, reason: '调度循环已在运行中', running: activeLoops.get(key).running };
  }

  // 新一轮开跑：清掉上一轮的收口时间，面板才会显示「进行中」而不是上一轮的时间。
  await mutateTeam(stateRoot, captainSessionId, (current) => {
    delete current.finishedAt;
    return current;
  });

  const controller = new AbortController();
  const handle = { running: 0, controller, cancelled: false };
  activeLoops.set(key, handle);

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
      await appendEvent({
        stateRoot,
        type: 'note',
        team: captainSessionId,
        data: { level: 'error', message: `调度循环异常退出：${String(error?.message ?? error)}` },
      }).catch(() => {});
    })
    .finally(() => {
      activeLoops.delete(key);
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
  if (team.phase === 'staged') return { started: false, reason: '计划尚未批准，无从续跑' };

  const key = loopKey(stateRoot, captainSessionId);
  if (activeLoops.has(key)) return { started: false, reason: '调度循环仍在运行中，等它收口再续跑' };

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
    subject: team?.decision?.task ?? team?.purpose ?? '',
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
  const library = await loadRoles(userRolesDir(stateRoot));

  for (;;) {
    if (handle.cancelled) return;

    const graph = await readTasks(stateRoot, captainSessionId);
    const { ready, blocked } = pickReady(graph.tasks, handle.running, maxParallel);

    // 依赖失败的 pending 任务转为 blocked，并说明原因
    if (blocked.length > 0) {
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
            item.blockedBy = failedDeps;
            item.updatedAt = new Date().toISOString();
          }
        }
        return current;
      });
      for (const item of blocked) {
        await appendEvent({
          stateRoot,
          type: 'gate',
          team: captainSessionId,
          data: { task: item.id, event: 'blocked', reason: '依赖任务失败' },
        });
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
        providerName,
        model,
      }).finally(() => {
        handle.running -= 1;
      });
    });
    await Promise.allSettled(batch);
  }

  // 收口：汇总最终状态
  const graph = await readTasks(stateRoot, captainSessionId);
  const stats = summarize(graph.tasks);
  const failed = stats.failed > 0 || stats.blocked > 0;
  await mutateTeam(stateRoot, captainSessionId, (team) => {
    team.phase = failed ? 'failed' : 'done';
    team.finishedAt = new Date().toISOString();
    for (const member of team.members ?? []) member.status = 'idle';
    return team;
  });
  await appendEvent({
    stateRoot,
    type: 'note',
    team: captainSessionId,
    data: { level: failed ? 'warn' : 'info', message: '调度收口', stats },
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
  providerName,
  model,
}) {
  const role = resolveRole(library, task.role);
  if (role === undefined) {
    await settleTask(stateRoot, captainSessionId, task.id, {
      ok: false,
      error: `找不到角色 "${task.role}"，无法派发`,
    });
    return;
  }

  const graph = await readTasks(stateRoot, captainSessionId);
  const dependencyOutputs = collectDependencyOutputs(task, graph.tasks);
  const team = await readTeam(stateRoot, captainSessionId);
  const teamGoal = team?.purpose ?? '';

  let attempt = 0;
  for (;;) {
    attempt += 1;

    // 标记为 running，UI 立即能看到
    await mutateTasks(stateRoot, captainSessionId, (current) => {
      const target = current.tasks.find((item) => item.id === task.id);
      if (target !== undefined) {
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
    });

    if (outcome.ok) {
      await settleTask(stateRoot, captainSessionId, task.id, outcome);
      await appendEvent({
        stateRoot,
        type: 'member',
        team: captainSessionId,
        data: { task: task.id, role: task.role, event: 'done', durationMs: outcome.durationMs },
      });
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
      // 退避后重试：给瞬时限流/网络抖动留出恢复窗口
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }

    // 不重试时把原因一起落进任务记录：面板上能直接看出「为什么没有再来一次」
    await settleTask(stateRoot, captainSessionId, task.id, {
      ...outcome,
      error: `${String(outcome.error ?? '未知失败')}（未重试：${verdict.reason}）`,
    });
    return;
  }
}

/**
 * 把一次运行结果写入任务记录。
 *
 * 角色直接从任务图里读回来——不靠 `team.decision` 的下标反查（那种写法一旦
 * 步骤列表与任务 id 不同步就会静默错配到别的成员）。
 */
async function settleTask(stateRoot, captainSessionId, taskId, outcome) {
  const now = new Date().toISOString();
  let settledRole;

  await mutateTasks(stateRoot, captainSessionId, (current) => {
    const task = current.tasks.find((item) => item.id === taskId);
    if (task === undefined) return current;
    settledRole = task.role;
    task.status = outcome.ok ? 'done' : 'failed';
    task.updatedAt = now;
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
          },
        };
    // 用量统计：面板每张卡片要显示步数 / token / 缓存命中
    if (outcome.metrics !== undefined) task.metrics = outcome.metrics;
    if (outcome.ok) {
      task.output = outcome.output ?? '';
      task.evidence.push({
        kind: 'run',
        at: now,
        childId: outcome.childId,
        durationMs: outcome.durationMs,
        stopReason: outcome.stopReason,
        ...watch,
      });
    } else {
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
      last.status = outcome.ok ? 'done' : 'failed';
      last.finishedAt = now;
      last.durationMs = outcome.durationMs;
      if (!outcome.ok) last.error = outcome.error;
    }
    return current;
  });

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

/** 请求停止（已派发的任务不打断，只是不再挑新任务）。 */
export function stopRun(stateRoot, captainSessionId) {
  const handle = activeLoops.get(loopKey(stateRoot, captainSessionId));
  if (handle === undefined) return false;
  handle.cancelled = true;
  handle.controller.abort();
  return true;
}

export { TIMEOUT_MS, truncate };
