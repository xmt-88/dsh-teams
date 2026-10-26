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
export const DEP_OUTPUT_LIMIT = 6000;
/** 一个任务卡能承载的全部依赖产物上限（字符）。 */
export const DEP_TOTAL_LIMIT = 24000;

/** `路径:行号` 形态的证据行——智能截断时这些行一律保留（判定口径与 verdict.js 的 hasEvidence 对齐）。 */
const FILE_LINE = /(?:[\w.-]+[/\\])+[\w.-]+:\d+|\b[\w-]+\.\w{1,6}:\d+/;
/** 交接截断时与开头一起保留的结尾非空行数：与 verdict.js 的 VERDICT 解析窗口（8 行）对齐。 */
const HANDOFF_TAIL_LINES = 8;

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
    review: [
      '每个 finding 有文件与行号',
      '明确给出是否存在 CRITICAL/HIGH 的结论',
      '范围外发现单列在「范围外发现」小节，不作为 FAIL 依据',
      '末行给出 VERDICT',
    ],
    verification: [
      '项目自身可用的验证手段零错误（不存在该环节时写明「不适用」并给出等价验证）',
      '验收标准全部被证据覆盖',
      '无未解决的 CRITICAL/HIGH',
      '范围外问题单列，不作为 FAIL 依据',
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
 * 截断用 {@link truncateForHandoff}：只从开头切会把写在末尾的 `VERDICT` 切掉，
 * 下游既看不到 findings 也看不到结论（实测 2610 / 2924 字的报告都被 2000 字上限切在判定行之前）。
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
    const header = `### ${dep.roleName ?? dep.role}（${dep.id}）`;
    const remaining = DEP_TOTAL_LIMIT - total;
    if (remaining <= 0) {
      // 总量已被前面的产出占满：明确标注省了多少，而不是以前那样 `break` 静默丢弃
      sections.push(`${header}\n（总量已达 ${DEP_TOTAL_LIMIT} 字上限，本条 ${dep.output.length} 字未交接）`);
      continue;
    }
    // 单条上限之外还要受「总量剩余额度」约束；智能截断保证 body 不超过预算
    const body =
      remaining >= 200 ? truncateForHandoff(dep.output, Math.min(DEP_OUTPUT_LIMIT, remaining)) : '';
    if (body === '') {
      // 剩余额度连一句省略说明都放不下：明确标注，不塞半句正文
      sections.push(`${header}\n（剩余交接额度不足 ${remaining} 字，本条 ${dep.output.length} 字未交接）`);
      continue;
    }
    total += body.length;
    sections.push(`${header}\n${body}`);
  }
  return sections.join('\n\n');
}

/**
 * 交接用的智能截断：超限时保留「开头 + 全部文件:行号 + 结尾结论」。
 *
 * 为什么不能只从头切：评审/安全报告把 `VERDICT` 写在最后一行，切掉它等于
 * 下游既看不到 findings 也看不到判定——返工与验证都失去依据。
 *
 * 返回长度**始终**不超过 `limit`；恰好等于上限时原样返回（不截断）。
 *
 * @param {string} text
 * @param {number} limit - 字面上限
 * @returns {string}
 */
export function truncateForHandoff(text, limit) {
  const value = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(limit)));
  if (!Number.isFinite(max)) return value;
  if (value.length <= max) return value;
  if (max === 0) return '';

  const lines = value.split(/\r?\n/);
  // 1) 结尾结论块：最后 HANDOFF_TAIL_LINES 个非空行（连同其间的空行），覆盖 VERDICT 解析窗口
  let tailStart = lines.length;
  let nonEmpty = 0;
  for (let index = lines.length - 1; index >= 0 && nonEmpty < HANDOFF_TAIL_LINES; index -= 1) {
    if (lines[index].trim() === '') continue;
    nonEmpty += 1;
    tailStart = index;
  }
  const tail = lines.slice(tailStart).join('\n');

  // 2) 文件:行号 证据行：去重，避免开头已含的重复
  const seen = new Set(tail.split(/\r?\n/).map((line) => line.trim()));
  const evidence = [];
  for (let index = 0; index < tailStart; index += 1) {
    const line = lines[index].trim();
    if (line === '' || !FILE_LINE.test(line) || seen.has(line)) continue;
    seen.add(line);
    evidence.push(line);
  }

  // 3) 省略说明按最坏情况（原长位数 + 分隔符）预留，保证拼出来仍不超限
  const noteFor = (omitted) => `…（已智能截断：省略 ${omitted} 字，保留开头 + 全部「文件:行号」+ 结尾结论）`;

  // 最后一条非空行（结论行）的起始偏移：结尾预算至少要覆盖到它，
  // 否则「说明 + 结尾」会挤掉 VERDICT——这正是 200 字边界出问题的放大版。
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') lastNonEmpty -= 1;
  const conclusionStart = lastNonEmpty < 0 ? value.length : value.lastIndexOf(lines[lastNonEmpty]);
  const conclusionLen = value.length - conclusionStart;

  const inner = max - (noteFor(value.length).length + 4);
  // 只有「短结论行」才值得为它牺牲省略说明（整段单行正文没有独立结论行）。
  // 说明与结论放不下时优先保结论，退回纯结尾，绝不按开头切。
  const protectConclusion = conclusionLen > 0 && conclusionLen <= 200;
  if ((protectConclusion && inner < conclusionLen) || inner <= 0) {
    return value.slice(value.length - max);
  }

  // 结尾块最多占 inner 的 40%（下限 200，但不得超过 inner），并至少覆盖受保护的结论行；
  // 以前下限 200 在 inner<200 时会吃掉全部预算，拼装超限后再由末尾 slice 兜底，
  // 恰好把写在最后的 VERDICT 切掉。从结尾往前切，最后一行 VERDICT 一定保住。
  const tailCap = Math.max(
    protectConclusion ? conclusionLen : 0,
    Math.min(inner, Math.max(200, Math.floor(inner * 0.4))),
  );
  const keptTail = tail.length <= tailCap ? tail : tail.slice(tail.length - tailCap);
  let left = inner - keptTail.length;

  // 4) 证据行优先于开头（它们短、且是判定可复核的前提）
  const keptEvidenceLines = [];
  let evidenceUsed = 0;
  for (const line of evidence) {
    const cost = line.length + (keptEvidenceLines.length === 0 ? 0 : 1);
    if (evidenceUsed + cost > left) break;
    evidenceUsed += cost;
    keptEvidenceLines.push(line);
  }
  const keptEvidence = keptEvidenceLines.join('\n');
  left -= evidenceUsed;

  // 5) 剩余空间给开头；尽量切在换行处，别把一行拦腰截断
  let head = value.slice(0, Math.max(0, left));
  const cut = head.lastIndexOf('\n');
  if (cut > 0 && cut > head.length * 0.6) head = head.slice(0, cut + 1);

  const omitted = value.length - head.length - keptEvidence.length - keptTail.length;
  const parts = [];
  if (head.trim() !== '') parts.push(head.replace(/\n+$/, ''));
  if (keptEvidence !== '') parts.push(keptEvidence);
  parts.push(noteFor(omitted));
  if (keptTail !== '') parts.push(keptTail);
  const result = parts.join('\n');
  // 预算已按最坏情况预留，拼装后必然不超限；万一有意外开销，也只牺牲开头，
  // 绝不从尾部切——否则又会切掉写在最后的结论。
  if (result.length <= max) return result;
  const withoutHead = [keptEvidence, noteFor(omitted), keptTail].filter((part) => part !== '').join('\n');
  return withoutHead.length <= max ? withoutHead : value.slice(value.length - max);
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

/** 任务状态统计。`ready` 是**算出来的**，不是状态位（以前声明成计数器、恒为 0，审计 R6-04）。 */
export function summarize(tasks) {
  const stats = {
    total: tasks.length,
    pending: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    // 待队长决策：返工预算耗尽的评审门（blocked + needsDecision），必须与真失败分开计数
    needsDecision: 0,
  };
  for (const task of tasks) {
    const key = task.status ?? 'pending';
    if (Object.hasOwn(stats, key)) stats[key] += 1;
  }
  // ready = 依赖已满足且仍在排队的任务数；`skipped` 从未有写入者，删掉
  const byId = new Map(tasks.map((task) => [task.id, task]));
  stats.ready = tasks.filter((task) => task.status === 'pending' && depsSatisfied(task, byId)).length;
  stats.needsDecision = tasks.filter((task) => task.needsDecision !== undefined).length;
  return stats;
}
