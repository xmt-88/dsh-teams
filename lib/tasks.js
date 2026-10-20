/**
 * DSH Teams — 任务图组装
 *
 * 把路由决策（角色链 + 依赖模板）物化成可执行的任务 DAG。
 *
 * 设计原则：
 *   1. 任务在计划阶段就写好「验收标准」与「验证方式」——质量门靠它们判定，不靠模型自述。
 *   2. 依赖关系来自路径模板；相同依赖且互不依赖的步骤天然构成并行组。
 *   3. 任务图是**派生缓存**：可从决策与工作区重建，不是唯一真相来源。
 */

/** 单个任务在提示词里承载的依赖产物上限（字符）。 */
export const DEP_OUTPUT_LIMIT = 2000;
/** 一个任务卡能承载的全部依赖产物上限（字符）。 */
export const DEP_TOTAL_LIMIT = 12000;

/**
 * 生成一个稳定、可读的任务 id。
 * @param {string} stepId - 路径模板里的步骤 id
 * @returns {string}
 */
export function taskIdFor(stepId) {
  return `t-${stepId}`;
}

/**
 * 由路由决策组装任务图。
 *
 * @param {object} input
 * @param {import('./router.js').PATH_TEMPLATES} input.steps - 路由决策里的步骤模板
 * @param {string} input.teamId            - 队长会话 id
 * @param {string} input.subject           - 用户任务的一句话描述
 * @param {string} [input.brief]           - 目标详述（写进每个任务的 objective）
 * @param {string[]} [input.acceptance]    - 全局验收标准（会附加到实现类任务）
 * @param {{inScope?:string[], outOfScope?:string[]}} [input.scope]
 * @param {string} [input.workspace]
 * @param {(role:string)=>object|undefined} [input.roleOf] - 角色查询，用于拿 emoji 与超时档
 * @returns {{tasks: object[], seq: number}}
 */
export function buildTaskGraph({ steps, teamId, subject, brief, acceptance, scope, workspace, roleOf }) {
  const now = new Date().toISOString();
  const tasks = steps.map((step, index) => {
    const role = typeof roleOf === 'function' ? roleOf(step.role) : undefined;
    return {
      id: taskIdFor(step.id),
      stepId: step.id,
      teamId,
      subject: subjectFor(step, subject),
      // 计划期依赖快照：图指纹用它，运行期对 deps 的改动不影响审批有效性
      plannedDeps: [...(step.deps ?? [])],
      objective: objectiveFor(step, { brief, subject }),
      role: step.role,
      roleName: role?.name ?? step.role,
      emoji: role?.emoji ?? '🤖',
      kind: step.kind,
      order: index,
      status: 'pending',
      deps: step.deps.map(taskIdFor),
      assignee: step.role,
      acceptance: acceptanceFor(step, acceptance),
      inScope: scope?.inScope ?? [],
      outOfScope: scope?.outOfScope ?? [],
      evidence: [],
      artifacts: [],
      attempts: [],
      createdAt: now,
      updatedAt: now,
      ...(workspace === undefined ? {} : { workspace }),
    };
  });
  // subject 随图走：归档要按"上一轮的目标"标注（teams_plan 会先把 team.purpose 换成新任务）
  return { subject: typeof subject === 'string' ? subject : '', tasks, seq: tasks.length };
}

/** 任务的展示标题：优先用角色名，避免一串英文 slug。 */
function subjectFor(step, subject) {
  const label = STEP_LABELS[step.id] ?? step.role;
  return `${label}：${truncate(subject, 60)}`;
}

/** 各步骤的中文动作名，用于任务标题与 UI。 */
const STEP_LABELS = Object.freeze({
  analyst: '澄清需求与验收标准',
  ui: '输出界面方案',
  architect: '输出技术方案',
  critic: '挑战技术方案',
  executor: '实现代码变更',
  simplify: '简化代码（行为不变）',
  review: '代码审查',
  security: '安全审查',
  test: '补充并运行测试',
  verify: '最终验证',
  debugger: '定位根因',
  devops: '执行部署',
  'deploy-audit': '独立验证部署结果',
});

/** 任务的执行目标：把自己要做的事和全局目标都说清楚。 */
function objectiveFor(step, { brief, subject }) {
  const focus = STEP_FOCUS[step.id] ?? '';
  const parts = [`总目标：${truncate(subject, 200)}`];
  if (brief !== undefined && brief !== '') parts.push(`任务说明：${truncate(brief, 600)}`);
  if (focus !== '') parts.push(`本步骤聚焦：${focus}`);
  return parts.join('\n');
}

/** 每个步骤要聚焦什么——避免子代理各写一遍"我要做什么"的歧义。 */
const STEP_FOCUS = Object.freeze({
  analyst: '把模糊需求变成可验证的验收标准，识别边界与异常场景。',
  ui: '给出界面结构、全部状态覆盖与可访问性要求；不写实现代码。',
  architect: '给出可比较的技术方案与决策依据；不改代码。',
  critic: '找出会让方案失败的问题，按 BLOCKER/MAJOR/MINOR/OK 分类。',
  executor: '按上游方案实现，改动最小化，并交出可验证的构建/测试证据。',
  simplify: '在行为完全不变的前提下降低复杂度；有风险就放弃。',
  review: '只审查本次变更范围，按严重等级分类，每条都要有文件与行号。',
  security: '以攻击者视角检查注入、越权、密钥泄露、敏感数据与依赖风险。',
  test: '为每条验收标准补测试并真实执行，如实报告失败与通过率。',
  verify: '基于客观证据判定 PASS/FAIL，逐项列出检查项与证据。',
  debugger: '定位根因并给出可复现路径；未定位到根因前不要改代码。',
  devops: '确认回滚方案后再执行部署，并做健康检查。',
  'deploy-audit': '独立于部署者，只读验证线上实际状态与声称是否一致。',
});

/**
 * 任务自带的验收标准。
 *
 * 实现类任务必须带上全局验收标准，否则「做完了」无从判定。
 * 审查/验证类任务的标准由角色契约固定（PASS/FAIL + 证据），这里不重复。
 */
function acceptanceFor(step, acceptance) {
  // ⚠️ 验收项必须与**技术栈无关**。
  // 以前这里写死「构建或类型检查通过」——对纯 Python（无 mypy）、文档整理、
  // 数据分析类任务是无解的死结：验收项根本不存在，验证员要么违约要么必然 FAIL
  // （审计 P2-4）。现在一律写成"项目自身可用的验证手段"，由角色按实际栈选择。
  const own = {
    implementation: [
      '变更范围与方案一致',
      '项目自身可用的验证手段（构建 / 类型检查 / 测试 / 静态检查，按项目实际存在者）通过',
      '不残留调试代码',
    ],
    review: ['每个 finding 有文件与行号', '明确给出是否存在 CRITICAL/HIGH 的结论', '末行给出 VERDICT'],
    verification: [
      '项目自身可用的验证手段零错误（不存在该环节时写明「不适用」并给出等价验证）',
      '验收标准全部被证据覆盖',
      '无未解决的 CRITICAL/HIGH',
      '末行给出 VERDICT',
    ],
  }[step.kind];

  const list = [...(own ?? [])];
  if (step.kind === 'implementation' && Array.isArray(acceptance)) {
    list.push(...acceptance.map((item) => `用户验收：${item}`));
  }
  return list;
}

/**
 * 依赖产物汇总：把已完成依赖的输出拼成经验证的上下文。
 *
 * 逐条截断 + 总量截断，避免把上游的整篇报告灌进下游提示词。
 *
 * 只取 **done / skipped** 的依赖：失败任务现在也会保留"超时前的部分产出"
 * （供人排查），那份内容不该被当作完成的交接物喂给下游。判定口径与
 * {@link depsSatisfied} 保持一致。
 * @param {object} task
 * @param {object[]} tasks
 * @returns {string}
 */
export function collectDependencyOutputs(task, tasks) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const sections = [];
  let total = 0;

  for (const depId of task.deps) {
    const dep = byId.get(depId);
    if (dep === undefined) continue;
    if (dep.status !== 'done' && dep.status !== 'skipped') continue;
    if (typeof dep.output !== 'string' || dep.output.trim() === '') continue;
    const body = truncate(dep.output, DEP_OUTPUT_LIMIT);
    if (total + body.length > DEP_TOTAL_LIMIT) {
      sections.push(`### ${dep.roleName ?? dep.role}（${dep.id}）\n（内容过长，已省略）`);
      break;
    }
    total += body.length;
    sections.push(`### ${dep.roleName ?? dep.role}（${dep.id}）\n${body}`);
  }
  return sections.join('\n\n');
}

/** 截断并加省略号。 */
export function truncate(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，原长 ${value.length} 字）`;
}

/**
 * 依赖是否全部完成。
 * @param {object} task
 * @param {Map<string, object>} byId
 */
export function depsSatisfied(task, byId) {
  return task.deps.every((depId) => {
    const dep = byId.get(depId);
    return dep !== undefined && (dep.status === 'done' || dep.status === 'skipped');
  });
}

/** 依赖里是否有失败项——失败会让下游阻塞而不是继续跑。 */
export function depsBlocked(task, byId) {
  return task.deps.some((depId) => {
    const dep = byId.get(depId);
    return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked');
  });
}

/**
 * 挑出下一批可执行任务。
 *
 * `running` 是并行上限的计数依据；同批返回的任务互不依赖，可安全并行。
 * @param {object[]} tasks
 * @param {number} runningCount
 * @param {number} maxParallel
 * @returns {{ready: object[], blocked: object[]}}
 */
export function pickReady(tasks, runningCount, maxParallel) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ready = [];
  const blocked = [];

  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (depsBlocked(task, byId)) {
      blocked.push(task);
      continue;
    }
    if (depsSatisfied(task, byId)) ready.push(task);
  }

  // 按模板顺序取，保证同一批的确定性；再受并行上限约束
  ready.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const slots = Math.max(0, maxParallel - runningCount);
  return { ready: ready.slice(0, slots), blocked };
}

/** 任务状态统计。 */
export function summarize(tasks) {
  const stats = { total: tasks.length, pending: 0, ready: 0, running: 0, blocked: 0, done: 0, failed: 0, skipped: 0 };
  for (const task of tasks) {
    const key = task.status ?? 'pending';
    if (Object.hasOwn(stats, key)) stats[key] += 1;
  }
  return stats;
}
