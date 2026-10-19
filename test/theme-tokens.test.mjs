/**
 * DSH Teams — 主题令牌核对
 *
 * 一条真实教训：客户端最初用了 `--dsw-alias-text-primary`、`--dsw-alias-border-subtle`、
 * `--dsw-alias-bg-subtle`、`--dsw-alias-brand` 等名字——**这些令牌在 DSH 里都不存在**。
 * 我甚至给每个都写了 fallback，于是 CSS 语法合法、页面不报错、颜色静默退化成硬编码灰，
 * 插件看起来和宿主"不像一套"，浅色/深色切换也失效。
 *
 * DSH 主题只有 14 个令牌，权威列表来自客户端 Theme Inspect 提供者（见下方基线快照）。
 * 本测试断言 client.js 里引用的每个 `--dsw-*` 都在该列表内。
 *
 * 运行：node --test test/theme-tokens.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');

/**
 * DSH 主题令牌基线（来自 `cordis_inspect_query` 的 Client Theme.listTokens）。
 *
 * 宿主升级后若令牌增删，这个列表需要同步更新——测试会提示差异，
 * 这正是我们想要的：令牌变化应该被显式看到，而不是静默退化。
 */
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]);

/** 提取文本里引用的所有 CSS 自定义属性名。 */
function referencedTokens(text) {
  const found = new Set();
  for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) found.add(match[1]);
  return [...found].sort();
}

test('client.js 引用的每个 --dsw-* 主题令牌都真实存在', async () => {
  const code = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  const referenced = referencedTokens(code).filter((name) => name.startsWith('--dsw-'));

  assert.ok(referenced.length > 0, '客户端应当使用主题令牌而不是硬编码颜色');

  const unknown = referenced.filter((name) => !THEME_TOKENS.has(name));
  assert.deepEqual(
    unknown,
    [],
    `以下主题令牌在 DSH 里不存在（颜色会静默退化为 fallback，且不随主题切换）：\n  ${unknown.join('\n  ')}\n可用令牌：\n  ${[...THEME_TOKENS].join('\n  ')}`,
  );
});

test('样式不使用硬编码颜色（装饰性图形除外）', async () => {
  const code = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  const css = /const CSS = `([\s\S]*?)`;/.exec(code);
  assert.ok(css, '应能找到 CSS 常量');

  // 检查 CSS 里是否残留 hex / rgb() / hsl() 字面量
  const literals = [...css[1].matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(
    literals,
    [],
    `CSS 里不应出现硬编码颜色，请改用主题令牌：\n  ${literals.join('\n  ')}`,
  );
});

test('主题令牌只出现在 var() 中，没有拼错的近义名', async () => {
  const code = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  // 官方常量名里带 alias 的令牌前缀，写错前缀会让所有令牌一起失效
  const suspects = [...code.matchAll(/--dsw-a-z]([a-z0-9-]*)/g)].map((m) => m[0]);
  assert.deepEqual(suspects, [], `疑似拼错的令牌前缀：${suspects.join(', ')}`);
});
