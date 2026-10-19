/**
 * DSH Teams — 子代理运行器
 *
 * 职责：把一个任务派发给一个角色子代理，等它跑完，把输出与证据收回任务记录。
 *
 * 关键契约（已对照宿主 `ctx.subagents` 的真实类型逐条核实，**含 0.2.1-rc.2 的破坏性变更**）：
 *   - **0.2.1-rc.2 起**：`ctx.subagents.startActivation(spec)` → `SubagentActivation`
 *     spec = { provider, label, request, signal, delivery }
 *     request = { prompt, parent, cwd?, agentPreset?, agentOptions?, outputSchema?, maxDepth? }
 *     返回 = { childId, messageId?, result, dispose }（**没有 localAgent**）
 *   - 旧版（≤0.2.0）：`ctx.subagents.start(provider, request)` → `SubagentRun`
 *     request = { prompt, parent, signal, persona?, toolFilter?, agentOptions?, maxDepth? }
 *     返回 = { id, localAgent, result, dispose }
 *   - `result` → `SubagentResult { output, stopReason }`（两种版本一致）
 *     stopReason: completed | aborted | error | max-tokens | refusal
 *   - 角色契约：旧版走 **persona**（子代理系统提示段）；0.2.1 起 persona 归 agent preset 所有，
 *     所以改为**注入任务卡开头**（子代理仍是全新会话、零父上下文，语义等价）
 *
 * 重要设计决定：用一次性派发而不是常驻（continuable）。
 * 团队任务是一次性工作单元，不需要后续消息往来；一次性运行能直接 await 结果，
 * 省掉一整套子会话生命周期管理。递归膨胀由 `maxDepth` 挡住——0.2.1 起
 * `toolFilter` 已从契约里移除，所以那不再是我们的防线。
 */

import { resolveTimeouts } from './config.js';
import { verdictInstruction } from './verdict.js';

/** 默认子代理提供者。 */
export const DEFAULT_PROVIDER = 'spawn';

/**
 * 计算本次派发的子代理「绝对深度」——也就是该传的 maxDepth。
 *
 * 为什么不能写死：宿主 `runs` 校验的是 `delegationDepthOf(parent) + 1 > maxDepth`
 * （见 @deepseek-ai/dsh-subagent 的 resolveChildDepth）。队长的深度取决于
 * 「谁启动了这支团队」——顶层会话是 0，但队长自身是子代理时就是 1（甚至更深）。
 * 写死 1 只能覆盖顶层队长：队长深度为 1 时子代理深度是 2 > 1，派发会被
 * `subagent depth 2 exceeds maxDepth 1` 直接拒掉。
 *
 * 所以从 parent 现算：深度只用于「自身」这一层，子代理再往下派孙子时深度仍会超限，
 * 防递归膨胀的语义不变。读不到深度信息时退回 1（等价于旧的顶层行为）。
 *
 * @param {object} parent - 队长 agent
 * @returns {number} 子代理的绝对深度（非负安全整数）
 */
export function resolveChildDelegationDepth(parent) {
  // 会话头是权威且单调的，运行时 options 只能加深，不能变浅——与宿主 delegationDepthOf 一致。
  const fromHeader = parent?.session?.header?.delegationDepth;
  const fromOptions = parent?.options?.subagentDepth;
  const candidates = [fromHeader, fromOptions].filter(
    (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  );
  const parentDepth = candidates.length > 0 ? Math.max(...candidates) : 0;
  return parentDepth + 1;
}

/**
 * 超时档 → 毫秒（兜底默认值，可被 `config.timeouts` 覆盖，单位为秒）。
 *
 * 数值全部来自真实运行实测，不是拍脑袋。按「角色实际要干的活」分档，而不是按重要性：
 *
 *   | 角色            | 档位   | 实测耗时      | 结果 |
 *   |-----------------|--------|---------------|------|
 *   | analyst         | medium | 199 / 234 / 444 秒 | 稳过（后两次靠看门狗回收） |
 *   | architect       | medium | 322 / 243 / 512 秒 | 稳过（同上） |
 *   | code-reviewer   | light→medium | 300×3 撞穿 → 343 / 617 秒 | 旧 light 全灭 |
 *   | executor        | heavy  | 855 / 949 / 1152 / **1806（被砍）** 秒 | 旧 900 秒必死；30 分钟也砍过一次 |
 *   | test-engineer   | medium→heavy | >900 撞穿 → **1493** 秒 | 差 7 秒撞穿 1500 |
 *   | verifier        | light→medium | >600 撞穿     | 待验 |
 *
 * 结论：**凡是真的干活（写代码、写测试、跑测试）的角色都要 10~25 分钟**，
 * 只有纯读报告的角色能在 5 分钟内收工。heavy 再加码的依据是**步数算术**：
 * executor 那次被砍时已经跑到第 39 步、每步平均 46 秒（模型在长上下文下的固有延迟），
 * 39 × 46 ≈ 30 分钟——**它是在自己的收尾 `node --test` 上被砍的**，而交付物当时已经全绿。
 *
 * 所以 heavy 提到 45 分钟。这个上限之所以敢给这么足，是因为**判死不再靠它**：
 * 「跑完了只是 result 没回来」由 `harvestFromSession` 接住，「真卡死」由看门狗
 * 在宽限后切断；墙钟只负责最后兜底。
 */
export const TIMEOUT_MS = Object.freeze({
  heavy: 2_700_000,
  medium: 1_200_000,
  light: 900_000,
  infrastructure: 300_000,
});

/**
 * 解析某个角色的超时预算：`config.timeouts[tier]`（秒）优先，否则用档位默认值。
 *
 * tier 缺失或未知一律按 `medium` 处理——配置查找与默认值查找用同一个口径，
 * 免得出现「配置取到了 medium 的值、默认值却走了另一档」这种不对称。
 *
 * ⚠️ **默认不设墙钟上限**（`timeouts.enabled` 默认 false）：返回 `undefined` 表示"不掐"。
 * 理由见 WATCH_LIMITS 里动态停滞判定的注释——墙钟惩罚的是任务大，而大任务正是我们该让它跑完的。
 * 想恢复"到点就砍"的老行为，把 `timeouts.enabled` 设为 true 即可。
 *
 * @param {object} [config] - 插件配置
 * @param {object} [role] - 角色记录（取 tier）
 * @returns {number|undefined} 毫秒；undefined = 不设上限
 */
export function resolveTimeoutMs(config, role) {
  const timeouts = resolveTimeouts(config);
  if (timeouts.enabled !== true) return undefined;
  const tier = role?.tier ?? 'medium';
  const configured = timeouts[tier];
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.round(configured * 1000);
  }
  return TIMEOUT_MS[tier] ?? TIMEOUT_MS.medium;
}

/**
 * 看门狗默认参数（毫秒），可由 `config.watch` / `runTask({ watchLimits })` 覆盖。
 *
 * `probeMs`：采样间隔。读的是宿主内存里的 `Agent.status` 与 `Session.seq`，
 * **零 I/O**（不读磁盘、不查会话库），所以可以便宜地高频采样。
 *
 * `idleGraceMs`：子代理的回合**真的结束**（会话里出现 `turn/end`）之后，再给宿主结果这么久的宽限。
 * 宽限不需要长：驱动里 `whenIdle()` 之后 `readResult` 是**纯同步**的，`run.result` 在回合结束那一刻就结算，
 * 正常路径下它总是先到；回收只是"结果万一没来"的兜底。⚠️ 判据是 **turn/end 存在**，
 * 不是 `status === 'idle'`——工具执行期间驱动不在跑模型回合，采样很容易落在那种空档里。
 *
 * `stallFloorMs` / `stallFactor`：**动态停滞判定**——真正的判死依据。
 *
 * 判据不是"跑了多久"，而是"**多久没有进展**"，并且阈值随该子代理自己的节奏自适应：
 *
 *   停滞窗口 = max(stallFloorMs, 已观测的最长进展间隔 × stallFactor)
 *
 * 为什么这么设计：墙钟（`timeouts`）惩罚的是"任务大"，而大任务恰恰是我们最该让它跑完的。
 * 实测教训：architect 在一个大任务上跑了 20 分钟、175 个事件、一直在推进，却被 1200 秒墙钟砍掉，
 * 整步工作作废（连半成品都没留下）；而真正卡死的子代理，特征从来不是"跑得久"，而是"不动了"。
 *
 * 自适应那一半同样重要：一个频繁推进的子代理（几十次工具调用）说明它节奏很快，
 * 那么它一旦静默超过自身最长间隔的若干倍，就非常可疑；反过来，一个本来就慢的子代理
 * （单次模型调用就要几分钟）不会因为"慢"被误杀。下限兜住"刚开始还没测出节奏"的阶段。
 *
 * `silenceLimitMs`：游标多久不前进就**记一笔静默**（写进 evidence 的 `silent` 标记），仅用于观测。
 */
export const WATCH_LIMITS = Object.freeze({
  probeMs: 10_000,
  idleGraceMs: 5_000,
  silenceLimitMs: 600_000,
  // 动态停滞判定：15 分钟下限，或该子代理已观测最长间隔的 4 倍，取较大者
  stallFloorMs: 900_000,
  stallFactor: 4,
});

/**
 * 取消子代理：优先走 `Agent.cancel(cause)`——取消原因会写进子代理自己的会话日志，
 * 事后能查"是谁在什么时候把它掐了、为什么"；再退回我们自己的 AbortSignal。
 *
 * @param {object|undefined} localAgent
 * @param {string} reason
 * @returns {'agent.cancel'|'signal'}
 */
function cancelChild(localAgent, reason) {
  try {
    if (localAgent !== undefined && typeof localAgent.cancel === 'function') {
      localAgent.cancel({ kind: 'hook', reason });
      return 'agent.cancel';
    }
  } catch {
    /* 取消失败不能掩盖原始失败原因 */
  }
  return 'signal';
}

/**
 * 从子代理自己的会话里回收产出。
 *
 * 背景（真实事故）：宿主把 `run.result` 交回来之前，子代理的回合可能早就结束了——
 * 实测 analyst 在 288 秒时 `turn/end` 已完成、3280 字的答复已落进会话日志，
 * 而 result 26 秒后仍未返回。此时若把 `idle` 当失败判据去杀它，就是纯误杀。
 *
 * `Agent.session` 是内存对象，读它零 I/O。所以判定顺序应当是：
 * **先问「这个回合是怎么结束的」，再决定是接住产出、还是判定卡死。**
 *
 * @param {object|undefined} localAgent
 * @returns {{turnEndKind:string, output:string}|undefined} 没有 turn/end 时返回 undefined（＝真的还没跑完）
 */
export function harvestFromSession(localAgent) {
  try {
    const session = localAgent?.session;
    if (session === undefined || typeof session.ownEvents !== 'function') return undefined;
    const events = session.ownEvents();
    if (!Array.isArray(events)) return undefined;

    const lastTurnEnd = [...events].reverse().find((event) => event?.type === 'turn/end');
    if (lastTurnEnd === undefined) return undefined;

    let output = '';
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue;
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      const text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
        .trim();
      if (text !== '') output = text;
    }

    return { turnEndKind: String(lastTurnEnd.data?.reason?.kind ?? 'unknown'), output };
  } catch {
    /* 读不到就当没有——不能因为回收失败把正常流程带崩 */
    return undefined;
  }
}

/**
 * 构造角色子代理的 persona（系统提示段）。
 *
 * 刻意把「预算与纪律」放在最后并重复关键约束：DeepSeek 系对结尾处的指令
 * 服从度更高，而这是最容易被长上下文稀释的部分。
 *
 * @param {object} role - 角色记录（来自 roles.js）
 * @param {object} task - 任务记录
 * @returns {string}
 */
export function buildPersona(role, task) {
  const lines = [
    role.prompt,
    '',
    // 门类任务（review / verification）必须有机器可读的终局判定，
    // 否则宿主无法区分"跑完了"和"通过了"（审计 P0-1）。
    ...(task.kind === 'review' || task.kind === 'verification' ? [verdictInstruction(), ''] : []),
    '## 本次任务的身份与纪律（提示词约束，不是宿主沙箱）',
    `- 你是团队里的「${role.name}」，当前任务 id：${task.id}`,
    `- 读取预算：最多 ${role.readBudget} 个文件；>300 行的文件先定位再读片段，不要整读`,
    `- 输出预算：${role.outputBudget} 字以内（代码不计入）`,
    '- 每个结论都要能指到证据：文件路径:行号，或命令 + 退出码',
    '- 不确定的事实必须写进「未确认项」，禁止把推测写成结论',
    '- 只做本步骤的事，不要越界替其他角色做决定',
    '- 角色契约是行为指导，不构成权限边界；你实际能用哪些工具由宿主授予，别假设自己"只能读"',
    '- 完成任务后按上面的「输出契约」小节输出，不要改小节标题',
  ];
  return lines.join('\n');
}

/**
 * 构造任务卡（首条用户消息）。
 *
 * @param {object} input
 * @param {object} input.task
 * @param {string} [input.teamGoal]
 * @param {string} [input.dependencyOutputs]
 * @returns {string}
 */
export function buildTaskPrompt({ task, teamGoal, dependencyOutputs }) {
  const sections = [];

  sections.push('## 任务');
  sections.push(`- 任务 id：${task.id}`);
  sections.push(`- 你的角色：${task.roleName ?? task.role}`);
  if (task.objective) sections.push(`- 目标：\n${task.objective}`);
  if (teamGoal) sections.push(`- 团队总目标：${teamGoal}`);

  // 续跑：上一次尝试被预算砍掉时留下的半成品。必须带回去，否则十几分钟的工作全部作废。
  if (typeof task.resumeFrom === 'string' && task.resumeFrom.trim() !== '') {
    sections.push('');
    sections.push('## ⚠️ 这是一次「续跑」，不是新任务');
    sections.push(
      `同一步的上一次尝试因为**角色预算耗尽**被中断了。工作区里可能已经留下了它改到一半的东西，下面是从它的会话里回收到的部分产出。`,
    );
    sections.push('');
    sections.push('动手之前先做三件事：');
    sections.push('1. **亲自核对工作区的当前实际状态**（读文件、跑测试）——下面这段是"它当时说它做了什么"，不是"现在是什么样"，可能已经过时或根本没落地。');
    sections.push('2. 判断它已经做到哪一步、还差什么。');
    sections.push('3. **只补缺口，不要重头再来**——已经正确的部分不要重写，也不要推翻重做。');
    sections.push('');
    sections.push('### 上一次尝试留下的部分产出（仅供参考，不作为事实依据）');
    sections.push(task.resumeFrom);
  }

  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) {
    sections.push('');
    sections.push('## 验收标准（逐条确认是否满足）');
    for (const item of task.acceptance) sections.push(`- ${item}`);
  }

  if (Array.isArray(task.inScope) && task.inScope.length > 0) {
    sections.push('');
    sections.push('## 允许改动的范围');
    for (const item of task.inScope) sections.push(`- ${item}`);
  }
  if (Array.isArray(task.outOfScope) && task.outOfScope.length > 0) {
    sections.push('');
    sections.push('## 明确不要动的地方');
    for (const item of task.outOfScope) sections.push(`- ${item}`);
  }

  sections.push('');
  sections.push('## 范围纪律（违反即视为交付失败）');
  sections.push('- 只改动「允许改动的范围」内的文件；「明确不要动的地方」一律不得修改。');
  sections.push('- 即使你确信范围外的某个文件就是根因，也不要动手：把判断与证据写进报告，由队长决定。');
  sections.push('- 状态目录（如 .dsh-teams/）里的 events.jsonl 是**跨轮累积的历史日志**，含之前失败运行的记录，不代表当前状态；判断现状请以本任务卡与上游产出为准。');

  if (typeof dependencyOutputs === 'string' && dependencyOutputs.trim() !== '') {
    sections.push('');
    sections.push('## 上游产出（已完成步骤的交接内容）');
    sections.push(dependencyOutputs);
  }

  sections.push('');
  sections.push('现在开始。完成后按你角色契约里的「输出契约」小节输出。');
  return sections.join('\n');
}

/**
 * 派发一个子代理，同时兼容 0.2.1 前后的两种宿主契约。
 *
 * **0.2.1-rc.2 改了契约**（逐条对照 `dsh-subagent` 的 typert 方法表核实）：
 *   - `subagents.start(provider, request)` → **已移除**，改为 `startActivation(spec)`
 *   - spec 形状是 `{ provider, label, request, signal, delivery }`：`label`/`signal` 提到外层，
 *     `request` 里不再有它们
 *   - 返回 `SubagentActivation { childId, messageId?, result, dispose }`——**不再有 `localAgent`**
 *   - `SubagentCapabilities` 去掉了 `persona`/`toolFilter`、新增 `agentPreset`；
 *     `SubagentStartRequest` 不再接受 `persona`/`toolFilter`
 *
 * 应对：新契约优先、旧契约兜底；子代理 Agent 改从 `ctx.agents.get(childId)` 取
 * （新版内部到处这么解析活着的 Agent，见 `dsh-subagent` 里的 `this.ctx.agents.get(...)`）。
 *
 * @param {object} ctx - 插件上下文（用来取 agents 服务）
 * @param {object} subagents - 宿主 subagents 服务
 * @param {object} input
 * @returns {Promise<{id: string, result: Promise<object>, dispose: Function, localAgent: object|undefined, api: string}>}
 */
async function startChild(ctx, subagents, input) {
  const { providerName, label, promptText, parent, signal, model, maxDepth, cwd } = input;
  const routeOptions = model === undefined || model === '' ? {} : { agentOptions: { model } };

  if (typeof subagents.startActivation === 'function') {
    const activation = await subagents.startActivation({
      provider: providerName,
      label,
      request: {
        prompt: [{ type: 'text', text: promptText }],
        parent,
        // 0.2.1 新增：显式指定子代理的工作目录，让它一开始就站在正确的工作区里
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        ...routeOptions,
        maxDepth,
      },
      signal,
      // 'caller' = 结果回到我们手里（我们自己 await 它）；'parent' 会把结果投递到父会话收件箱
      delivery: 'caller',
    });
    return {
      id: String(activation.childId ?? ''),
      result: activation.result,
      dispose: activation.dispose,
      localAgent: ctx?.get?.('agents')?.get?.(activation.childId),
      api: 'startActivation',
    };
  }

  if (typeof subagents.start === 'function') {
    const run = await subagents.start(providerName, {
      label,
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal,
      ...routeOptions,
      maxDepth,
    });
    return { id: String(run.id ?? ''), result: run.result, dispose: run.dispose, localAgent: run.localAgent, api: 'start' };
  }

  throw new Error('宿主未提供可用的子代理派发接口（既没有 startActivation 也没有 start）');
}

/**
 * 统计一个子代理这一跑的用量：步数、token、缓存命中。
 *
 * 数据来自 `localAgent.session.ownEvents()`——**纯内存，零 I/O**，与看门狗读的是同一份事件。
 * 面板上"这一步花了多少"就靠它：不读会话日志文件（那是 zstd 多帧拼接，代价大且脆弱）。
 *
 * @param {object|undefined} localAgent
 * @returns {{steps:number, turns:number, inputTokens:number, cacheReadTokens:number, outputTokens:number}|undefined}
 */
export function harvestMetrics(localAgent) {
  if (localAgent === undefined || typeof localAgent.session?.ownEvents !== 'function') return undefined;
  let events;
  try {
    events = localAgent.session.ownEvents();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  let steps = 0;
  let turns = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event?.type === 'step/start') steps += 1;
    else if (event?.type === 'turn/start') turns += 1;
    else if (event?.type === 'assistant/message') {
      const usage = event.data?.usage;
      if (usage !== undefined) {
        inputTokens += usage.inputTokens ?? 0;
        cacheReadTokens += usage.cacheReadTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
      }
    }
  }
  return { steps, turns, inputTokens, cacheReadTokens, outputTokens };
}

/**
 * 从运行结果里提取文本输出。
 *
 * `result.output` 是内容块数组；只取文本块，忽略推理块与工具调用块——
 * 那些不是交接内容。
 *
 * @param {{output?: unknown[], stopReason?: string}} result
 * @returns {string}
 */
export function extractOutput(result) {
  const blocks = Array.isArray(result?.output) ? result.output : [];
  const texts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n\n').trim();
}

/**
 * 把 stopReason 映射为人类可读的失败原因。
 * @param {string} stopReason
 * @returns {string|undefined} undefined 表示正常完成
 */
export function describeStopReason(stopReason) {
  switch (stopReason) {
    case 'completed':
      return undefined;
    case 'aborted':
      return '运行被中断（可能是超时或被上层取消）';
    case 'max-tokens':
      return '输出达到 token 上限被截断';
    case 'refusal':
      return '模型拒绝执行该任务';
    case 'error':
      return '运行期发生错误';
    default:
      return `未预期的结束原因：${String(stopReason)}`;
  }
}

/**
 * 探测子代理提供者的能力，缺失时给出可操作的错误。
 *
 * @param {object} subagents - ctx.subagents
 * @param {string} providerName
 * @returns {{provider: object, capabilities: object}}
 */
export function requireProvider(subagents, providerName) {
  const provider = subagents.getProvider(providerName);
  if (provider === undefined) {
    const available = typeof subagents.list === 'function' ? subagents.list().join(', ') : '(无法列出)';
    throw new Error(`子代理提供者 "${providerName}" 不存在。可用：${available}`);
  }
  return { provider, capabilities: provider.capabilities ?? {} };
}

/**
 * 运行一个任务：派发 → 等待 → 回收输出。
 *
 * 不走异常路径做控制流：失败信息写进返回值，由调度器决定重试还是熔断。
 *
 * @param {object} input
 * @param {object} input.ctx           - 插件上下文（需要 subagents）
 * @param {Agent} input.parent         - 队长 agent
 * @param {object} input.task          - 任务记录
 * @param {object} input.role          - 角色记录
 * @param {string} [input.teamGoal]
 * @param {string} [input.dependencyOutputs]
 * @param {string} [input.providerName]
 * @param {string} [input.model]       - 可选模型覆盖（不写死，来自配置）
 * @param {number} [input.maxParallel]
 * @returns {Promise<{ok:boolean, output?:string, stopReason?:string, error?:string, childId?:string, startedAt:string, finishedAt:string, durationMs:number}>}
 */
export async function runTask({
  ctx,
  config,
  parent,
  task,
  role,
  teamGoal,
  dependencyOutputs,
  providerName = DEFAULT_PROVIDER,
  model,
  timeoutMs,
  watchLimits,
}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const limits = { ...WATCH_LIMITS, ...(watchLimits ?? {}) };

  // ⚠️ 声明必须早于 finish()：早退路径（缺 subagents 服务 / provider 不存在）也会调用
  // finish，声明晚于它就是 TDZ ReferenceError。这个缺陷曾经让整个团队"零派发却判 done"。
  let liveAgent;

  const finish = (payload) => {
    // 用量统计：面板上每张卡片要显示步数 / token / 缓存命中（只算一次）
    const metrics = harvestMetrics(liveAgent);
    return {
      ...payload,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...(metrics === undefined ? {} : { metrics }),
    };
  };

  const subagents = ctx.get('subagents');
  if (subagents === undefined) {
    return finish({ ok: false, error: '宿主未提供 subagents 服务，无法派发子代理' });
  }

  let provider;
  let capabilities;
  try {
    ({ provider, capabilities } = requireProvider(subagents, providerName));
  } catch (error) {
    return finish({ ok: false, error: String(error?.message ?? error) });
  }

  // 角色契约：0.2.1-rc.2 起宿主不再接受 `persona`（角色身份改由 **agent preset** 拥有，
  // 见 SubagentStartRequest 与 SubagentCapabilities 的变更），所以把契约放进任务卡开头。
  // 子代理仍是**全新会话、零父上下文**，契约内容一字未少，只是从系统提示段挪到了首条消息。
  const persona = buildPersona(role, task);
  const prompt = `${persona}\n\n---\n\n${buildTaskPrompt({ task, teamGoal, dependencyOutputs })}`;

  // 墙钟上限：undefined = 不设（默认）。由 `resolveTimeoutMs` 决定，见那里的注释。
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : resolveTimeoutMs(config, role);
  const controller = new AbortController();
  let timedOut = false;
  // ⚠️ liveAgent 已在文件上方声明（finish 需要它），这里不能再声明一次。
  // 墙钟闸门：**默认关闭**（`timeouts.enabled !== true` 时 effectiveTimeout 为 undefined）。
  // 开着的时候它是"到点就砍"，砍掉的往往是正在推进的大任务；默认交给动态停滞判定。
  const timer =
    effectiveTimeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          if (liveAgent !== undefined) cancelChild(liveAgent, 'dsh-teams: 角色预算耗尽');
          controller.abort();
        }, effectiveTimeout);

  let run;
  try {
    run = await startChild(ctx, subagents, {
      providerName,
      label: `teams:${task.teamId}:${task.id}:${role.slug}`,
      promptText: prompt,
      parent,
      signal: controller.signal,
      model,
      // 任务记录里带着工作区；显式传给子代理（0.2.1 起 SubagentStartRequest 支持 cwd）
      cwd: task.workspace,
      // 子代理不得再派团队：把它自身的深度设为上限（绝对深度，不是"还能再往下几层"）。
      // 深度按队长的真实深度现算，队长自身也是子代理时才不会被误拒。
      maxDepth: resolveChildDelegationDepth(parent),
    });
  } catch (error) {
    clearTimeout(timer);
    // 深度上限是宿主/用户设置，超出时给一句能直接照做的提示，而不是干巴巴的原始报错
    const detail = String(error?.message ?? error);
    const hint =
      error?.name === 'SubagentDepthError'
        ? `（宿主子代理深度上限过小：当前队长深度 ${resolveChildDelegationDepth(parent) - 1}，需要上限 ≥ ${resolveChildDelegationDepth(parent)}）`
        : '';
    return finish({ ok: false, error: `派发失败：${detail}${hint}` });
  }

  // 看门狗：拿到子代理的 Agent 就能读 `status`（idle/running）、`cancel(cause)`、
  // `session.seq`（会话游标）——纯内存操作，不必靠"墙钟一刀切"判断它是死是活。
  // ⚠️ 0.2.1-rc.2 起宿主**不再把 Agent 放进返回值**（`SubagentActivation` 只有
  // childId/messageId/result/dispose），所以改从 `ctx.agents.get(childId)` 解析。
  const localAgent = run.localAgent;
  liveAgent = localAgent;
  const watch = {
    hadLocalAgent: localAgent !== undefined,
    api: run.api,
    sawRunning: false,
    lastSeq: undefined,
    lastProgressAt: Date.now(),
    idleAt: undefined,
    verdict: undefined,
    cancelVia: undefined,
  };

  const settleWatch = (verdict) => {
    if (watch.verdict === undefined) {
      watch.verdict = verdict;
      resolveWatch({ kind: 'watch', verdict });
    }
  };

  let resolveWatch = () => {};
  const watchVerdict = new Promise((resolve) => {
    resolveWatch = resolve;
  });

  let watchdogTimer;
  if (localAgent !== undefined) {
    watchdogTimer = setInterval(() => {
      const status = String(localAgent.status ?? '');
      if (status === 'running') watch.sawRunning = true;

      const seq = localAgent.session?.seq;
      if (typeof seq === 'number') {
        if (seq !== watch.lastSeq) {
          const now = Date.now();
          // 记下"两次进展之间最长的一次间隔"：这是该子代理自己的节奏基准，
          // 停滞窗口据此自适应（见 WATCH_LIMITS 注释）
          if (watch.lastSeq !== undefined) {
            watch.maxGapMs = Math.max(watch.maxGapMs ?? 0, now - watch.lastProgressAt);
          }
          watch.lastSeq = seq;
          watch.lastProgressAt = now;
        }
      }

      // 还没见它跑起来就不做生死判定——派发瞬间 Agent 本来就是 idle
      if (!watch.sawRunning) return;

      // ---- 动态停滞判定：唯一以"没进展"为依据的判死路径 ----
      // 注意：它排在 idle 分支之前，因为"卡死的驱动"既可能报 idle 也可能报 running，
      // 而判据是**游标不动**，与 status 无关。
      const stallWindow = Math.max(limits.stallFloorMs, (watch.maxGapMs ?? 0) * limits.stallFactor);
      if (Date.now() - watch.lastProgressAt >= stallWindow) {
        watch.stallWindowMs = stallWindow;
        settleWatch('stalled');
        return;
      }

      if (status === 'idle') {
        // ⚠️ `status === 'idle'` 并不等于"它干完了"：工具执行期间驱动并不在跑模型回合，
        // 采样很容易落在这种空档里。**只有会话里真的出现 turn/end，才说明回合结束了。**
        // 判据必须落在"回合结束"上，否则会在子代理还在干活时下结论——上一轮就是这样
        // 把 analyst 误杀的（详见 harvestFromSession 注释）。
        const ended = harvestFromSession(localAgent);
        if (ended === undefined) {
          // 回合还没结束：这不是真空闲，把计时清掉，别攒出一个假的"宽限已够"
          watch.idleAt = undefined;
          return;
        }
        if (watch.idleAt === undefined) watch.idleAt = Date.now();
        else if (Date.now() - watch.idleAt >= limits.idleGraceMs) settleWatch('idle');
        return;
      }
      // 回到 running = 它又干活了：宽限按「连续空闲段」重新计
      watch.idleAt = undefined;
      // 游标长时间不动只记一笔，不判死：它可能只是在一次很长的模型调用里（见 WATCH_LIMITS 注释）
      if (Date.now() - watch.lastProgressAt >= limits.silenceLimitMs) watch.silent = true;
    }, limits.probeMs);

    // 事件驱动的空闲边沿：比轮询快，且只在见过 running 之后才认（否则可能是派发前的瞬时 idle）
    if (typeof localAgent.whenIdle === 'function') {
      Promise.resolve(localAgent.whenIdle()).then(
        () => {
          // 同样要"回合真的结束"才算数
          if (watch.sawRunning && harvestFromSession(localAgent) !== undefined) settleWatch('idle');
        },
        () => {
          /* whenIdle 失败不构成失败原因，轮询仍在兜底 */
        },
      );
    }
  }

  const clearWatch = () => {
    clearTimeout(timer);
    if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
  };

  try {
    const race = await Promise.race([
      run.result.then((value) => ({ kind: 'result', value })),
      watchVerdict,
    ]);
    clearWatch();

    if (race.kind === 'watch') {
      // 先问「这个回合到底是怎么结束的」——答案就在它自己的会话日志里（内存读）。
      // 只有"回合已经正常完成"时才回收产出；否则才是真的卡死/空转。
      const harvested = harvestFromSession(localAgent);

      if (harvested !== undefined && harvested.turnEndKind === 'completed' && harvested.output !== '') {
        // 它其实干完了，只是 result 还没交回来：接住产出，别杀它。
        // （实测 analyst：turn/end 已完成、3280 字答复已落盘，而 result 迟迟不回）
        watch.verdict = `${race.verdict}:harvested`;
        watch.harvested = true;
        return finish({
          ok: true,
          childId: String(run.id ?? ''),
          stopReason: 'completed',
          output: harvested.output,
          watch,
        });
      }

      // 回合以非 completed 收场（error / aborted / max-tokens）：照实报，不冒充超时
      if (harvested !== undefined && harvested.turnEndKind !== 'completed') {
        const mapped = describeStopReason(harvested.turnEndKind) ?? `回合以 ${harvested.turnEndKind} 结束`;
        watch.verdict = `${race.verdict}:turnEnd=${harvested.turnEndKind}`;
        return finish({
          ok: false,
          childId: String(run.id ?? ''),
          stopReason: harvested.turnEndKind,
          output: harvested.output,
          // 是队长自己掐的（预算耗尽）就明说，别写成"宿主没交回结果"——
          // 实测踩过：executor 被预算砍掉，报告却说是宿主的问题，误导排查。
          error: timedOut
            ? `超时（${Math.round(effectiveTimeout / 1000)} 秒）：角色预算耗尽，已带原因取消`
            : `${mapped}（回合已结束但宿主未交回结果）`,
          watch,
        });
      }

      // 连 turn/end 都没有：确实没跑完 —— 带原因取消（原因会落到它自己的会话日志里）。
      // 判死依据现在只有一条：**动态停滞**（游标长时间不前进），不再是墙钟、也不是 status。
      const stalledMs = Math.round((watch.stallWindowMs ?? limits.stallFloorMs) / 1000);
      const reason =
        race.verdict === 'stalled'
          ? `子代理 ${stalledMs} 秒没有任何进展（会话游标不前进），判定为卡死`
          : '子代理已停止活动（idle）却没有任何回合结束记录，判定为空转结束';
      watch.cancelVia = cancelChild(localAgent, `dsh-teams: ${reason}`);
      controller.abort();
      return finish({
        ok: false,
        childId: String(run.id ?? ''),
        stopReason: 'aborted',
        error: `${reason}（已取消，取消方式：${watch.cancelVia}）`,
        watch,
      });
    }

    const result = race.value;
    const stopReason = String(result?.stopReason ?? 'error');
    const reason = describeStopReason(stopReason);
    const output = extractOutput(result);

    if (reason !== undefined) {
      return finish({
        ok: false,
        childId: String(run.id ?? ''),
        stopReason,
        output,
        error: timedOut ? `超时（${Math.round(effectiveTimeout / 1000)} 秒）：${reason}` : reason,
        watch,
      });
    }
    if (output === '') {
      return finish({
        ok: false,
        childId: String(run.id ?? ''),
        stopReason,
        error: '子代理正常结束但没有产出任何文本——无法作为交接内容',
        watch,
      });
    }
    return finish({ ok: true, childId: String(run.id ?? ''), stopReason, output, watch });
  } catch (error) {
    clearWatch();
    return finish({
      ok: false,
      childId: String(run?.id ?? ''),
      error: timedOut
        ? `超时（${Math.round(effectiveTimeout / 1000)} 秒）`
        : `运行失败：${String(error?.message ?? error)}`,
    });
  } finally {
    // 释放运行资源；失败不应影响已经拿到的结果
    try {
      await run.dispose();
    } catch {
      /* dispose 失败不影响结果回收 */
    }
  }
}
