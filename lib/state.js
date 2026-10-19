/**
 * DSH Teams — 状态存储
 *
 * 设计原则（遵循 Harness 实践）：
 *   1. 会话日志是唯一真相来源；本模块持有的全部是**派生缓存**，可从日志与工具调用重建。
 *   2. 每次读写都在锁内重新读盘，不在内存里做权威副本 —— 进程重启后状态自然可用。
 *   3. 写入用「临时文件 + 同目录 rename」原子替换，失败时按可重试错误码重试，最后退化为直接覆写。
 *   4. 进程内按 state root 串行化，避免并发工具调用互相覆盖。
 *
 * 目录布局（<workspace>/<stateDir>/）：
 *   teams/<captainSessionId>.json   团队记录（队长会话 / 路径决策 / 阶段）
 *   tasks/<captainSessionId>.json   任务图（DAG）
 *   events.jsonl                    事件流（路由决策 / 门禁 / 熔断），UI 数据源
 *   roles/*.md                      用户自定义角色
 */

import { mkdir, readFile, writeFile, rename, rm, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** rename 失败时值得重试的错误码（Windows 上文件句柄短暂占用很常见）。 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const ATOMIC_RENAME_RETRIES = 3;

/* ------------------------------------------------------------------ *
 * 进程内串行锁
 * ------------------------------------------------------------------ */

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * 按 key 串行执行操作：同一 key 的调用排队，不同 key 互不阻塞。
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export function withLock(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // 队列尾部只保留一个占位，避免长期运行后 Map 无限增长
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

/* ------------------------------------------------------------------ *
 * 原子写
 * ------------------------------------------------------------------ */

/**
 * 原子写文本：先写同目录临时文件，再 rename 覆盖目标。
 * @param {string} file - 目标文件绝对路径
 * @param {string} content
 */
export async function writeFileAtomic(file, content) {
  await mkdir(join(file, '..'), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, 'utf8');

  let lastError;
  for (let attempt = 0; attempt < ATOMIC_RENAME_RETRIES; attempt += 1) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(error?.code)) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  // 退化为直接覆写：atomic 尝试都失败时，宁可留下内容也不丢状态
  try {
    await writeFile(file, content, 'utf8');
  } catch (error) {
    throw lastError ?? error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** 读 JSON；不存在或损坏时返回 fallback。 */
export async function readJson(file, fallback = undefined) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // 文件不存在 = 真的没有；其它读错误（权限、占用）不该被当成"空状态"。
    if (error?.code === 'ENOENT') return fallback;
    process.emitWarning(`[dsh-teams] 读取 ${file} 失败：${error?.code ?? error}`);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // ⚠️ 损坏 ≠ 不存在。以前两者都返回 fallback，于是损坏的任务图被当成空图、
    // 损坏的团队记录被重建成 idle（连批准闸门一起消失，审计 D6/I11）。
    // 现在把坏文件改名留档：既不静默覆盖用户数据，也让下一次写入有干净的文件。
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, aside);
      process.emitWarning(`[dsh-teams] ${file} 不是合法 JSON，已改名保留为 ${aside}`);
    } catch {
      process.emitWarning(`[dsh-teams] ${file} 不是合法 JSON：${error?.message ?? error}`);
    }
    return fallback;
  }
}

/** 写 JSON（缩进 2，便于人工检查状态文件）。 */
export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 追加一行 JSONL。 */
export async function appendJsonl(file, value) {
  // ⚠️ 必须是**真追加**。以前这里是"读整个文件 → 拼一行 → 原子覆盖写"，
  // 无锁并发时 20 条事件只落 1 条（审计 I9）；读失败（非 ENOENT）时还会用一行
  // 覆盖掉整个历史。appendFile 由内核保证 O_APPEND 原子性，且永不读旧内容。
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`, 'utf8');
}


/* ------------------------------------------------------------------ *
 * 状态根
 * ------------------------------------------------------------------ */

/**
 * 解析状态根目录。
 * @param {string} workspace - 会话工作区绝对路径
 * @param {string} stateDir  - 配置项，默认 .dsh-teams
 * @returns {string}
 */
export function stateRootOf(workspace, stateDir) {
  return join(workspace, stateDir || '.dsh-teams');
}

/** 团队记录路径。 */
export function teamFile(stateRoot, captainSessionId) {
  return join(stateRoot, 'teams', `${safeKey(captainSessionId)}.json`);
}

/** 任务图路径。 */
export function tasksFile(stateRoot, captainSessionId) {
  return join(stateRoot, 'tasks', `${safeKey(captainSessionId)}.json`);
}

/** 事件流路径。 */
export function eventsFile(stateRoot) {
  return join(stateRoot, 'events.jsonl');
}

/** 用户自定义角色目录。 */
export function userRolesDir(stateRoot) {
  return join(stateRoot, 'roles');
}

/** 把任意 id 变成安全的文件名。 */
export function safeKey(id) {
  const cleaned = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 96);
}

/* ------------------------------------------------------------------ *
 * 团队 / 任务
 * ------------------------------------------------------------------ */

/**
 * 读取团队记录；不存在返回 undefined。
 * @returns {Promise<object|undefined>}
 */
export async function readTeam(stateRoot, captainSessionId) {
  return readJson(teamFile(stateRoot, captainSessionId));
}

/** 写团队记录。 */
export async function writeTeam(stateRoot, team) {
  await writeJsonAtomic(teamFile(stateRoot, team.captainSessionId), team);
}

/**
 * 读取或创建团队记录。已有记录时保留其 phase 与路径决策，只补充缺失字段。
 * @param {object} input
 * @param {string} input.stateRoot
 * @param {string} input.captainSessionId
 * @param {string} input.workspace
 * @param {string} [input.purpose]
 * @returns {Promise<object>}
 */
export async function ensureTeam({ stateRoot, captainSessionId, workspace, purpose }) {
  return withLock(`state:${stateRoot}`, async () => {
    const existing = await readTeam(stateRoot, captainSessionId);
    if (existing !== undefined) {
      let changed = false;
      if (workspace && existing.workspace !== workspace) {
        existing.workspace = workspace;
        changed = true;
      }
      if (purpose && existing.purpose !== purpose) {
        existing.purpose = purpose;
        changed = true;
      }
      if (changed) await writeTeam(stateRoot, existing);
      return existing;
    }
    const team = {
      schemaVersion: 1,
      captainSessionId,
      workspace,
      purpose: purpose ?? '',
      phase: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeTeam(stateRoot, team);
    return team;
  });
}

/**
 * 在锁内对团队记录做一次读-改-写。
 * @param {string} stateRoot
 * @param {string} captainSessionId
 * @param {(team: object) => object|void|Promise<object|void>} mutate
 * @returns {Promise<object|undefined>} 变更后的记录
 */
export async function mutateTeam(stateRoot, captainSessionId, mutate) {
  return withLock(`state:${stateRoot}`, async () => {
    const team = await readTeam(stateRoot, captainSessionId);
    if (team === undefined) return undefined;
    const replacement = await mutate(team);
    const next = replacement ?? team;
    next.updatedAt = new Date().toISOString();
    await writeTeam(stateRoot, next);
    return next;
  });
}

/**
 * 读取任务图。
 * @returns {Promise<{tasks: object[], seq: number}>}
 */
export async function readTasks(stateRoot, captainSessionId) {
  const value = await readJson(tasksFile(stateRoot, captainSessionId));
  if (value === undefined || !Array.isArray(value.tasks)) return { tasks: [], seq: 0 };
  return { tasks: value.tasks, seq: Number.isFinite(value.seq) ? value.seq : 0 };
}

/** 写任务图。 */
export async function writeTasks(stateRoot, captainSessionId, graph) {
  await writeJsonAtomic(tasksFile(stateRoot, captainSessionId), {
    schemaVersion: 1,
    captainSessionId,
    seq: graph.seq ?? 0,
    tasks: graph.tasks ?? [],
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 在锁内对任务图做一次读-改-写。
 * @param {(graph: {tasks: object[], seq: number}) => object|void|Promise<object|void>} mutate
 */
export async function mutateTasks(stateRoot, captainSessionId, mutate) {
  return withLock(`state:${stateRoot}`, async () => {
    const graph = await readTasks(stateRoot, captainSessionId);
    const replacement = await mutate(graph);
    const next = replacement ?? graph;
    await writeTasks(stateRoot, captainSessionId, next);
    return next;
  });
}

/* ------------------------------------------------------------------ *
 * 事件流
 * ------------------------------------------------------------------ */

/**
 * 追加一条事件。事件是 UI 的数据源，也是「为什么走了这条路径」的审计线索。
 * @param {object} input
 * @param {string} input.stateRoot
 * @param {string} input.type    - route | plan | gate | circuit | member | note
 * @param {string} [input.team]
 * @param {object} [input.data]
 */
export async function appendEvent({ stateRoot, type, team, data }) {
  await appendJsonl(eventsFile(stateRoot), {
    ts: new Date().toISOString(),
    type,
    team: team ?? null,
    data: data ?? {},
  });
}

/**
 * 读取最近的事件（尾部 N 条）。
 * @param {string} stateRoot
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
export async function readEvents(stateRoot, limit = 200) {
  try {
    const raw = await readFile(eventsFile(stateRoot), 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const tail = lines.slice(-Math.max(1, limit));
    return tail.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }).filter((entry) => entry !== undefined);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 目录辅助
 * ------------------------------------------------------------------ */

/** 确保状态目录骨架存在。 */
export async function ensureStateDirs(stateRoot) {
  await Promise.all([
    mkdir(join(stateRoot, 'teams'), { recursive: true }),
    mkdir(join(stateRoot, 'tasks'), { recursive: true }),
    mkdir(userRolesDir(stateRoot), { recursive: true }),
  ]);
}

/** 运行历史文件：每行一条已收口的运行摘要（供面板按"每次任务"折叠展示）。 */
export function runsFile(stateRoot, captainSessionId) {
  return join(stateRoot, 'runs', `${safeKey(captainSessionId)}.jsonl`);
}

/**
 * 追加一条运行历史。
 *
 * 为什么需要：状态目录里只保留**最新一轮**的任务图（`teams_plan` 会覆盖它），
 * 而面板要按"用户每次的任务"折叠展示历史。于是每轮重建前，把上一轮压成一条摘要追加进来。
 *
 * @param {string} stateRoot
 * @param {string} captainSessionId
 * @param {object} record
 */
export async function appendRunRecord(stateRoot, captainSessionId, record) {
  const file = runsFile(stateRoot, captainSessionId);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** 读取运行历史（最新在后）。文件不存在时返回空数组，不是错误。 */
export async function readRunRecords(stateRoot, captainSessionId) {
  const file = runsFile(stateRoot, captainSessionId);
  if (!existsSync(file)) return [];
  try {
    const text = await readFile(file, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 坏行跳过：历史记录不该拖垮面板 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 列出状态根下的团队 id。 */
export async function listTeamIds(stateRoot) {
  const dir = join(stateRoot, 'teams');
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}
