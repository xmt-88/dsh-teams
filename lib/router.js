/**
 * DSH Teams — 路由引擎（纯函数，无 IO、无宿主依赖）
 *
 * 移植并强化自 team-mode 的三维路由矩阵：
 *   维度 = 变更规模(scale) + 影响范围(impact) + 风险等级(risk)
 *   决策 = 风险优先短路 → 三维加和 → 关键词覆盖 → 边界倾向更重路径
 *
 * 本模块只做决策，不产生副作用，因此可以被单测完全覆盖。
 */

/** 五条路径。 */
export const PATHS = Object.freeze({
  FAST: 'fast',
  STANDARD: 'standard',
  FULL: 'full',
  DEBUG: 'debug',
  DEPLOY: 'deploy',
  /** 调试 + 安全审查的组合路径（运行时判定，不可由用户直接指定）。 */
  DEBUG_SECURE: 'debug-secure',
});

/** 路径的中文展示名。 */
export const PATH_LABELS = Object.freeze({
  fast: '快速',
  standard: '标准',
  full: '完整',
  debug: '调试',
  deploy: '部署',
  'debug-secure': '调试（含安全审查）',
});

/** 三维评分上限。 */
export const SCORE_MAX = 6;

/**
 * 路径模板：角色链 + 依赖 + 可选条件。
 *
 * `deps` 使用模板内的 step id；同组 deps 相同的步骤即为并行组。
 * `optional` + `condition` 表示条件插入步骤，计划阶段按 needsUiDesign 决定是否保留。
 *
 * @typedef {object} StepTemplate
 * @property {string}   id          - 模板内唯一 id
 * @property {string}   role        - 角色 id（见 roles.js）
 * @property {string[]} deps        - 依赖的 step id
 * @property {string}   kind        - 任务种类，决定质量门要求
 * @property {boolean} [optional]   - 是否条件步骤
 * @property {string}  [condition]  - 条件名（当前仅 'ui'）
 */
export const PATH_TEMPLATES = Object.freeze({
  fast: [
    { id: 'executor', role: 'executor', deps: [], kind: 'implementation' },
    { id: 'review', role: 'code-reviewer', deps: ['executor'], kind: 'review' },
    { id: 'verify', role: 'verifier', deps: ['review'], kind: 'verification' },
  ],

  standard: [
    { id: 'analyst', role: 'analyst', deps: [], kind: 'requirements' },
    { id: 'ui', role: 'ui-designer', deps: ['analyst'], kind: 'work', optional: true, condition: 'ui' },
    { id: 'architect', role: 'architect', deps: ['analyst'], kind: 'work' },
    // ⚠️ 依赖里写上 'ui' 是**有意为之**：设计产出必须真的交到实现者手里。
    // 之前只依赖 architect，UI 设计步骤与架构是兄弟节点，产出没人消费——
    // 等于白跑一趟（真实缺陷：图里有设计步骤，实现者却收不到设计）。
    // 'ui' 是可选步骤，被裁掉时由 buildSteps 统一剪掉悬空依赖，不会让任务永远不就绪。
    { id: 'executor', role: 'executor', deps: ['architect', 'ui'], kind: 'implementation' },
    { id: 'review', role: 'code-reviewer', deps: ['executor'], kind: 'review' },
    { id: 'test', role: 'test-engineer', deps: ['executor'], kind: 'verification' },
    { id: 'verify', role: 'verifier', deps: ['review', 'test'], kind: 'verification' },
  ],

  full: [
    { id: 'analyst', role: 'analyst', deps: [], kind: 'requirements' },
    { id: 'ui', role: 'ui-designer', deps: ['analyst'], kind: 'work', optional: true, condition: 'ui' },
    { id: 'architect', role: 'architect', deps: ['analyst'], kind: 'work' },
    { id: 'critic', role: 'critic', deps: ['architect'], kind: 'work' },
    { id: 'executor', role: 'executor', deps: ['critic', 'ui'], kind: 'implementation' },
    { id: 'simplify', role: 'code-simplifier', deps: ['executor'], kind: 'work' },
    { id: 'review', role: 'code-reviewer', deps: ['executor'], kind: 'review' },
    // 安全门依赖 executor：它要审的是**这次改动**。以前依赖 architect，
    // 于是在实现之前/并行就跑完，PASS 只覆盖变更前的代码（审计 R6-15）。
    { id: 'security', role: 'security-reviewer', deps: ['executor'], kind: 'review' },
    { id: 'test', role: 'test-engineer', deps: ['executor'], kind: 'verification' },
    { id: 'verify', role: 'verifier', deps: ['simplify', 'review', 'security', 'test'], kind: 'verification' },
  ],

  deploy: [
    { id: 'devops', role: 'devops', deps: [], kind: 'work' },
    { id: 'deploy-audit', role: 'deploy-auditor', deps: ['devops'], kind: 'review' },
    { id: 'verify', role: 'verifier', deps: ['deploy-audit'], kind: 'verification' },
  ],

  debug: [
    { id: 'debugger', role: 'debugger', deps: [], kind: 'work' },
    { id: 'executor', role: 'executor', deps: ['debugger'], kind: 'implementation' },
    { id: 'review', role: 'code-reviewer', deps: ['executor'], kind: 'review' },
    { id: 'verify', role: 'verifier', deps: ['review'], kind: 'verification' },
  ],

  /**
   * 调试 + 安全审查的组合路径。
   *
   * 当"这是个 bug"与"这段代码涉及认证/支付/数据安全"同时成立时，两条规则都不该被丢弃：
   * 既需要根因分析（而非全流程重走），又必须过安全门。缺任何一边都是错的——
   * 只走 full 会丢掉"先定位根因"这个关键步骤；只走 debug 会把安全面漏掉。
   */
  'debug-secure': [
    { id: 'debugger', role: 'debugger', deps: [], kind: 'work' },
    { id: 'executor', role: 'executor', deps: ['debugger'], kind: 'implementation' },
    { id: 'review', role: 'code-reviewer', deps: ['executor'], kind: 'review' },
    { id: 'security', role: 'security-reviewer', deps: ['debugger'], kind: 'review' },
    { id: 'verify', role: 'verifier', deps: ['review', 'security'], kind: 'verification' },
  ],
});

/**
 * 旧 skill 的「按任务类型默认路径」表，迁移为关键词词表。
 * 中英混合匹配；中文用子串，英文用词边界。
 */
const KEYWORDS = Object.freeze({
  debug: {
    zh: ['报错', '异常', '不工作', '崩溃', '闪退', '修复', '排查', '定位问题', '丢数据', '内存泄漏', '死锁'],
    en: ['bug', 'error', 'exception', 'crash', 'broken', 'not working', 'regression', 'stack trace', 'debug'],
  },
  deploy: {
    zh: ['部署', '发布', '上线', '回滚', '服务器', '生产环境', '打包发布'],
    en: ['deploy', 'release', 'rollback', 'production', 'ship to server'],
  },
  ui: {
    zh: ['界面', '页面', '布局', '样式', '主题', '配色', '颜色', '窗口', '对话框', '按钮', '图标', '美化', '外观', '交互', '视觉', '排版', '字体', '间距', '动效', '动画'],
    en: ['ui', 'ux', 'design', 'layout', 'theme', 'style', 'stylesheet', 'color scheme', 'animation', 'button', 'icon', 'font', 'spacing', 'css'],
  },
  /** 否定条件：命中则不做 UI 路由（旧 skill 原文照搬并扩展）。 */
  uiNegative: {
    zh: ['纯后端', '接口', '数据库', '配置文件', '打包', '部署脚本'],
    en: ['backend', 'api only', 'database', 'migration', 'config file', 'build script'],
  },
  /** 风险等级 2：认证 / 支付 / 直接安全。命中即短路到完整路径。 */
  /**
   * 歧义风险词：单独出现多半是噪音，**必须配语境词**才算安全信号。
   *
   * 实测误判两例：`给团队面板加"子会话"跳转` 被 `会话` 判成高风险 → 完整路径（3 小时）；
   * `token 预算优化` 被 `token` 判成高风险。这类词在 UI / 用量语境里天天出现。
   * 而 `会话劫持` / `token 泄露` / `sql 注入` 是真信号，所以不能删词，只能加共现条件。
   */
  riskAmbiguous: {
    zh: ['会话', '令牌', '票据', 'sql'],
    en: ['session', 'token', 'sql'],
  },
  /** 出现这些词时，歧义风险词才算数。 */
  riskContext: {
    zh: ['劫持', '固定', '泄露', '绕过', '篡改', '伪造', '注入', '攻击', '越权', '过期', '失效', '401', '403'],
    en: ['hijack', 'fixation', 'leak', 'bypass', 'tamper', 'forge', 'inject', 'attack', 'revoke', 'expire'],
  },
  riskHigh: {
    zh: [
      '认证', '鉴权', '登录', '授权', '支付', '结算', '订单金额', '密钥', '凭据', '密码', '加密', '脱敏',
      '权限', '越权', '注入', '漏洞', '安全审计',
      // 审计补充：这些是用户真会说的词，之前全部漏判
      '退款', '签名', '隐私', '银行卡', '身份证', '交易',
      // HTTP 状态码字面出现就是明确信号（纯数字走直接包含匹配，不会被空词干误命中）
      '401', '403',
    ],
    en: [
      'auth', 'authenticat', 'authoriz', 'login', 'oauth', 'jwt', 'payment', 'billing', 'checkout',
      'credential', 'secret', 'password', 'encrypt', 'decrypt', 'permission', 'privilege', 'injection',
      'vulnerability', 'cve', 'security audit',
      // 审计补充：英文侧的高频安全词
      'cookie', 'signature', 'crypt', 'xss', 'csrf', 'sanitiz',
      'tls', 'ssl', 'tenant',
    ],
  },
  /** 风险等级 1：功能扩展 / 间接安全。 */
  riskMedium: {
    zh: ['重构', '优化', '新增', '扩展', '改造', '升级', '迁移', '并发', '缓存', '日志', '监控', '上传', '下载'],
    en: ['refactor', 'optimize', 'extend', 'migrate', 'upgrade', 'concurrency', 'cache', 'logging', 'upload', 'download'],
  },
  /** 规模等级 2 的规模词。 */
  scaleLarge: {
    zh: ['跨模块', '跨服务', '架构', '全新', '从零', '整体改', '全量', '大范围', '多模块', '端到端', '框架', '全站', '系统性'],
    en: ['architecture', 'across modules', 'cross-module', 'from scratch', 'end-to-end', 'whole codebase', 'framework', 'entire codebase'],
  },
  /** 规模等级 1 的规模词：明确超出"单点小改"但仍属中等。 */
  scaleMedium: {
    zh: ['新增', '添加', '增加', '重构', '扩展', '改造', '升级', '迁移', '引入', '接入', '实现', '开发', '搭建', '生成'],
    en: ['add', 'implement', 'extend', 'refactor', 'migrate', 'upgrade', 'integrate', 'introduce', 'build a', 'create a'],
  },
  /** 规模等级 0 的规模词：明确的单点小改。 */
  scaleSmall: {
    zh: ['改一下', '改改', '微调', '小改', '一处', '单个', '这个', '该', '删除一行', '改个', '调一下', '修一下', '注释', '文案', '错别字'],
    en: ['typo', 'tweak', 'small fix', 'one line', 'rename', 'comment'],
  },
});

/** 命中任一（中文子串 / 英文词边界）即返回 true。 */
/**
 * 英文词干化：把常见屈折后缀去掉，让 `credentials` 命中 `credential`、
 * `authentication` 命中 `authenticat`。
 *
 * 审计 M7：以前英文走"词边界精确匹配"，只认原形——`permissions`/`credentials`/
 * `secrets`/`encryption`/`payments`/`vulnerabilities`/`authenticate` 全部漏判（实测 9/9）。
 * 中文没有屈折变化，所以只做子串匹配即可。
 *
 * @param {string} word
 * @returns {string}
 */
function stemEnglish(word) {
  return String(word)
    .toLowerCase()
    .replace(/ies$/, 'y')
    .replace(/(ations|ation|ions|ion|ings|ing|ers|er|eds|ed|es|s)$/, '')
    .replace(/e$/, '')
    // OAuth2 / sql2 这类带版本号的写法：去掉尾部数字再比对
    .replace(/\d+$/, '');
}

/** 把一段文本切成"词干集合"，用于英文关键词判定。 */
function stemSet(text) {
  const words = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const set = new Set();
  for (const word of words) {
    set.add(word);
    // 空词干不入集合：否则 '' 会和别的 '' 互相命中（同上，数字被剥光就会产生空串）
    const stem = stemEnglish(word);
    if (stem !== '') set.add(stem);
    // 复合词也拆一层：securityaudit → security + audit 由下面的 includes 兜底
  }
  return set;
}

function hits(text, table, _locale) {
  // ⚠️ locale 只决定**界面文案**，不能过滤关键词池。
  // 以前 locale==='en' 时只取英文词表 → 中文安全任务（支付/认证/凭据）风险判 0，
  // 直接落到 fast 路径，四道门全被跳过（审计 R6-07，已实测复现）。
  // 任务文本用哪种语言与界面语言无关，所以永远中英合并。
  const pool = [...KEYWORDS[table].zh, ...KEYWORDS[table].en];
  // 英文词干集合只算一次（关键词表里多数是英文，逐个建正则会重复分词）
  let stems;
  for (const word of pool) {
    // ⚠️ 纯数字关键词（如 HTTP 状态码 401/403）必须直接包含匹配：
    // stemEnglish 会把尾部数字整段剥掉 → '401' 变成空串，而文本里任何数字（"6 条" 的 6）
    // 剥完也是空串 → 空串命中空串，任何带数字的任务都会被判成安全高风险。
    if (/^\d+$/.test(word)) {
      if (text.includes(word)) return true;
      continue;
    }
    if (/^[\x20-\x7e]+$/.test(word)) {
      // 纯 ASCII：按词干比对（含多词关键词，逐词都要在集合里）
      stems ??= stemSet(text);
      const parts = word.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.every((part) => stems.has(part) || stems.has(stemEnglish(part)))) return true;
    } else if (text.includes(word)) {
      return true;
    }
  }
  return false;
}

/**
 * 三维评分。
 *
 * scale：单文件≤20行=0 / 2-5文件≤200行=1 / >5文件或>200行=2
 * impact：无依赖影响=0 / 同模块内=1 / 跨模块或跨服务=2
 * risk：纯样式注释=0 / 功能扩展或间接安全=1 / 认证·支付·直接安全=2
 *
 * @param {object} input
 * @param {string} input.taskText
 * @param {number} [input.filesTouched]     - 预估改动文件数
 * @param {number} [input.linesTouched]     - 预估改动行数
 * @param {boolean} [input.crossModule]     - 是否跨模块
 * @param {boolean} [input.touchesShared]   - 是否触碰共享/公共层
 * @param {'zh'|'en'} [input.locale]
 * @returns {{scale:number, impact:number, risk:number, reasons:string[]}}
 */
export function score(input) {
  const text = String(input.taskText ?? '');
  const reasons = [];

  // ---- scale ----
  let scale = 0;
  const files = Number.isFinite(input.filesTouched) ? input.filesTouched : -1;
  const lines = Number.isFinite(input.linesTouched) ? input.linesTouched : -1;
  if (files > 5 || lines > 200) {
    scale = 2;
    reasons.push(`规模=2（${files > 5 ? `${files} 个文件` : `${lines} 行`}超出中等预算）`);
  } else if ((files >= 2 && files <= 5) || (lines >= 21 && lines <= 200)) {
    scale = 1;
    reasons.push(`规模=1（${files >= 0 ? `${files} 个文件` : `${lines} 行`}属中等改动）`);
  } else if (files >= 0 || lines >= 0) {
    reasons.push(`规模=0（${files >= 0 ? `${files} 个文件` : `${lines} 行`}属小改动）`);
  } else if (hits(text, 'scaleLarge', input.locale)) {
    scale = 2;
    reasons.push('规模=2（描述含架构级/跨模块措辞）');
  } else if (hits(text, 'scaleMedium', input.locale)) {
    scale = 1;
    reasons.push('规模=1（描述含新增/改造类措辞，超出单点小改）');
  } else if (hits(text, 'scaleSmall', input.locale)) {
    reasons.push('规模=0（描述为单点小改）');
  } else {
    // 无法从描述判定规模时取保守中位数：宁可多审一步，也不要漏审。
    scale = 1;
    reasons.push('规模=1（未提供改动量且描述不足以判定，按保守中位数处理）');
  }

  // ---- impact ----
  let impact = 0;
  if (input.crossModule === true) {
    impact = 2;
    reasons.push('影响=2（跨模块/跨服务）');
  } else if (input.touchesShared === true) {
    impact = 1;
    reasons.push('影响=1（触碰共享层）');
  } else if (/跨模块|跨服务|cross-module|across modules/i.test(text)) {
    impact = 2;
    reasons.push('影响=2（描述声明跨模块）');
  } else {
    reasons.push('影响=0（限定在单一模块内）');
  }

  // ---- risk ----
  let risk = 0;
  // 歧义词只在有安全语境时才升级：`会话劫持` 算，`子会话` 不算
  const contextualRisk = hits(text, 'riskAmbiguous', input.locale) && hits(text, 'riskContext', input.locale);
  if (hits(text, 'riskHigh', input.locale) || contextualRisk) {
    risk = 2;
    reasons.push(
      contextualRisk && !hits(text, 'riskHigh', input.locale)
        ? '风险=2（歧义安全词配安全语境：如 会话/令牌 + 劫持/泄露）'
        : '风险=2（涉及认证/支付/直接安全）',
    );
  } else if (hits(text, 'riskMedium', input.locale)) {
    risk = 1;
    reasons.push('风险=1（功能扩展或间接安全）');
  } else {
    reasons.push('风险=0（纯样式/注释/低风险改动）');
  }

  return { scale, impact, risk, reasons };
}

/**
 * 按条件裁剪步骤，并**剪掉悬空依赖**。
 *
 * 条件步骤（如 `ui`）被裁掉后，仍指向它的依赖必须一并移除：`depsSatisfied` 要求
 * 每个依赖都存在且已完成，留下一个悬空 id 会让那个任务**永远不就绪**（整轮卡死）。
 * 有了这层保证，模板就可以放心让 executor 同时依赖 architect 与 ui，
 * 让设计产出真的交到实现者手里。
 *
 * @param {object[]} template - 路径模板
 * @param {boolean} ui - 是否需要 UI 设计步骤
 * @returns {object[]}
 */
export function buildSteps(template, ui) {
  const kept = template.filter((step) => !step.optional || (step.condition === 'ui' && ui));
  const ids = new Set(kept.map((step) => step.id));
  return kept.map((step) => ({ ...step, deps: step.deps.filter((dep) => ids.has(dep)) }));
}

/**
 * 触发词匹配器（**词边界**，不是子串）。
 *
 * 审计实测的误命中：触发词 `ui` 会因为任务里有 `build` 而命中，`go` 会因为 `google` 而命中。
 * 中文没有"词字符"概念，按子串匹配才是对的——所以只在首/尾是 ASCII 词字符时加 lookaround：
 *   · `ui` → `(?<![A-Za-z0-9_])ui(?![A-Za-z0-9_])`：`build` 不再命中 `ui`
 *   · `界面` → `界面`：中文仍按子串
 * 触发词里的正则元字符（`C++`、`c#`）一律转义，不做 token 化。
 *
 * @param {string[]} [triggers] - 触发词（大小写不敏感）
 * @returns {(text:string)=>boolean} 匹配函数；空表恒为 false
 */
export function buildTriggerMatcher(triggers) {
  const patterns = (Array.isArray(triggers) ? triggers : [])
    .map((word) => String(word ?? '').trim().toLowerCase())
    .filter((word) => word !== '')
    .map((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const head = /^[A-Za-z0-9_]/.test(word) ? '(?<![A-Za-z0-9_])' : '';
      const tail = /[A-Za-z0-9_]$/.test(word) ? '(?![A-Za-z0-9_])' : '';
      return new RegExp(`${head}${escaped}${tail}`, 'i');
    });
  return (text) => {
    if (patterns.length === 0) return false;
    const haystack = String(text ?? '');
    return patterns.some((pattern) => pattern.test(haystack));
  };
}

/**
 * 按角色库调整步骤：剪掉停用角色的步骤 + 插入命中触发词的自定义专家。
 *
 * 两条规则的语义：
 * 1. **停用**：该角色的步骤从图里消失，依赖它的步骤改为依赖它的上游（沿链继承），
 *    这样不会留下悬空依赖把下游永远卡在"不就绪"。
 * 2. **触发**：自定义角色的 `triggers` 命中任务描述时，把它插到实现步骤**之前**，
 *    并让实现步骤依赖它——专家产出会作为依赖产出喂进执行者的上下文
 *    （与 architect / ui 同样的机制）。多个专家命中时并列插入，顺序按 slug 稳定排序。
 *
 * @param {object[]} steps - buildSteps 的结果
 * @param {{ roles?: object[], matchText?: string }} [library]
 * @returns {object[]}
 */
export function adaptSteps(steps, library = {}) {
  const roles = Array.isArray(library.roles) ? library.roles : [];
  const matchText = String(library.matchText ?? '').toLowerCase();

  // ---- 1) 剪掉停用角色 ----
  const disabledSlugs = new Set(roles.filter((role) => role.enabled === false).map((role) => role.slug));
  const dependentsOf = new Map();
  for (const step of steps) {
    for (const dep of step.deps ?? []) {
      if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
      dependentsOf.get(dep).push(step.id);
    }
  }

  // 把"依赖了被剪步骤"的引用，替换成被剪步骤自己的依赖（可传递）
  const pruned = new Set();
  for (const step of steps) {
    if (disabledSlugs.has(step.role)) pruned.add(step.id);
  }
  const resolveDeps = (deps, seen = new Set()) => {
    const out = [];
    for (const dep of deps) {
      if (!pruned.has(dep)) {
        out.push(dep);
        continue;
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      const upstream = steps.find((item) => item.id === dep);
      out.push(...resolveDeps(upstream?.deps ?? [], seen));
    }
    return [...new Set(out)];
  };

  let kept = steps
    .filter((step) => !pruned.has(step.id))
    .map((step) => ({ ...step, deps: resolveDeps(step.deps ?? []) }));

  // ---- 2) 插入命中触发词的自定义专家 ----
  // 匹配走 buildTriggerMatcher：词边界，避免 `ui` 被 `build`、`go` 被 `google` 误命中。
  const triggered = roles
    .filter((role) => role.builtin !== true && role.enabled !== false && Array.isArray(role.triggers) && role.triggers.length > 0)
    .filter((role) => buildTriggerMatcher(role.triggers)(matchText))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  if (triggered.length > 0) {
    // 找实现步骤（没有就退到最后一个非验证步骤）
    const anchor =
      kept.find((step) => step.kind === 'implementation') ??
      [...kept].reverse().find((step) => step.kind !== 'verification') ??
      kept[kept.length - 1];
    if (anchor !== undefined) {
      const inserted = triggered.map((role, index) => ({
        id: `expert-${role.slug}`,
        role: role.slug,
        // 与锚点同级：专家的输入依赖锚点原本的依赖
        deps: [...(anchor.deps ?? [])],
        kind: 'work',
        optional: false,
        custom: true,
        order: (anchor.order ?? 0) + index * 0.001,
      }));
      kept = kept.map((step) =>
        step.id === anchor.id ? { ...step, deps: [...new Set([...(step.deps ?? []), ...inserted.map((item) => item.id)])] } : step,
      );
      // 插在锚点前面（保持步骤顺序稳定）
      const at = kept.findIndex((step) => step.id === anchor.id);
      kept = [...kept.slice(0, at), ...inserted, ...kept.slice(at)];
    }
  }

  return kept;
}

/** 该任务是否需要 UI 设计步骤。 */
export function needsUiDesign(taskText, locale) {  const text = String(taskText ?? '');
  if (hits(text, 'uiNegative', locale)) return false;
  return hits(text, 'ui', locale);
}

/**
 * 路由决策。
 *
 * @param {object} input - 同 {@link score}，另加：
 * @param {'auto'|'fast'|'standard'|'full'|'debug'|'deploy'} [input.forcePath] - 用户显式指定，仅风险可覆盖
 * @returns {{
 *   path:string, label:string, score:{scale:number,impact:number,risk:number},
 *   total:number, reasons:string[], steps:StepTemplate[], needsUiDesign:boolean,
 *   escalated:boolean, forced:boolean, ambiguous:boolean, notes:string[]
 * }}
 */
export function route(input) {
  const text = String(input.taskText ?? '');
  // 路由阈值与风险短路开关：以前写死在这里，配置项形同虚设（审计 P1-5）。
  const routing = input.routing ?? {};
  const fastMax = Number.isFinite(routing.fastMax) ? routing.fastMax : 1;
  const standardMax = Number.isFinite(routing.standardMax) ? routing.standardMax : 4;
  const riskShortCircuit = routing.riskShortCircuit !== false;
  // 角色库（可选）：停用剪枝 + 自定义专家按触发词插入
  const roleLibrary = input.roles;
  const scored = score(input);
  const reasons = [...scored.reasons];
  const notes = [];

  const wantsDebug = hits(text, 'debug', input.locale);
  const wantsDeploy = hits(text, 'deploy', input.locale);
  const ui = needsUiDesign(text, input.locale);

  // 规则 0：UI 变更加权。界面改动天然多一轮设计评审，且视觉回归靠人工发现，
  // 因此当规模并非显式给定（即来自保守默认而非用户实测）时，向上提一档。
  const scaleWasInferred = !Number.isFinite(input.filesTouched) && !Number.isFinite(input.linesTouched);
  const scoreFinal = { ...scored };
  if (ui && scaleWasInferred && scoreFinal.scale < 2) {
    scoreFinal.scale += 1;
    reasons.push(`规模上调至 ${scoreFinal.scale}（涉及界面变更，需要设计评审轮次）`);
  }
  const total = scoreFinal.scale + scoreFinal.impact + scoreFinal.risk;

  let path;
  let escalated = false;
  let forced = false;

  const forcedPath = input.forcePath && input.forcePath !== 'auto' ? input.forcePath : undefined;

  // 规则 1：风险优先短路 —— 认证/支付/直接安全直接强制完整路径，不看其他维度。
  // 但"这是个 bug"与"涉及安全"同时成立时合并为调试+安全审查路径：两条规则都不丢弃。
  if (riskShortCircuit && scoreFinal.risk === 2) {
    if (wantsDebug) {
      path = PATHS.DEBUG_SECURE;
      notes.push('同时命中调试关键词与风险等级=2：合并为「调试 + 安全审查」路径（保留根因分析，且不放过安全门）');
      if (forcedPath !== undefined && forcedPath !== PATHS.DEBUG_SECURE) {
        escalated = true;
        notes.push(`用户指定 ${PATH_LABELS[forcedPath] ?? forcedPath} 路径，但因涉及安全，已升级（风险不可降级）`);
      }
    } else {
      path = PATHS.FULL;
      if (forcedPath !== undefined && forcedPath !== PATHS.FULL) {
        escalated = true;
        notes.push(`用户指定 ${PATH_LABELS[forcedPath] ?? forcedPath} 路径，但风险等级=2，已升级为完整路径（风险不可降级）`);
      } else {
        notes.push('命中风险优先短路：风险等级=2 → 强制完整路径');
      }
    }
  } else if (forcedPath !== undefined) {
    path = forcedPath;
    forced = true;
    notes.push(`用户显式指定路径：${PATH_LABELS[path] ?? path}`);
  } else {
    // 规则 2：三维加和。
    if (total <= fastMax) path = PATHS.FAST;
    else if (total <= standardMax) path = PATHS.STANDARD;
    else path = PATHS.FULL;

    // 规则 3：任务类型关键词覆盖（仅在非 full 时生效，full 已是最高）。
    if (path !== PATHS.FULL) {
      if (wantsDebug) {
        path = PATHS.DEBUG;
        notes.push('命中调试关键词 → 调试路径');
      } else if (wantsDeploy) {
        path = PATHS.DEPLOY;
        notes.push('命中部署关键词 → 部署路径');
      }
    } else if (wantsDebug || wantsDeploy) {
      notes.push('命中调试/部署关键词，但三维评分已达完整路径，保留完整路径（更重的路径优先）');
    }

    reasons.push(`三维加和 = ${total} → ${PATH_LABELS[path] ?? path}路径`);
  }

  const template = PATH_TEMPLATES[path];
  const steps = adaptSteps(buildSteps(template, ui), { roles: roleLibrary, matchText: text });

  const ambiguous = text.trim().length > 0 && text.trim().length < 12 && !forced && scoreFinal.risk < 2;

  return {
    path,
    label: PATH_LABELS[path] ?? path,
    score: { scale: scoreFinal.scale, impact: scoreFinal.impact, risk: scoreFinal.risk },
    total,
    reasons,
    steps,
    needsUiDesign: ui,
    escalated,
    forced,
    ambiguous,
    notes,
  };
}

/**
 * 把路由结果渲染成人类可读的一行摘要，供工具输出与 UI 徽标复用。
 * @param {ReturnType<typeof route>} decision
 * @returns {string}
 */
export function describeRoute(decision) {
  const { scale, impact, risk } = decision.score;
  const chain = decision.steps.map((step) => step.role).join(' → ');
  return [
    `路径：${decision.label}（${decision.path}）`,
    `评分：规模 ${scale} + 影响 ${impact} + 风险 ${risk} = ${decision.total}`,
    `角色链：${chain}`,
    decision.notes.length > 0 ? `说明：${decision.notes.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
