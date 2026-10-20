/**
 * 探针：ui.openTabOnPlan 是否仍是"活配置"。
 *
 * 已知历史：AUDIT-2026-10-20.md 5.1 把它判为死配置；FIXES.md P1-4 声称已删除
 * （"客户端无法实现自动开标签"）。本探针检查：
 *   1. Config.parse 后的 apply 视图 / schema 里还有没有它；
 *   2. resolveUi() 是否仍返回它；
 *   3. index.js / client.js / lib 下有没有真正的消费者（排除 config.js 自身）。
 *
 * 假设：config.js:94 仍在返回该字段，而除它之外没有任何消费者——incomplete-fix。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveUi } from '../../lib/config.js';

export const id = 'probe-dead-config';
export const dim = 'dead-path';
export const title = 'ui.openTabOnPlan 已"删除"但仍由 resolveUi 返回';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function listSources() {
  const files = ['index.js', 'client.js'];
  const libDir = join(ROOT, 'lib');
  for (const entry of await readdir(libDir)) {
    if (entry.endsWith('.js')) files.push(join('lib', entry));
  }
  return files;
}

export async function run() {
  const files = await listSources();
  const hits = [];
  for (const relative of files) {
    let text;
    try {
      text = await readFile(join(ROOT, relative), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.includes('openTabOnPlan')) return;
      hits.push({ file: relative, line: index + 1, text: line.trim() });
    });
  }

  const indexSource = await readFile(join(ROOT, 'index.js'), 'utf8');
  const schemaMentions = (indexSource.match(/openTabOnPlan/g) ?? []).length;
  const valueOff = resolveUi({ ui: { openTabOnPlan: false } }).openTabOnPlan;
  const valueOn = resolveUi({ ui: { openTabOnPlan: true } }).openTabOnPlan;

  const consumers = hits.filter((hit) => hit.file !== join('lib', 'config.js'));
  const reproduced = valueOff === false && valueOn === true && consumers.length === 0 && schemaMentions === 0;

  return {
    reproduced,
    observed: {
      resolveUiStillReturns: { whenFalse: valueOff, whenTrue: valueOn },
      configSchemaMentions: schemaMentions,
      allSourceHits: hits,
      consumersOutsideConfigJs: consumers,
      clientMentions: hits.filter((hit) => hit.file === 'client.js').length,
    },
    expected: '既然客户端无法实现自动开标签，字段应从 schema、apply 视图与 lib/config.js 三处一并删除；只删 schema 会留下一个永远返回默认值、无人消费的"活配置"',
    note: 'FIXES.md P1-4 写的是"ui.openTabOnPlan 删除"；test/client.test.mjs:845 也按"已移除"数 volatile 叶子。config.js:94 是残留。',
  };
}

if (process.argv[1]?.endsWith('probe-dead-config.mjs')) {
  run().then((result) => {
    console.log(JSON.stringify({ id, dim, title, ...result }, null, 2));
    if (result.reproduced !== true) console.log('（假设未复现）');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
