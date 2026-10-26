/**
 * DSH Teams — 宿主插件入口
 *
 * 注册：
 *   - teams_* 工具族
 *   - 一段精简的系统提示（告诉模型何时以及怎么用团队流水线）
 *   - 状态观察用的 Web 路由（供团队视图读取，走鉴权门）
 *
 * 不注册 cordis Service：状态由本插件托管在工作区目录，UI 通过 Web 路由读取。
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { route } from './lib/router.js';
import { readField } from './lib/config.js';
import { loadRoles, resolveRole, validateCustomRole, PERMISSION_TIERS, TIMEOUT_TIERS } from './lib/roles.js';
import { stateRootOf, ensureTeam, readTeam, readTasks, mutateTeam, appendEvent, ensureStateDirs, userRolesDir } from './lib/state.js';
import { writeFileAtomic } from './lib/state.js';
import { authenticatedWebRoutes, registerStateRoutes } from './lib/web-routes.js';
import { planTeam, approveTeam, startTeamRun, retryFailedTeam, stopRun, isRunning } from './lib/scheduler.js';
import { setRoleEnabled, validateToggle } from './lib/role-state.js';
import { registerCommands } from './lib/commands.js';
import { summarize, truncate } from './lib/tasks.js';

export const name = 'dsh-teams';

/** 声明需要的宿主服务；缺失时插件保持不激活而不是抛错。 */
export const inject = ['tools', 'systemPrompt'];

/** 团队阶段的中文名：`needing-decision` 必须区别于「失败」（返工预算耗尽 ≠ 真失败）。 */
const PHASE_LABELS = Object.freeze({
  idle: '空闲',
  staged: '待审批',
  running: '运行中',
  halted: '已暂停',
  done: '已完成',
  failed: '失败',
  'needing-decision': '需队长决策',
});

/**
 * 插件配置。全部可被用户在 cordis.patch.yml 中覆盖，且升级不丢。
 *
 * **每个叶子字段都必须标 `.volatile()`**，这不是可选的样式问题：
 * 宿主 `dsh-settings` 的 `describe()` 只把「存在 volatile 字段」的插件条目下发给
 * 客户端（`volatileForm()` 对普通字段返回 undefined），`update/mutate` 也只接受
 * 落在 volatile 路径上的写入（否则抛 `Config field "…" is not volatile`）。
 * 漏标的后果不是保存失败，而是**设置卡片根本不会出现**——插件页里连条目都没有，
 * 且没有任何报错。标了之后，插件页的设置卡片才能在保存时走
 * `configEditor.edit()` → Loader 的正常路径生效，无需重挂插件。
 */
export const Config = z.object({
  /** 状态目录，相对会话工作区。 */
  stateDir: z.string().default('.dsh-teams').volatile(),
  /** 路由阈值。 */
  routing: z
    .object({
      riskShortCircuit: z.boolean().default(true).volatile(),
      fastMax: z.natural().default(1).volatile(),
      standardMax: z.natural().default(4).volatile(),
    })
    .default({}),
  /** 调度参数（P3 起生效，此处先落配置以免后续改契约）。 */
  scheduler: z
    .object({
      maxParallel: z.natural().min(1).default(4).volatile(),
      maxRetries: z.natural().default(2).volatile(),
      maxReviewRounds: z.natural().default(3).volatile(),
    })
    .default({}),
  /**
   * 角色墙钟预算（**秒**），按角色 tier 分档。**默认关闭**（`enabled: false`）。
   *
   * 为什么默认关：墙钟惩罚的是"任务大"，而大任务恰恰是最该让它跑完的。实测教训——
   * architect 在一个大任务上跑了 20 分钟、175 个事件、一直在推进，却被 1200 秒墙钟砍掉，
   * 整步工作作废（连半成品都没留下），还要续跑重来。真正卡死的子代理特征不是"跑得久"，
   * 而是"不动了"，那由 `watch` 的动态停滞判定负责。
   *
   * 想恢复"到点就砍"的老行为：把 `enabled` 设为 true，下面的档位（heavy 2700 /
   * medium 1200 / light 900 / infrastructure 300）随即生效。
   */
  timeouts: z
    .object({
      enabled: z.boolean().default(false).volatile(),
      heavy: z.natural().default(2700).volatile(),
      medium: z.natural().default(1200).volatile(),
      light: z.natural().default(900).volatile(),
      infrastructure: z.natural().default(300).volatile(),
    })
    .default({}),
  /**
   * 看门狗参数（毫秒）：靠子代理 Agent 的 `status`、`Session.seq`（会话游标）与
   * `Session.ownEvents()`（它自己的会话日志）观察它是死是活，而不是只靠墙钟。
   *
   * **判据是「会话里出现 turn/end」，不是 `status === 'idle'`**——工具执行期间驱动不在跑
   * 模型回合，采样很容易落在那种空档里（真实事故：据此误杀了正在干活的 analyst）。
   * 回合结束后再给宿主 `idleGraceMs` 的宽限；宽限不需要长，因为驱动里 `whenIdle()`
   * 之后 `readResult` 是纯同步的，`run.result` 在回合结束那一刻就结算，回收只是兜底。
   * `silenceLimitMs` 只记一笔静默标记，**不判死**。改动前请先读 `lib/runner.js` 里
   * WATCH_LIMITS 的注释。
   */
  watch: z
    .object({
      probeMs: z.natural().default(10_000).volatile(),
      idleGraceMs: z.natural().default(5_000).volatile(),
      silenceLimitMs: z.natural().default(600_000).volatile(),
      // 动态停滞判定的两道闸：缺了这两个键，apply 期视图就取不到值，
      // 用户怎么配都是默认的 900000 / 4（审计 R6-02）
      stallFloorMs: z.natural().default(900_000).volatile(),
      stallFactor: z.natural().default(4).volatile(),
    })
    .default({}),
  /** 质量门开关。 */
  gates: z
    .object({
      requireEvidence: z.boolean().default(true).volatile(),
      securityBlock: z.boolean().default(true).volatile(),
    })
    .default({}),
  /** UI 偏好。 */
  ui: z
    .object({
      locale: z.string().default('zh-CN').volatile(),
    })
    .default({}),
});

/** 系统提示段在装配中的顺序：紧跟在技能目录之后，保证模型先知道它是谁、再知道有哪些工具。 */
const PROMPT_SECTION_ORDER = 120;

/**
 * 从工具执行上下文解析会话工作区。
 * 队长会话的 header.cwd 即工作区；缺失时退回进程工作目录。
 */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  return process.cwd();
}

/** 取队长会话 id；没有活动会话时给出明确失败，而不是静默降级。 */
function captainOf(exec) {
  const agent = exec?.agent;
  if (agent?.id === undefined || agent.id === null) {
    throw new Error('dsh-teams: 该工具需要在会话内调用（无法确定队长会话）');
  }
  return { agent, captainSessionId: String(agent.id), workspace: workspaceOf(agent) };
}

/** 角色库缓存：按状态根缓存，自定义角色变更时失效。 */
const roleCache = new Map();

async function rolesFor(stateRoot) {
  const cached = roleCache.get(stateRoot);
  if (cached !== undefined) return cached;
  // 必须用 path.join：Windows 上用 `${root}/roles` 会拼出不存在的目录
  const library = await loadRoles(userRolesDir(stateRoot));
  roleCache.set(stateRoot, library);
  return library;
}

/** 使角色缓存失效（自定义角色写入后调用）。 */
function invalidateRoles(stateRoot) {
  roleCache.delete(stateRoot);
}

/** 工具输出的通用渲染：一行摘要 + 可选正文。 */
function renderText(summary, body) {
  const blocks = [{ type: 'text', text: summary }];
  if (body !== undefined && body !== '') blocks.push({ type: 'text', text: body });
  return blocks;
}

/**
 * 注册全部 teams_* 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - 已解析的插件配置
 */
function registerTools(ctx, config) {
  /* ---------------------------------------------------------------- *
   * 1) teams_route — 任务 → 路径决策
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_route',
      description:
        '对任务做路径决策：按「变更规模 + 影响范围 + 风险等级」三维评分，选出快速/标准/完整/调试/部署之一，并给出可解释的理由与角色链。用于在动手之前确定该走哪条团队流水线。仅做决策，不派发任何工作。',
      parameters: {
        task: { type: 'string', required: true, description: '任务描述（用户原话或你整理后的目标）' },
        files_touched: { type: 'integer', description: '预估改动文件数（有估算就填，能让评分更准）' },
        lines_touched: { type: 'integer', description: '预估改动行数' },
        cross_module: { type: 'boolean', description: '是否跨模块/跨服务' },
        touches_shared: { type: 'boolean', description: '是否触碰共享层（公共工具、基础库、公共配置）' },
        force_path: {
          type: 'string',
          enum: ['auto', 'fast', 'standard', 'full', 'debug', 'deploy'],
          description: '用户显式指定路径；涉及认证/支付/安全时会被强制升级，不会被降级',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            label: { type: 'string', required: true },
            scale: { type: 'integer', required: true },
            impact: { type: 'integer', required: true },
            risk: { type: 'integer', required: true },
            total: { type: 'integer', required: true },
            role_chain: { type: 'array', required: true, items: { type: 'string' } },
            needs_ui_design: { type: 'boolean', required: true },
            escalated: { type: 'boolean', required: true },
            // 任务描述过短时评分不可靠（审计 R6-03）：字段必须在这里声明，
            // 否则 output schema 会以 additionalProperties:false 拒掉整个工具结果。
            ambiguous: { type: 'boolean' },
            notes: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) =>
          renderText(
            `路径：${value.label}（${value.path}）　评分：规模 ${value.scale} + 影响 ${value.impact} + 风险 ${value.risk} = ${value.total}`,
          ),
        presentationMeta: (_args, value) => ({ path: value.path, total: value.total }),
      },
      async execute(args, exec) {
        const { captainSessionId, workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));

        const decision = route({
          taskText: args.task,
          filesTouched: args.files_touched,
          linesTouched: args.lines_touched,
          crossModule: args.cross_module,
          touchesShared: args.touches_shared,
          forcePath: args.force_path ?? 'auto',
        });

        // 记录决策：既供团队视图展示，也是「为什么走这条路径」的审计线索
        await ensureStateDirs(stateRoot);
        await ensureTeam({ stateRoot, captainSessionId, workspace, purpose: args.task });
        await mutateTeam(stateRoot, captainSessionId, (team) => {
          team.decision = {
            path: decision.path,
            label: decision.label,
            score: decision.score,
            total: decision.total,
            reasons: decision.reasons,
            notes: decision.notes,
            needsUiDesign: decision.needsUiDesign,
            escalated: decision.escalated,
            // 任务描述过短（<12 字）时评分不可靠：算出来就要让调用方看见（审计 R6-03）
            ambiguous: decision.ambiguous === true,
            task: args.task,
            roleChain: decision.steps.map((step) => step.role),
            stepIds: decision.steps.map((step) => step.id),
            decidedAt: new Date().toISOString(),
          };
          return team;
        });
        await appendEvent({
          stateRoot,
          type: 'route',
          team: captainSessionId,
          data: { path: decision.path, score: decision.score, total: decision.total, notes: decision.notes },
        });

        return {
          path: decision.path,
          label: decision.label,
          scale: decision.score.scale,
          impact: decision.score.impact,
          risk: decision.score.risk,
          total: decision.total,
          role_chain: decision.steps.map((step) => step.role),
          needs_ui_design: decision.needsUiDesign,
          escalated: decision.escalated,
          ambiguous: decision.ambiguous === true,
          notes: [
            ...decision.notes,
            ...decision.reasons,
            ...(decision.ambiguous === true
              ? ['任务描述过短（<12 字），评分可能不准；补一句具体目标能让路径更可靠']
              : []),
          ],
        };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 2) teams_roles — 查看角色库
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_roles',
      description:
        '查看可用的团队角色。内置角色随插件发布、只读不可编辑；用户自定义角色存放在工作区状态目录的 roles/ 下，可增删改。返回角色 id、名称、描述、权限档与所属类别。',
      parameters: {
        role: { type: 'string', description: '要查看详情的角色 id（省略则列出全部）' },
        include_prompt: { type: 'boolean', description: '查看详情时是否附带角色契约正文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            builtin_count: { type: 'integer', required: true },
            custom_count: { type: 'integer', required: true },
            roles: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  slug: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  emoji: { type: 'string', required: true },
                  permissions: { type: 'string', required: true },
                  tier: { type: 'string', required: true },
                  builtin: { type: 'boolean', required: true },
                },
              },
            },
            prompt: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderText(`共 ${value.count} 个角色（内置 ${value.builtin_count}，自定义 ${value.custom_count}）`),
      },
      async execute(args, exec) {
        const { workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
        const library = await rolesFor(stateRoot);

        const summarize = (role) => ({
          slug: role.slug,
          name: role.name,
          description: role.description,
          emoji: role.emoji,
          permissions: role.permissions,
          tier: role.tier,
          builtin: role.builtin,
        });

        if (args.role === undefined || args.role === '') {
          const roles = library.roles.map(summarize);
          return {
            count: roles.length,
            builtin_count: roles.filter((role) => role.builtin).length,
            custom_count: roles.filter((role) => !role.builtin).length,
            roles,
          };
        }

        const role = resolveRole(library, args.role);
        if (role === undefined) {
          const available = library.roles.map((entry) => entry.slug).join(', ');
          throw new Error(`未找到角色 "${args.role}"。可用角色：${available}`);
        }
        return {
          count: 1,
          builtin_count: role.builtin ? 1 : 0,
          custom_count: role.builtin ? 0 : 1,
          roles: [summarize(role)],
          ...(args.include_prompt === true ? { prompt: role.prompt } : {}),
        };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 3) teams_status — 当前团队状态
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_status',
      description: '读取当前会话的团队状态：已决策的路径、阶段与任务概况。用于确认是否已有计划、是否在运行。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            has_team: { type: 'boolean', required: true },
            phase: { type: 'string' },
            path: { type: 'string' },
            path_label: { type: 'string' },
            purpose: { type: 'string' },
            state_dir: { type: 'string', required: true },
            running: { type: 'boolean' },
            tasks_total: { type: 'integer' },
            tasks_done: { type: 'integer' },
            tasks_failed: { type: 'integer' },
            tasks_blocked: { type: 'integer' },
            needs_decision: { type: 'boolean' },
            next_tasks: { type: 'array', items: { type: 'string' } },
            role_chain: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) =>
          renderText(
            value.has_team
              ? `团队阶段：${PHASE_LABELS[value.phase] ?? value.phase}${
                  value.path_label ? `　路径：${value.path_label}` : ''
                }${value.tasks_total ? `　任务 ${value.tasks_done}/${value.tasks_total} 完成` : ''}${
                  value.needs_decision === true ? '　⚠️ 需队长决策（返工预算耗尽，可续跑）' : ''
                }${value.running ? '　（调度中）' : ''}`
              : '当前会话还没有团队',
          ),
      },
      async execute(_args, exec) {
        const { captainSessionId, workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
        const team = await readTeam(stateRoot, captainSessionId);
        if (team === undefined) {
          return { has_team: false, state_dir: stateRoot };
        }
        const decision = team.decision;
        const graph = await readTasks(stateRoot, captainSessionId);
        const stats = summarize(graph.tasks);
        return {
          has_team: true,
          phase: String(team.phase ?? 'idle'),
          state_dir: stateRoot,
          running: isRunning(stateRoot, captainSessionId),
          tasks_total: stats.total,
          tasks_done: stats.done,
          tasks_failed: stats.failed,
          tasks_blocked: stats.blocked,
          // 「返工预算耗尽」不是失败：单独标出来，让模型/用户知道该拍板而不是修复
          needs_decision: stats.needsDecision > 0,
          ...(decision === undefined
            ? {}
            : {
                path: decision.path,
                path_label: decision.label,
                purpose: String(team.purpose ?? ''),
                ...(Array.isArray(decision.roleChain) ? { role_chain: decision.roleChain } : {}),
              }),
          ...(stats.total === 0
            ? {}
            : {
                next_tasks: graph.tasks
                  .filter((item) => item.status === 'running' || item.status === 'pending')
                  .slice(0, 8)
                  .map((item) => `${item.id}:${item.role}:${item.status}`),
              }),
        };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 4) teams_plan — 生成任务图（停在待审批）
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_plan',
      description:
        '把任务物化成可执行的团队任务图（角色 + 依赖 + 每步验收标准），并停在「待审批」。生成后必须先让用户确认，再调用 teams_approve 批准、teams_run 执行。已有任务图时不会覆盖，除非传 rebuild=true。',
      parameters: {
        task: { type: 'string', required: true, description: '用户任务的完整描述（将作为团队目标）' },
        brief: { type: 'string', description: '补充说明：背景、约束、已知信息' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '验收标准；会附加到实现类任务，供质量门判定',
        },
        in_scope: { type: 'array', items: { type: 'string' }, description: '允许改动的范围（如 src/**）' },
        out_of_scope: { type: 'array', items: { type: 'string' }, description: '明确不要动的地方' },
        files_touched: { type: 'integer', description: '预估改动文件数，让路由评分更准' },
        lines_touched: { type: 'integer', description: '预估改动行数' },
        cross_module: { type: 'boolean', description: '是否跨模块/跨服务' },
        touches_shared: { type: 'boolean', description: '是否触碰共享层' },
        force_path: {
          type: 'string',
          enum: ['auto', 'fast', 'standard', 'full', 'debug', 'deploy'],
          description: '显式指定路径；涉及安全时会被强制升级',
        },
        rebuild: { type: 'boolean', description: '已有任务图时是否重建（默认 false）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rebuilt: { type: 'boolean', required: true },
            reason: { type: 'string' },
            path: { type: 'string', required: true },
            path_label: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            phase: { type: 'string', required: true },
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  role: { type: 'string', required: true },
                  role_name: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  deps: { type: 'array', required: true, items: { type: 'string' } },
                  acceptance: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
            },
            parallel_hint: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderText(
            value.rebuilt
              ? `已生成任务图：${value.path_label}路径，共 ${value.tasks.length} 个任务（阶段：${value.phase}）`
              : `未生成新计划：${value.reason ?? ''}`,
          ),
      },
      async execute(args, exec) {
        const { agent, captainSessionId, workspace } = captainOf(exec);
        const result = await planTeam({
          ctx,
          config,
          agent,
          captainSessionId,
          workspace,
          task: args.task,
          brief: args.brief,
          acceptance: args.acceptance,
          inScope: args.in_scope,
          outOfScope: args.out_of_scope,
          forcePath: args.force_path,
          filesTouched: args.files_touched,
          linesTouched: args.lines_touched,
          crossModule: args.cross_module,
          touchesShared: args.touches_shared,
          rebuild: args.rebuild === true,
        });

        const tasks = (result.graph.tasks ?? []).map((item) => ({
          id: item.id,
          role: item.role,
          role_name: item.roleName ?? item.role,
          kind: item.kind,
          deps: item.deps,
          acceptance: item.acceptance ?? [],
        }));

        // 并行提示：依赖集合相同的任务构成一个可并行批次
        const groups = new Map();
        for (const item of result.graph.tasks ?? []) {
          const key = [...item.deps].sort().join(',') || '(无依赖)';
          groups.set(key, [...(groups.get(key) ?? []), item.id]);
        }
        const parallelHint = [...groups.entries()]
          .filter(([, ids]) => ids.length > 1)
          .map(([deps, ids]) => `${ids.join(' ‖ ')}（依赖：${deps}）`)
          .join('；');

        return {
          rebuilt: result.rebuilt,
          // reason 只在"未生成新计划"时存在；无条件赋值会留一个 undefined 自有属性，
          // 宿主会判定整份输出非无损 JSON 并拒绝（副作用已落盘，调用方却看到报错）。
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          path: result.decision.path,
          path_label: result.decision.label,
          total: result.decision.total,
          phase: result.phase ?? (result.rebuilt ? 'staged' : 'idle'),
          tasks,
          ...(parallelHint === '' ? {} : { parallel_hint: parallelHint }),
        };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 5) teams_approve — 批准计划（闸门）
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_approve',
      description:
        '批准当前任务图，允许开始派发子代理。这是最后一道人工闸门：有审批通道时会弹出确认，用户同意才生效。未批准前 teams_run 会拒绝执行。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', required: true },
            reason: { type: 'string' },
            phase: { type: 'string' },
            // 批准成功时 approveTeam 会回指纹；没声明就会被 additionalProperties:false 拒掉
            graph: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderText(value.approved ? '计划已批准，可以调用 teams_run 开始执行' : `未批准：${value.reason ?? ''}`),
      },
      async execute(_args, exec) {
        const { captainSessionId, workspace } = captainOf(exec);

        // 人工闸门：宿主有审批通道时就把决定权交给用户。
        // 以前"批准"只是模型自己能调的一个普通工具——它可以在同一轮里
        // plan → approve → run，用户压根没看到任务图（审计 P2-8）。
        const approval = ctx.get('approval');
        const hasSeam = approval !== undefined && typeof approval.request === 'function';
        let unconfirmed;

        if (hasSeam) {
          // 没有 agent 就没法把审批路由给某个人——宿主自己的 serviceAsk 也是这么判的
          if (exec.agent === undefined) {
            return { approved: false, reason: '这次调用没有可路由的会话，无法取得人工确认' };
          }

          // ⚠️ 先读策略：`never` 表示用户选择"不要问我"，此时宿主**不会弹窗**，
          // 而是直接返回 'rejected'（dsh-user-approval 的 decide() 就是这么写的）。
          // 把它当成"用户拒绝"是误判——那会让"关掉审批弹窗"的人永远批不了计划。
          let policy;
          try {
            policy =
              typeof approval.effectivePolicy === 'function'
                ? approval.effectivePolicy(exec.agent.session)
                : undefined;
          } catch {
            policy = undefined;
          }

          if (policy === 'never') {
            unconfirmed = '会话审批策略为 never（用户选择不弹窗），本次批准未经弹窗确认';
          } else {
            let outcome;
            try {
              outcome = await approval.request({
                agent: exec.agent,
                toolName: 'teams_approve',
                callId: exec.callId,
                reason: '批准团队计划，随后会派发多个子代理执行该计划',
                displayReason: '批准这份任务图并开始执行？',
                signal: exec.signal,
              });
            } catch (error) {
              return { approved: false, reason: `审批通道异常：${String(error?.message ?? error)}` };
            }
            if (outcome !== 'allowed-once') {
              return {
                approved: false,
                reason: outcome === 'rejected' ? '用户拒绝了这份计划' : `审批未通过（${String(outcome)}）`,
              };
            }
          }
        } else {
          unconfirmed = '宿主未提供审批通道，本次批准未经人工确认';
        }

        const result = await approveTeam({ config, captainSessionId, workspace });
        // 未经弹窗确认时如实留痕，别让人以为已经批过了
        if (unconfirmed !== undefined && result.approved === true) {
          const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
          await appendEvent({
            stateRoot,
            type: 'gate',
            team: captainSessionId,
            data: { action: 'approve-unconfirmed', note: unconfirmed },
          }).catch(() => {});
        }
        return result;
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 6) teams_run — 启动调度（后台执行）
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_run',
      description:
        '启动团队调度：按任务图依赖并行派发角色子代理。立即返回并在后台执行，用 teams_status 或团队视图查看进度。未批准的计划会被拒绝。',
      parameters: {
        provider: { type: 'string', description: '子代理提供者名，默认为 spawn' },
        model: { type: 'string', description: '可选模型覆盖；不填则跟随配置与会话默认' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            started: { type: 'boolean', required: true },
            reason: { type: 'string' },
            tasks: { type: 'integer' },
            pending: { type: 'integer' },
            // 拒绝分支会带上在飞任务数 / 批准与当前图指纹；不声明就会被
            // additionalProperties:false 拒掉整个结果（复核实测：重复 teams_run 与改图后 teams_run）
            running: { type: 'integer' },
            approvedGraph: { type: 'string' },
            currentGraph: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderText(
            value.started
              ? `团队已开始执行：共 ${value.tasks} 个任务，待派发 ${value.pending} 个`
              : `未启动：${value.reason ?? ''}`,
          ),
      },
      async execute(args, exec) {
        const { agent, captainSessionId, workspace } = captainOf(exec);
        return startTeamRun({
          ctx,
          config,
          agent,
          captainSessionId,
          workspace,
          providerName: args.provider,
          model: args.model,
        });
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 7) teams_retry — 从失败处续跑（不重头再来）
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_retry',
      description:
        '续跑：把失败与受阻的任务重新排上并继续调度，同时把上一次的部分产出作为「续写起点」注入任务卡（成员会先核对工作区实际状态，只补缺口、不重头再来）。已完成的步骤不会被重做。',
      parameters: {
        provider: { type: 'string', description: '子代理提供者名，默认为 spawn' },
        model: { type: 'string', description: '可选模型覆盖；不填则跟随配置与会话默认' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            started: { type: 'boolean', required: true },
            reason: { type: 'string' },
            retried: { type: 'integer' },
            resumed: { type: 'integer' },
          },
        },
        render: (_args, value) =>
          renderText(
            value.started
              ? `已续跑：重新排上 ${value.retried} 个任务，其中 ${value.resumed} 个带上了续写起点`
              : `未续跑：${value.reason ?? ''}`,
          ),
      },
      async execute(args, exec) {
        const { agent, captainSessionId, workspace } = captainOf(exec);
        const retry = await retryFailedTeam({ config, captainSessionId, workspace });
        if (!retry.started) return retry;

        const started = await startTeamRun({
          ctx,
          config,
          agent,
          captainSessionId,
          workspace,
          providerName: args.provider,
          model: args.model,
        });
        if (!started.started) return { started: false, reason: started.reason };
        return { started: true, retried: retry.retried, resumed: retry.resumed };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 8) teams_role_save — 新增/覆盖自定义角色
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_role_save',
      description:
        '新增或覆盖一个自定义角色（写入工作区状态目录的 roles/ 下，可随时编辑删除）。内置的 16 个角色是只读的，不能通过本工具修改；同名时会覆盖为自定义版本。写入前会校验格式。',
      parameters: {
        role_id: {
          type: 'string',
          required: true,
          description: '角色 id（小写字母、数字、短横线），例如 db-tuning',
        },
        name: { type: 'string', required: true, description: '角色显示名，例如 数据库调优工程师' },
        description: { type: 'string', required: true, description: '一句话说明该角色做什么' },
        prompt: {
          type: 'string',
          required: true,
          description:
            '角色契约正文。建议按固定结构写：一句话职责 / 权限边界 / 编号工作步骤 / 输出契约（结论·证据·变更清单·未确认项）/ 预算与纪律',
        },
        emoji: { type: 'string', description: '角色图标 emoji' },
        permissions: {
          type: 'string',
          enum: ['readonly', 'readwrite', 'execute'],
          description: '权限档：readonly 只读；readwrite 可改文件；execute 可改文件并执行命令',
        },
        tier: {
          type: 'string',
          enum: ['heavy', 'medium', 'light', 'infrastructure'],
          description: '超时档：heavy 15 分钟 / medium 8 分钟 / light 5 分钟 / infrastructure 3 分钟',
        },
        read_budget: { type: 'integer', description: '最多读取文件数，默认 6' },
        output_budget: { type: 'integer', description: '输出字数上限，默认 900' },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description:
            '触发词：任务描述命中其中任一词时，这个专家会被自动插进流水线（插在实现步骤之前，产出作为依赖喂给执行者）。例如 python、pytest、django',
        },
        category: { type: 'string', description: '分类（仅用于界面分组），例如 数据 / 前端 / 文档' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            saved: { type: 'boolean', required: true },
            file: { type: 'string' },
            overrode_builtin: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) =>
          renderText(
            value.saved
              ? `已保存自定义角色，文件：${value.file}${value.overrode_builtin ? '（覆盖了同名内置角色）' : ''}`
              : `保存失败：${(value.errors ?? []).join('；')}`,
          ),
      },
      async execute(args, exec) {
        const { workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
        const rolesDir = userRolesDir(stateRoot);

        const validation = validateCustomRole({
          slug: args.role_id,
          name: args.name,
          description: args.description,
          prompt: args.prompt,
          emoji: args.emoji,
          permissions: args.permissions,
          tier: args.tier,
          readBudget: args.read_budget,
          outputBudget: args.output_budget,
          triggers: args.triggers,
          category: args.category,
        });
        if (!validation.ok) {
          return { saved: false, errors: validation.errors };
        }

        const slug = String(args.role_id).trim().toLowerCase();
        // 覆盖内置角色是允许的（用户自定义优先），但要如实告知
        const library = await loadRoles(rolesDir);
        const overrodeBuiltin = library.allBySlug?.get(slug)?.builtin === true;

        await ensureStateDirs(stateRoot);
        const file = join(rolesDir, `${slug}.md`);
        await writeFileAtomic(file, validation.markdown);

        invalidateRoles(stateRoot);
        await appendEvent({
          stateRoot,
          type: 'note',
          team: null,
          data: { level: 'info', message: `角色已保存：${slug}` },
        });

        return { saved: true, file, overrode_builtin: overrodeBuiltin };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 9) teams_stop — 停止正在跑的调度循环
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_stop',
      description:
        '停止当前会话正在运行的调度循环：不再挑新任务，并中断正在等待的子代理。已派发任务的产出会照常落盘。没有循环在跑时返回 stopped=false。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { stopped: { type: 'boolean', required: true }, reason: { type: 'string' } },
        },
        render: (_args, value) =>
          renderText(value.stopped ? '已请求停止：不再派发新任务' : `没有可停止的循环：${value.reason ?? '当前没有在跑'}`),
      },
      async execute(_args, exec) {
        const { captainSessionId, workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
        const stopped = stopRun(stateRoot, captainSessionId);
        await appendEvent({
          stateRoot,
          type: 'gate',
          team: captainSessionId,
          data: { action: 'stop', stopped },
        }).catch(() => {});
        return stopped ? { stopped: true } : { stopped: false, reason: '当前没有在跑的调度循环' };
      },
    }),
  );

  /* ---------------------------------------------------------------- *
   * 10) teams_role_manage — 启停 / 删除角色
   * ---------------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'teams_role_manage',
      description:
        '管理角色：enable/disable 启停任意角色（停用后不会被流水线派发；executor 与 verifier 是核心角色不可停用），delete 删除自定义角色（内置角色不可删除）。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['enable', 'disable', 'delete'],
          description: '操作类型',
        },
        role: { type: 'string', required: true, description: '角色 id 或显示名，例如 db-tuning' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            role: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        render: (_args, value) =>
          renderText(
            value.ok
              ? `${value.role}：${value.enabled === undefined ? '已删除' : value.enabled ? '已启用' : '已停用'}`
              : `未执行：${value.reason ?? ''}`,
          ),
      },
      async execute(args, exec) {
        const { workspace } = captainOf(exec);
        const stateRoot = stateRootOf(workspace, readField(config?.stateDir, '.dsh-teams'));
        const rolesDir = userRolesDir(stateRoot);
        const library = await loadRoles(rolesDir);
        const role = resolveRole(library, args.role);
        if (role === undefined) return { ok: false, reason: `找不到角色：${args.role}` };

        if (args.action === 'delete') {
          if (role.builtin === true) return { ok: false, reason: '内置角色不可删除（只能停用）' };
          await rm(role.path, { force: true });
          invalidateRoles(stateRoot);
          await setRoleEnabled(stateRoot, role.slug, true);
          await appendEvent({
            stateRoot,
            type: 'note',
            team: null,
            data: { level: 'info', message: `自定义角色已删除：${role.slug}` },
          });
          return { ok: true, role: role.slug };
        }

        const enabled = args.action === 'enable';
        const allowed = validateToggle(role.slug, enabled);
        if (!allowed.ok) return { ok: false, reason: allowed.reason };

        await setRoleEnabled(stateRoot, role.slug, enabled);
        invalidateRoles(stateRoot);
        await appendEvent({
          stateRoot,
          type: 'gate',
          team: null,
          data: { action: enabled ? 'role-enable' : 'role-disable', role: role.slug },
        });
        return { ok: true, role: role.slug, enabled };
      },
    }),
  );
}

/**
 * 系统提示段：只在主代理上下文中出现，子代理不注入。
 *
 * 目的不是"教模型一套流程"，而是让它知道工具存在、以及**何时不该用**。
 * 刻意写得很短——长提示会稀释注意力，纪律应当由宿主代码保证。
 */
function usageSectionText() {
  return [
    '## 团队流水线（dsh-teams）',
    '工具：`teams_route` 决策路径；`teams_plan` 生成任务图；`teams_approve` 批准；`teams_run` 启动；`teams_status` 看进度；`teams_stop` 停止；`teams_retry` 从失败处续跑；`teams_roles` 查角色；`teams_role_save` 新建/覆盖自定义角色；`teams_role_manage` 启停或删除角色。',
    '用户也可直接用斜杠命令：`/teams-plan <目标>`、`/teams-status`、`/teams-approve`、`/teams-run`、`/teams-retry`、`/teams-stop`、`/teams-roles`。',
    '标准流程：`teams_route` 定路径 → `teams_plan` 生成任务图 → **把任务图给用户确认** → `teams_approve` → `teams_run`。',
    '闸门是硬的：未调用 `teams_approve` 前 `teams_run` 会拒绝执行，不要绕过用户确认。',
    '`teams_run` 立即返回并在后台跑，用 `teams_status` 或团队视图看进度，不要反复轮询。',
    '不要用：单纯问答、信息查询、读文件解释、单行改动、以及用户已明确指定做法时——这些直接做即可。',
    '路径含义：快速=小改直接实现并审查；标准=先需求后架构再实现；完整=多一轮批判与安全审查；调试=先定位根因再修；部署=备份与回滚优先并独立验证。',
    '涉及认证、支付、凭据、数据安全的改动不要降级路径。',
    '质量门是可机器判定的：评审/验证类角色必须在产出末行写 `VERDICT: PASS|FAIL|BLOCKED`，缺这行按未通过处理；判 FAIL 会自动把实现步骤退回重做（轮数受 maxReviewRounds 限制）。',
    '驳回轮次用尽时任务标为 `blocked` 并带 `needsDecision`（团队阶段 `needing-decision`，不是失败）：这表示评审要求超出了执行者的改动范围，需人拍板；改范围或方案后用 `teams_retry` 续跑。安全审查 FAIL 仍是终局失败。',
    '角色可停用：被停用的角色不会被派发；`executor` 与 `verifier` 是核心角色不可停用。自定义角色可带触发词，任务命中时会被自动插进流水线。',
  ].join('\n');
}

/**
 * 安装 Web 表面（团队视图的数据源）。
 *
 * `webServer` 不一定在插件激活时已就绪，因此用 `internal/service` 惰性等待；
 * 每次注册都包在 ctx.effect 里，卸载时自动摘除路由。
 */
function installWebSurface(ctx, config) {
  let installed = false;

  const install = () => {
    if (installed) return;
    const rawWebServer = ctx.get('webServer') ?? ctx.get('httpServer');
    if (rawWebServer === undefined) return;
    installed = true;

    const webServer = authenticatedWebRoutes(rawWebServer, () => ctx.get('connection'));
    ctx.effect(
      () =>
        registerStateRoutes({
          webServer,
          config,
          // 惰性取值：注册时这些服务可能还没就绪，请求到达时再解析
          workspaceRegistry: () => ctx.get('workspaceRegistry') ?? ctx.get('workspace'),
          // 面板「批准并启动」：启动必须持队长**活着的 Agent**（runLoop → startActivation 的 parent）。
          // 路由层拿不到 tool 上下文，所以在宿主这边接线：按会话来取 Agent。
          // 取不到时如实拒绝，绝不假装已启动（否则面板显示"运行中"而实际零派发）。
          startRun: (args) => {
            const agent = ctx.agents?.get?.(args.captainSessionId);
            if (agent === undefined || agent === null) {
              return { started: false, reason: '该会话当前没有活动的 Agent，无法启动调度（请回到会话后重试）' };
            }
            return startTeamRun({ ...args, ctx, config, agent });
          },
        }),
      'dsh-teams: state route',
    );
  };

  install();
  if (!installed) {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === 'webServer' || serviceName === 'httpServer') install();
    });
  }
}

/**
 * 安装斜杠命令。
 *
 * `commands` 不一定在插件激活时就绪（也允许缺失），因此按需惰性注册。
 * 缺失时插件其余功能照常工作——命令只是入口的便利，不是核心能力。
 */
function installCommands(ctx, config) {
  const install = (commands) => {
    if (commands === undefined || typeof commands.register !== 'function') return;
    ctx.effect(() => registerCommands({ ctx, commands, config }), 'dsh-teams: slash commands');
  };

  install(ctx.get('commands'));
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'commands') install(ctx.get('commands'));
  });
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  /**
   * 读取一个配置叶子的当前值。
   *
   * 标了 `.volatile()` 的字段，宿主会把它解析成 cosmokit 的只读引用
   * （`Object.freeze({ get })`），必须 `.get()` 才拿得到值；直接把引用当值用会
   * 得到 `[object Object]`。没有走 Loader 的场合（单元测试直接传普通对象）
   * 原样返回，所以两种形态都要能吃。
   */
  const read = (ref, fallback) => {
    const value =
      ref !== null && typeof ref === 'object' && typeof ref.get === 'function' && Object.isFrozen(ref)
        ? ref.get()
        : ref;
    return value === undefined ? fallback : value;
  };

  /**
   * 配置视图。用 getter 而不是快照对象是有意的：宿主 Loader 对 volatile 字段走
   * `_commitVolatile()` **就地更新引用、不重挂插件**，所以只有每次现取，设置页
   * 保存的值才会立刻生效——否则界面显示"已保存"而运行行为不变。
   *
   * `timeouts` / `watch` 曾经漏在这里，导致 cordis.patch.yml 里配的墙钟与看门狗
   * 参数全部落不到 `resolveTimeoutMs()` / `watchLimits`（配置形同虚设）。
   */
  const resolved = {
    get stateDir() {
      return readField(config?.stateDir, '.dsh-teams');
    },
    routing: {
      get riskShortCircuit() {
        return read(config?.routing?.riskShortCircuit, true);
      },
      get fastMax() {
        return read(config?.routing?.fastMax, 1);
      },
      get standardMax() {
        return read(config?.routing?.standardMax, 4);
      },
    },
    scheduler: {
      get maxParallel() {
        return read(config?.scheduler?.maxParallel, 4);
      },
      get maxRetries() {
        return read(config?.scheduler?.maxRetries, 2);
      },
      get maxReviewRounds() {
        return read(config?.scheduler?.maxReviewRounds, 3);
      },
    },
    timeouts: {
      get enabled() {
        return read(config?.timeouts?.enabled, false);
      },
      get heavy() {
        return read(config?.timeouts?.heavy, 2700);
      },
      get medium() {
        return read(config?.timeouts?.medium, 1200);
      },
      get light() {
        return read(config?.timeouts?.light, 900);
      },
      get infrastructure() {
        return read(config?.timeouts?.infrastructure, 300);
      },
    },
    watch: {
      get probeMs() {
        return read(config?.watch?.probeMs, 10_000);
      },
      get idleGraceMs() {
        return read(config?.watch?.idleGraceMs, 5_000);
      },
      get silenceLimitMs() {
        return read(config?.watch?.silenceLimitMs, 600_000);
      },
      // ⚠️ 这两个以前只存在于 lib/config.js 的读取列表里，schema 与 apply 视图都没声明，
      // 于是 watchOverrides() 永远取不到 → 动态判死的阈值实际不可配（审计 R6-02）。
      get stallFloorMs() {
        return read(config?.watch?.stallFloorMs, 900_000);
      },
      get stallFactor() {
        return read(config?.watch?.stallFactor, 4);
      },
    },
    gates: {
      get requireEvidence() {
        return read(config?.gates?.requireEvidence, true);
      },
      get securityBlock() {
        return read(config?.gates?.securityBlock, true);
      },
    },
    ui: {
      get locale() {
        return read(config?.ui?.locale, 'zh-CN');
      },
    },
  };

  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'dsh-teams', order: PROMPT_SECTION_ORDER, text: usageSectionText() }),
    'dsh-teams: usage section',
  );

  registerTools(ctx, resolved);
  installCommands(ctx, resolved);
  installWebSurface(ctx, resolved);

  ctx.logger?.debug?.('dsh-teams: 已注册（stateDir=%s）', resolved.stateDir);
}

export { invalidateRoles };
