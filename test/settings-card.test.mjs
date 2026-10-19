/**
 * DSH Teams — 设置卡片的数据契约
 *
 * 这里锁定的是设置卡片「静默失效」的三条路径，它们都**不报错**：
 *
 *   1. 字段路径与 index.js 的 Config 叶子对不上 —— 卡片照常渲染，但读取的是
 *      undefined，控件显示空白、保存写回一个宿主不认的路径。
 *   2. 字典驱动的文案 key 漏了中英任意一份 —— `t(key)` 直接返回 key 本身，
 *      界面上出现 `set.f.maxParallel` 这样的裸 key。
 *   3. 命名空间写错 —— `whileServed` 永远等不到该命名空间，**卡片根本不出现**，
 *      插件页里连条目都没有（真实契约见 dsh-settings:122 `volatileForm()`）。
 *
 * 判定「哪些叶子可配置」不能靠手抄：默认值与约束的唯一来源是 index.js 的 Config，
 * 因此本测试**直接 import 真实的 Config** 并枚举它的 volatile 叶子，
 * 与 client.js 的字段表逐字比对。Config 增删字段而没有同步字段表时，这里会红。
 *
 * 运行：node --test test/settings-card.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '../index.js';
import z from '@deepseek-ai/schemastery';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');

/* ================================================================== *
 * 源码字面量提取
 * ================================================================== */

/**
 * 从 `startIdx` 处的括号开始，截出配平的整段字面量。
 *
 * 必须跳过字符串与注释：字典里有 `// ---- Settings card ----` 这类行注释，
 * 里面出现的括号会让朴素的深度计数提前收尾，从而**静默截断**出半个对象。
 */
function sliceBalanced(source, startIdx) {
  const open = source[startIdx];
  const close = open === '[' ? ']' : open === '{' ? '}' : undefined;
  assert.ok(close !== undefined, `不支持的起始括号：${open}`);

  let depth = 0;
  for (let i = startIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  assert.fail('括号不平衡，无法提取字面量');
}

/**
 * 截出 `const NAME = <对象或数组字面量>;` 里的那段字面量并求值。
 *
 * 向后找**第一个** `{` 或 `[`，因此 marker 本身不要带括号——否则会把数组当成
 * 它的第一个元素来截（字段表就会被截成单个分组，测试看着绿实则只核了一组）。
 */
function literalAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `client.js 里找不到 ${marker}`);

  let startIdx = -1;
  for (let i = at + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '[') {
      startIdx = i;
      break;
    }
    // 不跨语句边界去找：找不到就说明这个常量不是对象/数组字面量
    if (ch === ';' || ch === '\n') break;
  }
  assert.ok(startIdx >= 0, `${marker} 后面没有找到对象或数组字面量`);

  // eslint-disable-next-line no-new-func -- 求值的是本仓库自己的纯数据字面量
  return new Function(`return (${sliceBalanced(source, startIdx)})`)();
}

/** 载入 client.js 并取出设置卡片的四样东西。 */
async function settingsSurface() {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');

  // 命名空间是字符串字面量，不是对象，单独取
  const ns = /const SETTINGS_NS = '([^']+)'/.exec(source);
  assert.ok(ns, 'client.js 里应声明 SETTINGS_NS');

  return {
    source,
    ns: ns[1],
    groups: literalAfter(source, 'const SETTINGS_GROUPS = '),
    zh: literalAfter(source, 'const ZH = '),
    en: literalAfter(source, 'const EN = '),
  };
}

/**
 * 复刻宿主 `volatileForm()`（dsh-settings/lib/index.js:122）的选取规则：
 * 带 `meta.volatile` 的叶子即为可配置字段，普通字段不下发。
 *
 * 这里刻意直接走真实 Config 的 Schema 实例（`.type` / `.meta` / `.dict`），
 * 而不是抄一份字段名清单——抄一份就等于埋了第二份真相。
 */
function volatileLeaves(config, path = [], leaves = []) {
  if (config?.meta?.volatile === true) {
    leaves.push({ path: [...path], type: config.type, meta: config.meta });
    return leaves;
  }
  if (config?.type === 'object') {
    for (const [key, child] of Object.entries(config.dict ?? {})) {
      volatileLeaves(child, [...path, key], leaves);
    }
  }
  return leaves;
}

/** 字段表里声明的全部路径。 */
function declaredPaths(groups) {
  return groups.flatMap((group) => group.fields.map((field) => field.path.join('.')));
}

/* ================================================================== *
 * 1. 字段路径 ↔ 真实 Config
 * ================================================================== */

test('字段表与 index.js 的 Config volatile 叶子逐字一致（不重不漏）', async () => {
  const { groups } = await settingsSurface();
  const declared = declaredPaths(groups).sort();
  const actual = volatileLeaves(Config).map((leaf) => leaf.path.join('.')).sort();

  assert.ok(actual.length > 0, 'Config 里应当存在可配置（volatile）字段，否则卡片不会出现在插件页');
  assert.deepEqual(
    declared,
    actual,
    '字段表与 Config 的 volatile 叶子必须一一对应：少了字段等于用户改不了，多了字段等于写回宿主不认的路径',
  );
});

test('字段表声明的每一类控件都在 Config 里有真实类型支撑', async () => {
  const { groups } = await settingsSurface();
  const byPath = new Map(volatileLeaves(Config).map((leaf) => [leaf.path.join('.'), leaf]));

  for (const group of groups) {
    for (const field of group.fields) {
      const key = field.path.join('.');
      const leaf = byPath.get(key);
      assert.ok(leaf, `${key} 在 Config 里不存在`);

      if (field.kind === 'boolean') {
        assert.equal(leaf.type, 'boolean', `${key} 声明为开关，Config 里却是 ${leaf.type}`);
      } else if (field.kind === 'number') {
        // 卡片用 `node.type === 'number'` 判断「按数字提交」，靠 step/min 做范围校验；
        // 类型对不上会把数字当字符串写回，宿主直接拒绝保存。
        assert.equal(leaf.type, 'number', `${key} 声明为数字，Config 里却是 ${leaf.type}`);
        assert.equal(typeof leaf.meta.step, 'number', `${key} 缺少 step，前端无法校验整数`);
        assert.equal(typeof leaf.meta.min, 'number', `${key} 缺少 min，前端无法校验下界`);
      } else if (field.kind === 'select') {
        assert.equal(leaf.type, 'string', `${key} 声明为下拉，Config 里却是 ${leaf.type}`);
        assert.ok(Array.isArray(field.options) && field.options.length > 0, `${key} 下拉没有任何选项`);
      } else {
        assert.equal(leaf.type, 'string', `${key} 声明为文本，Config 里却是 ${leaf.type}`);
      }

      assert.notEqual(leaf.meta.default, undefined, `${key} 没有默认值，控件的占位符会是空的`);
    }
  }
});

test('默认值只来自 Config：字段表里不出现第二份默认值或 min/max', async () => {
  const { groups } = await settingsSurface();
  for (const group of groups) {
    for (const field of group.fields) {
      for (const forbidden of ['default', 'min', 'max', 'step']) {
        assert.ok(
          !Object.hasOwn(field, forbidden),
          `${field.path.join('.')} 手抄了 ${forbidden}；默认值与约束的唯一来源是 index.js 的 Config，抄一份就会静默漂移`,
        );
      }
    }
  }
});

/* ================================================================== *
 * 2. 宿主下发 → 客户端重建：卡片读 schema 的前提
 * ================================================================== */

/**
 * 按宿主 `volatileForm()`（dsh-settings/lib/index.js:122）的算法，
 * 用**真实 schemastery** 造出客户端最终会收到的那棵树。
 *
 * 这条链路是卡片的地基：宿主 `describe()` 下发 `form.toJSON()`（引用图信封
 * `{uid, refs}`），客户端 `settingsSchema.rehydrate()` 再把它解回节点树
 * （dsh-client-ui-settings/lib/client.js:933）。卡片随后用 `nodeAtPath()` 按路径取
 * `type` / `meta.default` / `meta.min`——任何一环对不上，控件就是空的、默认值就没了。
 */
function hostVolatileForm(schema) {
  if (schema.meta.volatile) return new z(schema.toJSON());
  if (schema.type === 'object') {
    const dict = {};
    for (const [key, child] of Object.entries(schema.dict ?? {})) {
      const field = hostVolatileForm(child);
      if (field !== undefined) dict[key] = field;
    }
    return Object.keys(dict).length === 0 ? undefined : z.object(dict);
  }
  return undefined;
}

test('宿主下发 → 客户端 rehydrate 后，字段表里每个路径都能解出类型与默认值', async () => {
  const { groups } = await settingsSurface();
  const real = new Map(volatileLeaves(Config).map((leaf) => [leaf.path.join('.'), leaf]));

  const form = hostVolatileForm(Config);
  assert.ok(form, 'Config 应产出可下发的表单 schema（没有 volatile 字段时插件页不会出现条目）');

  // 宿主 describe 下发 form.toJSON()，客户端把它 rehydrate 回节点树
  const root = new z(form.toJSON());
  assert.equal(root.type, 'object', 'rehydrate 后应是对象节点（卡片靠 node.dict 逐层取字段）');

  const nodeAtPath = (node, path) => {
    let current = node;
    for (const key of path) {
      if (current === undefined) return undefined;
      if (current.type === 'object') current = current.dict?.[key];
      else return undefined;
    }
    return current;
  };

  for (const group of groups) {
    for (const field of group.fields) {
      const key = field.path.join('.');
      const node = nodeAtPath(root, field.path);
      assert.ok(node, `${key} 在客户端重建的 schema 里解不出来（控件会渲染成空的）`);
      assert.equal(node.type, real.get(key).type, `${key} 的类型与 Config 不一致`);
      assert.notEqual(node.meta?.default, undefined, `${key} 解不出默认值（占位符会变空）`);
      assert.deepEqual(
        { min: node.meta?.min, step: node.meta?.step },
        { min: real.get(key).meta.min, step: real.get(key).meta.step },
        `${key} 的约束与 Config 不一致（前端校验会误判）`,
      );
    }
  }
});

/* ================================================================== *
 * 3. 单位与分组（设计约定）
 * ================================================================== */

test('时间字段带对单位：角色超时标「秒」，看门狗标「毫秒」', async () => {
  const { groups } = await settingsSurface();
  const byId = new Map(groups.map((group) => [group.id, group]));

  for (const field of byId.get('timeouts').fields) {
    if (field.kind !== 'number') continue;
    assert.equal(field.unit, 'set.unitSeconds', `timeouts.${field.path.join('.')} 应标「秒」`);
  }
  for (const field of byId.get('watch').fields) {
    assert.equal(field.unit, 'set.unitMs', `watch.${field.path.join('.')} 应标「毫秒」`);
  }

  // 配错单位不会报错，只会让用户按错误的量级填数，所以这里对着 Config 的默认值再核一次：
  // 秒级预算应是「分钟量级」的数（数百到数千），毫秒级应是「万级」以上。
  const heavy = byId.get('timeouts').fields.find((field) => field.path.join('.') === 'timeouts.heavy');
  const probe = byId.get('watch').fields.find((field) => field.path.join('.') === 'watch.probeMs');
  assert.ok(heavy && probe, '字段表应包含 timeouts.heavy 与 watch.probeMs');
  const heavyDefault = volatileLeaves(Config).find((leaf) => leaf.path.join('.') === 'timeouts.heavy').meta.default;
  const probeDefault = volatileLeaves(Config).find((leaf) => leaf.path.join('.') === 'watch.probeMs').meta.default;
  assert.ok(heavyDefault >= 60, `timeouts.heavy 默认 ${heavyDefault} 若按秒计应远大于 60`);
  assert.ok(probeDefault >= 1000, `watch.probeMs 默认 ${probeDefault} 若按毫秒计应不小于 1000`);
});

test('任务要求的六类配置都有对应分组', async () => {
  const { groups } = await settingsSurface();
  const ids = groups.map((group) => group.id);
  for (const required of ['state', 'routing', 'scheduler', 'timeouts', 'gates', 'watch']) {
    assert.ok(ids.includes(required), `缺少分组 ${required}`);
  }
  const paths = declaredPaths(groups);
  assert.ok(paths.includes('stateDir'), '必须能改状态目录');
  assert.ok(paths.includes('scheduler.maxParallel'), '必须能改并发');
  assert.ok(paths.includes('scheduler.maxRetries'), '必须能改重试');
  assert.ok(paths.includes('gates.requireEvidence'), '必须能开关注质量门');
});

/* ================================================================== *
 * 4. 文案：字典驱动的 key 也要中英齐全
 * ================================================================== */

test('字典驱动的每个文案 key 在中英两份字典里都有定义', async () => {
  const { groups, zh, en } = await settingsSurface();

  const keys = [];
  for (const group of groups) {
    keys.push(group.title);
    for (const field of group.fields) {
      keys.push(field.label, field.hint);
      if (field.unit !== undefined) keys.push(field.unit);
    }
  }

  const missing = [];
  for (const key of keys) {
    // 中英各必须有一处：缺一门语言时 t(key) 会直接把 key 显示给用户
    if (!Object.hasOwn(zh, key)) missing.push(`zh 缺 ${key}`);
    if (!Object.hasOwn(en, key)) missing.push(`en 缺 ${key}`);
  }
  assert.deepEqual(missing, [], `字段表引用的文案 key 有缺失：\n  ${missing.join('\n  ')}`);

  // 条目数应一致：任何一侧多写/少写都说明字典漂移了
  assert.equal(
    Object.keys(zh).length,
    Object.keys(en).length,
    `中英字典条目数不一致（zh ${Object.keys(zh).length} / en ${Object.keys(en).length}）`,
  );
});

test('英文文案里不残留中文，中文文案里不残留裸 key', async () => {
  const { en, zh } = await settingsSurface();

  const chinese = Object.entries(en)
    .filter(([, value]) => /[\u4e00-\u9fa5]/.test(String(value)))
    .map(([key]) => key);
  assert.deepEqual(chinese, [], `英文文案里残留中文：${chinese.join('、')}`);

  const bare = Object.entries(zh)
    .filter(([key, value]) => String(value).trim() === key)
    .map(([key]) => key);
  assert.deepEqual(bare, [], `中文文案的值等于 key（等于没翻译）：${bare.join('、')}`);

  const placeholders = Object.entries(zh).filter(([, value]) => String(value).includes('{n}')).map(([k]) => k);
  for (const key of placeholders) {
    assert.ok(String(en[key]).includes('{n}'), `${key} 的英文文案缺少 {n} 占位符`);
  }
});

/* ================================================================== *
 * 5. 命名空间（写错卡片会完全不出现）
 * ================================================================== */

test('设置命名空间等于 cordis 条目 id，而不是包名', async () => {
  const { ns } = await settingsSurface();
  assert.equal(ns, 'dsh-teams');

  const patch = await readFile(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8');
  const entries = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.ok(entries.length > 0, 'cordis.patch.yml 里应有条目 id');
  assert.ok(
    entries.includes(ns),
    `设置命名空间 ${ns} 必须是 cordis.patch.yml 里的条目 id（当前有 ${entries.join(', ')}）；` +
      '写错不会有任何报错：whileServed 永远等不到该命名空间，卡片静默不出现',
  );
});

test('设置卡片按软依赖接入：configForms / settingsSchema 不写进硬 inject 数组', async () => {
  const { source } = await settingsSurface();

  const hard = /const inject = \[([^\]]*)\]/.exec(source);
  assert.ok(hard, 'client.js 应声明 inject 数组');
  const names = hard[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const soft of ['configForms', 'settingsSchema']) {
    assert.ok(
      !names.includes(soft),
      `${soft} 不能是硬依赖：宿主没有设置服务时，硬依赖会让本插件永远停在非 ACTIVE 状态`,
    );
  }

  // 但必须在 apply 里通过 ctx.inject 惰性等待，且走到 whileServed / plugins.bundle.config
  assert.match(source, /ctx\.inject\(\['configForms',\s*'settingsSchema'\]/, '应在 apply 里惰性等待设置服务');
  assert.match(
    source,
    /whileServed\(\[SETTINGS_NS\]/,
    '应经 whileServed 跟随命名空间挂载/卸载（命名空间消失时自动摘掉卡片）',
  );
  // ⚠️ 槽位是 plugins.bundle.config（bundle 配置，key 用包名），**不是** plugins.item：
  // 后者是「官方插件」组，挤进去卡片注册是 active 的、但用户在自己能到达的页面上看不到它
  // ——真实事故：我们最初就注册在 plugins.item，重启后设置里什么都没出现。
  assert.match(source, /name:\s*'plugins\.bundle\.config'/, '卡片应注册进 plugins.bundle.config 槽位');
  assert.match(source, /key:\s*BUNDLE_PACKAGE/, 'keyed 槽位必须给 key，且 key 用 bundle 包名');
  assert.doesNotMatch(source, /name:\s*'plugins\.item'/, '不得再注册进 plugins.item（那是官方插件组）');

  // ⚠️ 用户真正会看到它的入口是**设置窗口的左栏**：`settings.section` = "One settings page per
  // list entry"，左栏里的插件市场/宠物/专家/浏览器/使用统计全是外部插件注册出来的
  // （真实事故：只注册 bundle 配置的话，用户在自己能找到的任何地方都看不见这张卡）。
  assert.match(source, /name:\s*'settings\.section'/, '必须注册进 settings.section，否则设置左栏里没有这一栏');
  assert.match(source, /id:\s*'dsh-teams'/, '设置栏目要有自己的 section key');
  assert.match(source, /order:\s*\d+/, '设置栏目要有导航位置');
  assert.match(source, /label:\s*\(\)\s*=>\s*t\('set\.nav'\)/, '栏目名要走本插件字典（本地化）');
  // 两处注册共用同一张卡片与同一份注入面（form/mirror/schema）
  assert.match(source, /const face = \(\) => \(\{ form, mirror, schema \}\)/, '两处注册应共用同一份注入面');
});

/* ================================================================== *
 * 6. 纪律
 * ================================================================== */

test('设置卡片区域内没有调试残留', async () => {
  const { source } = await settingsSurface();
  const from = source.indexOf('const SETTINGS_NS');
  const to = source.indexOf('* 插件入口');
  assert.ok(from >= 0 && to > from, '应能定位设置卡片区域');

  const region = source.slice(from, to);
  const residue = [...region.matchAll(/console\.\w+\(|debugger|TODO|FIXME|XXX/g)].map((match) => match[0]);
  assert.deepEqual(residue, [], `设置卡片区域不应残留调试代码：${residue.join('、')}`);
});

test('设置卡片不引入任何第三方依赖（只许 react）', async () => {
  const { source } = await settingsSurface();
  const from = source.indexOf('const SETTINGS_NS');
  const to = source.indexOf('* 插件入口');
  const region = source.slice(from, to);

  const requires = [...region.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  const allowed = new Set(['react']);
  const offenders = requires.filter((name) => !allowed.has(name));
  assert.deepEqual(offenders, [], `设置卡片不得 require 第三方模块：${offenders.join('、')}`);

  // 客户端的模块加载器只认识 react；import 语句在 bundle 里不会被解析
  assert.ok(!/^\s*import\s/m.test(region), '设置卡片区域不应出现 import 语句');
});
