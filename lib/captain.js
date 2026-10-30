/**
 * 队长 Agent 解析：**工具 / 命令 / HTTP 三条启动通路共用的唯一实现**。
 *
 * 结构根因（四维度审计原话）：同一"启动"能力在三个适配层各自获取 Agent，
 * 而人工闸门只装在一处 —— 这是"启动失败 / 命令不派发"两个缺陷反复修不净的原因。
 * 现在三处都调 `resolveCaptain`，取不到时返回**同一套** reasonCode，面板与命令都能直接显示。
 *
 * 为什么还要一张进程内登记表：面板点击与工具调用在**同一个进程**里，
 * 但路由层拿不到 tool 上下文，只能按会话 id 反查宿主 `agents` 服务。
 * 真实宿主里 `agents.get()` 的键到底是 sessionId 还是别的 id 未证实（本机无法验证），
 * 所以：宿主 lookup 优先（权威），拿不到时回退到工具/命令调用时登记过的活 Agent。
 * 仍拿不到就如实失败 —— 绝不假装已启动。
 */

/** 失败原因：固定中文文案，reasonCode 供面板/命令分支与真机诊断定位。 */
export const CAPTAIN_REASONS = Object.freeze({
  'no-session': '需要在会话内调用（无法确定队长会话）',
  'no-service': '宿主没有提供 agents 服务，无法按会话取回活着的 Agent',
  miss: '该会话当前没有活动的 Agent，无法启动调度（请回到会话后重试）',
  'lookup-threw': '按会话取 Agent 时宿主报错：',
  'invalid-agent': '宿主返回的 Agent 形状非法（缺 id），无法作为派发的 parent',
});

/** 登记表上限：陈旧条目只占内存，不参与决策（宿主 lookup 优先）。 */
const REGISTRY_LIMIT = 32;

/** captainSessionId -> { agent, workspace, touchedAt }。 */
const registry = new Map();

/** 可用的活 Agent：必须能给出 id（runLoop → startActivation 的 parent 就靠它）。 */
function usable(agent) {
  if (agent === null || typeof agent !== 'object') return false;
  if (agent.id === undefined || agent.id === null) return false;
  return String(agent.id) !== '';
}

/** 会话工作区：队长会话的 header.cwd；缺失时退回进程工作目录。 */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  return process.cwd();
}

/** 记一笔（同时做 LRU 淘汰）：工具/命令每次调用都会刷新，表不会过期到无法使用。 */
function remember(captainSessionId, agent) {
  if (captainSessionId === '') return;
  registry.delete(captainSessionId);
  registry.set(captainSessionId, { agent, workspace: workspaceOf(agent), touchedAt: Date.now() });
  while (registry.size > REGISTRY_LIMIT) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

/** 命中登记表时统一成成功形状。 */
function fromRegistry(captainSessionId, entry, { source, workspaceHint }) {
  entry.touchedAt = Date.now();
  return {
    ok: true,
    agent: entry.agent,
    captainSessionId,
    workspace: typeof workspaceHint === 'string' && workspaceHint !== '' ? workspaceHint : entry.workspace,
    source,
    cached: true,
  };
}

/**
 * 解析队长 Agent。
 *
 * @param {object} [input]
 * @param {object} [input.agent]            - 入口自带的活 Agent（工具 exec.agent / 命令 invocation.agent）
 * @param {(id:string)=>object|undefined} [input.lookup] - 宿主按会话取 Agent；没有该能力时**不要传**
 * @param {string} [input.captainSessionId] - 只有会话 id 时（HTTP 路由）
 * @param {string} [input.workspaceHint]    - 调用方已知的工作区（HTTP 路由定位到的那个）
 * @param {string} [input.source]           - 'tool' | 'command' | 'http'，只用于诊断
 * @returns {{ok:true, agent:object, captainSessionId:string, workspace:string, source:string, cached?:boolean}
 *          |{ok:false, reasonCode:string, reason:string}}
 */
export function resolveCaptain({ agent, lookup, captainSessionId, workspaceHint, source = 'tool' } = {}) {
  // ① 入口自带活 Agent：最可信，顺带登记，供 HTTP 通路复用
  if (usable(agent)) {
    const id = String(agent.id);
    remember(id, agent);
    return { ok: true, agent, captainSessionId: id, workspace: workspaceOf(agent), source };
  }

  const id = captainSessionId === undefined || captainSessionId === null ? '' : String(captainSessionId);
  if (id === '') return { ok: false, reasonCode: 'no-session', reason: CAPTAIN_REASONS['no-session'] };

  // ② 宿主 lookup 优先：会话 resume / 进程重启后登记表可能陈旧，宿主里活着的那个才算数
  if (typeof lookup === 'function') {
    let found;
    try {
      found = lookup(id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error ?? '');
      return { ok: false, reasonCode: 'lookup-threw', reason: `${CAPTAIN_REASONS['lookup-threw']}${detail}` };
    }
    if (usable(found)) {
      remember(id, found);
      return { ok: true, agent: found, captainSessionId: id, workspace: workspaceOf(found), source };
    }
    if (found !== undefined && found !== null) {
      return { ok: false, reasonCode: 'invalid-agent', reason: CAPTAIN_REASONS['invalid-agent'] };
    }
    // ③ 登记表兜底：lookup miss 时，同进程里工具/命令登记过的句柄仍是那条活 Agent
    const cached = registry.get(id);
    if (cached !== undefined) return fromRegistry(id, cached, { source, workspaceHint });
    return { ok: false, reasonCode: 'miss', reason: CAPTAIN_REASONS.miss };
  }

  // 没有 lookup 能力：只能看登记表
  const cached = registry.get(id);
  if (cached !== undefined) return fromRegistry(id, cached, { source, workspaceHint });
  return { ok: false, reasonCode: 'no-service', reason: CAPTAIN_REASONS['no-service'] };
}

/** 清空登记表（测试隔离用；生产代码不需要调用）。 */
export function resetCaptainsForTests() {
  registry.clear();
}

/** 当前登记表大小（诊断/测试用）。 */
export function captainRegistrySize() {
  return registry.size;
}
