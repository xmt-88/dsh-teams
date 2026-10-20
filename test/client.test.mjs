/**
 * DSH Teams — 客户端插件契约测试
 *
 * 这里锁定的是一次**真实线上事故**的成因链：
 *
 *   package.json 的 `dsh.client.inject` 里写了 `@deepseek-ai/dsh-client-ui-slots`。
 *   该包不提供客户端 bundle（无 `dsh.client`、无 `./client` 导出），于是启动图里
 *   这一行永远到达不了 → 本插件的 bundle 不加载 → cordis fiber 停在非 ACTIVE 状态
 *   → 宿主渲染进程启动失败：「Renderer boot failed for 1 plugin(s)」，
 *   而且**没有错误文本**（apply 从未执行，自然没有异常可报）。排查代价极高。
 *
 * 因此断言分两类：
 *   A. manifest 一致性 —— dsh.client.inject 里每个包都必须真的提供客户端 bundle
 *   B. 模块契约      —— apply 不抛错、注册到正确槽位、注入语义正确、资源可释放
 *
 * 运行：node --test test/client.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 设置卡片把 index.js 的 Config 当作默认值与约束的唯一来源，测试也从同一个来源取，
// 这样「字段表 ↔ Config」的对应关系才有意义（而不是对着手抄的清单自证）。
import { Config } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');

/* ================================================================== *
 * 环境与工具
 * ================================================================== */

/** 可能存放 DSH 安装的 node_modules 根目录。 */
function dshModulesRoots() {
  const roots = [];
  if (process.env.DSH_APP_ROOT) roots.push(join(process.env.DSH_APP_ROOT, 'node_modules'));
  if (process.env.DSH_PROFILE_DIR) roots.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'));
  roots.push('F:/MT/DSH Desktop/resources/app/node_modules');
  return roots.filter((root) => existsSync(root));
}

/** 在 DSH 安装里定位一个包目录。 */
function locatePackage(name) {
  for (const root of dshModulesRoots()) {
    const dir = join(root, ...name.split('/'));
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/** 最小 DOM 替身：插件只用到 createElement / head.appendChild / removeChild。 */
function fakeDocument(tags = []) {
  const head = {
    appendChild(node) {
      node.parentNode = head;
      tags.push(node);
      return node;
    },
    removeChild(node) {
      const index = tags.indexOf(node);
      if (index >= 0) tags.splice(index, 1);
      node.parentNode = null;
      return node;
    },
  };
  return {
    createElement() {
      return { textContent: '', parentNode: null, setAttribute() {} };
    },
    head,
  };
}

/**
 * 足够支撑组件渲染的 React 替身，**useState 真的有状态**。
 *
 * 为什么不能只把 setState 当空函数：保存按钮的可用性取决于「草稿是否偏离生效值」，
 * 字段级错误取决于用户输入后的重渲染。无状态替身只能证明"首帧画出来了"，
 * 而交互恰恰是设置卡片最容易坏的地方。
 */
function fakeReact() {
  const slots = [];
  let cursor = 0;
  let redraw = () => {};

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
          redraw();
        },
      ];
    },
    // 卡片用 useEffect 订阅 form/mirror；替身里这两者不会自己变化，跳过即可
    useEffect() {},
    useMemo: (fn) => fn(),
    useRef(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
  };

  /**
   * 挂载一个函数组件并返回它渲染出的树。
   * setState 触发的重渲染会就地更新这棵树（返回同一个包装对象，便于断言最新状态）。
   */
  React.mount = (component, props) => {
    const box = { tree: undefined };
    const render = () => {
      cursor = 0;
      box.tree = component(props);
    };
    redraw = render;
    render();
    return box;
  };

  return React;
}

/** 深度遍历渲染树，收集满足条件的节点（跳过 null/false 这类空子节点）。 */
function collect(tree, predicate, found = []) {
  if (tree === null || tree === undefined || tree === false || typeof tree !== 'object') return found;
  if (Array.isArray(tree)) {
    for (const child of tree) collect(child, predicate, found);
    return found;
  }
  if (predicate(tree)) found.push(tree);
  for (const child of tree.children ?? []) collect(child, predicate, found);
  return found;
}

/** 取渲染树里所有某类节点的直接文本子节点。 */
function textsOf(tree, type) {
  return collect(tree, (node) => node.type === type)
    .flatMap((node) => node.children ?? [])
    .filter((child) => typeof child === 'string');
}

/**
 * 载入客户端 bundle，返回它注册的 { id, factory }。
 *
 * 每次都用不同的 data URL：ESM 模块缓存会缓存相同 URL 的导入，那样第二次调用
 * 就不会再执行 bundle，本次捕获的注册信息会丢失。错误信息里剥掉巨大的 data URL。
 */
let loadSeq = 0;
async function loadClientBundle() {
  const code = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  let registration;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registration = spec; } } };
  globalThis.document = fakeDocument();
  const stamp = ++loadSeq;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${stamp}`);
  } catch (error) {
    const message = String(error?.message ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<bundle>');
    assert.fail(`client.js 顶层执行失败（这会让渲染进程启动失败）：${message}`);
  }
  assert.ok(registration, 'client.js 必须通过 window.__ModuleLoader__.load 注册');
  return registration;
}

/**
 * 记录型客户端 ctx。
 *
 * 关键设计：这个替身必须**和真实 cordis 一样严格**。
 * 上一轮它宽容地接受了字符串形式的 `ctx.inject('name', cb)`，于是测试全绿而线上
 * 崩溃（真实 cordis 会对字符串调 `Reflect.has` 抛 TypeError）。现在传字符串直接抛错，
 * 让同类缺陷在本地就暴露。
 *
 * `inject` 其余语义按官方用法：回调收到 **scope**，服务按名字挂在 scope 上。
 */
function fakeClientContext({
  withLocale = true,
  withSidebarRightTabs = false,
  withSettings = true,
  settingsServed = true,
} = {}) {
  const log = {
    injects: [],
    registers: [],
    effects: [],
    warns: [],
    missingServices: [],
    slotCallbacks: new Map(),
  };
  const services = new Map();

  /**
   * 设置家当：测试可以直接改这些字段来摆出加载中 / 只读 / 写被拒 / 命名空间未服务等状态。
   * `value` 是「当前生效值」，`user` 是「用户覆盖层」（决定是否显示"已覆盖/恢复默认"）。
   */
  const settings = {
    served: settingsServed,
    status: 'ready',
    writable: true,
    revision: 7,
    value: {},
    user: {},
    mutateCalls: [],
    mutateAccepts: true,
  };

  const ctx = {
    logger: { warn: (m) => log.warns.push(String(m)), info() {}, debug() {} },
    get: (name) => services.get(name),
    effect(fn, label) {
      log.effects.push(label ?? '(unlabeled)');
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    inject(names, callback) {
      // 与真实 cordis 对齐：第一个参数必须是数组或"名字→配置"映射
      if (typeof names === 'string') {
        throw new TypeError(
          "Reflect.has called on non-object — ctx.inject 的第一个参数必须是数组，例如 ctx.inject(['slots'], scope => ...)",
        );
      }
      const list = Array.isArray(names) ? names : Object.keys(names);
      log.injects.push(...list);
      const missing = list.filter((name) => !services.has(name));
      if (missing.length > 0) {
        log.missingServices.push(...missing);
        return () => {};
      }
      const scope = { ...ctx };
      for (const name of list) scope[name] = services.get(name);
      callback(scope);
      return () => {};
    },
    slots: {
      inject(key, callback) {
        // ⚠️ 真实宿主允许同一个槽位有**多个** inject 回调（插件会给一个槽位注册多份，
        // 例如按不同的 key 各注册一份正文）。旧版假实现只存一个回调，后一次覆盖前一次，
        // 于是"只注册了 kind 一份"也能测绿——那是在测假实现，不是在测宿主行为。
        const list = log.slotCallbacks.get(key) ?? [];
        list.push(callback);
        log.slotCallbacks.set(key, list);
        return () => {};
      },
      register(options, component) {
        log.registers.push({ options, component });
        return () => {};
      },
    },
    /** 模拟槽位被声明，触发先前登记的所有回调。 */
    __declareSlot(key) {
      const list = log.slotCallbacks.get(key) ?? [];
      assert.ok(list.length > 0, `槽位 ${key} 上没有等待中的 inject 回调`);
      for (const callback of list) callback();
    },
    __log: log,
    __services: services,
  };

  if (withLocale) {
    services.set('locale', {
      register: (ns) => {
        log.localeNs = ns;
        return () => {};
      },
      bind: () => (key) => key,
    });
  }
  if (withSidebarRightTabs) {
    services.set('sidebarRightTabs', {
      register: (definition) => {
        log.tabType = definition;
        return () => {};
      },
    });
    services.set('sidebarRight', { openTab: () => {} });
  }
  if (withSettings) {
    services.set('settingsSchema', settingsSchemaDouble);
    services.set('configForms', configFormsDouble(log, settings));
  }
  ctx.__settings = settings;

  return ctx;
}

/* ================================================================== *
 * 设置服务替身
 *
 * `settingsSchema` 与 `configForms` 都是 DSH **真实存在**的客户端服务，由
 * `@deepseek-ai/dsh-client-ui-settings` 提供（`super(ctx, "settingsSchema")` /
 * `super(ctx, "configForms")`）。下面是按宿主语义实现的替身，不是凭空发明的接口。
 * ================================================================== */

/**
 * 复刻宿主 `volatileForm()`（dsh-settings/lib/index.js:122）的选取规则：
 * 只有带 `meta.volatile` 的叶子会下发给客户端，其余字段对设置页不可见。
 *
 * 走真实 Config 的 Schema 实例（`.type` / `.meta` / `.dict`），不手抄字段名。
 */
function volatileFormOf(config) {
  if (config?.meta?.volatile === true) return { type: config.type, meta: { ...config.meta } };
  if (config?.type === 'object') {
    const dict = {};
    for (const [key, child] of Object.entries(config.dict ?? {})) {
      const field = volatileFormOf(child);
      if (field !== undefined) dict[key] = field;
    }
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', meta: { default: {} }, dict };
  }
  return undefined;
}

/** 按 schema 校验候选值，失败时抛出「宿主一定会拒」的错。 */
function validateNode(node, value, path = []) {
  if (node === undefined || value === undefined) return;
  const where = path.join('.') || '(root)';
  if (node.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} 期望对象`);
    for (const [key, child] of Object.entries(node.dict ?? {})) validateNode(child, value[key], [...path, key]);
    return;
  }
  if (node.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${where} 期望布尔值`);
  if (node.type === 'string' && typeof value !== 'string') throw new Error(`${where} 期望字符串`);
  if (node.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} 期望数字`);
    const { min, max, step } = node.meta ?? {};
    if (typeof min === 'number' && value < min) throw new Error(`${where} 不能小于 ${min}`);
    if (typeof max === 'number' && value > max) throw new Error(`${where} 不能大于 ${max}`);
    if (typeof step === 'number' && step > 0 && Math.abs(value / step - Math.round(value / step)) > 1e-9) {
      throw new Error(`${where} 必须是 ${step} 的整数倍`);
    }
  }
}

/** 宿主 schema 服务（rehydrate / validate / nodeAtPath / get / set / delete / has）。 */
const settingsSchemaDouble = {
  rehydrate: (serialized) => serialized,
  validate(schema, draft) {
    try {
      validateNode(schema, draft, []);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  nodeAtPath(root, path) {
    let node = root;
    for (const key of path) {
      if (node === undefined) return undefined;
      if (node.type === 'object') node = node.dict?.[key];
      else if (node.type === 'dict' || node.type === 'array') node = node.inner;
      else return undefined;
    }
    return node;
  },
  getPath(value, path) {
    let current = value;
    for (const key of path) {
      if (Array.isArray(current)) {
        current = current[Number(key)];
        continue;
      }
      if (typeof current !== 'object' || current === null) return undefined;
      current = current[key];
    }
    return current;
  },
  hasPath(value, path) {
    if (path.length === 0) return value !== undefined;
    const parent = settingsSchemaDouble.getPath(value, path.slice(0, -1));
    const key = path[path.length - 1];
    if (Array.isArray(parent)) return Number(key) < parent.length;
    if (typeof parent !== 'object' || parent === null) return false;
    return key in parent;
  },
  setPath(root, path, value) {
    if (path.length === 0) throw new Error('setPath 需要非空路径');
    const [key, ...rest] = path;
    const base = typeof root === 'object' && root !== null ? { ...root } : {};
    base[key] = rest.length === 0 ? value : settingsSchemaDouble.setPath(base[key], rest, value);
    return base;
  },
  deletePath(root, path) {
    if (path.length === 0) throw new Error('deletePath 需要非空路径');
    if (!settingsSchemaDouble.hasPath(root, path)) return root;
    const [key, ...rest] = path;
    const base = { ...root };
    if (rest.length === 0) delete base[key];
    else base[key] = settingsSchemaDouble.deletePath(base[key], rest);
    return base;
  },
};

/** 宿主 configForms 服务：共享表单 + describe 镜像 + whileServed。 */
function configFormsDouble(log, settings) {
  const formTree = volatileFormOf(Config);
  const form = {
    getSnapshot: () => ({
      status: settings.status,
      writable: settings.writable,
      revision: settings.revision,
      value: settings.value,
      user: settings.user,
    }),
    subscribe: () => () => {},
    mutate: async (ops, revision) => {
      settings.mutateCalls.push({ ops, revision });
      return settings.mutateAccepts;
    },
  };
  const mirror = {
    getSnapshot: () => ({
      status: 'ready',
      error: null,
      view: {
        writable: settings.writable,
        namespaces: settings.served
          ? [{
              ns: 'dsh-teams',
              schema: formTree,
              revision: settings.revision,
              value: settings.value,
              base: {},
              user: settings.user,
            }]
          : [],
      },
    }),
    subscribe: () => () => {},
    ensure: () => {},
  };
  return {
    get: () => form,
    describe: () => mirror,
    whileServed(namespaces, register) {
      log.servedNamespaces = namespaces;
      // 与宿主一致：命名空间不在 describe 镜像里时不注册，出现时才注册，消失时摘掉
      if (!settings.served) return () => {};
      const off = register(new Set(namespaces));
      return () => off?.();
    },
  };
}

/** 载入 bundle 并取出插件模块。 */
async function pluginModule() {
  const registration = await loadClientBundle();
  const React = fakeReact();
  return { registration, React, module: registration.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`不得 require 未声明的模块：${name}`);
  }) };
}

/* ================================================================== *
 * A. manifest 一致性
 * ================================================================== */

test('manifest：dsh.client.inject 里每个包都必须真的提供客户端 bundle', async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const injected = pkg.dsh?.client?.inject ?? [];
  assert.ok(injected.length > 0, '应声明客户端依赖顺序');

  const problems = [];
  for (const name of injected) {
    const dir = locatePackage(name);
    if (dir === undefined) {
      problems.push(`${name}：在 DSH 安装中找不到该包`);
      continue;
    }
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const hasClientExport = manifest.exports?.['./client'] !== undefined;
    if (!hasClientExport || manifest.dsh?.client === undefined) {
      problems.push(
        `${name}：不提供客户端 bundle（exports["./client"]=${hasClientExport ? '有' : '缺失'}，dsh.client=${manifest.dsh?.client === undefined ? '缺失' : '有'}）`,
      );
    }
  }

  assert.deepEqual(
    problems,
    [],
    `dsh.client.inject 只能列真正的客户端 bundle 包，否则启动图缺行、插件永不激活：\n  ${problems.join('\n  ')}`,
  );
});

test('manifest：exports 指向的文件真实存在，client 平台为 web', async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value !== 'string' || value.includes('*')) continue; // 通配导出不是具体文件
    assert.ok(existsSync(join(PACKAGE_DIR, value)), `exports["${key}"] 指向的文件不存在：${value}`);
  }
  assert.equal(pkg.dsh?.client?.platform, 'web', 'Web UI 插件平台必须是 web');
  assert.ok(existsSync(join(PACKAGE_DIR, pkg.dsh.bundle.patch)), 'bundle patch 文件必须存在');
});

/* ================================================================== *
 * B. 模块契约
 * ================================================================== */

test('客户端 bundle：注册 id 等于包名，并导出 apply/inject', async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const { registration, module } = await pluginModule();
  assert.equal(registration.id, pkg.name, '注册 id 必须与包名一致，否则宿主按行查找找不到 factory');
  assert.equal(typeof registration.factory, 'function');
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject), 'inject 必须是服务名数组');
});

test('客户端只 require react，不引入任何 DSH 客户端包', async () => {
  const registration = await loadClientBundle();
  const required = [];
  const React = fakeReact();
  registration.factory((name) => {
    required.push(name);
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  // 官方硬规定：禁止 require 任何 @deepseek-ai/dsh-client-* 包
  assert.deepEqual(required, ['react'], `客户端只能 require react，实际：${required.join(', ')}`);
});

test('apply 不抛错，且把资源登记进 effect 以便释放', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withLocale: true });
  assert.doesNotThrow(() => module.apply(ctx), 'apply 抛错会让整个渲染进程启动失败');
  assert.equal(ctx.__log.effects.length, 1, '资源应由单个 effect 统一托管');
  assert.deepEqual(ctx.__log.warns, [], '不应有告警');
});

test('头部徽标注册到 conversation.session.header.actions，list 槽位带 id 与 order', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext();
  module.apply(ctx);
  ctx.__declareSlot('conversation.session.header.actions');

  const entry = ctx.__log.registers.find((item) => item.options.name === 'conversation.session.header.actions');
  assert.ok(entry, '必须注册头部入口');
  assert.equal(entry.options.id, 'dsh-teams-entry', 'list 槽位要求 id');
  assert.equal(typeof entry.options.order, 'number', 'list 槽位应有 order');
  assert.equal(typeof entry.component, 'function');
});

test('注入契约：只注入真实存在的服务，且回调参数是 scope', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withSidebarRightTabs: true });
  module.apply(ctx);

  assert.deepEqual(
    ctx.__log.missingServices,
    [],
    `注入了 DSH 里不存在的服务名：${ctx.__log.missingServices.join(', ')}`,
  );
  assert.ok(ctx.__log.injects.includes('sidebarRightTabs'), '应等待右栏标签机制');
  // 官方语义确认：回调收到 scope，服务挂在 scope 上（写成 (tabs)=>tabs.register 会抛错）
  assert.ok(ctx.__log.tabType, '回调里应能通过 scope.sidebarRightTabs 完成注册');
});

test('缺少右栏服务时不注册右栏，头部入口照常工作（软依赖）', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withSidebarRightTabs: false });
  assert.doesNotThrow(() => module.apply(ctx));
  ctx.__declareSlot('conversation.session.header.actions');

  assert.equal(ctx.__log.tabType, undefined, '没有右栏服务时不应注册标签类型');
  assert.ok(
    ctx.__log.registers.some((item) => item.options.name === 'conversation.session.header.actions'),
    '头部入口不应受右栏缺失影响',
  );
});

test('i18n：client.js 里 t() 引用的每个 key 都在中英两份字典里有定义', async () => {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');
  // 只匹配真正的 t('key') 调用：`ctx.get('locale')`、`createElement('style')` 这类
  // 以 t 结尾的标识符会被朴素正则误伤（`(?<![\w.])` 把它们挡在外面）
  const keys = [...source.matchAll(/(?<![\w.])t\('([^']+)'\)/g)].map((match) => match[1]);
  const unique = [...new Set(keys)];
  assert.ok(unique.length > 20, `应当引用到足够多的 key（实际 ${unique.length}）`);

  const missing = [];
  for (const key of unique) {
    const occurrences = source.split(`'${key}':`).length - 1;
    // 中英各一处；只有一处说明漏了另一门语言，0 处说明根本没定义
    if (occurrences < 2) missing.push(`${key}（出现 ${occurrences} 次）`);
  }
  assert.deepEqual(missing, [], `这些 key 没有在中英两份字典里同时定义：${missing.join('、')}`);
});

test('流程视图：按每次任务折叠 + 左→右流程图 + 方形身份卡（含用量与状态边框）', async () => {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');

  // 折叠列表：一次任务一项，当前轮在最前并默认展开
  assert.match(source, /function RunsView\(/, '应有按任务折叠的运行列表');
  assert.match(source, /team\.runs/, '运行列表要读快照的 runs');
  assert.match(source, /defaultOpen: index === 0/, '最新一轮默认展开');

  // 流程图：依赖层级 = 列，列之间画折线（左→右）
  assert.match(source, /function layersOf\(/, '应按依赖算层级');
  assert.match(source, /function FlowGap\(/, '列之间要有连接线');
  assert.match(source, /H50 V\$\{y2\} H100/, '连接线是折线（水平-垂直-水平），从左列连到右列');

  // 方形身份卡：鲸鱼 + 角色名 + 用量 + 状态边框 + 整卡可点
  assert.match(source, /function FlowCard\(/, '应有方形身份卡');
  assert.match(source, /metrics\.steps/, '卡片要显示步数');
  assert.match(source, /metrics\.cacheReadTokens/, '卡片要显示缓存命中量');
  assert.match(source, /formatTokens/, 'token 数要格式化（1.2k 这种）');
  assert.match(source, /openSession\(step\.childId\)/, '点卡片进对应子代理会话');

  // 状态边框：进行中黄色流光（旋转的锥形渐变）、完成绿、失败红
  assert.match(source, /dsh-teams-flow-glow/, '应有流光层');
  assert.match(source, /conic-gradient/, '流光用锥形渐变');
  assert.match(source, /@keyframes dsh-teams-flow-spin/, '流光要转起来');
  // 进行中：琥珀边框打底 + 流光环叠加（之前用 border-color:transparent，流光转到背面时半边没边）
  assert.match(source, /data-status="running"\],[\s\S]{0,300}40%,var\(--dsw-alias-border-l1\)/, '进行中要有琥珀边框打底');
  assert.match(source, /data-status="running"\] \.dsh-teams-flow-glow/, '进行中要有流光环');
  // 完成/失败用状态色画边框（完成允许与 border-l2 混合出更柔的绿）
  assert.match(source, /data-status="done"\]\{[\s\S]{0,120}state-success-primary/, '完成=绿边框');
  assert.match(source, /data-status="failed"\]\{[\s\S]{0,120}state-error-primary/, '失败=红边框');
  assert.match(source, /data-status="blocked"\]\{[\s\S]{0,160}state-warn-primary/, '受阻=橙边框');
  assert.match(source, /data-status="pending"\],[\s\S]{0,160}border-style:dashed/, '待派发=虚线边框');
  assert.match(source, /prefers-reduced-motion/, '尊重"减少动效"偏好');

  // 鲸鱼形象：内联 SVG（不引外部图片）+ 每个角色不同装扮
  // 形象：矢量（描摹自原画），加载失败退回手绘鲸鱼
  assert.match(source, /function GirlArt\(/, '应有矢量形象组件');
  assert.match(source, /function WhaleGirl\(/, '应保留手绘鲸鱼作为回退');
  assert.match(source, /const WHALE_BLUE = '#4D6BFE'/, '用 DeepSeek 经典蓝');
  assert.match(source, /const ROLE_LOOKS = \{/, '每个角色要有自己的配色（裙装/挂件）');
  assert.match(source, /dsh-teams-whale-accessory/, '装扮挂件要渲染出来');
  // 矢量必须走宿主路由（客户端插件读不了文件）
  assert.match(source, /\/plugins\/dsh-teams\/asset\?name=/, '矢量要走宿主资源路由');
  assert.match(source, /girl-vector\.svg/, '拉的是矢量资源');

  // ⚠️ 性能红线：只内联一份 <g>，卡片一律 <use> 引用。
  // 实测（60 张卡）：每卡内联 22.4ms / 1080 节点，<use> 共享 8.9ms / 240 节点。
  assert.match(source, /const GIRL_ID = 'dsh-teams-girl'/, '共享定义要有稳定 id');
  assert.match(source, /<g id="\$\{GIRL_ID\}">/, '必须内联成全局 <g id>（只一份）');
  assert.match(source, /h\('use', \{ href: `#\$\{GIRL_ID\}` \}\)/, '卡片要用 <use> 引用而不是各自内联');
  assert.match(source, /const GIRL_ART = \{ started: false/, '要有一次性加载状态（避免重复拉取）');
  assert.match(source, /if \(GIRL_ART\.started\) return;/, '重复调用不应重复加载');
  // 换角色配色靠 CSS 变量（一个文件服务所有角色）
  assert.match(source, /'--dress-main': dress, '--dress-shadow': darken\(dress\)/, '裙装配色走 CSS 变量');
  assert.match(source, /function darken\(hex/, '暗部由主色推导');
  assert.match(source, /headOnly: true/, '徽标用同一份矢量、只换 viewBox');
  assert.match(source, /const GIRL_HEAD_VIEWBOX/, '头部 viewBox 要独立定义');

  // 折叠的运行不挂载流程图（DOM 里只留头部）——历史再长也不会堆节点
  assert.match(source, /const \[open, setOpen\] = React\.useState\(defaultOpen === true\)/, '展开态要由 React 管');
  assert.match(source, /onToggle: \(event\) => setOpen\(event\.currentTarget\.open === true\)/, '折叠事件要同步到状态');
  assert.match(source, /open\s*\? h\(/, '折叠时不挂载正文');
  // 历史上限
  assert.match(source, /const RUNS_PAGE = \d+/, '要有历史上限');
  assert.match(source, /flow\.more/, '更早的轮次要能按需展开');
});

test('成员卡片可点进子代理会话，且子会话里有返回队长的入口', async () => {
  const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8');

  // 打开会话走宿主服务 uiWorkspace.openSession(target)（SessionTarget = SessionId | SubagentAddress）。
  // 软依赖：没有该服务时静默降级，面板照常可用，只是卡片不可点。
  assert.match(source, /function openSessionVia\(ctx, sessionId\)/, '应有统一的打开会话助手');
  assert.match(source, /ctx\.get\('uiWorkspace'\)/, '应经宿主 uiWorkspace 打开会话（软依赖取值）');
  assert.match(source, /uiWorkspace\.openSession\(sessionId\)/, '应调用 openSession');

  // 成员卡：整卡可点 + 键盘可达（Enter/Space），并把子会话 id 传出去
  assert.match(source, /dsh-teams-member/, '成员卡应有专门的样式类');
  assert.match(source, /member\.sessionId/, '成员卡要用成员的子会话 id');
  assert.match(source, /onClick: clickable \? openMember : undefined/, '可点时才挂 onClick');
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === ' '/, '键盘也要能进（可达性）');

  // 子会话横幅：识别 viewingAsChild 并给一条回队长的路
  // 真实缺陷：点进子代理后团队面板空白，只能返回主会话才看得到。
  assert.match(source, /viewingAsChild/, '应识别"正在看子代理会话"');
  assert.match(source, /nav\.backToCaptain/, '应给出返回队长会话的入口');
  assert.match(source, /openSession\(team\.captainSessionId\)/, '返回按钮应打开队长会话');

  // 任务卡：那一步的会话入口
  assert.match(source, /task\.openSession/, '任务卡应能点进那一步的子会话');
  assert.match(source, /openSession\(task\.childId\)/, '任务卡应打开 task.childId');
});

test('右栏标签类型与内容都注册，且正文按宿主的派发键注册（id 与 kind 两份）', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withSidebarRightTabs: true });
  module.apply(ctx);

  assert.ok(ctx.__log.tabType, '应注册右栏标签类型');
  assert.equal(typeof ctx.__log.tabType.id, 'string');
  assert.equal(typeof ctx.__log.tabType.kind, 'string');
  assert.equal(typeof ctx.__log.tabType.title, 'function');

  ctx.__declareSlot('sidebar.right.pane.tab');
  const keys = ctx.__log.registers
    .filter((item) => item.options.name === 'sidebar.right.pane.tab')
    .map((item) => item.options.key);

  // 宿主的派发键是 `definition?.id ?? tab.kind`（见 dsh-client-ui-sidebar-right 的 TabSlot）：
  // 类型注册成功时用 id，类型没注册上时退回 kind。两份都要有，否则正文会显示
  // 「这类内容还没有可用的查看方式。」——真实事故，已回归。
  assert.ok(keys.includes(ctx.__log.tabType.id), `正文必须注册在类型 id（${ctx.__log.tabType.id}）下`);
  assert.ok(keys.includes(ctx.__log.tabType.kind), `正文还必须注册在 kind（${ctx.__log.tabType.kind}）下，覆盖退回路径`);
});

test('缺少 locale 服务时退回中文默认值，不影响激活', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withLocale: false });
  assert.doesNotThrow(() => module.apply(ctx), '缺少 locale 服务不应导致激活失败');
  ctx.__declareSlot('conversation.session.header.actions');
  assert.ok(ctx.__log.registers.length > 0, '没有 locale 也应正常注册 UI');
});

test('effect 的清理函数可安全重复调用', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withSidebarRightTabs: true });
  let cleanup;
  const originalEffect = ctx.effect;
  ctx.effect = (fn, label) => {
    const dispose = fn();
    cleanup = () => dispose?.();
    return originalEffect.call(ctx, () => () => {}, label);
  };

  module.apply(ctx);
  assert.equal(typeof cleanup, 'function');
  assert.doesNotThrow(() => cleanup());
  assert.doesNotThrow(() => cleanup(), '重复清理不应抛错');
});

/* ================================================================== *
 * C. 设置卡片（plugins.bundle.config）
 *
 * 这一节回答验收里最难自证的两个问题：**卡片是怎么挂上去的**、
 * **保存是怎么走通的**。断言打在真实注册路径产出的 props 与渲染树上，
 * 而不是打在 client.js 的源码文本上。
 * ================================================================== */

/**
 * 按宿主的 `factoryKit()` 组出卡片真正收到的 props。
 *
 * 关键在 `t`：注册项声明了 `locale`，宿主就把 `t` 放进 **kit**（renderer
 * `client.js:949-952`），并且 `assertNoPropOverlap()` 对 kit 与 inject() 的重复
 * prop **直接抛 SlotAssemblyError**（同文件 943-944、1026）。所以 inject() 里
 * 绝不能返回 `t`——这条替身必须与宿主一样严格，否则测不出这个崩溃。
 */
function hostProps(ctx, entry, extra = {}) {
  const kit = { t: (key) => key, renderFactorySlot: () => null };
  const injected = entry.options.inject();
  const duplicate = Object.keys(injected).filter((name) => Object.hasOwn(kit, name));
  assert.deepEqual(
    duplicate,
    [],
    `inject() 返回了 kit 里已有的 prop：${duplicate.join('、')}（宿主会抛 SlotAssemblyError，卡片渲染即崩）`,
  );
  return { ...kit, ...injected, ...extra };
}

/** 挂载设置卡片：走真实注册路径，返回注册项、注入的 props 与渲染树。 */
async function mountSettingsCard({ settings: tweak = {}, view = 'form', ...ctxOptions } = {}) {
  const { module, React } = await pluginModule();
  const ctx = fakeClientContext(ctxOptions);
  Object.assign(ctx.__settings, tweak);
  module.apply(ctx);
  ctx.__declareSlot('plugins.bundle.config');

  const entry = ctx.__log.registers.find((item) => item.options.name === 'plugins.bundle.config');
  assert.ok(entry, '插件页应出现设置卡片（注册进 plugins.bundle.config 槽位）');
  const props = hostProps(ctx, entry, { view });
  const box = React.mount(entry.component, props);
  return { ctx, entry, props, box, React };
}

/** 取某个配置路径上的控件节点。 */
function controlAt(tree, path) {
  return collect(tree, (node) => node.props?.['data-path'] === path)[0];
}

/** 取渲染树里所有可编辑控件。 */
function controlsOf(tree) {
  return collect(tree, (node) => typeof node.props?.['data-path'] === 'string');
}

test('设置卡片注册到 plugins.bundle.config：key 用 bundle 包名，命名空间取条目 id，注入 form/mirror/schema', async () => {
  // 把所有软依赖都备齐，这样 missingServices 为空才真的说明"没有向 DSH 要不存在的服务"
  const { ctx, entry, props } = await mountSettingsCard({ withSidebarRightTabs: true });

  assert.deepEqual(ctx.__log.missingServices, [], '不应注入 DSH 里不存在的服务');
  assert.deepEqual(
    ctx.__log.servedNamespaces,
    ['dsh-teams'],
    '必须按 cordis 条目 id（不是包名）观察命名空间；写错不会有任何报错，卡片静默不出现',
  );
  assert.ok(ctx.__log.injects.includes('configForms'), '应惰性等待 configForms');
  assert.ok(ctx.__log.injects.includes('settingsSchema'), '应惰性等待 settingsSchema');

  // keyed 槽位按 key 派发：bundle 配置的 key 是**包名**（宿主契约原文：
  // "A bundle's own configuration, keyed by the bundle's package name"）。
  // 写错 key 不会报错，卡片只是永远没人渲染——真实事故：注册 active 但用户看不见。
  assert.equal(entry.options.key, '@dsh-external/dsh-teams', 'key 必须是 bundle 包名');
  assert.equal(entry.options.locale, ctx.__log.localeNs, '卡片文案应走本插件的字典命名空间');

  // t 由宿主按 `locale` 注入 kit，inject() 只能给宿主没有的那三样；
  // 多给一个 t 会让宿主抛 SlotAssemblyError（hostProps 里已按宿主语义拦截）
  assert.deepEqual(
    Object.keys(entry.options.inject()).sort(),
    ['form', 'mirror', 'schema'],
    'inject() 只应提供 form/mirror/schema，t 由宿主按 locale 注入',
  );
  for (const key of ['form', 'mirror', 'schema']) {
    assert.ok(props[key] !== undefined, `注册项必须向卡片注入 ${key}`);
  }
  assert.equal(typeof props.t, 'function', '卡片依赖宿主注入的 t');
  assert.equal(typeof entry.component, 'function');
});

test('摘要视图只给一句话，不挂表单（插件列表不展开整张卡）', async () => {
  const { entry, props, React } = await mountSettingsCard();
  const summary = React.mount(entry.component, { ...props, view: 'summary' });

  assert.equal(typeof summary.tree, 'string', '摘要视图应返回一行描述');
  assert.equal(collect(summary.tree, () => true).length, 0, '摘要视图不应渲染任何控件');
});

test('渲染：七个分组、每个可配置项一个控件，默认值走占位符', async () => {
  const { box } = await mountSettingsCard();

  const groups = collect(box.tree, (node) => node.type === 'fieldset');
  assert.equal(groups.length, 7, '应为七组：状态与路径/路由/调度/角色超时/看门狗/质量门/界面');

  const controls = controlsOf(box.tree);
  // 18 = Config 的 volatile 叶子数（ui.openTabOnPlan 已移除：客户端无法实现自动开标签）
  assert.equal(controls.length, 18, `应有 18 个控件（Config 的 volatile 叶子数），实际 ${controls.length}`);

  for (const path of [
    'stateDir',
    'routing.riskShortCircuit',
    'scheduler.maxParallel',
    'scheduler.maxRetries',
    'timeouts.enabled',
    'timeouts.heavy',
    'watch.probeMs',
    'watch.silenceLimitMs',
    'gates.requireEvidence',
    'ui.locale',
  ]) {
    assert.ok(controlAt(box.tree, path), `${path} 应有对应控件`);
  }

  // 未覆盖时控件为空、占位符显示宿主下发的默认值（默认值不手抄在客户端）
  const retries = controlAt(box.tree, 'scheduler.maxRetries');
  assert.equal(retries.props.value, '', '未覆盖的字段应为空');
  assert.equal(retries.props.placeholder, '2', '占位符应来自宿主 schema 的 default');

  const locale = controlAt(box.tree, 'ui.locale');
  assert.equal(locale.type, 'select', '界面语言应为下拉');
  assert.equal(locale.props.value, '', '未覆盖时下拉不预选，交给占位/默认');
});

test('无改动时保存禁用，改动后可用（且数字按数字提交）', async () => {
  const { ctx, box } = await mountSettingsCard();
  const saveButton = () => collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-primary')[0];

  assert.equal(saveButton().props.disabled, true, '没有改动时不应能保存');

  controlAt(box.tree, 'scheduler.maxRetries').props.onChange({ target: { value: '5' } });
  assert.equal(saveButton().props.disabled, false, '改动后应可保存');

  await saveButton().props.onClick();
  assert.equal(ctx.__settings.mutateCalls.length, 1, '保存应恰好提交一次');

  const call = ctx.__settings.mutateCalls[0];
  assert.deepEqual(
    call.ops,
    [{ op: 'set', path: ['scheduler', 'maxRetries'], value: 5 }],
    '数字字段必须以数字提交（写成字符串会被宿主解码拒绝）',
  );
  assert.equal(call.revision, 7, '必须带上读取时的 revision，并发改动才会被宿主拒绝而不是静默覆盖');

  assert.equal(saveButton().props.disabled, true, '保存成功后草稿清空，按钮回到禁用');
});

test('校验反馈：非整数与越界都在字段上报错，并挡住保存', async () => {
  const { box } = await mountSettingsCard();
  const saveButton = () => collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-primary')[0];
  const errorTexts = () =>
    collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-error').flatMap((node) => node.children);

  controlAt(box.tree, 'scheduler.maxParallel').props.onChange({ target: { value: '1.5' } });
  assert.equal(controlAt(box.tree, 'scheduler.maxParallel').props['aria-invalid'], 'true');
  assert.deepEqual(errorTexts(), ['set.errorInteger'], '非整数应报「整数」错');
  assert.equal(saveButton().props.disabled, true, '有字段错误时不得提交');

  // maxParallel 的 min 是 1（来自 index.js 的 .min(1)），0 是整数但不合法
  controlAt(box.tree, 'scheduler.maxParallel').props.onChange({ target: { value: '0' } });
  assert.deepEqual(errorTexts(), ['set.errorRange'], '越界应报「范围」错');
  assert.equal(saveButton().props.disabled, true);

  controlAt(box.tree, 'scheduler.maxParallel').props.onChange({ target: { value: '4' } });
  assert.deepEqual(errorTexts(), [], '合法值应清掉错误');
});

test('错误态：写被拒时保留用户输入并提示，不吞掉草稿', async () => {
  const { ctx, box } = await mountSettingsCard({ settings: { mutateAccepts: false } });

  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-x' } });
  const saveButton = collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-primary')[0];
  await saveButton.props.onClick();

  assert.equal(ctx.__settings.mutateCalls.length, 1, '被拒也要真的提交过');
  const alerts = collect(box.tree, (node) => node.props?.role === 'alert').flatMap((node) => node.children);
  assert.deepEqual(alerts, ['set.saveFailed'], '应给出可读的失败提示');
  assert.equal(
    controlAt(box.tree, 'stateDir').props.value,
    '.teams-x',
    '被拒后必须保留用户输入：不该让人为一次冲突重敲',
  );
});

test('加载态与只读态都有可读说明，且控件按可写性禁用', async () => {
  const loading = await mountSettingsCard({ settings: { status: 'loading' } });
  assert.equal(collect(loading.box.tree, (n) => n.type === 'fieldset').length, 0, '加载中不应画出半张表单');
  assert.ok(
    collect(loading.box.tree, (n) => n.props?.className === 'dsh-teams-set-note').some((n) =>
      n.children.includes('set.loading')),
    '加载态应有「读取设置…」说明',
  );

  const readOnly = await mountSettingsCard({ settings: { writable: false } });
  assert.ok(
    collect(readOnly.box.tree, (n) => n.props?.className === 'dsh-teams-set-note').some((n) =>
      n.children.includes('set.readOnly')),
    '只读部署应有说明',
  );
  assert.ok(
    controlsOf(readOnly.box.tree).every((node) => node.props.disabled === true),
    '只读部署下所有控件都应禁用',
  );
  assert.equal(
    collect(readOnly.box.tree, (n) => n.props?.className === 'dsh-teams-set-primary')[0].props.disabled,
    true,
    '只读部署下保存应禁用',
  );
});

test('覆盖标记与「恢复默认」：已覆盖字段可单字段回落', async () => {
  const { ctx, box } = await mountSettingsCard({
    settings: { value: { scheduler: { maxParallel: 6 } }, user: { scheduler: { maxParallel: 6 } } },
  });

  assert.equal(controlAt(box.tree, 'scheduler.maxParallel').props.value, '6', '生效值应回填到控件');
  const chips = collect(box.tree, (node) => node.props?.className?.includes('dsh-teams-set-chip'));
  assert.ok(
    chips.some((chip) => chip.children.includes('set.overridden')),
    '已覆盖字段应带「已覆盖」标记',
  );

  const reset = collect(box.tree, (node) => node.children?.includes('set.reset'))[0];
  assert.ok(reset, '已覆盖字段应提供「恢复默认」');
  reset.props.onClick();

  const saveButton = collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-primary')[0];
  await saveButton.props.onClick();
  assert.deepEqual(
    ctx.__settings.mutateCalls[0].ops,
    [{ op: 'unset', path: ['scheduler', 'maxParallel'] }],
    '「恢复默认」应提交 unset（回落默认/继承），而不是写一个猜测的默认值',
  );
});

test('软依赖：缺少设置服务时插件照常激活，只是没有这张卡', async () => {
  const { module } = await pluginModule();
  const ctx = fakeClientContext({ withSettings: false });

  assert.doesNotThrow(() => module.apply(ctx), '缺少设置服务不应导致激活失败');
  assert.deepEqual(ctx.__log.warns, [], '不应产生告警');
  assert.ok(
    !ctx.__log.registers.some((item) => item.options.name === 'plugins.bundle.config'),
    '没有设置服务时不应注册设置卡片',
  );

  ctx.__declareSlot('conversation.session.header.actions');
  assert.ok(
    ctx.__log.registers.some((item) => item.options.name === 'conversation.session.header.actions'),
    '团队入口不应受设置服务缺失影响',
  );
});

test('命名空间未被宿主服务时不挂载卡片（宿主卸载插件后不留空壳）', async () => {
  const { module, React } = await pluginModule();
  const ctx = fakeClientContext({ settingsServed: false });
  module.apply(ctx);

  assert.ok(ctx.__log.injects.includes('configForms'), '仍应惰性等待设置服务');
  assert.deepEqual(ctx.__log.servedNamespaces, ['dsh-teams'], '观察的命名空间依然要被登记');
  assert.ok(
    !ctx.__log.registers.some((item) => item.options.name === 'plugins.bundle.config'),
    '命名空间不在 describe 镜像里时不应注册卡片',
  );
  assert.equal(typeof React.mount, 'function');
});

/* ================================================================== *
 * D. 设置卡片：边界与异常（补齐验收证据）
 *
 * C 节覆盖的是正常路径。本节补的是真正决定成败的那几条边：提交的类型是不是宿主
 * 期望的、空值与撤销的语义、宿主校验失败时用户能不能看懂、以及**写调用抛错**时
 * 卡片还能不能用。任何一条红，都意味着真实用户会撞上。
 * ================================================================== */

const saveBtn = (box) => collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-primary')[0];
const alertsIn = (box) => collect(box.tree, (node) => node.props?.role === 'alert').flatMap((node) => node.children);
const errorsIn = (box) =>
  collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-error').flatMap((node) => node.children);
const labelled = (box, text) => collect(box.tree, (node) => node.children?.includes(text))[0];
/** 提交的操作按路径排序，避免把断言绑在编辑顺序上。 */
const byPath = (ops) => [...ops].sort((left, right) => left.path.join('.').localeCompare(right.path.join('.')));

/**
 * 与 `mountSettingsCard` 同一条真实注册路径，但允许在**首次渲染前**改 props：
 * 退化 schema、闸门化的 form、自定义字典都必须在首渲染前就位才生效。
 */
async function mountCard({ settings = {}, ...ctxOptions } = {}) {
  const { module, React } = await pluginModule();
  const ctx = fakeClientContext(ctxOptions);
  Object.assign(ctx.__settings, settings);
  module.apply(ctx);
  ctx.__declareSlot('plugins.bundle.config');

  const entry = ctx.__log.registers.find((item) => item.options.name === 'plugins.bundle.config');
  assert.ok(entry, '插件页应出现设置卡片（注册进 plugins.bundle.config 槽位）');
  const props = hostProps(ctx, entry, { view: 'form' });

  return {
    ctx,
    entry,
    React,
    props,
    mount(prepare) {
      prepare?.(props);
      return { props, box: React.mount(entry.component, props) };
    },
  };
}

test('开关提交布尔、下拉提交字符串（类型错了宿主会整份拒绝）', async () => {
  // 生效值必须是 true：开关「关到 false」才与当前值不同，否则草稿会被正确地撤回
  const { ctx, mount } = await mountCard({ settings: { value: { gates: { requireEvidence: true } } } });
  const { box } = mount();

  const toggle = controlAt(box.tree, 'gates.requireEvidence');
  assert.equal(toggle.props.checked, true, '生效值应回填到开关');
  toggle.props.onChange({ target: { checked: false } });
  controlAt(box.tree, 'ui.locale').props.onChange({ target: { value: 'en' } });
  assert.equal(saveBtn(box).props.disabled, false);

  await saveBtn(box).props.onClick();
  assert.deepEqual(
    byPath(ctx.__settings.mutateCalls[0].ops),
    [
      { op: 'set', path: ['gates', 'requireEvidence'], value: false },
      { op: 'set', path: ['ui', 'locale'], value: 'en' },
    ],
    '布尔必须是布尔、选项必须是字符串：写成 "false" / 数字都会被宿主解码拒绝',
  );
});

test('多字段混合改动在一次提交里各自带对类型（数字/布尔/文本）', async () => {
  const { ctx, mount } = await mountCard({
    settings: { value: { gates: { securityBlock: true } } },
  });
  const { box } = mount();

  controlAt(box.tree, 'scheduler.maxParallel').props.onChange({ target: { value: '6' } });
  controlAt(box.tree, 'gates.securityBlock').props.onChange({ target: { checked: false } });
  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-ci' } });
  await saveBtn(box).props.onClick();

  assert.equal(ctx.__settings.mutateCalls.length, 1, '三个字段应合并成一次原子提交，而不是三次写入');
  assert.deepEqual(
    byPath(ctx.__settings.mutateCalls[0].ops),
    [
      { op: 'set', path: ['gates', 'securityBlock'], value: false },
      { op: 'set', path: ['scheduler', 'maxParallel'], value: 6 },
      { op: 'set', path: ['stateDir'], value: '.teams-ci' },
    ],
  );
  assert.equal(ctx.__settings.mutateCalls[0].revision, 7, '整批操作共用一个 revision');
});

test('文本框：清空按 unset 提交（回落默认），填回当前值则撤回草稿', async () => {
  const cleared = await mountCard({ settings: { value: { stateDir: '.dsh-teams' } } });
  const clearedBox = cleared.mount().box;
  assert.equal(controlAt(clearedBox.tree, 'stateDir').props.value, '.dsh-teams', '生效值应回填');

  controlAt(clearedBox.tree, 'stateDir').props.onChange({ target: { value: '   ' } });
  await saveBtn(clearedBox).props.onClick();
  assert.deepEqual(
    cleared.ctx.__settings.mutateCalls[0].ops,
    [{ op: 'unset', path: ['stateDir'] }],
    '清空必须是 unset（回落默认/继承），不能用空字符串覆盖配置',
  );

  // 敲回与生效值相同的文本：这是「真的没改」，不应产生一次写入
  const reverted = await mountCard({ settings: { value: { stateDir: '.dsh-teams' } } });
  const revertedBox = reverted.mount().box;
  controlAt(revertedBox.tree, 'stateDir').props.onChange({ target: { value: '.dsh-teams' } });
  assert.equal(saveBtn(revertedBox).props.disabled, true, '与当前值相同的输入不算改动，保存应保持禁用');
});

test('Escape 撤单字段、「放弃修改」清全部草稿，不留给宿主脏写', async () => {
  const { ctx, mount } = await mountCard({ settings: { value: { scheduler: { maxRetries: 2 } } } });
  const { box } = mount();

  controlAt(box.tree, 'scheduler.maxRetries').props.onChange({ target: { value: '9' } });
  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-x' } });

  controlAt(box.tree, 'scheduler.maxRetries').props.onKeyDown({ key: 'Escape' });
  assert.equal(controlAt(box.tree, 'scheduler.maxRetries').props.value, '2', 'Escape 应把该字段退回生效值');
  assert.equal(saveBtn(box).props.disabled, false, '另一个字段仍是脏的');

  labelled(box, 'set.discard').props.onClick();
  assert.equal(saveBtn(box).props.disabled, true, '放弃修改后不应还有可提交的内容');
  assert.equal(controlAt(box.tree, 'stateDir').props.value, '', '放弃后控件应回到生效值');
  assert.equal(controlAt(box.tree, 'scheduler.maxRetries').props.value, '2');

  assert.equal(ctx.__settings.mutateCalls.length, 0, '撤销与放弃都不该产生写入');
});

test('保存进行中：主按钮与控件冻结、文案切到「保存中」，成功后清空草稿并提示「已保存」', async () => {
  const { mount } = await mountCard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const { box } = mount((props) => {
    props.form = {
      ...props.form,
      mutate: async (ops, revision) => {
        calls.push({ ops, revision });
        await gate;
        return true;
      },
    };
  });

  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-busy' } });
  const pending = saveBtn(box).props.onClick();

  assert.equal(saveBtn(box).props.disabled, true, '在途写入期间不得再次提交');
  assert.ok(labelled(box, 'set.saving'), '按钮应显示「保存中…」');
  assert.equal(controlAt(box.tree, 'stateDir').props.disabled, true, '在途期间应冻结控件，否则提交的内容与界面所见不一致');

  release();
  await pending;

  assert.equal(calls.length, 1, '只应写入一次');
  assert.equal(controlAt(box.tree, 'stateDir').props.value, '', '成功后草稿应清空');
  assert.equal(
    collect(box.tree, (node) => node.props?.role === 'status').flatMap((node) => node.children)[0],
    'set.saved',
    '应给出「已保存」反馈',
  );
});

test('宿主校验失败：挡住保存并带上宿主给的原因（客户端判不出的形态也不能放行）', async () => {
  // gates.securityBlock 在生效值里是字符串。逐字段校验只看数字形态，判不出这种错；
  // 能发现它的只有与宿主同源的 settingsSchema.validate —— 那正是 host 的最终闸门。
  const { mount } = await mountCard({ settings: { value: { gates: { securityBlock: 'yes' } } } });
  const { box } = mount();

  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-x' } });

  const alerts = alertsIn(box);
  assert.equal(alerts.length, 1, '应给出一条全局校验失败提示');
  assert.match(String(alerts[0]), /^set\.invalid/, '应说明「未通过宿主的配置校验」');
  assert.match(String(alerts[0]), /gates\.securityBlock/, '应带上宿主给出的具体原因，而不是只有一句「无效」');
  assert.equal(saveBtn(box).props.disabled, true, '宿主一定会拒的值不得提交');
});

test('数字边界：正好等于下界合法，负数与科学计数法按「非负整数」拦下', async () => {
  const { ctx, mount } = await mountCard();
  const { box } = mount();
  const retries = () => controlAt(box.tree, 'scheduler.maxRetries');

  retries().props.onChange({ target: { value: '0' } }); // natural 的下界
  assert.deepEqual(errorsIn(box), [], '0 是 natural 的合法下界，不该报错');
  assert.equal(saveBtn(box).props.disabled, false);

  retries().props.onChange({ target: { value: '-1' } });
  assert.deepEqual(errorsIn(box), ['set.errorInteger'], '负数应报「非负整数」');
  assert.equal(saveBtn(box).props.disabled, true);

  retries().props.onChange({ target: { value: '1e3' } });
  assert.deepEqual(errorsIn(box), ['set.errorInteger'], '科学计数法不在输入形态里，本地先拦比让宿主整份拒更早');

  retries().props.onChange({ target: { value: ' 7 ' } });
  assert.deepEqual(errorsIn(box), [], '两端空白应被裁掉');
  await saveBtn(box).props.onClick();
  assert.deepEqual(
    ctx.__settings.mutateCalls[0].ops,
    [{ op: 'set', path: ['scheduler', 'maxRetries'], value: 7 }],
    '裁剪后的文本仍要按数字提交',
  );
});

test('分组可折叠：收起后该组控件消失，其它组不受影响', async () => {
  const { mount } = await mountCard();
  const { box } = mount();
  const toggles = () => collect(box.tree, (node) => node.props?.className === 'dsh-teams-set-toggle');

  assert.equal(toggles()[0].props['aria-expanded'], 'true', '默认应展开');
  toggles()[0].props.onClick();

  assert.equal(toggles()[0].props['aria-expanded'], 'false', '折叠按钮应同步 aria-expanded');
  assert.equal(controlAt(box.tree, 'stateDir'), undefined, '收起后不应再渲染该组控件');
  assert.ok(controlAt(box.tree, 'scheduler.maxParallel'), '其它分组不受影响');
});

test('已覆盖计数经 {n} 占位符替换后显示（占位符不替换等于没提示）', async () => {
  const { mount } = await mountCard({
    settings: {
      value: { stateDir: '.x', scheduler: { maxRetries: 2 } },
      user: { stateDir: '.x', scheduler: { maxRetries: 2 } },
    },
  });
  const { box } = mount((props) => {
    props.t = (key) => (key === 'set.covered' ? '已覆盖 {n} 项' : key);
  });

  const chip = collect(box.tree, (node) => node.props?.className?.includes('dsh-teams-set-chip'))[0];
  assert.equal(chip.children[0], '已覆盖 2 项', '覆盖项数应替换进 {n}，而不是把占位符原样显示');
});

test('schema 信封损坏时不把插件页炸掉（降级渲染，异常不外抛）', async () => {
  const { mount } = await mountCard();
  let mounted;
  assert.doesNotThrow(() => {
    mounted = mount((props) => {
      props.schema = {
        ...props.schema,
        rehydrate: () => {
          throw new Error('envelope corrupted');
        },
      };
    });
  }, 'rehydrate 抛错必须被卡片自己兜住：渲染层的异常会带走整个插件页');

  assert.equal(
    collect(mounted.box.tree, (node) => node.props?.className === 'dsh-teams-set').length,
    1,
    '卡片本身仍应渲染出来',
  );
});

test('异常态：宿主写调用抛错时卡片必须回到可用状态（不得锁死在「保存中」）', async () => {
  // 真实 mutate 会把 ctx.remote.settings.mutate 的拒绝原样抛出（ui-settings lib/client.js:1165-1185），
  // 传输中断、宿主重启都会走到这里。这不是臆想的场景。
  const { mount } = await mountCard();
  const { box } = mount((props) => {
    props.form = {
      ...props.form,
      mutate: async () => {
        throw new Error('remote transport closed');
      },
    };
  });

  controlAt(box.tree, 'stateDir').props.onChange({ target: { value: '.teams-x' } });
  let escaped;
  await saveBtn(box).props.onClick().catch((cause) => {
    escaped = cause;
  });

  assert.equal(
    escaped,
    undefined,
    `提交不应把异常抛给渲染层：没人接的拒绝既给不出提示，也走不到 setSaving(false)。实际抛出：${escaped?.message}`,
  );
  assert.equal(collect(box.tree, (node) => node.children?.includes('set.saving')).length, 0, '不能停在「保存中…」');
  assert.equal(saveBtn(box).props.disabled, false, '写失败后应能重试');
  assert.deepEqual(alertsIn(box), ['set.saveFailed'], '应给出可读的失败提示');
  assert.equal(controlAt(box.tree, 'stateDir').props.value, '.teams-x', '失败后保留用户输入');
});

/* ================================================================== *
 * 设置页：配置项 / 角色 两个页签
 * ================================================================== */

/** 按文字找按钮。 */
function buttonByText(tree, text) {
  return collect(
    tree,
    (node) => node.type === 'button' && node.children?.[0] === text,
  )[0];
}

test('设置页：两个页签，默认停在「配置项」', async () => {
  const { box } = await mountSettingsCard();
  const tabs = collect(box.tree, (node) => node.props?.role === 'tab');
  assert.equal(tabs.length, 2, '应有「配置项」「角色」两个页签');
  assert.equal(tabs[0].props['aria-selected'], 'true', '默认选中配置项');
  assert.equal(tabs[1].props['aria-selected'], 'false');
  // 默认页签下仍然是配置项表单
  assert.ok(controlAt(box.tree, 'scheduler.maxRetries'), '配置项页应有表单');
  // 角色管理未挂载
  assert.equal(collect(box.tree, (node) => node.props?.['aria-label'] === '搜索角色（名称 / 描述 / 触发词）').length, 0);
});

test('设置页：切到「角色」后配置表单让位，角色管理挂上', async () => {
  const { box } = await mountSettingsCard();
  const tabs = collect(box.tree, (node) => node.props?.role === 'tab');
  tabs[1].props.onClick();

  assert.equal(controlAt(box.tree, 'scheduler.maxRetries'), undefined, '角色页不应再显示配置表单');
  assert.equal(collect(box.tree, (node) => node.type === 'fieldset').length, 0, '不应再有配置分组');
  // 角色管理的元素挂在根节点下（假 React 不递归渲染子组件，所以断言到"挂上了"这一层）
  const mounted = collect(box.tree, (node) => typeof node.type === 'function');
  assert.ok(mounted.length >= 1, '应挂载角色管理组件');
  assert.equal(typeof mounted[0].props?.t, 'function', '角色管理应拿到文案函数');
});

test('设置页：角色页签下不显示「已覆盖」徽标（那是配置项的说法）', async () => {
  const { box } = await mountSettingsCard();
  const chips = () =>
    collect(box.tree, (node) => String(node.props?.className ?? '').includes('dsh-teams-set-chip'));
  assert.equal(chips().length, 1, '配置项页有一个覆盖数徽标');
  // 测试环境的 t() 返回 key 本身，所以只断言"有内容"
  assert.ok(chips()[0].children?.[0], '配置项页应显示覆盖数');
  const tabs = collect(box.tree, (node) => node.props?.role === 'tab');
  tabs[1].props.onClick();
  assert.equal(chips()[0].children?.[0], '', '角色页清空该徽标');
});
;
