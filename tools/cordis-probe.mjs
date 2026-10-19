/**
 * 用**真实 cordis** 驱动客户端插件，而不是手写替身。
 *
 * 手写替身会掩盖真实运行时的约束——上一轮就是这么漏掉问题的。
 * 这个探针的价值：如果 apply() 在真实 cordis 下抛错，fiber 会失败，我们就能看到它。
 *
 * 运行：node tools/cordis-probe.mjs
 */

import { readFile } from 'node:fs/promises';

const CORDIS = 'file:///F:/MT/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js';

const { Context } = await import(CORDIS);

/* ---- 载入客户端 bundle（模拟模块加载器） ---- */
let spec;
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.document = {
  createElement: () => ({ textContent: '', parentNode: null, setAttribute() {} }),
  head: {
    appendChild(node) { node.parentNode = this; },
    removeChild(node) { node.parentNode = null; },
  },
};
const code = await readFile(new URL('../client.js', import.meta.url), 'utf8');
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#probe`);

if (spec === undefined) {
  console.error('✗ bundle 未通过 window.__ModuleLoader__.load 注册');
  process.exit(1);
}
console.log('bundle id     :', spec.id);

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};
const plugin = spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
console.log('plugin exports:', Object.keys(plugin).join(', '));
console.log('plugin inject :', JSON.stringify(plugin.inject));

/* ---- 真实 cordis 根上下文 + 服务 ---- */
const registrations = [];
const slotInjections = [];
const tabTypes = [];

const root = new Context();

const slotsService = {
  inject(key, callback) {
    slotInjections.push(key);
    console.log('  slots.inject ->', key);
    return () => {};
  },
  register(options, component) {
    registrations.push(options);
    console.log('  slots.register ->', options.name, JSON.stringify({ id: options.id, key: options.key }));
    return () => {};
  },
};
const localeService = { register: () => () => {}, bind: () => (key) => key };
const tabsService = { register: (definition) => { tabTypes.push(definition); console.log('  sidebarRightTabs.register ->', definition.kind); return () => {}; } };
const sidebarRightService = { openTab: () => {} };

for (const [name, service] of [
  ['slots', slotsService],
  ['locale', localeService],
  ['sidebarRightTabs', tabsService],
  ['sidebarRight', sidebarRightService],
]) {
  root.provide(name, service);
}
console.log('services provided:', ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'].join(', '));

/* ---- 交给真实 cordis 加载插件 ---- */
let fiber;
try {
  fiber = root.plugin(plugin);
  await fiber;
} catch (error) {
  console.error('\n✗ FIBER FAILED（这正是渲染进程启动失败的原因）');
  console.error('  ', error?.constructor?.name, '-', error?.message);
  console.error((error?.stack ?? '').split('\n').slice(1, 7).join('\n'));
  process.exit(1);
}

const state = fiber?.state;
console.log('\n✓ fiber settled, state =', state, '(2 = ACTIVE)');
console.log('  slotInjections :', slotInjections.join(', ') || '(none)');
console.log('  registrations  :', registrations.length);
console.log('  tabTypes       :', tabTypes.length);

if (state !== 2) {
  console.error(`\n✗ fiber 未达 ACTIVE（state=${state}）——渲染进程会判定为启动失败`);
  const waiting = Object.keys(fiber?.inject ?? {});
  console.error('  仍在等待的服务:', waiting.join(', ') || '(未知)');
  process.exit(1);
}
console.log('\n全部通过：真实 cordis 下插件可正常激活。');
