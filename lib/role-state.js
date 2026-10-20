/**
 * 角色启停状态。
 *
 * 为什么单独存：内置角色是**只读资产**（打包在插件里），不能把 `enabled: false`
 * 写回 .md；自定义角色虽然可写，但启停是"用户偏好"而不是契约内容，
 * 混在契约里会让同一份角色在不同工作区行为不一致。
 *
 * 落点：`<stateRoot>/roles-state.json`，与自定义角色目录同级（同属一个工作区）。
 *
 * 文件格式：
 * ```json
 * { "disabled": ["orchestrator", "explore"], "updatedAt": "2026-10-20T..." }
 * ```
 */

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withLock, writeFileAtomic } from './state.js';

/** 停用后会让流水线无法成立的核心角色：任何路径都要用。 */
export const CORE_ROLES = Object.freeze(['executor', 'verifier']);

/** 角色状态文件名。 */
export function roleStateFile(stateRoot) {
  return join(stateRoot, 'roles-state.json');
}

/**
 * 读取停用集合。
 * @param {string} stateRoot
 * @returns {Promise<Set<string>>}
 */
export async function readDisabledRoles(stateRoot) {
  try {
    const raw = await readFile(roleStateFile(stateRoot), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.disabled) ? parsed.disabled : [];
    return new Set(list.filter((item) => typeof item === 'string' && item !== ''));
  } catch {
    // 文件不存在或损坏都按"没有停用"处理：启停是偏好，坏了不该阻断派发。
    return new Set();
  }
}

/**
 * 写入停用集合（复用 state.js 的原子写）。
 * @param {string} stateRoot
 * @param {Iterable<string>} disabled
 * @returns {Promise<string[]>} 实际写入的列表（已去重排序）
 */
export async function writeDisabledRoles(stateRoot, disabled) {
  const unique = [...new Set([...disabled].filter((item) => typeof item === 'string' && item !== ''))].sort();
  const file = roleStateFile(stateRoot);
  await mkdir(dirname(file), { recursive: true });
  // ⚠️ 加锁：以前是无锁读-改-写，两个并发停用会互相覆盖（审计二轮问题 4，实测 6 个只落 1 个）
  await withLock(`${file}.lock`, async () => {
    await writeFileAtomic(file, `${JSON.stringify({ disabled: unique, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  });
  return unique;
}

/**
 * 原子地"改一个角色的启停"：读-改-写整体在锁内，避免并发覆盖。
 * @param {string} stateRoot
 * @param {string} slug
 * @param {boolean} enabled
 * @returns {Promise<string[]>} 写入后的停用列表
 */
export async function setRoleEnabled(stateRoot, slug, enabled) {
  const file = roleStateFile(stateRoot);
  await mkdir(dirname(file), { recursive: true });
  return withLock(`${file}.lock`, async () => {
    const current = await readDisabledRoles(stateRoot);
    if (enabled) current.delete(slug);
    else current.add(slug);
    const unique = [...current].sort();
    await writeFileAtomic(file, `${JSON.stringify({ disabled: unique, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    return unique;
  });
}

/**
 * 校验一次启停请求。
 * @param {string} slug
 * @param {boolean} enabled
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateToggle(slug, enabled) {
  if (typeof slug !== 'string' || slug.trim() === '') return { ok: false, reason: '角色 id 不能为空' };
  if (enabled !== true && enabled !== false) return { ok: false, reason: 'enabled 必须是布尔值' };
  if (!enabled && CORE_ROLES.includes(slug)) {
    return { ok: false, reason: `「${slug}」是核心角色，任何路径都要用，不能停用` };
  }
  return { ok: true };
}
