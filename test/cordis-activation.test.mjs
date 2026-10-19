/**
 * DSH Teams — 真实 cordis 下的客户端激活测试
 *
 * 为什么需要这个文件（一次真实事故）：
 *
 *   客户端写入 `ctx.inject('sidebarRightTabs', cb)`——传了**字符串**。
 *   cordis 的 `RegistryService.inject(inject, callback)` 会把第一个参数原样透传：
 *       inject(inject, callback) { return this.plugin({ inject, apply: callback }) }
 *   于是 `Inject.resolve` 走到 `else if (Reflect.has(inject, symbols.checkProto))`，
 *   对字符串调用 `Reflect.has` → `TypeError: Reflect.has called on non-object`
 *   → 插件 fiber 失败 → 渲染进程判定「启动失败」，却**拿不到错误文本**
 *   （apply 没走完，`loader.await()` 也就没有异常可报）。
 *
 *   手写替身当时「宽容地」接受字符串并继续执行，所以测试全绿而线上崩溃。
 *   结论：客户端插件的激活必须用**真实 cordis** 验证，替身只能验证业务逻辑。
 *
 * 运行：node --test test/cordis-activation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');

/** cordis 的真实安装位置。 */
function locateCordis() {
  const candidates = [];
  if (process.env.DSH_APP_ROOT) candidates.push(join(process.env.DSH_APP_ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));
  candidates.push('F:/MT/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js');
  const found = candidates.find((path) => existsSync(path));
  assert.ok(found, '找不到 cordis 安装；设置 DSH_APP_ROOT 指向 DSH 应用目录');
  return `file:///${found.replace(/\\/g, '/').replace(/ /g, '%20')}`;
}

/** React 替身：只需要让模块顶层与组件定义不报错。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  };
}

/** 载入客户端 bundle，返回插件模块（apply/inject）。 */
let loadSeq = 0;
async function loadClientPlugin() {
  const code = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  let registration;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registration = spec; } } };
  globalThis.document = {
    createElement: () => ({ textContent: '', parentNode: null, setAttribute() {} }),
    head: {
      appendChild(node) { node.parentNode = this; },
      removeChild(node) { node.parentNode = null; },
    },
  };
  const stamp = ++loadSeq;
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#act${stamp}`);
  assert.ok(registration, 'bundle 必须通过 window.__ModuleLoader__.load 注册');
  const React = fakeReact();
  return registration.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`不得 require 未声明的模块：${name}`);
  });
}

/**
 * 在真实 cordis 上下文里激活插件。
 * @param {object} options
 * @param {boolean} [options.withSidebarRightTabs] 是否提供右栏标签服务
 */
async function activateClientPlugin({ withSidebarRightTabs = true } = {}) {
  const { Context } = await import(locateCordis());
  const plugin = await loadClientPlugin();

  const observed = { slots: [], registered: [], tabTypes: [], opened: [] };
  const root = new Context();

  root.provide('slots', {
    inject(key, callback) {
      observed.slots.push(key);
      // 真实语义：槽位声明后才执行注册回调；这里立即执行以便观察注册结果
      callback();
      return () => {};
    },
    register(options, component) {
      observed.registered.push({ options, component });
      return () => {};
    },
  });
  root.provide('locale', {
    register: () => () => {},
    bind: () => (key) => key,
  });
  if (withSidebarRightTabs) {
    root.provide('sidebarRightTabs', {
      register: (definition) => {
        observed.tabTypes.push(definition);
        return () => {};
      },
    });
    root.provide('sidebarRight', {
      openTab: (kind) => observed.opened.push(kind),
    });
  }

  const fiber = root.plugin(plugin);
  await fiber;
  return { fiber, observed, plugin };
}

test('真实 cordis 下插件能激活到 ACTIVE（state=2）', async () => {
  const { fiber, observed } = await activateClientPlugin();
  assert.equal(
    fiber.state,
    2,
    'fiber 必须是 ACTIVE(2)。非 ACTIVE 会让宿主渲染进程判定「启动失败」且不给出错误文本',
  );
  assert.ok(
    observed.slots.includes('conversation.session.header.actions'),
    '应登记会话头部入口槽位',
  );
});

test('真实 cordis 下右栏标签与内容都被注册', async () => {
  const { observed } = await activateClientPlugin({ withSidebarRightTabs: true });
  assert.equal(observed.tabTypes.length, 1, '应注册一个右栏标签类型');
  const definition = observed.tabTypes[0];
  assert.equal(typeof definition.kind, 'string');

  const keys = observed.registered
    .filter((entry) => entry.options.name === 'sidebar.right.pane.tab')
    .map((entry) => entry.options.key);

  // 派发键由宿主算：TabSlot 里是 `entryKey: definition?.id ?? tab.kind`
  // （见 @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js）。
  // 只注册 kind 一份时，类型注册成功会让派发键变成 id → 永远匹配不上 →
  // 标签页出现但正文只显示「这类内容还没有可用的查看方式。」（真实事故，已回归）
  assert.ok(keys.includes(definition.id), `派发键必须包含类型 id（${definition.id}）`);
  assert.ok(
    keys.includes(definition.kind),
    `派发键还必须包含 kind（${definition.kind}），覆盖「类型没注册上时退回 kind」的路径`,
  );
});

test('缺少右栏标签服务时仍能激活，只是不注册右栏', async () => {
  const { fiber, observed } = await activateClientPlugin({ withSidebarRightTabs: false });
  assert.equal(fiber.state, 2, '软依赖缺失不应导致 fiber 失败');
  assert.equal(observed.tabTypes.length, 0, '没有服务时不应注册标签类型');
  assert.ok(
    observed.slots.includes('conversation.session.header.actions'),
    '头部入口不受右栏缺失影响',
  );
});

test('回归锁定：ctx.inject 传字符串会让真实 cordis 抛错（证明该用数组）', async () => {
  const { Context } = await import(locateCordis());
  const root = new Context();
  root.provide('someService', { ping: () => 'pong' });

  // 字符串形式：fiber 不会同步抛，错误在 await 时浮现
  let threw;
  try {
    await root.plugin({
      inject: [],
      apply(ctx) {
        ctx.inject('someService', () => {});
      },
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, 'cordis 必须拒绝字符串形式的 inject 声明');
  assert.match(String(threw.message), /Reflect\.has/, '错误应为 Reflect.has 相关，与线上表现一致');

  // 数组形式：正常激活
  const ok = root.plugin({
    inject: [],
    apply(ctx) {
      ctx.inject(['someService'], () => {});
    },
  });
  await ok;
  assert.equal(ok.state, 2, '数组形式应正常激活');
});

test('回归锁定：字符串 inject 失败时，聚合器拿不到错误文本（解释线上症状）', async () => {
  // 这条测试解释「为什么宿主只报插件名、没有错误文本」：
  // 失败发生在 fiber 内部，调用方若只检查 state 就不会看到异常。
  const { Context } = await import(locateCordis());
  const root = new Context();
  root.provide('someService', { ping: () => 'pong' });

  const fiber = root.plugin({
    inject: [],
    apply(ctx) {
      ctx.inject('someService', () => {});
    },
  });
  // fiber 是可 await 的对象而非 Promise，用 Promise.resolve 包一层再吞掉错误
  await Promise.resolve(fiber).catch(() => {});
  assert.notEqual(fiber.state, 2, '失败的 fiber 不应是 ACTIVE —— 宿主据此判定「启动失败」');
});
