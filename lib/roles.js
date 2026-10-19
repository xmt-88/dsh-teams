/**
 * DSH Teams — 角色库
 *
 * 两类角色：
 *   - 内置角色：随包发布在 assets/roles/builtin/*.md，只读、不可编辑，仅可查看
 *   - 自定义角色：用户写在 <workspace>/<stateDir>/roles/*.md，可自由增删改
 *
 * 角色文件格式（复用已验证的 persona 文件约定）：
 *   ---
 *   name: 显示名
 *   description: 一句话说明
 *   emoji: 🧭
 *   permissions: readonly | readwrite | execute
 *   tier: heavy | medium | light | infrastructure
 *   readBudget: 4
 *   outputBudget: 800
 *   ---
 *   （正文 = 角色契约，将被注入子代理的 systemPrompt section）
 *
 * 只解析上表键；正文按需读取。文件头扫描上限 64KB。
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本模块所在目录，用于定位随包发布的内置角色。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 内置角色根目录。 */
export const BUILTIN_ROLES_ROOT = join(HERE, '..', 'assets', 'roles', 'builtin');

/** 文件头读取上限（字节）。 */
const HEADER_READ_LIMIT = 64 * 1024;

/** slug 白名单：小写字母/数字/短横线，防路径穿越。 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 合法权限档。 */
export const PERMISSION_TIERS = Object.freeze(['readonly', 'readwrite', 'execute']);

/** 合法超时档。 */
export const TIMEOUT_TIERS = Object.freeze(['heavy', 'medium', 'light', 'infrastructure']);

/**
 * 权限档 → 工具过滤清单。
 *
 * `allow` 列出该角色可以调用的工具；未列入的工具一律不可见。
 * 每个角色都禁止派发类工具（防止子代理自我递归扩张团队）。
 */
const DELEGATION_DENY = ['teams_run', 'teams_plan', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'task_board_run'];

const PERMISSION_TOOLS = Object.freeze({
  readonly: {
    allow: ['read', 'read_image', 'glob', 'grep', 'list_agents', 'job_list', 'job_output'],
    deny: DELEGATION_DENY,
  },
  readwrite: {
    allow: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'present', 'todo_write', 'list_agents'],
    deny: DELEGATION_DENY,
  },
  execute: {
    allow: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'bash', 'pwsh', 'present', 'todo_write', 'job_list', 'job_output', 'list_agents'],
    deny: DELEGATION_DENY,
  },
});

/**
 * 解析角色文件头。
 * @param {string} raw - 文件原文（或被截断的文件头）
 * @returns {{meta:Record<string,string>, body:string}}
 */
export function parseRoleFile(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return { meta: {}, body: text.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv === null) continue;
    let value = kv[2].trim();
    // 去掉成对的引号
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

/**
 * 把角色文件解析成一个角色记录。
 * @param {object} input
 * @param {string} input.slug
 * @param {string} input.raw
 * @param {boolean} input.builtin
 * @param {string} [input.path]
 * @returns {object} 角色记录；格式非法时带 `error` 字段而非抛错
 */
export function buildRole({ slug, raw, builtin, path }) {
  const { meta, body } = parseRoleFile(raw);
  const errors = [];

  if (!SLUG_PATTERN.test(slug)) errors.push(`角色 id 非法："${slug}"（只允许小写字母、数字、短横线）`);
  if (!meta.name) errors.push('缺少 name');
  if (!meta.description) errors.push('缺少 description');
  if (!body) errors.push('正文（角色契约）为空');

  const permissions = meta.permissions ?? 'readonly';
  if (!PERMISSION_TIERS.includes(permissions)) errors.push(`permissions 非法："${permissions}"（可选 ${PERMISSION_TIERS.join(' / ')}）`);

  const tier = meta.tier ?? 'medium';
  if (!TIMEOUT_TIERS.includes(tier)) errors.push(`tier 非法："${tier}"（可选 ${TIMEOUT_TIERS.join(' / ')}）`);

  const readBudget = Number.parseInt(meta.readBudget ?? '', 10);
  const outputBudget = Number.parseInt(meta.outputBudget ?? '', 10);

  const tools = PERMISSION_TOOLS[permissions] ?? PERMISSION_TOOLS.readonly;

  const role = {
    slug,
    name: meta.name ?? slug,
    description: meta.description ?? '',
    emoji: meta.emoji ?? '🤖',
    permissions,
    tier,
    readBudget: Number.isFinite(readBudget) ? readBudget : 6,
    outputBudget: Number.isFinite(outputBudget) ? outputBudget : 900,
    builtin: builtin === true,
    path,
    prompt: body,
    toolFilter: { allow: [...tools.allow], deny: [...tools.deny] },
  };
  if (errors.length > 0) role.errors = errors;
  return role;
}

/** 读取目录下所有 .md 文件（不递归）。目录不存在时返回空数组。 */
async function readRoleDir(dir, builtin) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const slug = basename(entry.name, entry.name.slice(-3));
    const full = join(dir, entry.name);
    let raw;
    try {
      raw = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    roles.push(buildRole({ slug, raw: raw.slice(0, HEADER_READ_LIMIT), builtin, path: full }));
  }
  roles.sort((a, b) => a.slug.localeCompare(b.slug));
  return roles;
}

/**
 * 装载完整角色库：内置 + 自定义。
 * 自定义角色与内置同 id 时，自定义胜出（用户可覆盖行为），但内置仍以 `builtin` 标记保留在列表里。
 *
 * @param {string|undefined} userRolesDir - 用户角色目录（<workspace>/<stateDir>/roles）
 * @returns {Promise<{roles:object[], bySlug:Map<string,object>, errors:object[]}>}
 */
export async function loadRoles(userRolesDir) {
  const builtinRoles = await readRoleDir(BUILTIN_ROLES_ROOT, true);
  const userRoles = userRolesDir === undefined ? [] : await readRoleDir(userRolesDir, false);

  const bySlug = new Map();
  for (const role of builtinRoles) bySlug.set(role.slug, role);
  for (const role of userRoles) bySlug.set(role.slug, role);

  const roles = [...bySlug.values()].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  const errors = roles.filter((role) => role.errors !== undefined);
  return { roles, bySlug, errors };
}

/**
 * 解析角色标识：接受 slug、显示名或 emoji+名。
 * @param {{bySlug:Map<string,object>, roles:object[]}} library
 * @param {string} query
 * @returns {object|undefined}
 */
export function resolveRole(library, query) {
  const raw = String(query ?? '').trim();
  if (raw === '') return undefined;
  const lower = raw.toLowerCase();

  const direct = library.bySlug.get(lower);
  if (direct !== undefined) return direct;

  const exact = library.roles.find((role) => role.name === raw);
  if (exact !== undefined) return exact;

  const folded = library.roles.filter((role) => role.name.toLowerCase().includes(lower) || role.slug.includes(lower));
  return folded.length === 1 ? folded[0] : undefined;
}

/**
 * 校验一个待写入的自定义角色。写入前调用，避免坏角色进入目录。
 * @param {object} input - { slug, name, description, emoji, permissions, tier, readBudget, outputBudget, prompt }
 * @returns {{ok:boolean, errors:string[], markdown?:string}}
 */
export function validateCustomRole(input) {
  const errors = [];
  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) errors.push('slug 必须是小写字母/数字/短横线组成，例如 db-tuning');
  if (!String(input.name ?? '').trim()) errors.push('name 不能为空');
  if (!String(input.description ?? '').trim()) errors.push('description 不能为空');
  if (!String(input.prompt ?? '').trim()) errors.push('prompt（角色契约正文）不能为空');
  const permissions = input.permissions ?? 'readonly';
  if (!PERMISSION_TIERS.includes(permissions)) errors.push(`permissions 只能是 ${PERMISSION_TIERS.join(' / ')}`);
  const tier = input.tier ?? 'medium';
  if (!TIMEOUT_TIERS.includes(tier)) errors.push(`tier 只能是 ${TIMEOUT_TIERS.join(' / ')}`);
  if (errors.length > 0) return { ok: false, errors };

  const readBudget = Number.parseInt(input.readBudget ?? '', 10);
  const outputBudget = Number.parseInt(input.outputBudget ?? '', 10);
  const lines = [
    '---',
    `name: ${String(input.name).trim()}`,
    `description: ${String(input.description).trim()}`,
    `emoji: ${String(input.emoji ?? '🤖').trim()}`,
    `permissions: ${permissions}`,
    `tier: ${tier}`,
    `readBudget: ${Number.isFinite(readBudget) ? readBudget : 6}`,
    `outputBudget: ${Number.isFinite(outputBudget) ? outputBudget : 900}`,
    '---',
    '',
    String(input.prompt).trim(),
    '',
  ];
  return { ok: true, errors: [], markdown: lines.join('\n') };
}
