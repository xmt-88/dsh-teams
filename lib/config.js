/**
 * DSH Teams — 配置读取
 *
 * 为什么需要这一层：插件的**每个配置叶子都标了 `.volatile()`**（见 `index.js` 里
 * Config 的注释——不标的话，宿主 `dsh-settings` 根本不会把这个插件下发给设置页，
 * 卡片连出现的机会都没有）。而标了 volatile 的字段会被宿主解析成 **cosmokit 的只读引用**
 * （`Object.freeze({ get })`），必须 `.get()` 才拿得到值。
 *
 * 直接把它当值用会得到 `[object Object]`：`stateRootOf(workspace, config.stateDir)`
 * 会拼出 `[object Object]` 目录，`Math.max(1, config.scheduler.maxParallel)` 会得到 NaN。
 * 这种错误**不抛异常**，只是行为悄悄错掉——所以统一走这里，不要在别处手写解包。
 *
 * 同时兼容"没有走 Loader"的场合（单元测试直接传普通对象）：那时字段就是普通值，原样返回。
 *
 * @param {unknown} ref - 配置叶子（可能是 volatile 引用，也可能是普通值）
 * @param {unknown} fallback - 取不到值时的兜底
 * @returns {unknown}
 */
export function readField(ref, fallback) {
  const value =
    ref !== null && typeof ref === 'object' && typeof ref.get === 'function' && Object.isFrozen(ref)
      ? ref.get()
      : ref;
  return value === undefined ? fallback : value;
}

/** 状态目录（相对会话工作区）。 */
export function resolveStateDir(config) {
  return readField(config?.stateDir, '.dsh-teams');
}

/** 墙钟闸门：`{ enabled, heavy, medium, light, infrastructure }`（秒）。 */
export function resolveTimeouts(config) {
  const timeouts = config?.timeouts;
  return {
    enabled: readField(timeouts?.enabled, false) === true,
    heavy: readField(timeouts?.heavy, 2700),
    medium: readField(timeouts?.medium, 1200),
    light: readField(timeouts?.light, 900),
    infrastructure: readField(timeouts?.infrastructure, 300),
  };
}

/**
 * 看门狗参数覆盖项。
 *
 * 只返回**确实配了且是正数**的键：其余留给 `lib/runner.js` 的 WATCH_LIMITS 默认值，
 * 避免"配置里没有这个键"被解包成 undefined 后覆盖掉默认值。
 */
export function watchOverrides(config) {
  const watch = config?.watch;
  const out = {};
  for (const key of ['probeMs', 'idleGraceMs', 'silenceLimitMs', 'stallFloorMs', 'stallFactor']) {
    const value = readField(watch?.[key], undefined);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

/** 调度参数：并发、重试、审查轮数。 */
export function resolveScheduler(config) {
  const scheduler = config?.scheduler;
  return {
    maxParallel: readField(scheduler?.maxParallel, 4),
    maxRetries: readField(scheduler?.maxRetries, 2),
    maxReviewRounds: readField(scheduler?.maxReviewRounds, 3),
  };
}

/** 质量门开关。 */
export function resolveGates(config) {
  const gates = config?.gates;
  return {
    requireEvidence: readField(gates?.requireEvidence, true) === true,
    securityBlock: readField(gates?.securityBlock, true) === true,
  };
}

/** 路由阈值。 */
export function resolveRouting(config) {
  const routing = config?.routing;
  return {
    riskShortCircuit: readField(routing?.riskShortCircuit, true) === true,
    fastMax: readField(routing?.fastMax, 1),
    standardMax: readField(routing?.standardMax, 4),
  };
}

/** UI 偏好。 */
export function resolveUi(config) {
  const ui = config?.ui;
  return {
    locale: readField(ui?.locale, 'zh-CN'),
    openTabOnPlan: readField(ui?.openTabOnPlan, true) === true,
  };
}
