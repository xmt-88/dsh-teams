/**
 * DSH Teams — 客户端（浏览器侧）插件
 *
 * 契约（已对照宿主 `@deepseek-ai/dsh-client-modules` 与官方模板核实）：
 *   - 入口由 package.json 的 `exports["./client"]` 解析，不是 dsh.client.entry
 *   - 用 `window.__ModuleLoader__.load({ id, factory })` 注册，id 必须等于包名
 *   - factory 内 `require('react')`；**禁止** require 任何 @deepseek-ai/dsh-client-* 包
 *   - 通过 ctx.slots.inject(key, () => ctx.slots.register(options, Component)) 挂载
 *   - 只用 --dsw-alias-* 主题令牌；文案走 ctx.locale
 *
 * 本文件（P0 阶段）提供两处 UI：
 *   1. 会话头部「团队」徽标，展示当前路径与阶段
 *   2. 右栏 Tab 的团队工作视图（成员 / 任务板 / 运行日志）
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-teams',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'teams';

    /** 云端状态轮询间隔（毫秒）。运行中快一点，空闲时放慢。 */
    const POLL_ACTIVE_MS = 1200;
    const POLL_IDLE_MS = 5000;

    const TAB_KIND = 'dsh-teams';
    const TAB_ID = '@dsh-external/dsh-teams/workspace';

    /* -------------------------------------------------------------- *
     * 文案
     * -------------------------------------------------------------- */

    const ZH = {
      'badge.idle': '团队',
      'badge.ready': '团队',
      'badge.running': '团队运行中',
      'tab.title': '团队',
      'view.members': '成员',
      'view.tasks': '任务板',
      'view.log': '运行日志',
      'view.empty': '当前会话还没有团队。用 teams_route 先做路径决策。',
      'view.noMembers': '尚未派发成员。先 teams_plan 生成计划并批准。',
      'view.noTasks': '尚未生成任务图。用 teams_plan 生成计划。',
      'view.loading': '读取团队状态…',
      'view.unavailable': '无法读取团队状态',
      'field.path': '路径',
      'field.phase': '阶段',
      'field.score': '评分',
      'field.progress': '进度',
      'field.purpose': '目标',
      'member.working': '执行中',
      'member.idle': '空闲',
      'member.onTask': '当前任务：',
      'member.openSession': '查看这个成员的会话',
      'nav.viewingChild': '正在查看子代理会话 · 团队视图来自队长会话',
      'nav.backToCaptain': '返回队长会话',
      'task.deps': '依赖',
      'task.noDeps': '无依赖',
      'task.attempts': '尝试',
      'task.output': '查看产出',
      'task.truncated': '已截断',
      'task.acceptance': '验收标准',
      'task.parallel': '可并行',
      'task.budget': '预算',
      'task.openSession': '会话',
      'flow.tab': '流程',
      'flow.steps': '步数',
      'flow.cache': '缓存',
      'flow.tokens': 'token',
      'flow.openSession': '查看这个子代理的会话',
      'flow.empty': '这一轮还没有步骤。',
      'flow.failed': '失败',
      'flow.current': '当前',
      'flow.untitled': '（未命名任务）',
      'flow.more': '显示更早的 {n} 轮',

      'watch.harvested': '回收',
      'watch.cancelled': '已取消',
      'watch.observed': '已观测',
      'phase.idle': '空闲',
      'phase.staged': '待审批',
      'phase.running': '运行中',
      'phase.halted': '已暂停',
      'phase.done': '已完成',
      'phase.failed': '失败',
      'task.pending': '待派发',
      'task.ready': '就绪',
      'task.running': '进行中',
      'task.blocked': '受阻',
      'task.done': '已完成',
      'task.failed': '失败',
      'task.skipped': '已跳过',
      'log.empty': '暂无事件',
      'refresh': '刷新',

      // ---- 角色页 ----
      'role.title': '角色',
      'role.builtin': '内置',
      'role.custom': '自定义',
      'role.on': '已启用',
      'role.off': '已停用',
      'role.enable': '启用',
      'role.disable': '停用',
      'role.coreLocked': '核心角色，不能停用',
      'role.view': '查看',
      'role.edit': '编辑',
      'role.delete': '删除',
      'role.copy': '复制为自定义',
      'role.new': '新建角色',
      'role.cancel': '取消',
      'role.close': '关闭',
      'role.save': '保存',
      'role.saveFailed': '保存失败，请检查必填项',
      'role.confirmDelete': '删除',
      'role.irreversible': '不可撤销',
      'role.emptyCustom': '还没有自定义角色',
      'role.emptyBuiltin': '没有可显示的内置角色',
      'role.copyFromBuiltin': '从内置复制',
      'role.builtinHint': '内置角色：只能查看与启停',
      'role.customHint': '自定义角色：可编辑、删除、启停',
      'role.overrides': '覆盖内置',
      'role.overridden': '已被覆盖',
      'role.triggers': '触发词',
      'role.triggersLabel': '触发词（逗号分隔，任务命中即自动启用）',
      'role.id': '角色 id',
      'role.name': '显示名',
      'role.category': '分类',
      'role.emoji': '图标 emoji',
      'role.permissions': '权限档',
      'role.tier': '超时档',
      'role.description': '一句话说明',
      'role.prompt': '角色契约正文',
      'role.catBuiltin': '内置',
      'role.search': '搜索角色（名称 / 描述 / 触发词）',
      'role.noMatch': '没有匹配的角色',
      'role.workspace': '工作区',
      'role.workspaceOf': '工作区：{path}',
      'role.back': '返回列表',
      'role.categoryHint': '数据 / 前端 / 文档',
      'role.editor': '角色编辑器',
      // ---- 设置卡片 ----
      'set.tabs': '设置分区',
      'set.tabConfig': '配置项',
      'set.tabRoles': '角色',
      'set.nav': '团队',
      'set.title': 'DSH Teams 设置',
      'set.summary': '配置状态目录、路径路由、并发与重试、角色超时、看门狗与质量门。',
      'set.loading': '读取设置…',
      'set.unavailable': '该插件当前未加载，暂时无法配置。',
      'set.readOnly': '本部署的设置为只读。',
      'set.overridden': '已覆盖',
      'set.covered': '已覆盖 {n} 项',
      'set.reset': '恢复默认',
      'set.undo': '撤销',
      'set.save': '保存',
      'set.saving': '保存中…',
      'set.discard': '放弃修改',
      'set.saved': '已保存',
      'set.saveFailed': '本部署没有接受这些值，已保留你的修改供修正。',
      'set.invalid': '有字段未通过宿主的配置校验，修正后才能保存：',
      'set.unitSeconds': '秒',
      'set.unitMs': '毫秒',
      'set.errorInteger': '请填非负整数。',
      'set.errorRange': '取值范围 {min} – {max}。',
      'set.group.state': '状态与路径',
      'set.group.routing': '路径路由',
      'set.group.scheduler': '并发与重试',
      'set.group.timeouts': '角色超时',
      'set.group.watch': '看门狗',
      'set.group.gates': '质量门',
      'set.group.ui': '界面',
      'set.f.stateDir': '状态目录',
      'set.h.stateDir': '相对会话工作区的团队状态目录。留空表示使用默认值。',
      'set.f.riskShortCircuit': '高风险直达完整路径',
      'set.h.riskShortCircuit': '命中认证、支付、凭据、数据安全等关键词时不再逐级评分，直接走「完整」路径。',
      'set.f.fastMax': '快速路径文件上限',
      'set.h.fastMax': '改动文件数不超过此值时走「快速」路径。',
      'set.f.standardMax': '标准路径文件上限',
      'set.h.standardMax': '超过快速上限、但不大于此值时走「标准」路径。',
      'set.f.maxParallel': '最大并发成员数',
      'set.h.maxParallel': '同一轮最多同时派发的成员数，至少为 1。',
      'set.f.maxRetries': '失败重试次数',
      'set.h.maxRetries': '任务失败后自动重排的次数。',
      'set.f.maxReviewRounds': '最多评审轮数',
      'set.h.maxReviewRounds': '质量门最多驳回重做的轮数。',
      'set.f.timeoutEnabled': '启用角色墙钟',
      'set.h.timeoutEnabled': '默认关闭：墙钟惩罚的是「任务大」，而大任务恰恰最该让它跑完，卡死判定交给看门狗。',
      'set.f.timeoutHeavy': 'heavy 档预算',
      'set.h.timeoutHeavy': '架构、实现等重角色的墙钟预算。',
      'set.f.timeoutMedium': 'medium 档预算',
      'set.h.timeoutMedium': '常规角色的墙钟预算。',
      'set.f.timeoutLight': 'light 档预算',
      'set.h.timeoutLight': '轻量审查角色的墙钟预算。',
      'set.f.timeoutInfrastructure': 'infrastructure 档预算',
      'set.h.timeoutInfrastructure': '状态巡检等基础设施角色的墙钟预算。',
      'set.f.probeMs': '采样间隔',
      'set.h.probeMs': '读取宿主内存中的状态与会话游标的间隔，零 I/O。',
      'set.f.idleGraceMs': '回合结束宽限',
      'set.h.idleGraceMs': '子代理回合真正结束后，再等宿主结果送达的宽限时间。',
      'set.f.silenceLimitMs': '静默标记阈值',
      'set.h.silenceLimitMs': '超过此时长没有进展只记一笔标记，不据此判死。',
      'set.f.requireEvidence': '要求交付证据',
      'set.h.requireEvidence': '验收时必须有可复核的命令、退出码与输出，不接受「我看到了」。',
      'set.f.securityBlock': '安全项阻断',
      'set.h.securityBlock': '涉及认证、支付、凭据、数据安全的改动在质量门直接阻断。',
      'set.f.locale': '界面语言',
      'set.h.locale': '团队视图与设置卡片的文案语言。',
    };

    const EN = {
      'badge.idle': 'Team',
      'badge.ready': 'Team',
      'badge.running': 'Team running',
      'tab.title': 'Team',
      'view.members': 'Members',
      'view.tasks': 'Task board',
      'view.log': 'Run log',
      'view.empty': 'No team in this session yet. Run teams_route first to pick a path.',
      'view.noMembers': 'No members dispatched yet. Run teams_plan and approve it first.',
      'view.noTasks': 'No task graph yet. Run teams_plan to generate a plan.',
      'view.loading': 'Loading team state…',
      'view.unavailable': 'Team state unavailable',
      'field.path': 'Path',
      'field.phase': 'Phase',
      'field.score': 'Score',
      'field.progress': 'Progress',
      'field.purpose': 'Goal',
      'member.working': 'Working',
      'member.idle': 'Idle',
      'member.onTask': 'Current task: ',
      'member.openSession': 'Open this member\u2019s session',
      'nav.viewingChild': 'Viewing a subagent session · the team view comes from the captain session',
      'nav.backToCaptain': 'Back to captain session',
      'task.deps': 'deps',
      'task.noDeps': 'no deps',
      'task.attempts': 'attempts',
      'task.output': 'View output',
      'task.truncated': 'truncated',
      'task.acceptance': 'Acceptance',
      'task.parallel': 'parallel',
      'task.budget': 'Budget',
      'task.openSession': 'Session',
      'flow.tab': 'Flow',
      'flow.steps': 'Steps',
      'flow.cache': 'cache',
      'flow.tokens': 'tokens',
      'flow.openSession': 'Open this subagent session',
      'flow.empty': 'No steps in this run yet.',
      'flow.failed': 'failed',
      'flow.current': 'current',
      'flow.untitled': '(untitled task)',
      'flow.more': 'Show {n} earlier runs',

      'watch.harvested': 'recovered',
      'watch.cancelled': 'cancelled',
      'watch.observed': 'observed',
      'phase.idle': 'Idle',
      'phase.staged': 'Awaiting approval',
      'phase.running': 'Running',
      'phase.halted': 'Paused',
      'phase.done': 'Done',
      'phase.failed': 'Failed',
      'task.pending': 'Pending',
      'task.ready': 'Ready',
      'task.running': 'Running',
      'task.blocked': 'Blocked',
      'task.done': 'Done',
      'task.failed': 'Failed',
      'task.skipped': 'Skipped',
      'log.empty': 'No events yet',
      'refresh': 'Refresh',

      // ---- roles page ----
      'role.title': 'Roles',
      'role.builtin': 'Built-in',
      'role.custom': 'Custom',
      'role.on': 'Enabled',
      'role.off': 'Disabled',
      'role.enable': 'Enable',
      'role.disable': 'Disable',
      'role.coreLocked': 'Core role, cannot be disabled',
      'role.view': 'View',
      'role.edit': 'Edit',
      'role.delete': 'Delete',
      'role.copy': 'Copy to custom',
      'role.new': 'New role',
      'role.cancel': 'Cancel',
      'role.close': 'Close',
      'role.save': 'Save',
      'role.saveFailed': 'Save failed, check required fields',
      'role.confirmDelete': 'Delete',
      'role.irreversible': 'cannot be undone',
      'role.emptyCustom': 'No custom roles yet',
      'role.emptyBuiltin': 'No built-in roles to show',
      'role.copyFromBuiltin': 'Copy from built-in',
      'role.builtinHint': 'Built-in: view and enable/disable only',
      'role.customHint': 'Custom: edit, delete, enable/disable',
      'role.overrides': 'overrides built-in',
      'role.overridden': 'overridden',
      'role.triggers': 'triggers',
      'role.triggersLabel': 'Triggers (comma separated; auto-enabled when the task matches)',
      'role.id': 'Role id',
      'role.name': 'Display name',
      'role.category': 'Category',
      'role.emoji': 'Emoji',
      'role.permissions': 'Permissions',
      'role.tier': 'Timeout tier',
      'role.description': 'One-line summary',
      'role.prompt': 'Role contract',
      'role.catBuiltin': 'built-in',
      'role.search': 'Search roles (name / description / triggers)',
      'role.noMatch': 'No matching roles',
      'role.workspace': 'Workspace',
      'role.workspaceOf': 'Workspace: {path}',
      'role.back': 'Back to list',
      'role.categoryHint': 'data / frontend / docs',
      'role.editor': 'Role editor',
      // ---- Settings card ----
      'set.tabs': 'Settings sections',
      'set.tabConfig': 'Settings',
      'set.tabRoles': 'Roles',
      'set.nav': 'Team',
      'set.title': 'DSH Teams settings',
      'set.summary': 'Configure the state directory, routing, concurrency and retries, role timeouts, watchdog, and quality gates.',
      'set.loading': 'Loading settings…',
      'set.unavailable': 'This plugin is not loaded, so it cannot be configured right now.',
      'set.readOnly': 'This deployment stores settings read-only.',
      'set.overridden': 'Overridden',
      'set.covered': '{n} overridden',
      'set.reset': 'Reset to default',
      'set.undo': 'Undo',
      'set.save': 'Save',
      'set.saving': 'Saving…',
      'set.discard': 'Discard changes',
      'set.saved': 'Saved',
      'set.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
      'set.invalid': 'Some fields failed the Host configuration check; fix them before saving:',
      'set.unitSeconds': 'seconds',
      'set.unitMs': 'ms',
      'set.errorInteger': 'Enter a non-negative whole number.',
      'set.errorRange': 'Allowed range: {min} – {max}.',
      'set.group.state': 'State and path',
      'set.group.routing': 'Path routing',
      'set.group.scheduler': 'Concurrency and retries',
      'set.group.timeouts': 'Role timeouts',
      'set.group.watch': 'Watchdog',
      'set.group.gates': 'Quality gates',
      'set.group.ui': 'Interface',
      'set.f.stateDir': 'State directory',
      'set.h.stateDir': 'Team state directory relative to the session workspace. Leave blank to use the default.',
      'set.f.riskShortCircuit': 'High-risk goes straight to Full',
      'set.h.riskShortCircuit': 'Authentication, payment, credential, and data-security work skips scoring and takes the Full path.',
      'set.f.fastMax': 'Fast path file limit',
      'set.h.fastMax': 'Changes touching no more files than this take the Fast path.',
      'set.f.standardMax': 'Standard path file limit',
      'set.h.standardMax': 'Above the Fast limit but no more than this takes the Standard path.',
      'set.f.maxParallel': 'Max parallel members',
      'set.h.maxParallel': 'How many members one round may dispatch at once; at least 1.',
      'set.f.maxRetries': 'Retries after failure',
      'set.h.maxRetries': 'How many times a failed task is automatically requeued.',
      'set.f.maxReviewRounds': 'Max review rounds',
      'set.h.maxReviewRounds': 'How many times a quality gate may send work back.',
      'set.f.timeoutEnabled': 'Enable role wall clock',
      'set.h.timeoutEnabled': 'Off by default: a wall clock punishes big tasks, which are exactly the ones that should finish; stalls are the watchdog\u2019s job.',
      'set.f.timeoutHeavy': 'Heavy tier budget',
      'set.h.timeoutHeavy': 'Wall-clock budget for heavy roles such as architecture and implementation.',
      'set.f.timeoutMedium': 'Medium tier budget',
      'set.h.timeoutMedium': 'Wall-clock budget for ordinary roles.',
      'set.f.timeoutLight': 'Light tier budget',
      'set.h.timeoutLight': 'Wall-clock budget for lightweight review roles.',
      'set.f.timeoutInfrastructure': 'Infrastructure tier budget',
      'set.h.timeoutInfrastructure': 'Wall-clock budget for infrastructure roles such as status checks.',
      'set.f.probeMs': 'Probe interval',
      'set.h.probeMs': 'How often the Host\u2019s in-memory status and session cursor are sampled; no I/O.',
      'set.f.idleGraceMs': 'Turn-end grace',
      'set.h.idleGraceMs': 'Extra time allowed for the Host result after a child turn has genuinely ended.',
      'set.f.silenceLimitMs': 'Silence mark threshold',
      'set.h.silenceLimitMs': 'No progress for this long only records a mark; it never declares the child dead.',
      'set.f.requireEvidence': 'Require delivery evidence',
      'set.h.requireEvidence': 'Acceptance needs a reviewable command, exit code, and output instead of "I saw it work".',
      'set.f.securityBlock': 'Block security-sensitive work',
      'set.h.securityBlock': 'Changes touching authentication, payment, credentials, or data security are blocked at the quality gate.',
      'set.f.locale': 'Interface language',
      'set.h.locale': 'Copy language for the team view and this settings card.',
    };

    /* -------------------------------------------------------------- *
     * 样式（只用主题令牌；颜色一律走 --dsw-alias-*）
     * -------------------------------------------------------------- */

    /* -------------------------------------------------------------- *
     * 样式
     *
     * 必须是 DSH 主题**真实存在**的令牌（见 Client Theme.listTokens 的 14 个
     * --dsw-alias-* / --dsw-specific-*）。用不存在的名字不会报错，但颜色会静默
     * 退化——插件看起来就和宿主"不像一套"，且浅色/深色切换失效。
     * test/theme-tokens.test.mjs 会核对这些名字。
     * -------------------------------------------------------------- */

    const CSS = `
.dsh-teams-badge{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:999px;
  background:transparent;color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:1;cursor:pointer;transition:background .15s ease,border-color .15s ease;}
.dsh-teams-badge:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}
.dsh-teams-badge[data-active="true"]{border-color:var(--dsw-alias-brand-primary);}
.dsh-teams-badge .dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);}
.dsh-teams-badge[data-running="true"] .dot{background:var(--dsw-alias-brand-primary);}
.dsh-teams-badge .path{font-weight:600;color:var(--dsw-alias-label-primary);}

.dsh-teams-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;
  font-size:13px;color:var(--dsw-alias-label-primary);}
.dsh-teams-tabs{display:flex;gap:4px;padding:8px 10px;flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-tab{appearance:none;border:0;background:transparent;cursor:pointer;padding:5px 10px;
  border-radius:7px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-tab:hover{color:var(--dsw-alias-label-primary);}
.dsh-teams-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-weight:600;}
.dsh-teams-body{flex:1;min-height:0;overflow:auto;padding:10px;}
.dsh-teams-card{border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;padding:10px 12px;margin-bottom:8px;background:transparent;}
.dsh-teams-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:0;}
.dsh-teams-kv dt{color:var(--dsw-alias-label-secondary);}
.dsh-teams-kv dd{margin:0;word-break:break-word;}
.dsh-teams-muted{color:var(--dsw-alias-label-secondary);}
.dsh-teams-chip{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}
.dsh-teams-row{display:flex;align-items:center;gap:8px;justify-content:space-between;}
.dsh-teams-logline{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);
  white-space:pre-wrap;word-break:break-word;}
.dsh-teams-btn{appearance:none;cursor:pointer;font-size:12px;padding:4px 10px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-secondary);}
.dsh-teams-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dsh-teams-failure{margin-top:6px;padding:6px 8px;border-radius:6px;font-size:12px;
  border:1px solid var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary);
  white-space:pre-wrap;word-break:break-word;}
.dsh-teams-details{margin-top:6px;}
.dsh-teams-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-details summary:hover{color:var(--dsw-alias-label-primary);}
.dsh-teams-output{margin-top:6px;padding:8px;border-radius:6px;max-height:280px;overflow:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;
  white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}

/* 状态区分：只改边框与语义色，颜色仍然全部来自主题令牌 */
.dsh-teams-card[data-status="done"]{border-color:var(--dsw-alias-border-l2);}
.dsh-teams-card[data-status="running"]{border-color:var(--dsw-alias-brand-primary);}
.dsh-teams-card[data-status="failed"]{border-color:var(--dsw-alias-state-error-primary);}
.dsh-teams-card[data-status="blocked"]{border-color:var(--dsw-alias-state-warn-primary);}
.dsh-teams-chip[data-state="running"],.dsh-teams-chip[data-state="working"]{font-weight:600;
  border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}
.dsh-teams-chip[data-state="done"]{color:var(--dsw-alias-state-success-primary);
  border-color:var(--dsw-alias-state-success-primary);}
.dsh-teams-chip[data-state="failed"]{color:var(--dsw-alias-state-error-primary);
  border-color:var(--dsw-alias-state-error-primary);}
.dsh-teams-chip[data-state="blocked"]{color:var(--dsw-alias-state-warn-primary);
  border-color:var(--dsw-alias-state-warn-primary);}

/* ============ 设置页：页签 + 角色管理 ============ */
/* 设置页是宽屏（600–800px），所以角色用多列网格；窄面板那套单列不适用 */
.dsh-teams-set-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dsh-teams-set-tabs{display:flex;gap:2px;padding:2px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-set-tabs button{height:26px;padding:0 12px;border:0;border-radius:7px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;
  white-space:nowrap;}
.dsh-teams-set-tabs button[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-weight:600;
  box-shadow:0 1px 2px color-mix(in srgb,black 8%,transparent);}
.dsh-teams-set-tabs button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
/* 角色区 */
.dsh-teams-role-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
.dsh-teams-role-head .dsh-teams-seg{flex:none;width:auto;margin-bottom:0;padding:2px;}
.dsh-teams-role-head .dsh-teams-seg button{flex:none;padding:0 12px;}
.dsh-teams-role-search{flex:1;min-width:140px;height:28px;box-sizing:border-box;border-radius:8px;
  padding:0 9px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-role-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.dsh-teams-role-ws{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 网格：宽屏两列，窄屏一列 */
.dsh-teams-role-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px;}
.dsh-teams-role-card{display:grid;grid-template-columns:32px minmax(0,1fr) 34px;column-gap:9px;
  align-items:start;padding:10px;border-radius:10px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-border-l1));
  background:var(--dsw-alias-bg-layer-2);
  box-shadow:0 1px 2px color-mix(in srgb,black 7%,transparent);}
.dsh-teams-role-card[data-off="true"] .dsh-teams-role-avatar,
.dsh-teams-role-card[data-off="true"] .dsh-teams-role-desc{opacity:.6;}
.dsh-teams-role-card .dsh-teams-role-name{font-size:13px;font-weight:600;line-height:17px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dsh-teams-role-card .dsh-teams-role-desc{font-size:12px;line-height:1.45;margin-top:4px;
  color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;}
.dsh-teams-role-card .dsh-teams-role-actions{grid-column:1 / -1;display:flex;gap:6px;margin-top:8px;}
.dsh-teams-role-card .dsh-teams-role-actions > button{height:26px;font-size:12px;border-radius:7px;flex:1;}
/* 编辑视图（占满角色区，不做浮层：设置页容器不确定，浮层容易定位错） */
.dsh-teams-role-editor{display:flex;flex-direction:column;gap:10px;}
.dsh-teams-role-editor-foot{display:flex;gap:8px;padding-top:4px;}
/* ============ 角色页（覆盖层，UI 设计师规范） ============ */
.dsh-teams-role-sheet-title{font-size:13px;font-weight:600;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 分段控件：内置 / 自定义（兼作来源筛选，省掉一个下拉） */
.dsh-teams-seg{display:flex;gap:4px;padding:3px;margin-bottom:8px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-seg button{flex:1;min-width:0;height:26px;border:0;border-radius:7px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;
  font-family:inherit;font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-teams-seg button[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-weight:600;
  box-shadow:0 1px 2px color-mix(in srgb,black 8%,transparent);}
.dsh-teams-seg button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.dsh-teams-role-avatar{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;
  justify-content:center;font-size:17px;line-height:1;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-layer-2));
  border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-role-name{font-size:13px;font-weight:600;line-height:17px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dsh-teams-role-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;
  color:var(--dsw-alias-label-secondary);}
.dsh-teams-role-cat{flex:none;height:17px;padding:0 6px;border-radius:999px;font-size:11px;
  line-height:15px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}
.dsh-teams-role-state{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 开关：旋钮位置 + 文字双重编码，不只靠颜色 */
.dsh-teams-switch{position:relative;width:34px;height:20px;flex:none;border-radius:999px;
  border:0;padding:0;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 25%,transparent);
  transition:background .16s ease;}
.dsh-teams-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
  border-radius:50%;background:var(--dsw-alias-bg-layer-2);
  box-shadow:0 1px 2px color-mix(in srgb,black 25%,transparent);
  transition:transform .16s ease;}
.dsh-teams-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}
.dsh-teams-switch[aria-checked="true"]::after{transform:translateX(14px);}
.dsh-teams-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dsh-teams-switch:disabled{opacity:.45;cursor:not-allowed;}
.dsh-teams-role-desc{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary);
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
.dsh-teams-role-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-role-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:2px;}
.dsh-teams-role-actions > button{height:28px;font-size:12px;border-radius:7px;}
.dsh-teams-role-danger{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 65%,var(--dsw-alias-label-primary));}
/* 触发词 */
.dsh-teams-role-triggers{display:flex;flex-wrap:wrap;gap:4px;}
.dsh-teams-role-trigger{height:17px;padding:0 6px;border-radius:5px;font-size:11px;line-height:15px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l1));
  color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));}
/* 删除确认条 */
.dsh-teams-confirm{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-2));
  font-size:12px;}
.dsh-teams-confirm .dsh-teams-role-actions{margin-top:0;}
.dsh-teams-field{display:flex;flex-direction:column;gap:3px;}
.dsh-teams-field > label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-field input,.dsh-teams-field select,.dsh-teams-field textarea{
  width:100%;box-sizing:border-box;border-radius:7px;padding:6px 8px;font-size:12px;
  font-family:inherit;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-field textarea{min-height:180px;resize:vertical;line-height:1.45;}
.dsh-teams-field input:focus-visible,.dsh-teams-field select:focus-visible,
.dsh-teams-field textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.dsh-teams-role-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;min-height:96px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;
  font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center;}
/* ============ 运行列表：按每次任务折叠 ============ */
.dsh-teams-runs{display:flex;flex-direction:column;gap:8px;}
.dsh-teams-run{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
/* 折叠行：网格排版，标题不再被 meta 挤成 7 个汉字宽 */
.dsh-teams-run-head{position:relative;display:grid;grid-template-columns:34px minmax(0,1fr) 12px;
  column-gap:9px;row-gap:1px;align-items:center;min-height:48px;padding:7px 10px 10px;
  cursor:pointer;list-style:none;font-size:13px;}
.dsh-teams-run-head::-webkit-details-marker{display:none;}
.dsh-teams-run-head:hover{background:var(--dsw-alias-bg-layer-2);}
.dsh-teams-run-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
/* 立绘牌：人物"站"在牌底，全身不裁头 */
.dsh-teams-run-avatar{grid-row:1 / span 2;align-self:center;width:34px;height:38px;border-radius:11px;
  overflow:visible;display:flex;align-items:flex-end;justify-content:center;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-run-avatar .dsh-teams-whale{margin-bottom:-2px;}
.dsh-teams-run-subject{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dsh-teams-run-meta{grid-column:2;display:flex;align-items:center;gap:6px;min-width:0;
  font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-run-meta > span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-teams-run-chevron{grid-row:1 / span 2;grid-column:3;justify-self:end;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);transition:transform .16s ease;}
.dsh-teams-run[open] .dsh-teams-run-chevron{transform:rotate(135deg);}
/* 进度条贴折叠行底边：折叠时也能看完成度 */
.dsh-teams-run-bar{position:absolute;left:0;right:0;bottom:0;height:3px;
  background:var(--dsw-alias-border-l1);}
.dsh-teams-run-bar > i{display:block;height:100%;background:var(--dsw-alias-state-success-primary);}
.dsh-teams-run-body{padding:0 10px 10px;}
.dsh-teams-run[data-phase="running"]{border-color:var(--dsw-alias-brand-primary);}

/* 三态 */
.dsh-teams-empty{display:flex;align-items:center;justify-content:center;min-height:40px;
  padding:18px 0;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;min-height:40px;
  font-size:12px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;
  padding:8px 10px;margin-bottom:8px;font-size:12px;
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,var(--dsw-alias-label-primary));}
.dsh-teams-skeleton{display:flex;gap:10px;overflow:hidden;}
.dsh-teams-skeleton > span{position:relative;width:116px;height:180px;flex:none;border-radius:16px;
  overflow:hidden;background:var(--dsw-alias-bg-layer-1);
  border:1.5px solid var(--dsw-alias-border-l1);}
.dsh-teams-skeleton > span::after{content:"";position:absolute;inset:0;background-size:200% 100%;
  background-image:linear-gradient(90deg,transparent,
    color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent),transparent);
  animation:dsh-teams-shimmer 1.6s linear infinite;}
@keyframes dsh-teams-shimmer{from{background-position:200% 0;}to{background-position:-100% 0;}}

/* 流程图 */
/* 流程图区不垫底色：运行卡本身已是 bg-layer-1，重复垫一层等于没垫（设计师实测指出） */
.dsh-teams-flow{display:flex;align-items:stretch;overflow-x:auto;padding:8px 6px 16px;
  /* 右侧渐隐：用令牌而不是 hex（hex 会被主题令牌测试抓） */
  -webkit-mask-image:linear-gradient(90deg,var(--dsw-alias-label-primary) 0 96%,transparent);
  mask-image:linear-gradient(90deg,var(--dsw-alias-label-primary) 0 96%,transparent);}
.dsh-teams-flow-col{display:flex;flex-direction:column;gap:10px;justify-content:center;flex:none;}
.dsh-teams-flow-gap{flex:none;width:18px;align-self:stretch;
  color:var(--dsw-alias-label-secondary);opacity:.75;}
.dsh-teams-run[data-phase="running"] .dsh-teams-run-bar > i{background:var(--dsw-alias-brand-primary);}
@media (prefers-reduced-motion:reduce){
  .dsh-teams-flow-glow,.dsh-teams-skeleton > span::after,
  .dsh-teams-flow-card[data-status="running"] .dsh-teams-dot{animation:none;}
  /* 不要翻动，只保留一点点位移 */
  .dsh-teams-flow-card[data-clickable="true"]:hover{transform:translateY(-2px);}
  .dsh-teams-flow-card[data-clickable="true"]::after{display:none;}
}

/* ============ 身份牌（UI 设计师规范 v2 · 浅色为主，深色同构） ============ */
/* 高度构成：边框 2 + 舞台 60 + 分隔线 1 + 信息区 115（5 上padding + 30 名 + 3 + 44 用量 + 3 + 18 胶囊 + 12 下padding） */
.dsh-teams-flow-card{position:relative;box-sizing:border-box;width:116px;height:180px;flex:none;
  display:flex;flex-direction:column;border-radius:16px;overflow:hidden;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-border-l1));
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font-size:11px;line-height:1.3;text-align:center;
  /* 只做外阴影。浅色下白卡与运行卡底色只差不到一档，结构靠"边 + 影"撑 */
  box-shadow:0 1px 2px color-mix(in srgb,black 8%,transparent),
             0 4px 12px color-mix(in srgb,black 6%,transparent);
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
/* 舞台：角色色淡彩条，不用内阴影（用户明确不要） */
.dsh-teams-flow-stage{position:relative;flex:none;height:60px;display:flex;align-items:flex-end;
  justify-content:center;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--role-accent,var(--dsw-alias-brand-primary)) 9%,var(--dsw-alias-bg-layer-1));}
/* 落地影：一小条，让人物"站"在舞台上 */
.dsh-teams-flow-stage::after{content:"";position:absolute;left:50%;bottom:2px;width:34px;height:4px;
  transform:translateX(-50%);border-radius:50%;filter:blur(1.5px);
  background:color-mix(in srgb,black 10%,transparent);}
.dsh-teams-flow-inner{position:relative;z-index:1;display:flex;align-items:flex-end;
  justify-content:center;margin-bottom:-1px;}
/* 信息区 */
.dsh-teams-flow-info{display:flex;flex-direction:column;gap:3px;padding:5px 8px 12px;flex:1;min-width:0;}
.dsh-teams-flow-role{font-size:12px;font-weight:600;line-height:15px;min-height:30px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  word-break:break-word;color:var(--dsw-alias-label-primary);}
.dsh-teams-flow-usage{display:flex;flex-direction:column;font-size:9.5px;line-height:13px;
  padding-bottom:2px;}
.dsh-teams-flow-usage > span{display:flex;justify-content:space-between;gap:6px;align-items:baseline;}
.dsh-teams-flow-usage b{font-weight:400;color:var(--dsw-alias-label-secondary);}
.dsh-teams-flow-usage i{font-style:normal;font-size:10.5px;font-weight:600;
  color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 状态胶囊：字色用状态色与正文字混合（100% 状态色做字对比度只有 1.3–2.6） */
.dsh-teams-flow-state{display:flex;align-items:center;justify-content:center;gap:4px;height:18px;
  align-self:center;margin-top:auto;font-size:10px;font-weight:600;border-radius:999px;padding:0 8px;
  color:var(--state-text,var(--dsw-alias-label-secondary));
  background:color-mix(in srgb,var(--state-color,var(--dsw-alias-border-l2)) 10%,var(--dsw-alias-bg-layer-2));
  border:1px solid color-mix(in srgb,var(--state-color,var(--dsw-alias-border-l2)) 30%,var(--dsw-alias-border-l1));}
.dsh-teams-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;}
/* emoji 角标 */
.dsh-teams-flow-badge{position:absolute;right:6px;top:6px;z-index:2;width:18px;height:18px;
  display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:10px;
  line-height:1;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);}
/* ---- 五种状态 ---- */
.dsh-teams-flow-card[data-status="done"]{--state-color:var(--dsw-alias-state-success-primary);
  --state-text:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 26%,var(--dsw-alias-border-l1));}
.dsh-teams-flow-card[data-status="failed"]{--state-color:var(--dsw-alias-state-error-primary);
  --state-text:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,var(--dsw-alias-border-l1));}
/* 受阻：左侧竖条用 ::before（不能用 inset 阴影——用户明确不要内阴影） */
.dsh-teams-flow-card[data-status="blocked"]{--state-color:var(--dsw-alias-state-warn-primary);
  --state-text:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,var(--dsw-alias-border-l1));}
.dsh-teams-flow-card[data-status="blocked"]::before{content:"";position:absolute;left:0;top:14px;
  bottom:14px;width:2px;border-radius:0 2px 2px 0;background:var(--dsw-alias-state-warn-primary);z-index:3;}
/* 进行中 / 就绪：边框交给流光环画 */
.dsh-teams-flow-card[data-status="running"],
.dsh-teams-flow-card[data-status="ready"]{--state-color:var(--dsw-alias-state-warn-primary);
  --state-text:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));}
.dsh-teams-flow-card[data-status="ready"]{--state-color:var(--dsw-alias-brand-primary);
  --state-text:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));}
/* 待派发 / 跳过：虚线 + 次级字 */
.dsh-teams-flow-card[data-status="pending"],
.dsh-teams-flow-card[data-status="skipped"]{--state-color:var(--dsw-alias-border-l2);
  --state-text:var(--dsw-alias-label-secondary);
  border-style:dashed;}
.dsh-teams-flow-card[data-status="running"] .dsh-teams-dot,
.dsh-teams-flow-card[data-status="ready"] .dsh-teams-dot{
  animation:dsh-teams-pulse 1.4s ease-in-out infinite;}
@keyframes dsh-teams-pulse{50%{opacity:.35;}}
/* ---- 交互：轻微 3D 翻动，阴影随之偏移 ---- */
.dsh-teams-flow-card[data-clickable="true"]{cursor:pointer;}
.dsh-teams-flow-card[data-clickable="true"]:hover{
  transform:perspective(700px) rotateX(3deg) rotateY(-4deg) translateY(-3px) scale(1.02);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 36%,var(--dsw-alias-border-l2));
  box-shadow:-5px 9px 18px color-mix(in srgb,black 13%,transparent),
             0 2px 4px color-mix(in srgb,black 9%,transparent);}
.dsh-teams-flow-card[data-clickable="true"]:active{
  transform:perspective(700px) rotateX(1deg) rotateY(-1deg) translateY(-1px) scale(.995);
  box-shadow:0 1px 3px color-mix(in srgb,black 12%,transparent);}
.dsh-teams-flow-card[data-clickable="true"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}
/* 进行中：黄色流光沿边框环绕转动。
   ⚠️ inset 必须是 0：绝对定位的包含块是 padding box，写成 -1.5px 时遮罩保留的环
   正好落在 padding box 之外，会被卡片自己的 overflow:hidden 裁掉 → 流光完全看不见。 */
.dsh-teams-flow-glow{display:none;position:absolute;inset:0;border-radius:16.5px;z-index:0;
  padding:1.5px;
  background:conic-gradient(from 0deg, transparent 0deg, transparent 250deg,
    var(--dsw-alias-state-warn-primary) 320deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, white) 350deg, transparent 360deg);
  -webkit-mask:linear-gradient(white 0 0) content-box,linear-gradient(white 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(white 0 0) content-box,linear-gradient(white 0 0);
  mask-composite:exclude;
  animation:dsh-teams-flow-spin 2.4s linear infinite;}
.dsh-teams-flow-card[data-status="running"] .dsh-teams-flow-glow,
.dsh-teams-flow-card[data-status="ready"] .dsh-teams-flow-glow{display:block;}
.dsh-teams-flow-card > .dsh-teams-flow-stage,
.dsh-teams-flow-card > .dsh-teams-flow-info{position:relative;z-index:1;}
@keyframes dsh-teams-flow-spin{to{transform:rotate(360deg);}}
/* 鲸鱼图标 + 装扮挂件 */
.dsh-teams-whale{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;}
.dsh-teams-whale-accessory{position:absolute;right:-3px;top:-3px;font-size:11px;line-height:1;}
/* ============ 成员卡与子会话横幅 ============ */
.dsh-teams-member[data-clickable="true"]{cursor:pointer;}
.dsh-teams-member[data-clickable="true"]:hover{background:var(--dsw-alias-bg-layer-2);}
.dsh-teams-member[data-clickable="true"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dsh-teams-member-main{display:flex;align-items:center;gap:8px;}
.dsh-teams-member-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}
.dsh-teams-avatar{flex:none;width:24px;height:24px;border-radius:8px;display:inline-flex;
  align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:1;}
.dsh-teams-open{flex:none;color:var(--dsw-alias-label-secondary);font-size:16px;opacity:.45;}
.dsh-teams-member[data-clickable="true"]:hover .dsh-teams-open{opacity:1;color:var(--dsw-alias-brand-primary);}
.dsh-teams-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 8px;
  padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;}
.dsh-teams-banner .dsh-teams-btn{margin-left:auto;}
.dsh-teams-session-btn{font-size:11px;padding:1px 8px;margin-left:auto;}
/* 设置卡片（plugins.item 槽位）。尺寸沿用既有刻度：行高 28、圆角 7–10、小字 11–12。 */
.dsh-teams-set{display:flex;flex-direction:column;gap:10px;font-size:13px;
  color:var(--dsw-alias-label-primary);}
.dsh-teams-set:focus-visible{outline:none;}
.dsh-teams-set-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.dsh-teams-set-group{border:0;border-top:1px solid var(--dsw-alias-border-l1);
  margin:0;padding:8px 0 0;min-width:0;}
.dsh-teams-set-legend{padding:0;}
.dsh-teams-set-toggle{appearance:none;border:0;background:transparent;cursor:pointer;padding:0;
  font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dsh-teams-set-toggle:hover{color:var(--dsw-alias-brand-primary);}
.dsh-teams-set-fields{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
.dsh-teams-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.dsh-teams-set-main{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dsh-teams-set-label{font-size:12px;color:var(--dsw-alias-label-primary);}
.dsh-teams-set-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}
.dsh-teams-set-side{display:flex;align-items:center;gap:6px;flex:none;}
.dsh-teams-set-unit{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dsh-teams-set-input{box-sizing:border-box;height:28px;width:120px;padding:0 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
.dsh-teams-set-input::placeholder{color:var(--dsw-alias-label-secondary);}
.dsh-teams-set-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none;}
.dsh-teams-set-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary);}
.dsh-teams-set-input:disabled{opacity:.5;cursor:not-allowed;}
.dsh-teams-set-select{width:auto;min-width:120px;}
.dsh-teams-set-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.dsh-teams-set-check{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary);}
.dsh-teams-set-error{margin:0;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-state-error-primary);}
.dsh-teams-set-alert{margin:0;padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.5;
  border:1px solid var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word;}
.dsh-teams-set-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;margin-top:2px;}
.dsh-teams-set-primary{appearance:none;cursor:pointer;font-size:12px;padding:4px 12px;
  border-radius:7px;border:1px solid var(--dsw-alias-brand-primary);background:transparent;
  color:var(--dsw-alias-label-primary);font-weight:600;}
.dsh-teams-set-primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
.dsh-teams-btn:disabled,.dsh-teams-set-primary:disabled{opacity:.5;cursor:not-allowed;}
.dsh-teams-set-note{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-set-note[data-tone="done"]{color:var(--dsw-alias-state-success-primary);}
.dsh-teams-set-chip{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}
`;

    /* -------------------------------------------------------------- *
     * 宿主状态获取
     * -------------------------------------------------------------- */

    /**
     * 打开某个会话：成员卡片 → 它的子会话；子会话横幅 → 队长会话。
     *
     * 走宿主的 `uiWorkspace.openSession(target)`（`SessionTarget = SessionId | SubagentAddress`）。
     * 软依赖：宿主没提供该服务时静默返回 false，面板照常可用（只是卡片不可点）。
     */
    function openSessionVia(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const uiWorkspace = ctx.get('uiWorkspace');
      if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') return false;
      try {
        uiWorkspace.openSession(sessionId);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 创建团队状态读取器。
     * 走宿主注册的 Web 路由；未启用/不可用时返回 null，UI 显示降级文案而不是崩掉。
     */
    function createTeamStore(sessionIdRef) {
      let snapshot = null;
      let error = undefined;
      let inflight = false;
      let loaded = false;   // 首次请求是否已回来（UI 据此区分"加载中"与"没有团队"）
      const listeners = new Set();

      const emit = () => {
        for (const listener of listeners) listener();
      };

      const load = async () => {
        if (inflight) return;
        inflight = true;
        try {
          const sessionId = sessionIdRef();
          const query = sessionId === undefined ? '' : `?session=${encodeURIComponent(sessionId)}`;
          const response = await fetch(`/plugins/dsh-teams/state${query}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          snapshot = body?.team ?? null;
          error = undefined;
        } catch (cause) {
          error = cause;
        } finally {
          inflight = false;
          loaded = true;
          emit();
        }
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot() {
          return snapshot;
        },
        isLoading() {
          return !loaded;
        },
        getError() {
          return error;
        },
        refresh: load,
        /** 运行中轮询更快；空闲时放慢，避免无谓请求。 */
        intervalFor() {
          const phase = snapshot?.phase;
          return phase === 'running' || phase === 'staged' ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        },
      };
    }

    /**
     * 自调节轮询：每一轮结束都重新读一次间隔，而不是挂载时定死。
     *
     * 用 `setInterval(…, intervalFor())` 的话，面板在"空闲"时打开就会永远按 5 秒轮询，
     * 哪怕团队随后开始运行——用户看到的是进度条半天不动。自调节也让运行结束后
     * 自动放慢，不再空转请求。（在途保护在 store.refresh 里，不会并发打同一个接口。）
     */
    function pollLoop(store) {
      let timer;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        await store.refresh();
        if (stopped) return;
        timer = setTimeout(tick, store.intervalFor());
      };
      timer = setTimeout(tick, store.intervalFor());
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }

    /* -------------------------------------------------------------- *
     * 组件
     * -------------------------------------------------------------- */

    /** 会话头部徽标：显示路径与运行状态，点击打开右栏团队页。 */
    function TeamBadge(props) {
      const store = props.store;
      const t = props.t ?? ((key) => key);
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        const unsubscribe = store.subscribe(() => setTick((value) => value + 1));
        store.refresh();
        const stopPoll = pollLoop(store);
        return () => {
          unsubscribe();
          stopPoll();
        };
      }, [store]);

      const team = store.getSnapshot();
      const phase = team?.phase ?? 'idle';
      const running = phase === 'running';
      const active = team !== null && team !== undefined;

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-teams-badge',
          'data-active': String(active),
          'data-running': String(running),
          title: team?.purpose ? String(team.purpose) : t('badge.idle'),
          onClick: () => props.onOpen?.(),
          'data-tick': String(tick),
        },
        // DeepSeek 经典蓝鲸鱼：运行中给主色，空闲时降饱和（见 CSS 的 data-running）
        h(GirlArt, { accent: running ? WHALE_BLUE : '#8FA3C8', size: 20, headOnly: true }),
        h('span', null, running ? t('badge.running') : t('badge.idle')),
        team?.pathLabel ? h('span', { className: 'path' }, String(team.pathLabel)) : null,
      );
    }

    /** 右栏团队工作视图：成员 / 任务板 / 运行日志。 */
    /* -------------------------------------------------------------- *
     * 运行流程图：按"每次任务"折叠，展开是路径概述 + 左→右流程图
     * -------------------------------------------------------------- */

    /** DeepSeek 经典蓝。 */
    const WHALE_BLUE = '#4D6BFE';

    /**
     * 鲸鱼图标：DeepSeek 经典蓝的简洁鲸鱼（内联 SVG，不引外部图片——
     * 插件离线可用、无授权问题）。
     *
     * 每个角色靠**主色 + 挂件**做装扮区分：形状统一（都是鲸鱼），
     * 颜色与右上角的小挂件表示身份。
     */
    /* -------------------------------------------------------------- *
     * 角色形象：一份矢量，所有卡片用 <use> 引用
     * -------------------------------------------------------------- */

    /** 矢量资源由宿主路由提供（客户端插件读不了文件）。 */
    const ASSET_URL = '/plugins/dsh-teams/asset?name=';
    const GIRL_ID = 'dsh-teams-girl';
    /** 全身 / 头部（徽标用同一个 <g>，只换 viewBox，不另做图）。 */
    const GIRL_VIEWBOX = '0 0 640 606';
    const GIRL_HEAD_VIEWBOX = '160 100 280 280';

    /**
     * 矢量加载状态。
     *
     * 实测（见 .perf-bench.html）：60 张卡片时，
     *   每张卡内联一份完整 SVG → 单次重渲染 22.4ms、1080 个 DOM 节点（超过一帧，会掉帧）
     *   全局一份 <g> + 每张卡一个 <use> → 8.9ms、240 个节点
     * 所以：**只内联一份**，卡片一律 <use> 引用。
     */
    const GIRL_ART = { started: false, ready: false, failed: false, listeners: new Set() };

    function subscribeGirlArt(listener) {
      GIRL_ART.listeners.add(listener);
      return () => {
        GIRL_ART.listeners.delete(listener);
      };
    }

    function notifyGirlArt() {
      for (const listener of [...GIRL_ART.listeners]) {
        try {
          listener();
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    /** 拉一次矢量并内联成全局 <g id>；失败则标记，组件回退到手绘鲸鱼。 */
    function loadGirlArt() {
      if (GIRL_ART.started) return;
      GIRL_ART.started = true;
      fetch(`${ASSET_URL}girl-vector.svg`, { cache: 'force-cache' })
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((text) => {
          const inner = text.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
          if (inner === '') throw new Error('empty svg');
          const host = document.createElement('div');
          host.setAttribute('aria-hidden', 'true');
          host.setAttribute('data-dsh-teams-art', '');
          host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
          host.innerHTML = `<svg width="0" height="0"><defs><g id="${GIRL_ID}">${inner}</g></defs></svg>`;
          document.body.appendChild(host);
          GIRL_ART.ready = true;
          notifyGirlArt();
        })
        .catch(() => {
          GIRL_ART.failed = true;
          notifyGirlArt();
        });
    }

    /** 订阅矢量就绪状态（就绪后立刻重渲染，不用等下一次轮询）。 */
    function useGirlArt() {
      const [, force] = React.useState(0);
      React.useEffect(
        () =>
          subscribeGirlArt(() => {
            force((value) => value + 1);
          }),
        [],
      );
      return GIRL_ART.ready;
    }

    /** 把颜色压暗，用作裙子暗部（没有调色板时的兜底算法）。 */
    function darken(hex, ratio = 0.62) {
      const value = String(hex ?? '').replace('#', '');
      if (!/^[0-9a-fA-F]{6}$/.test(value)) return '#2f2b3d';
      const parts = [0, 2, 4].map((i) => Math.round(parseInt(value.slice(i, i + 2), 16) * ratio));
      return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    }

    /**
     * Q 版鲸鱼娘：**矢量**，每个子代理一套裙装配色。
     *
     * 裙子的两层在 SVG 里写的是 `var(--dress-main)` / `var(--dress-shadow)`，
     * 所以换角色配色只要在这层外壳上给两个 CSS 变量——13 个角色共用一份资源。
     * 矢量没拉下来（或宿主路由不可用）时回退到手绘鲸鱼，不会出现破图。
     */
    function GirlArt({ role, accent, size = 46, headOnly = false }) {
      const ready = useGirlArt();
      const dress = accent ?? (lookOf(role).accent ?? WHALE_BLUE);
      if (!ready) return WhaleGirl({ accent: dress, size });
      return h(
        'span',
        { className: 'dsh-teams-whale', style: { width: `${size}px`, height: `${size}px` } },
        h(
          'svg',
          {
            viewBox: headOnly ? GIRL_HEAD_VIEWBOX : GIRL_VIEWBOX,
            width: size,
            height: size,
            'aria-hidden': 'true',
            focusable: 'false',
            style: { '--dress-main': dress, '--dress-shadow': darken(dress) },
          },
          h('use', { href: `#${GIRL_ID}` }),
        ),
      );
    }

    /**
     * Q 版鲸鱼娘：每个子代理一张，**用裙装配色 + 佩饰区分身份**。
     *
     * 造型取自 DeepSeek 的"蓝色大肥鱼"Q 版形象（作者开放二创）：
     * 大头小身、大眼睛带高光、深蓝长发、鲸鱼鳍耳、女仆头饰与白围裙、右下方探出鲸尾。
     * 刻意做得简（十几条路径），不追求原画精度，但保住 Q 萌的几个标志。
     *
     * `size < 24` 时自动省略荷叶边/腮红/嘴/围裙细节——小尺寸下它们只会糊成一团。
     */
    function WhaleGirl({ accent = WHALE_BLUE, accessory, size = 32 }) {
      const HAIR = '#2f3f7f';
      const HAIR2 = '#4a63b8';
      const SKIN = '#ffe3d3';
      const FIN = '#4D6BFE';
      const detail = size >= 24;
      return h(
        'span',
        { className: 'dsh-teams-whale', style: { width: `${size}px`, height: `${size}px` } },
        h(
          'svg',
          { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
          // 背后长发：宽发团
          h('path', { d: 'M9 31c0-15 10-25 23-25s23 10 23 25c0 13-4 25-10 31H19c-6-6-10-18-10-31z', fill: HAIR }),
          h('path', { d: 'M12 40c1 8 4 15 8 20-6-3-10-11-11-20z', fill: HAIR2, opacity: '0.55' }),
          h('path', { d: 'M52 40c-1 8-4 15-8 20 6-3 10-11 11-20z', fill: HAIR2, opacity: '0.55' }),
          // 鲸鱼鳍耳（招牌）
          h('path', { d: 'M13 27C7 25 3 21 1 15c6 0 12 3 16 9z', fill: FIN }),
          h('path', { d: 'M51 27c6-2 10-6 12-12-6 0-12 3-16 9z', fill: FIN }),
          // 鲸尾
          h('path', { d: 'M47 51c6-3 12-2 16 2-4 5-11 6-16 3 2-2 2-4 0-5z', fill: FIN }),
          // 脸
          h('ellipse', { cx: '32', cy: '30', rx: '15', ry: '14', fill: SKIN }),
          // 女仆头饰（细节层）
          detail
            ? h('path', {
                d: 'M16 21c3-9 9-14 16-14s13 5 16 14c-4-4-10-6-16-6s-12 2-16 6z',
                fill: '#ffffff',
                opacity: '0.95',
              })
            : null,
          // 刘海
          h('path', {
            d: 'M16 25c1-10 7-16 16-16s15 6 16 16c-2-4-5-7-9-7-3 3-6 5-10 5-3 0-6-1-8-3-2 2-4 3-5 5z',
            fill: HAIR,
          }),
          // 蝴蝶结：与裙装同色
          h('path', { d: 'M16 16l-6-4v8l6-4z', fill: accent }),
          h('path', { d: 'M16 16l6-4v8l-6-4z', fill: accent }),
          h('circle', { cx: '16', cy: '16.5', r: '1.7', fill: accent }),
          // 大眼睛 + 高光（Q 萌的关键，任何尺寸都保留）
          h('ellipse', { cx: '25', cy: '30', rx: '5', ry: '5.8', fill: '#ffffff' }),
          h('ellipse', { cx: '39', cy: '30', rx: '5', ry: '5.8', fill: '#ffffff' }),
          h('circle', { cx: '25', cy: '30.6', r: '3.5', fill: '#2b6fd8' }),
          h('circle', { cx: '39', cy: '30.6', r: '3.5', fill: '#2b6fd8' }),
          h('circle', { cx: '25', cy: '30.9', r: '1.9', fill: '#132a5c' }),
          h('circle', { cx: '39', cy: '30.9', r: '1.9', fill: '#132a5c' }),
          h('circle', { cx: '26.4', cy: '28.4', r: '1.5', fill: '#ffffff' }),
          h('circle', { cx: '40.4', cy: '28.4', r: '1.5', fill: '#ffffff' }),
          // 腮红与嘴
          detail
            ? h('ellipse', { cx: '18.5', cy: '35', rx: '3.2', ry: '1.9', fill: '#ff9db0', opacity: '0.5' })
            : null,
          detail
            ? h('ellipse', { cx: '45.5', cy: '35', rx: '3.2', ry: '1.9', fill: '#ff9db0', opacity: '0.5' })
            : null,
          detail
            ? h('path', { d: 'M29 36c1.5 3.4 4.5 3.4 6 0-1 3.4-2 4.4-3 4.4s-2-1-3-4.4z', fill: '#a83a4a' })
            : null,
          // 女仆裙（accent 配色）+ 白围裙
          h('path', { d: 'M21 43h22l4 18H17z', fill: accent }),
          detail ? h('path', { d: 'M25 45h14l2 14H23z', fill: '#ffffff', opacity: '0.95' }) : null,
          detail ? h('path', { d: 'M21 43h22l1 4H20z', fill: '#ffffff', opacity: '0.3' }) : null,
        ),
        accessory === undefined
          ? null
          : h('span', { className: 'dsh-teams-whale-accessory', 'aria-hidden': 'true' }, accessory),
      );
    }

    /** token 数：卡片上空间有限，用 1.2k / 3.4M 这种写法。 */
    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      if (value < 1000) return String(Math.round(value));
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
      return `${(value / 1_000_000).toFixed(1)}M`;
    }

    /** 角色 → 鲸鱼的装扮（主色 + 挂件）。 */
    const ROLE_LOOKS = {
      analyst: { accent: '#4D6BFE', accessory: '🔍' },
      'ui-designer': { accent: '#8B5CF6', accessory: '🎨' },
      architect: { accent: '#0EA5E9', accessory: '🏛️' },
      critic: { accent: '#F97316', accessory: '🧠' },
      executor: { accent: '#22C55E', accessory: '🔨' },
      'code-reviewer': { accent: '#EAB308', accessory: '🔎' },
      'test-engineer': { accent: '#14B8A6', accessory: '🧪' },
      verifier: { accent: '#10B981', accessory: '✅' },
      'security-reviewer': { accent: '#EF4444', accessory: '🛡️' },
      'code-simplifier': { accent: '#06B6D4', accessory: '🧹' },
      debugger: { accent: '#A855F7', accessory: '🐞' },
      devops: { accent: '#64748B', accessory: '🚀' },
      'deploy-auditor': { accent: '#F59E0B', accessory: '📋' },
    };
    const DEFAULT_LOOK = { accent: WHALE_BLUE, accessory: '🐳' };
    function lookOf(role) {
      return ROLE_LOOKS[role] ?? DEFAULT_LOOK;
    }

    /** 依赖 → 层级（列号）；同列即可并行。 */
    function layersOf(steps) {
      const byId = new Map(steps.map((step) => [step.id, step]));
      const depth = new Map();
      const depthOf = (step, seen) => {
        const known = depth.get(step.id);
        if (known !== undefined) return known;
        if (seen.has(step.id)) return 0; // 环：按 0 处理，别把面板拖死
        seen.add(step.id);
        const deps = (step.deps ?? []).map((id) => byId.get(id)).filter((item) => item !== undefined);
        const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep, seen))) + 1;
        depth.set(step.id, value);
        return value;
      };
      for (const step of steps) depthOf(step, new Set());
      const layers = [];
      for (const step of steps) {
        const level = depth.get(step.id) ?? 0;
        if (layers[level] === undefined) layers[level] = [];
        layers[level].push(step);
      }
      return layers;
    }

    /**
     * 连接线：从前一列连到本列。
     *
     * 用百分比坐标画**折线**（先水平、再垂直、再水平），不测量 DOM——
     * 同列卡片等高，于是"第 j 张的中心"就是 `(j + 0.5) / count`。
     * 这样在任何宽度下都连得准，也不会因为重排错位。
     */
    function FlowGap({ parents, children }) {
      const paths = [];
      children.forEach((step, index) => {
        const y2 = ((index + 0.5) / children.length) * 100;
        for (const depId of step.deps ?? []) {
          const parentIndex = parents.findIndex((item) => item.id === depId);
          if (parentIndex < 0) continue;
          const y1 = ((parentIndex + 0.5) / parents.length) * 100;
          paths.push(
            h('path', {
              key: `${depId}->${step.id}`,
              d: `M0 ${y1} H50 V${y2} H100`,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1,
              vectorEffect: 'non-scaling-stroke',
              opacity: 0.4,
            }),
          );
        }
      });
      if (paths.length === 0) return h('span', { className: 'dsh-teams-flow-gap' });
      return h(
        'svg',
        {
          className: 'dsh-teams-flow-gap',
          viewBox: '0 0 100 100',
          preserveAspectRatio: 'none',
          'aria-hidden': 'true',
        },
        ...paths,
      );
    }

    /**
     * 一张身份牌（UI 设计师规范）：上半立绘舞台 + 下半信息区。
     *
     * 信息层级：角色名（2 行 clamp）→ 用量（label/value 右对齐 + tabular-nums）→ 状态胶囊。
     * 状态不单靠颜色（有文字），并带 aria-label。
     */
    function FlowCard({ step, t, openSession }) {
      const look = lookOf(step.role);
      const status = String(step.status ?? 'pending');
      const metrics = step.metrics ?? {};
      const clickable = typeof step.childId === 'string' && step.childId !== '';
      const open = () => {
        if (clickable) openSession(step.childId);
      };
      const tokens =
        metrics.inputTokens === undefined && metrics.outputTokens === undefined
          ? undefined
          : (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
      const usage = [
        [t('flow.steps'), metrics.steps === undefined ? undefined : String(metrics.steps)],
        [t('flow.tokens'), tokens === undefined ? undefined : formatTokens(tokens)],
        [t('flow.cache'), metrics.cacheReadTokens === undefined ? undefined : formatTokens(metrics.cacheReadTokens)],
      ].filter((pair) => pair[1] !== undefined);
      const roleName = step.roleName ?? step.role;
      const statusLabel = t(`task.${status}`);
      const described = usage.map(([label, value]) => `${label} ${value}`).join('，');
      return h(
        'div',
        {
          className: 'dsh-teams-flow-card',
          'data-status': status,
          'data-clickable': clickable ? 'true' : undefined,
          role: clickable ? 'button' : undefined,
          tabIndex: clickable ? 0 : undefined,
          'aria-label': `${roleName}，${statusLabel}${described === '' ? '' : `，${described}`}`,
          title: clickable ? t('flow.openSession') : String(step.failure ?? ''),
          style: { '--role-accent': look.accent },
          onClick: clickable ? open : undefined,
          onKeyDown: clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open();
                }
              }
            : undefined,
        },
        // 流光层：只有"进行中"才转
        h('span', { className: 'dsh-teams-flow-glow', 'aria-hidden': 'true' }),
        look.accessory === undefined
          ? null
          : h('span', { className: 'dsh-teams-flow-badge', 'aria-hidden': 'true' }, look.accessory),
        h(
          'span',
          { className: 'dsh-teams-flow-stage' },
          h('span', { className: 'dsh-teams-flow-inner' }, GirlArt({ role: step.role, accent: look.accent, size: 54 })),
        ),
        h(
          'div',
          { className: 'dsh-teams-flow-info' },
          h('strong', { className: 'dsh-teams-flow-role', title: roleName }, roleName),
          usage.length === 0
            ? null
            : h(
                'span',
                { className: 'dsh-teams-flow-usage' },
                ...usage.map(([label, value]) =>
                  h('span', { key: label }, h('b', null, label), h('i', null, value)),
                ),
              ),
          h(
            'span',
            { className: 'dsh-teams-flow-state' },
            h('i', { className: 'dsh-teams-dot', 'aria-hidden': 'true' }),
            statusLabel,
          ),
        ),
      );
    }

    /** 一轮运行的流程图：列 = 依赖层级，左→右。 */
    function FlowDiagram({ run, t, openSession }) {
      const steps = Array.isArray(run.steps) ? run.steps : [];
      if (steps.length === 0) return h('div', { className: 'dsh-teams-muted' }, t('flow.empty'));
      const layers = layersOf(steps);
      const columns = [];
      layers.forEach((layer, index) => {
        if (index > 0) {
          columns.push(h(FlowGap, { key: `gap-${index}`, parents: layers[index - 1], children: layer }));
        }
        columns.push(
          h(
            'div',
            { className: 'dsh-teams-flow-col', key: `col-${index}` },
            ...layer.map((step) => h(FlowCard, { key: step.id, step, t, openSession })),
          ),
        );
      });
      return h('div', { className: 'dsh-teams-flow' }, ...columns);
    }

    /** 一轮运行的折叠项：头部一行（立绘牌 + 标题 + meta + 箭头 + 进度条），展开是流程图。 */
    function RunItem({ run, t, openSession, defaultOpen }) {
      // 折叠时不挂载流程图：DOM 里只有头部（历史再长，挂载的卡片数 = 展开那一轮的步数）
      const [open, setOpen] = React.useState(defaultOpen === true);
      const steps = Array.isArray(run.steps) ? run.steps : [];
      const done = steps.filter((step) => step.status === 'done').length;
      const failed = steps.filter((step) => step.status === 'failed').length;
      const running = steps.filter((step) => step.status === 'running').length;
      const total = steps.length;
      const phase = run.phase ?? 'idle';
      // 立绘牌固定用蓝色初版形象（与需求分析师卡片同一个蓝），不随运行状态变色——
      // 状态已经由边框颜色/状态胶囊表达，头像再变一次只会让"这个人是谁"变得难认。
      const accent = WHALE_BLUE;
      const meta = [
        run.pathLabel ?? run.path ?? '-',
        t(`phase.${phase}`),
        total > 0 ? `${done}/${total}` : '',
        formatTime(run.finishedAt ?? run.at),
      ]
        .filter(Boolean)
        .join(' · ');
      const subject = String(run.subject ?? t('flow.untitled'));
      return h(
        'details',
        {
          className: 'dsh-teams-run',
          'data-phase': String(phase),
          open,
          onToggle: (event) => setOpen(event.currentTarget.open === true),
        },
        h(
          'summary',
          { className: 'dsh-teams-run-head' },
          // 立绘牌：全身人物站在牌底（不裁头）
          h('span', { className: 'dsh-teams-run-avatar' }, h(GirlArt, { accent, size: 34 })),
          h('span', { className: 'dsh-teams-run-subject', title: subject }, subject),
          h(
            'span',
            { className: 'dsh-teams-run-meta' },
            run.current === true
              ? h('span', { className: 'dsh-teams-chip', 'data-state': 'running' }, t('flow.current'))
              : null,
            h('span', null, meta),
          ),
          h('span', { className: 'dsh-teams-run-chevron', 'aria-hidden': 'true' }, '⌄'),
          // 进度条贴折叠行底边：折叠时也能看完成度
          total > 0
            ? h(
                'span',
                { className: 'dsh-teams-run-bar', role: 'progressbar', 'aria-valuenow': String(done), 'aria-valuemin': '0', 'aria-valuemax': String(total) },
                h('i', { style: { width: `${Math.round((done / total) * 100)}%` } }),
              )
            : null,
        ),
        open ? h('div', { className: 'dsh-teams-run-body' }, h(FlowDiagram, { run, t, openSession })) : null,
      );
    }

    /** 历史上限：先渲染最近这些轮，更早的按需展开（兜住极端情况）。 */
    const RUNS_PAGE = 8;

    /** 运行列表：每次任务一项，最新在最上面。 */
    function RunsView({ team, t, openSession }) {
      const runs = Array.isArray(team.runs) ? team.runs : [];
      const [showAll, setShowAll] = React.useState(false);
      if (runs.length === 0) return h('div', { className: 'dsh-teams-empty' }, t('view.noTasks'));
      const shown = showAll ? runs : runs.slice(0, RUNS_PAGE);
      const hidden = runs.length - shown.length;
      return h(
        'div',
        { className: 'dsh-teams-runs' },
        ...shown.map((run, index) => h(RunItem, {
              key: run.runId ?? index,
              run,
              t,
              openSession,
              // 极端数据：步骤特别多的运行默认折叠，避免一次性挂载几百张卡
              defaultOpen: index === 0 && (Array.isArray(run.steps) ? run.steps.length : 0) <= 30,
            })),
        hidden > 0
          ? h(
              'button',
              { type: 'button', className: 'dsh-teams-btn', onClick: () => setShowAll(true) },
              t('flow.more').replace('{n}', String(hidden)),
            )
          : null,
      );
    }

    function TeamWorkspace(props) {
      const store = props.store;
      const t = props.t ?? ((key) => key);
      const [tab, setTab] = React.useState('runs');
      const [, setTick] = React.useState(0);
      // 打开会话的能力由面板注册处注入（组件在 factory 作用域里拿不到 ctx）
      const openSession = typeof props.onOpenSession === 'function' ? props.onOpenSession : () => false;

      React.useEffect(() => {
        const unsubscribe = store.subscribe(() => setTick((value) => value + 1));
        store.refresh();
        const stopPoll = pollLoop(store);
        return () => {
          unsubscribe();
          stopPoll();
        };
      }, [store]);

      const team = store.getSnapshot();
      const failed = store.getError() !== undefined;

      const tabs = [
        // 流程优先：按"每次任务"折叠，展开就是那一轮的路径概述与左→右流程图
        ['runs', t('flow.tab')],
        ['members', t('view.members')],
        ['tasks', t('view.tasks')],
        ['log', t('view.log')],
      ];

      const header = h(
        'div',
        { className: 'dsh-teams-tabs', role: 'tablist' },
        ...tabs.map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              role: 'tab',
              className: 'dsh-teams-tab',
              'aria-selected': String(tab === key),
              onClick: () => setTab(key),
            },
            label,
          ),
        ),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          { type: 'button', className: 'dsh-teams-btn', onClick: () => store.refresh() },
          t('refresh'),
        ),
      );

      const loading = typeof store.isLoading === 'function' && store.isLoading();

      let body;
      if (failed) {
        // 错误只报一条横幅，不逐卡染红
        body = h('div', { className: 'dsh-teams-error' }, t('view.unavailable'));
      } else if (team === null || team === undefined) {
        body = loading
          ? h('div', { className: 'dsh-teams-skeleton', 'aria-busy': 'true' }, ...[0, 1, 2].map((i) => h('span', { key: i })))
          : h('div', { className: 'dsh-teams-empty' }, t('view.empty'));
      } else if (tab === 'runs') {
        body = h(RunsView, { team, t, openSession });
      } else if (tab === 'members') {
        body = h(MembersView, { team, t, openSession });
      } else if (tab === 'tasks') {
        body = h(TasksView, { team, t, openSession });
      } else {
        body = h(LogView, { team, t });
      }

      // 正在看子代理会话时给一条返回通道：团队视图来自队长会话，
      // 用户点进成员后不该"迷路"（真实缺陷：进去后面板空白、只能返回主会话）
      const childBanner =
        team !== null && team !== undefined && team.viewingAsChild === true
          ? h(
              'div',
              { className: 'dsh-teams-banner' },
              h('span', null, t('nav.viewingChild')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-teams-btn',
                  onClick: () => openSession(team.captainSessionId),
                },
                t('nav.backToCaptain'),
              ),
            )
          : null;

      return h(
        'div',
        { className: 'dsh-teams-root' },
        header,
        childBanner,
        h('div', { className: 'dsh-teams-body' }, body),
      );
    }

    /**
     * 角色管理（设置页里的「角色」页签）。
     *
     * 形态与右栏面板不同：设置页是宽屏（600–800px），所以用**多列网格**；
     * 编辑不浮层，直接占满角色区（设置页容器不确定，浮层容易定位错）。
     *
     * 交互约定：
     *   - 卡片不用 <details>：summary 里嵌开关时，空格键会同时折叠与切换
     *   - 开关是独立 button[role=switch]，状态用「旋钮位置 + 文字」双通道编码
     *   - 删除走行内确认条（不是整页弹窗），Esc 逐层退
     */
    function RoleManager({ t }) {
      const [state, setState] = React.useState({ status: 'loading', roles: [], coreRoles: [], workspace: '', workspaces: [], error: undefined });
      const [view, setView] = React.useState('builtin');
      const [query, setQuery] = React.useState('');
      const [editing, setEditing] = React.useState(undefined); // { mode, role?, from? }
      const [confirming, setConfirming] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      // 多工作区时用户选的那个；空 = 用宿主给的默认
      const [workspace, setWorkspace] = React.useState('');

      const load = React.useCallback(async (targetWorkspace) => {
        try {
          const query_ = new URLSearchParams();
          if (targetWorkspace) query_.set('workspace', targetWorkspace);
          const response = await fetch(`/plugins/dsh-teams/roles?${query_.toString()}`, { credentials: 'same-origin' });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.detail ?? payload?.error ?? `HTTP ${response.status}`);
          setState({
            status: 'ready',
            roles: payload.roles ?? [],
            coreRoles: payload.coreRoles ?? [],
            workspace: payload.workspace ?? '',
            workspaces: payload.workspaces ?? [],
            error: undefined,
          });
        } catch (cause) {
          setState({ status: 'failed', roles: [], coreRoles: [], workspace: '', workspaces: [], error: String(cause?.message ?? cause) });
        }
      }, []);

      React.useEffect(() => {
        load(workspace);
      }, [load, workspace]);

      const act = async (body) => {
        setBusy(true);
        try {
          const response = await fetch('/plugins/dsh-teams/roles', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, workspace: workspace || state.workspace }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok !== true) {
            const reason = payload.reason ?? payload.detail ?? (Array.isArray(payload.errors) ? payload.errors.join('；') : `HTTP ${response.status}`);
            setState((current) => ({ ...current, error: reason }));
            return { ok: false, reason };
          }
          setState((current) => ({ ...current, roles: payload.roles ?? current.roles, coreRoles: payload.coreRoles ?? current.coreRoles, error: undefined }));
          return { ok: true };
        } catch (cause) {
          const reason = String(cause?.message ?? cause);
          setState((current) => ({ ...current, error: reason }));
          return { ok: false, reason };
        } finally {
          setBusy(false);
        }
      };

      const builtin = state.roles.filter((role) => role.builtin === true);
      const custom = state.roles.filter((role) => role.builtin !== true);
      const source = view === 'builtin' ? builtin : custom;
      const shown = query.trim() === ''
        ? source
        : source.filter((role) => `${role.name} ${role.slug} ${role.description} ${(role.triggers ?? []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
      const countEnabled = (list) => list.filter((role) => role.enabled !== false).length;

      // 编辑中：整块换成编辑器
      if (editing !== undefined) {
        return h(RoleEditor, {
          t,
          mode: editing.mode,
          role: editing.role,
          from: editing.from,
          workspace: workspace || state.workspace,
          onCancel: () => setEditing(undefined),
          onSubmit: act,
          onSaved: async () => {
            setEditing(undefined);
            await load(workspace);
          },
        });
      }

      const card = (role) => {
        const off = role.enabled !== true;
        const core = state.coreRoles.includes(role.slug);
        const confirm = confirming === role.slug;
        const isCustom = role.builtin !== true;
        return h(
          'div',
          { key: `${role.builtin ? 'b' : 'c'}-${role.slug}`, className: 'dsh-teams-role-card', 'data-off': off ? 'true' : undefined },
          h('span', { className: 'dsh-teams-role-avatar', 'aria-hidden': 'true' }, role.emoji ?? '🤖'),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { className: 'dsh-teams-role-name', title: `${role.name}（${role.slug}）` }, role.name),
            h(
              'div',
              { className: 'dsh-teams-role-meta' },
              h('span', { className: 'dsh-teams-role-cat' }, role.category === 'builtin' ? t('role.catBuiltin') : role.category),
              h('span', { className: 'dsh-teams-role-state' }, off ? t('role.off') : t('role.on')),
              role.overrides === true ? h('span', { className: 'dsh-teams-role-cat' }, t('role.overrides')) : null,
              role.overridden === true ? h('span', { className: 'dsh-teams-role-cat' }, t('role.overridden')) : null,
            ),
            h('div', { className: 'dsh-teams-role-desc' }, role.description),
            role.triggers?.length > 0
              ? h(
                  'div',
                  { className: 'dsh-teams-role-triggers', style: { marginTop: '6px' } },
                  ...role.triggers.map((word) => h('span', { key: word, className: 'dsh-teams-role-trigger' }, word)),
                )
              : null,
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-teams-switch',
            'aria-checked': String(role.enabled === true),
            'aria-label': `${role.name} ${role.enabled === true ? t('role.disable') : t('role.enable')}`,
            title: core ? t('role.coreLocked') : undefined,
            disabled: busy,
            onClick: () => act({ action: 'toggle', role: role.slug, enabled: off }),
          }),
          confirm
            ? h(
                'div',
                { className: 'dsh-teams-role-actions' },
                h('span', { className: 'dsh-teams-role-hint', style: { flex: 1, alignSelf: 'center' } }, `${t('role.confirmDelete')}「${role.name}」？`),
                h('button', { type: 'button', className: 'dsh-teams-btn', autoFocus: true, onClick: () => setConfirming(undefined) }, t('role.cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-teams-btn dsh-teams-role-danger',
                    disabled: busy,
                    onClick: async () => {
                      const done = await act({ action: 'delete', role: role.slug });
                      if (done.ok) setConfirming(undefined);
                    },
                  },
                  t('role.delete'),
                ),
              )
            : h(
                'div',
                { className: 'dsh-teams-role-actions' },
                h('button', { type: 'button', className: 'dsh-teams-btn', onClick: () => setEditing({ mode: 'view', role }) }, t('role.view')),
                isCustom
                  ? h('button', { type: 'button', className: 'dsh-teams-btn', onClick: () => setEditing({ mode: 'edit', role }) }, t('role.edit'))
                  : h('button', { type: 'button', className: 'dsh-teams-btn', onClick: () => setEditing({ mode: 'create', from: role }) }, t('role.copy')),
                isCustom
                  ? h('button', { type: 'button', className: 'dsh-teams-btn dsh-teams-role-danger', onClick: () => setConfirming(role.slug) }, t('role.delete'))
                  : null,
              ),
        );
      };

      const list =
        state.status === 'loading'
          ? h('div', { className: 'dsh-teams-empty' }, t('view.loading'))
          : shown.length === 0
            ? h(
                'div',
                { className: 'dsh-teams-role-empty' },
                h('span', null, query.trim() !== '' ? t('role.noMatch') : view === 'custom' ? t('role.emptyCustom') : t('role.emptyBuiltin')),
                view === 'custom' && query.trim() === ''
                  ? h('button', { type: 'button', className: 'dsh-teams-btn', onClick: () => setEditing({ mode: 'create' }) }, t('role.new'))
                  : null,
              )
            : h('div', { className: 'dsh-teams-role-grid' }, ...shown.map(card));

      return h(
        'div',
        null,
        state.error === undefined ? null : h('div', { className: 'dsh-teams-error', role: 'alert' }, state.error),
        h(
          'div',
          { className: 'dsh-teams-role-head' },
          h(
            'div',
            { className: 'dsh-teams-seg', role: 'tablist' },
            h(
              'button',
              { type: 'button', role: 'tab', 'aria-selected': String(view === 'builtin'), onClick: () => { setView('builtin'); setConfirming(undefined); } },
              `${t('role.builtin')} ${builtin.length}·${countEnabled(builtin)}`,
            ),
            h(
              'button',
              { type: 'button', role: 'tab', 'aria-selected': String(view === 'custom'), onClick: () => { setView('custom'); setConfirming(undefined); } },
              `${t('role.custom')} ${custom.length}·${countEnabled(custom)}`,
            ),
          ),
          h('input', {
            type: 'search',
            className: 'dsh-teams-role-search',
            placeholder: t('role.search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t('role.search'),
          }),
          state.workspaces.length > 1
            ? h(
                'select',
                {
                  className: 'dsh-teams-role-search',
                  style: { flex: 'none', width: 'auto', maxWidth: '240px' },
                  value: workspace || state.workspace,
                  onChange: (event) => setWorkspace(event.target.value),
                  'aria-label': t('role.workspace'),
                },
                ...state.workspaces.map((item) => h('option', { key: item, value: item }, item)),
              )
            : state.workspace === ''
              ? null
              : h('span', { className: 'dsh-teams-role-ws', title: state.workspace }, t('role.workspaceOf').replace('{path}', state.workspace)),
          h(
            'button',
            { type: 'button', className: 'dsh-teams-btn', onClick: () => setEditing({ mode: 'create' }) },
            `+ ${t('role.new')}`,
          ),
        ),
        list,
      );
    }

    /** 角色编辑器（设置页内联，不浮层）。 */
    function RoleEditor({ t, mode, role, from, workspace, onCancel, onSubmit, onSaved }) {
      const seed = mode === 'view' || mode === 'edit' ? role : undefined;
      const source = from ?? seed;
      const readOnly = mode === 'view';
      const [form, setForm] = React.useState({
        role_id: mode === 'edit' ? seed?.slug ?? '' : '',
        name: mode === 'create' ? (source === undefined ? '' : `${source.name}（副本）`) : seed?.name ?? '',
        description: seed?.description ?? source?.description ?? '',
        emoji: seed?.emoji ?? source?.emoji ?? '🤖',
        category: seed?.category === 'builtin' ? '' : seed?.category ?? '',
        permissions: seed?.permissions ?? 'readonly',
        tier: seed?.tier ?? 'medium',
        triggers: (seed?.triggers ?? []).join(', '),
        prompt: '',
      });
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);

      // 契约正文不在列表接口里回传（太长），查看/复制时单独按 slug 取
      React.useEffect(() => {
        if (source === undefined) return undefined;
        let alive = true;
        (async () => {
          try {
            const response = await fetch(
              `/plugins/dsh-teams/roles/body?role=${encodeURIComponent(source.slug)}&workspace=${encodeURIComponent(workspace ?? '')}`,
              { credentials: 'same-origin' },
            );
            if (!response.ok) return;
            const payload = await response.json();
            if (alive && typeof payload.body === 'string') setForm((current) => ({ ...current, prompt: payload.body }));
          } catch {
            /* 取不到正文时留空，保存会提示必填 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [source, workspace]);

      const field = (label, control) => h('div', { className: 'dsh-teams-field' }, h('label', null, label), control);
      const input = (key, extra = {}) =>
        h('input', {
          value: form[key],
          disabled: readOnly || (mode === 'edit' && key === 'role_id'),
          onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
          ...extra,
        });

      return h(
        'div',
        { className: 'dsh-teams-role-editor' },
        h(
          'div',
          { className: 'dsh-teams-role-head' },
          h('span', { className: 'dsh-teams-role-sheet-title', style: { flex: 1 } }, readOnly ? `${t('role.view')}：${role?.name ?? ''}` : mode === 'edit' ? `${t('role.edit')}：${role?.name ?? ''}` : t('role.new')),
          h('button', { type: 'button', className: 'dsh-teams-btn', onClick: onCancel }, t('role.back')),
        ),
        error === undefined ? null : h('div', { className: 'dsh-teams-error', role: 'alert' }, error),
        field(t('role.id'), input('role_id', { placeholder: 'db-tuning' })),
        field(t('role.name'), input('name')),
        field(t('role.category'), input('category', { placeholder: t('role.categoryHint') })),
        field(t('role.emoji'), input('emoji')),
        field(t('role.triggersLabel'), input('triggers', { placeholder: 'python, pytest, django' })),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
          field(
            t('role.permissions'),
            h(
              'select',
              { value: form.permissions, disabled: readOnly, onChange: (event) => setForm((current) => ({ ...current, permissions: event.target.value })) },
              ...['readonly', 'readwrite', 'execute'].map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          field(
            t('role.tier'),
            h(
              'select',
              { value: form.tier, disabled: readOnly, onChange: (event) => setForm((current) => ({ ...current, tier: event.target.value })) },
              ...['heavy', 'medium', 'light', 'infrastructure'].map((value) => h('option', { key: value, value }, value)),
            ),
          ),
        ),
        field(t('role.description'), input('description')),
        field(
          t('role.prompt'),
          h('textarea', {
            value: form.prompt,
            disabled: readOnly,
            onChange: (event) => setForm((current) => ({ ...current, prompt: event.target.value })),
          }),
        ),
        h(
          'div',
          { className: 'dsh-teams-role-editor-foot' },
          h('button', { type: 'button', className: 'dsh-teams-btn', onClick: onCancel }, readOnly ? t('role.close') : t('role.cancel')),
          readOnly
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-teams-set-primary',
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true);
                    setError(undefined);
                    const result = await onSubmit({
                      action: 'save',
                      role_id: form.role_id,
                      name: form.name,
                      description: form.description,
                      emoji: form.emoji,
                      category: form.category,
                      permissions: form.permissions,
                      tier: form.tier,
                      triggers: form.triggers,
                      prompt: form.prompt,
                    });
                    setBusy(false);
                    if (result.ok === true) onSaved();
                    else setError(result.reason ?? t('role.saveFailed'));
                  },
                },
                busy ? t('set.saving') : t('role.save'),
              ),
        ),
      );
    }

    /** 毫秒 → 人类可读耗时。 */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      if (ms < 1000) return `${ms}ms`;
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
    }

    /** 时间戳 → 本地 HH:MM:SS。 */
    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '';
      return value.replace('T', ' ').slice(11, 19);
    }

    function MembersView({ team, t }) {
      const nodes = [];
      const stats = team.stats ?? {};

      // 概览：路径、阶段、进度
      nodes.push(
        h(
          'div',
          { className: 'dsh-teams-card', key: 'summary' },
          h(
            'dl',
            { className: 'dsh-teams-kv' },
            h('dt', null, t('field.path')),
            h('dd', null, `${team.pathLabel ?? '-'}（${team.path ?? '-'}）`),
            h('dt', null, t('field.phase')),
            h('dd', null, t(`phase.${team.phase ?? 'idle'}`)),
            team.score === undefined
              ? null
              : h('dt', null, t('field.score')),
            team.score === undefined
              ? null
              : h(
                  'dd',
                  null,
                  `规模 ${team.score.scale} + 影响 ${team.score.impact} + 风险 ${team.score.risk} = ${team.total}`,
                ),
            stats.total > 0 ? h('dt', null, t('field.progress')) : null,
            stats.total > 0
              ? h('dd', null, `${stats.done ?? 0}/${stats.total}${stats.failed ? `　失败 ${stats.failed}` : ''}`)
              : null,
          ),
          stats.total > 0
            ? h(
                'div',
                { className: 'dsh-teams-progress', role: 'progressbar', 'aria-valuenow': String(stats.done ?? 0), 'aria-valuemin': '0', 'aria-valuemax': String(stats.total) },
                h('i', { style: { width: `${Math.round(((stats.done ?? 0) / stats.total) * 100)}%` } }),
              )
            : null,
        ),
      );

      const members = Array.isArray(team.members) ? team.members : [];
      if (members.length === 0) {
        nodes.push(h('div', { className: 'dsh-teams-muted', key: 'none' }, t('view.noMembers')));
      } else {
        for (const member of members) {
          const sessionId = member.sessionId;
          const clickable = typeof sessionId === 'string' && sessionId !== '';
          const openMember = () => {
            if (clickable) openSession(sessionId);
          };
          nodes.push(
            h(
              'div',
              {
                className: 'dsh-teams-card dsh-teams-member',
                key: member.role ?? member.name,
                'data-clickable': clickable ? 'true' : undefined,
                role: clickable ? 'button' : undefined,
                tabIndex: clickable ? 0 : undefined,
                title: clickable ? t('member.openSession') : undefined,
                onClick: clickable ? openMember : undefined,
                onKeyDown: clickable
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openMember();
                      }
                    }
                  : undefined,
              },
              h(
                'div',
                { className: 'dsh-teams-member-main' },
                h('span', { className: 'dsh-teams-avatar', 'aria-hidden': 'true' }, member.emoji ?? '🧩'),
                h(
                  'span',
                  { className: 'dsh-teams-member-text' },
                  h('strong', null, member.roleName ?? member.name),
                  member.currentTask
                    ? h('span', { className: 'dsh-teams-muted' }, `${t('member.onTask')} ${member.currentTask}`)
                    : null,
                ),
                h(
                  'span',
                  { className: 'dsh-teams-chip', 'data-state': String(member.status ?? 'idle') },
                  member.status === 'working' ? t('member.working') : t('member.idle'),
                ),
                clickable ? h('span', { className: 'dsh-teams-open', 'aria-hidden': 'true' }, '›') : null,
              ),
            ),
          );
        }
      }
      return h('div', null, ...nodes);
    }

    /** 看门狗徽标：这一步是正常跑完的、被回收救回来的，还是被取消的。 */
    function watchBadge(task, t) {
      const watch = task.watch;
      if (watch === undefined) return null;
      const label = watch.harvested
        ? t('watch.harvested')
        : watch.cancelVia !== undefined
          ? t('watch.cancelled')
          : watch.verdict !== undefined
            ? t('watch.observed')
            : undefined;
      if (label === undefined) return null;
      return h(
        'span',
        { className: 'dsh-teams-chip', 'data-state': 'done', title: String(watch.verdict ?? '') },
        `🐕 ${label}`,
      );
    }

    /** 预算条：已用 / 该角色档位的预算。实测里这个比值是判断"要不要调档"的唯一依据。 */
    function budgetBar(task, t) {
      const budget = task.budgetMs;
      const used = task.durationMs;
      if (!Number.isFinite(budget) || budget <= 0) return null;
      const elapsed = Number.isFinite(used) ? used : task.status === 'running' ? Date.now() - Date.parse(task.startedAt ?? '') : undefined;
      if (!Number.isFinite(elapsed)) return null;
      const ratio = Math.min(1, elapsed / budget);
      const over = elapsed >= budget;
      return h(
        'div',
        { className: 'dsh-teams-muted', style: { marginTop: 4 } },
        h('span', null, `${t('task.budget')} ${formatDuration(elapsed)} / ${formatDuration(budget)}`),
        h(
          'div',
          {
            className: 'dsh-teams-budget',
            'data-over': over ? 'true' : 'false',
            style: { marginTop: 2, height: 3, borderRadius: 2, background: 'var(--dsw-alias-border-l1)' },
          },
          h('div', {
            style: {
              width: `${Math.round(ratio * 100)}%`,
              height: '100%',
              borderRadius: 2,
              background: over ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
            },
          }),
        ),
      );
    }

    function TasksView({ team, t }) {
      const tasks = Array.isArray(team.tasks) ? team.tasks : [];
      if (tasks.length === 0) {
        return h('div', { className: 'dsh-teams-muted' }, t('view.noTasks'));
      }
      // 按依赖层级排序：面板要能一眼看出"谁在等谁"，而不是一串平铺的卡片
      const ordered = tasks
        .map((task, index) => ({ task, index }))
        .sort((a, b) => (a.task.depth ?? 0) - (b.task.depth ?? 0) || a.index - b.index)
        .map((entry) => entry.task);

      // 同批次 = 依赖集合相同 = 可以并行；标出来（这是任务图最容易被忽略的信息）
      const batchSize = new Map();
      for (const task of ordered) {
        const key = task.batch ?? -1;
        batchSize.set(key, (batchSize.get(key) ?? 0) + 1);
      }

      return h(
        'div',
        null,
        ...ordered.map((task) => {
          const status = task.status ?? 'pending';
          const depth = Number.isFinite(task.depth) ? task.depth : 0;
          const parallel = (batchSize.get(task.batch ?? -1) ?? 0) > 1;
          const meta = [
            task.roleName ?? task.role,
            Array.isArray(task.deps) && task.deps.length > 0 ? `${t('task.deps')} ${task.deps.join(', ')}` : t('task.noDeps'),
            parallel ? t('task.parallel') : '',
            task.attemptCount > 1 ? `${t('task.attempts')} ${task.attemptCount}` : '',
            formatDuration(task.durationMs),
            task.finishedAt ? formatTime(task.finishedAt) : '',
          ]
            .filter(Boolean)
            .join('　·　');

          return h(
            'div',
            {
              className: 'dsh-teams-card',
              key: task.id,
              'data-status': String(status),
              'data-depth': String(depth),
              style: { marginLeft: depth * 12 },
            },
            h(
              'div',
              { className: 'dsh-teams-row' },
              h('strong', null, String(task.subject ?? task.id)),
              h('span', { className: 'dsh-teams-chip', 'data-state': String(status) }, t(`task.${status}`)),
              watchBadge(task, t),
              // 这一步的子会话入口：点进去看它自己完整的对话（含工具调用与推理）
              typeof task.childId === 'string' && task.childId !== ''
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-teams-btn dsh-teams-session-btn',
                      title: t('task.openSession'),
                      onClick: () => openSession(task.childId),
                    },
                    `${t('task.openSession')} ›`,
                  )
                : null,
            ),
            h('div', { className: 'dsh-teams-muted', style: { marginTop: 4 } }, meta),
            budgetBar(task, t),
            task.failure ? h('div', { className: 'dsh-teams-failure' }, String(task.failure)) : null,
            // 验收标准：审批闸门要用户看着它决定批不批，所以必须可见
            Array.isArray(task.acceptance) && task.acceptance.length > 0
              ? h(
                  'details',
                  { className: 'dsh-teams-details' },
                  h('summary', null, `${t('task.acceptance')}（${task.acceptance.length}）`),
                  h(
                    'ul',
                    { className: 'dsh-teams-output', style: { margin: '4px 0 0', paddingLeft: 18 } },
                    ...task.acceptance.map((item, index) => h('li', { key: index }, String(item))),
                  ),
                )
              : null,
            task.outputPreview
              ? h(
                  'details',
                  { className: 'dsh-teams-details' },
                  h(
                    'summary',
                    null,
                    `${t('task.output')}（${task.outputPreview.total} 字${task.outputPreview.truncated ? `，${t('task.truncated')}` : ''}）`,
                  ),
                  h('div', { className: 'dsh-teams-output' }, task.outputPreview.text),
                )
              : null,
          );
        }),
      );
    }

    function LogView({ team, t }) {
      const events = Array.isArray(team.events) ? team.events : [];
      if (events.length === 0) return h('div', { className: 'dsh-teams-muted' }, t('log.empty'));
      return h(
        'div',
        null,
        ...events
          .slice()
          .reverse()
          .map((event, index) => {
            const data = event.data ?? {};
            const detail =
              data.path !== undefined
                ? `${t('field.path')}=${data.path}`
                : data.task !== undefined
                  ? `${data.task} ${data.event ?? ''}${data.error !== undefined ? ` — ${data.error}` : ''}`
                  : data.message !== undefined
                    ? String(data.message)
                    : '';
            return h(
              'div',
              { className: 'dsh-teams-logline', key: `${event.ts ?? index}-${index}` },
              `${String(event.ts ?? '').replace('T', ' ').slice(0, 19)}  [${event.type ?? '?'}]  ${detail}`,
            );
          }),
      );
    }

    /* -------------------------------------------------------------- *
     * 设置卡片（plugins.item）
     * -------------------------------------------------------------- */

    /**
     * 设置命名空间 = profile 条目 id。
     *
     * 宿主 `dsh-settings` 下发/接收的是 `entry.options.id`（`cordis.patch.yml` 里的
     * `id: dsh-teams`），**不是包名**。写错不会有任何报错：`whileServed` 永远等不到
     * 这个命名空间，卡片静默不出现。
     */
    const SETTINGS_NS = 'dsh-teams';
    /**
     * 本 bundle 的包名 —— 也是 `plugins.bundle.config` 槽位的 key。
     *
     * 契约原文：`plugins.bundle.config` 是 "A bundle's own configuration, keyed by the
     * bundle's **package name**"。我们的包在 profile 的 `dsh.profile.bundles` 里，
     * 所以 key 就是包名（与 dsh-context / dshmarket / @hyzyn/dsh-codegraph 同款）。
     * 改动包名时这里必须同步，否则卡片会静默消失（槽位按 key 派发，不匹配就没人渲染）。
     */
    const BUNDLE_PACKAGE = '@dsh-external/dsh-teams';

    /**
     * 字段表：只描述「怎么展示」——分组、标签、提示、单位、控件种类。
     *
     * **不写默认值、不写 min/max**：那三样一律现取宿主随 describe 下发的 schema
     * （`node.type` / `node.meta.default` / `node.meta.min|max|step`）。在这里抄一份
     * 默认值就等于埋了第二份真相，index.js 的 Config 一改就静默漂移。
     *
     * `path` 必须与 index.js 的 Config 叶子逐字对应；test/settings-card.test.mjs 会核对。
     */
    const SETTINGS_GROUPS = [
      {
        id: 'state',
        title: 'set.group.state',
        fields: [
          {
            path: ['stateDir'],
            kind: 'text',
            mono: true,
            label: 'set.f.stateDir',
            hint: 'set.h.stateDir',
          },
        ],
      },
      {
        id: 'routing',
        title: 'set.group.routing',
        fields: [
          {
            path: ['routing', 'riskShortCircuit'],
            kind: 'boolean',
            label: 'set.f.riskShortCircuit',
            hint: 'set.h.riskShortCircuit',
          },
          { path: ['routing', 'fastMax'], kind: 'number', label: 'set.f.fastMax', hint: 'set.h.fastMax' },
          {
            path: ['routing', 'standardMax'],
            kind: 'number',
            label: 'set.f.standardMax',
            hint: 'set.h.standardMax',
          },
        ],
      },
      {
        id: 'scheduler',
        title: 'set.group.scheduler',
        fields: [
          {
            path: ['scheduler', 'maxParallel'],
            kind: 'number',
            label: 'set.f.maxParallel',
            hint: 'set.h.maxParallel',
          },
          { path: ['scheduler', 'maxRetries'], kind: 'number', label: 'set.f.maxRetries', hint: 'set.h.maxRetries' },
          {
            path: ['scheduler', 'maxReviewRounds'],
            kind: 'number',
            label: 'set.f.maxReviewRounds',
            hint: 'set.h.maxReviewRounds',
          },
        ],
      },
      {
        id: 'timeouts',
        title: 'set.group.timeouts',
        fields: [
          {
            path: ['timeouts', 'enabled'],
            kind: 'boolean',
            label: 'set.f.timeoutEnabled',
            hint: 'set.h.timeoutEnabled',
          },
          {
            path: ['timeouts', 'heavy'],
            kind: 'number',
            unit: 'set.unitSeconds',
            label: 'set.f.timeoutHeavy',
            hint: 'set.h.timeoutHeavy',
          },
          {
            path: ['timeouts', 'medium'],
            kind: 'number',
            unit: 'set.unitSeconds',
            label: 'set.f.timeoutMedium',
            hint: 'set.h.timeoutMedium',
          },
          {
            path: ['timeouts', 'light'],
            kind: 'number',
            unit: 'set.unitSeconds',
            label: 'set.f.timeoutLight',
            hint: 'set.h.timeoutLight',
          },
          {
            path: ['timeouts', 'infrastructure'],
            kind: 'number',
            unit: 'set.unitSeconds',
            label: 'set.f.timeoutInfrastructure',
            hint: 'set.h.timeoutInfrastructure',
          },
        ],
      },
      {
        id: 'watch',
        title: 'set.group.watch',
        fields: [
          { path: ['watch', 'probeMs'], kind: 'number', unit: 'set.unitMs', label: 'set.f.probeMs', hint: 'set.h.probeMs' },
          {
            path: ['watch', 'idleGraceMs'],
            kind: 'number',
            unit: 'set.unitMs',
            label: 'set.f.idleGraceMs',
            hint: 'set.h.idleGraceMs',
          },
          {
            path: ['watch', 'silenceLimitMs'],
            kind: 'number',
            unit: 'set.unitMs',
            label: 'set.f.silenceLimitMs',
            hint: 'set.h.silenceLimitMs',
          },
        ],
      },
      {
        id: 'gates',
        title: 'set.group.gates',
        fields: [
          {
            path: ['gates', 'requireEvidence'],
            kind: 'boolean',
            label: 'set.f.requireEvidence',
            hint: 'set.h.requireEvidence',
          },
          { path: ['gates', 'securityBlock'], kind: 'boolean', label: 'set.f.securityBlock', hint: 'set.h.securityBlock' },
        ],
      },
      {
        id: 'ui',
        title: 'set.group.ui',
        fields: [
          {
            path: ['ui', 'locale'],
            kind: 'select',
            label: 'set.f.locale',
            hint: 'set.h.locale',
            options: [
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ],
          },
        ],
      },
    ];

    /**
     * 设置卡片。
     *
     * 取值全部来自宿主：schema 给默认值与约束，form 快照给当前值 / 覆盖层 / 可写性。
     * 本地只判「宿主一定会拒」的形态（非整数、越界），**不发明比宿主更严的规则**；
     * 最终闸门是 `settingsSchema.validate()`——与宿主解码走同一条代码路径。
     *
     * @param props - 槽位给的 view/t，加上注入的 form / mirror / schema / t
     */
    function SettingsCard(props) {
      const { form, mirror, schema, t } = props;
      const [, setTick] = React.useState(0);
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [writeFailed, setWriteFailed] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState({});
      // 设置页两个页签：配置项（表单）/ 角色（管理）
      const [tab, setTab] = React.useState('config');
      const cardRef = React.useRef(null);

      React.useEffect(() => {
        const offForm = form.subscribe(() => setTick((value) => value + 1));
        const offMirror = mirror.subscribe(() => setTick((value) => value + 1));
        return () => {
          offForm();
          offMirror();
        };
      }, [form, mirror]);

      // 卡片头（插件列表里的摘要）只需要一句话，不挂表单
      if (props.view === 'summary') return t('set.summary');

      const snapshot = form.getSnapshot();
      const mirrored = mirror.getSnapshot();
      const namespaceView = mirrored?.view?.namespaces?.find((row) => row.ns === SETTINGS_NS);
      const writable = mirrored?.view?.writable === true;

      let root;
      try {
        root = namespaceView?.schema === undefined ? undefined : schema.rehydrate(namespaceView.schema);
      } catch {
        // schema 信封损坏：降级成「读不出设置」，不把整张卡片炸掉
        root = undefined;
      }

      const effective = snapshot.value ?? {};
      const user = snapshot.user ?? {};
      const nodeOf = (path) => (root === undefined ? undefined : schema.nodeAtPath(root, path));
      const keyOf = (path) => path.join('.');
      const draftOf = (path) => draft[keyOf(path)];

      /** 草稿 → 宿主 mutate 操作。空串与「恢复默认」都走 unset（语义就是回落默认/继承）。 */
      const opOf = (path, entry) => {
        if (entry === undefined) return undefined;
        if (entry.kind === 'unset') return { op: 'unset', path };
        if (typeof entry.value === 'boolean') return { op: 'set', path, value: entry.value };
        const text = String(entry.text ?? '').trim();
        if (text === '') return { op: 'unset', path };
        return { op: 'set', path, value: nodeOf(path)?.type === 'number' ? Number(text) : text };
      };

      /** 字段级错误。只覆盖「宿主一定会拒」的形态，措辞不发明新规则。 */
      const fieldError = (path, entry) => {
        if (entry === undefined || entry.kind === 'unset') return undefined;
        const node = nodeOf(path);
        if (node?.type !== 'number' || typeof entry.value === 'boolean') return undefined;
        const text = String(entry.text ?? '').trim();
        if (text === '') return undefined;
        const step = node.meta?.step;
        if (!/^\d+$/.test(text) || (typeof step === 'number' && step > 0 && Number(text) % step !== 0)) {
          return t('set.errorInteger');
        }
        const min = node.meta?.min;
        const max = node.meta?.max;
        if ((typeof min === 'number' && Number(text) < min) || (typeof max === 'number' && Number(text) > max)) {
          return t('set.errorRange')
            .replace('{min}', String(typeof min === 'number' ? min : 0))
            .replace('{max}', String(typeof max === 'number' ? max : '-'));
        }
        return undefined;
      };

      const fields = SETTINGS_GROUPS.flatMap((group) => group.fields);
      const ops = Object.entries(draft)
        .map(([key, entry]) => opOf(key.split('.'), entry))
        .filter((op) => op !== undefined);
      const dirty = ops.length > 0;
      const issues = fields.map((field) => fieldError(field.path, draftOf(field.path))).filter(Boolean);

      // 与宿主同一条校验路径：把草稿套进当前生效值，交给 settingsSchema 解码
      let failure;
      if (dirty && root !== undefined) {
        let candidate = effective;
        try {
          for (const op of ops) {
            candidate =
              op.op === 'set'
                ? schema.setPath(candidate, op.path, op.value)
                : schema.deletePath(candidate, op.path);
          }
          failure = schema.validate(root, candidate);
        } catch (cause) {
          failure = String(cause?.message ?? cause);
        }
      }

      const busy = saving;
      const controlsDisabled = !writable || busy;
      const canSave = dirty && issues.length === 0 && failure === undefined && !controlsDisabled;
      const overriddenCount = fields.filter((field) => schema.hasPath(user, field.path)).length;

      const setField = (path, entry) => {
        const next = { ...draft };
        if (entry === undefined) delete next[keyOf(path)];
        else next[keyOf(path)] = entry;
        setSaved(false);
        setWriteFailed(false);
        setDraft(next);
      };

      /** 输入即暂存；输入回当前生效值时撤回草稿，于是「无改动」是真的无改动。 */
      const editText = (path, text) => {
        const current = String(schema.getPath(effective, path) ?? '');
        setField(path, text === current ? undefined : { kind: 'set', text });
      };

      const editBoolean = (path, value) => {
        const current = Boolean(schema.getPath(effective, path));
        setField(path, value === current ? undefined : { kind: 'set', value });
      };

      const commit = async () => {
        if (!canSave) return;
        setSaving(true);
        setWriteFailed(false);
        setSaved(false);
        // ⚠️ 必须 try/catch/finally：`form.mutate` 会把宿主的拒绝**原样抛出**
        // （传输中断、宿主重启都会走到这里）。没有兜底的话异常会逃逸到渲染层——
        // 既没人接这个拒绝、也没有提示，而 `setSaving(false)` 根本不可达，
        // 卡片就永久停在「保存中…」且控件全部 disabled（真实缺陷，
        // 锁在 client.test.mjs 的「异常态」用例里）。
        try {
          // 带 revision 提交：并发改动会被宿主拒（而不是静默覆盖别人的编辑）
          const accepted = await form.mutate(ops, snapshot.revision);
          if (accepted) {
            setDraft({});
            setSaved(true);
            cardRef.current?.focus?.();
          } else {
            // 被拒时**保留**草稿：不该让用户为一次冲突重敲
            setWriteFailed(true);
          }
        } catch {
          // 异常同样回到「可恢复」状态，并保留草稿——用户可以直接再点保存
          setWriteFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        setDraft({});
        setSaved(false);
        setWriteFailed(false);
      };

      const rowOf = (field) => {
        const path = field.path;
        const id = `dsh-teams-set-${keyOf(path)}`;
        const hintId = `${id}-hint`;
        const errorId = `${id}-error`;
        const entry = draftOf(path);
        const error = fieldError(path, entry);
        const describedBy = error === undefined ? hintId : `${hintId} ${errorId}`;
        const overriddenField = schema.hasPath(user, path);
        const node = nodeOf(path);
        const placeholder = node?.meta?.default === undefined ? '' : String(node.meta.default);
        let control;

        if (field.kind === 'boolean') {
          control = h('input', {
            id,
            type: 'checkbox',
            className: 'dsh-teams-set-check',
            checked: typeof entry?.value === 'boolean' ? entry.value : Boolean(schema.getPath(effective, path)),
            disabled: controlsDisabled,
            'data-path': keyOf(path),
            'aria-describedby': describedBy,
            onChange: (event) => editBoolean(path, event.target.checked),
          });
        } else if (field.kind === 'select') {
          control = h(
            'select',
            {
              id,
              className: 'dsh-teams-set-input dsh-teams-set-select',
              value: String(entry?.text ?? schema.getPath(effective, path) ?? ''),
              disabled: controlsDisabled,
              'data-path': keyOf(path),
              'aria-describedby': describedBy,
              onChange: (event) => editText(path, event.target.value),
            },
            ...(field.options ?? []).map((option) =>
              h('option', { key: option.value, value: option.value }, option.label),
            ),
          );
        } else {
          const numeric = field.kind === 'number';
          control = h('input', {
            id,
            type: numeric ? 'number' : 'text',
            inputMode: numeric ? 'numeric' : undefined,
            className: `dsh-teams-set-input${field.mono === true ? ' dsh-teams-set-mono' : ''}`,
            value: String(entry?.text ?? schema.getPath(effective, path) ?? ''),
            placeholder,
            disabled: controlsDisabled,
            'data-path': keyOf(path),
            'aria-invalid': String(error !== undefined),
            'aria-describedby': describedBy,
            onChange: (event) => editText(path, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setField(path, undefined);
            },
          });
        }

        return h(
          'div',
          { className: 'dsh-teams-set-row', key: id },
          h(
            'div',
            { className: 'dsh-teams-set-main' },
            h('label', { className: 'dsh-teams-set-label', htmlFor: id }, t(field.label)),
            h('p', { className: 'dsh-teams-set-hint', id: hintId }, t(field.hint)),
            error === undefined ? null : h('p', { className: 'dsh-teams-set-error', id: errorId }, error),
          ),
          h(
            'div',
            { className: 'dsh-teams-set-side' },
            overriddenField ? h('span', { className: 'dsh-teams-chip dsh-teams-set-chip' }, t('set.overridden')) : null,
            control,
            field.unit === undefined ? null : h('span', { className: 'dsh-teams-set-unit' }, t(field.unit)),
            entry === undefined
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-teams-btn',
                    disabled: controlsDisabled,
                    onClick: () => setField(path, undefined),
                  },
                  t('set.undo'),
                ),
            overriddenField
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-teams-btn',
                    disabled: controlsDisabled,
                    onClick: () => setField(path, { kind: 'unset' }),
                  },
                  t('set.reset'),
                )
              : null,
          ),
        );
      };

      const body = [];
      if (snapshot.status !== 'ready' || namespaceView === undefined) {
        body.push(
          h(
            'p',
            { className: 'dsh-teams-set-note' },
            snapshot.status === 'unavailable' ? t('set.unavailable') : t('set.loading'),
          ),
        );
      } else {
        if (!writable) body.push(h('p', { className: 'dsh-teams-set-note' }, t('set.readOnly')));
        if (writeFailed) body.push(h('p', { className: 'dsh-teams-set-alert', role: 'alert' }, t('set.saveFailed')));
        if (issues.length > 0 || failure !== undefined) {
          body.push(
            h(
              'p',
              { className: 'dsh-teams-set-alert', role: 'alert' },
              `${t('set.invalid')}${failure === undefined ? '' : ` ${failure}`}`,
            ),
          );
        }
        for (const group of SETTINGS_GROUPS) {
          const open = collapsed[group.id] !== true;
          body.push(
            h(
              'fieldset',
              { className: 'dsh-teams-set-group', key: group.id },
              h(
                'legend',
                { className: 'dsh-teams-set-legend' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-teams-set-toggle',
                    'aria-expanded': String(open),
                    onClick: () => setCollapsed({ ...collapsed, [group.id]: open }),
                  },
                  t(group.title),
                ),
              ),
              open ? h('div', { className: 'dsh-teams-set-fields' }, ...group.fields.map(rowOf)) : null,
            ),
          );
        }
        body.push(
          h(
            'div',
            { className: 'dsh-teams-set-bar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-teams-set-primary',
                disabled: !canSave,
                onClick: commit,
              },
              saving ? t('set.saving') : t('set.save'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-teams-btn', disabled: !dirty || busy, onClick: discard },
              t('set.discard'),
            ),
            h(
              'span',
              { className: 'dsh-teams-set-note', role: 'status', 'data-tone': saved && !dirty ? 'done' : 'idle' },
              saved && !dirty ? t('set.saved') : '',
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'dsh-teams-set', ref: cardRef, tabIndex: -1 },
        h(
          'div',
          { className: 'dsh-teams-set-head' },
          h('span', { className: 'dsh-teams-set-label' }, t('set.title')),
          h(
            'div',
            { className: 'dsh-teams-set-tabs', role: 'tablist', 'aria-label': t('set.tabs') },
            h(
              'button',
              { type: 'button', role: 'tab', 'aria-selected': String(tab === 'config'), onClick: () => setTab('config') },
              t('set.tabConfig'),
            ),
            h(
              'button',
              { type: 'button', role: 'tab', 'aria-selected': String(tab === 'roles'), onClick: () => setTab('roles') },
              t('set.tabRoles'),
            ),
          ),
          // 角色页签下"已覆盖 N 项"说的是配置项，留着会误导——整个徽标不渲染
          tab === 'roles'
            ? null
            : h(
                'span',
                { className: 'dsh-teams-chip dsh-teams-set-chip' },
                t('set.covered').replace('{n}', String(overriddenCount)),
              ),
        ),
        ...(tab === 'roles' ? [h(RoleManager, { key: 'roles', t })] : body),
      );
    }

    /* -------------------------------------------------------------- *
     * 插件入口
     * -------------------------------------------------------------- */

    /**
     * 注入的客户端服务。
     *
     * `slots` 是硬依赖：没有它本插件什么也做不了，cordis 会等到它出现再激活。
     * 其余服务（locale / sidebarRightTabs / sidebarRight）一律走 `ctx.inject`
     * 惰性等待 —— 用 `ctx.get()` 直接取会在宿主启动顺序变化时静默拿到 undefined，
     * 功能无声消失且不报错，这正是最难排查的一类缺陷。
     */
    const inject = ['slots'];

    function apply(ctx) {
      // 资源登记全部收进一个 effect：卸载时统一释放，且任一登记抛错都能被定位
      ctx.effect(() => {
        const disposers = [];

        /** 登记一个可释放资源；失败只记录，不影响后续登记。 */
        const track = (label, dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose);
          else ctx.logger?.warn?.(`dsh-teams: ${label} 未返回释放函数`);
        };

        // ---- 1) 文案 ----
        let t = (key) => ZH[key] ?? key;
        const locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            track('locale', locale.register(NS, { zh: ZH, en: EN }));
            if (typeof locale.bind === 'function') t = locale.bind(NS);
          } catch (error) {
            ctx.logger?.warn?.(`dsh-teams: 文案注册失败，退回中文默认值：${error?.message ?? error}`);
          }
        }

        // ---- 2) 样式 ----
        const styleElement = document.createElement('style');
        styleElement.setAttribute('data-dsh-teams', '');
        styleElement.textContent = CSS;
        document.head.appendChild(styleElement);
        track('style', () => {
          if (styleElement.parentNode) styleElement.parentNode.removeChild(styleElement);
        });

        // ---- 3) 会话级状态读取器：会话 id 由槽位 props 提供 ----
        const sessionIdRef = { current: undefined };
        const store = createTeamStore(() => sessionIdRef.current);
        const rememberSession = (props) => {
          const id = props?.sessionId ?? props?.session?.id;
          if (typeof id === 'string' && id !== '') sessionIdRef.current = id;
        };

        // ---- 4) 右栏团队页：仅在宿主提供右栏标签机制时注册 ----
        //
        // 两处真实踩过的坑：
        //   a) `ctx.inject(deps, cb)` 的第一个参数**必须是数组**（或名字→配置映射）。
        //      传字符串会让 cordis 内部对它调 `Reflect.has`，抛
        //      `TypeError: Reflect.has called on non-object` → fiber 失败 →
        //      渲染进程判「启动失败」且拿不到错误文本（apply 没走完）。
        //   b) 回调收到的是 **scope**，服务挂在 scope 上（官方写法
        //      `scope.effect(() => scope.locale.register(...))`），不是服务本身。
        // `sidebarRight`（负责打开标签）只在点击时防御式取值，缺失静默降级。
        ctx.inject(['sidebarRightTabs'], (scope) => {
          track(
            'sidebarRightTabs',
            scope.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => t('tab.title'),
            }),
          );
          // keyed 槽位的派发键由宿主算：TabSlot 里是 `entryKey: definition?.id ?? tab.kind`
          // （见 @deepseek-ai/dsh-client-ui-sidebar-right）。于是有两条路径：
          //   · 标签类型注册成功 → 派发键是**类型 id**（TAB_ID）
          //   · 类型没注册上（或注册抛错） → 派发键退回 **kind**（TAB_KIND）
          // 两份都注册，两条路径才都能渲染出视图。只注册其中一份的表现是：
          // 标签页正常出现、标题正常，但正文只显示「这类内容还没有可用的查看方式。」
          for (const paneKey of [TAB_ID, TAB_KIND]) {
            track(
              `sidebar.right.pane.tab:${paneKey}`,
              ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register({ name: 'sidebar.right.pane.tab', key: paneKey, locale: NS }, (props) => {
                  rememberSession(props);
                  return h(TeamWorkspace, {
                    ...props,
                    store,
                    t,
                    // 角色是工作区级的：没团队时也要能管理，所以把会话 id 一并传下去
                    sessionId: String(props?.session?.id ?? props?.sessionId ?? ''),
                    onOpenSession: (sessionId) => openSessionVia(ctx, sessionId),
                  });
                }),
              ),
            );
          }
        });

        // ---- 5) 会话头部徽标：入口始终可用 ----
        track(
          'conversation.session.header.actions',
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'dsh-teams-entry',
                order: 40,
                locale: NS,
                label: () => t('badge.idle'),
              },
              (props) => {
                rememberSession(props);
                return h(TeamBadge, {
                  ...props,
                  store,
                  t,
                  onOpen: () => {
                    const sidebarRight = ctx.get('sidebarRight');
                    if (sidebarRight !== undefined && typeof sidebarRight.openTab === 'function') {
                      sidebarRight.openTab(TAB_KIND, {});
                    }
                  },
                });
              },
            ),
          ),
        );

        // ---- 6) 设置卡片：宿主同时提供 configForms 与 settingsSchema 时才挂载 ----
        //
        // 这两个服务都是**软依赖**：`inject` 数组里只有 `slots` 一个硬依赖，所以
        // 宿主没有设置服务时本插件照样激活，只是插件页里没有这张卡——绝不抛错。
        // 这里必须用 `ctx.inject(deps, scope => …)` 而不是 `ctx.get()`：后者在宿主
        // 启动顺序变化时会静默拿到 undefined，卡片无声消失且不报错。
        //
        // `configForms.get(id)` 返回的是宿主持有的**共享**表单（同一命名空间的所有
        // 消费者共用一份），因此这里不自己订阅 describe：卡片用 `form` 读写、用
        // `describe()` 的共享镜像拿 schema 信封与可写性、用 `settingsSchema` 走与
        // 宿主解码**同一条**校验路径。
        //
        // ⚠️ `inject()` 里**绝不能返回 `t`**：注册项声明了 `locale: NS`，宿主的
        // `factoryKit()` 已经把 `t` 放进 kit，而紧接着的 `assertNoPropOverlap()`
        // 对重复 prop 是**直接抛错**（SlotAssemblyError）——卡片会在渲染时崩掉。
        //
        // ⚠️ 槽位必须是 `plugins.bundle.config`，**不是** `plugins.item`：
        // 后者是「官方插件」组（"OCCUPIED by the official settings pages"），
        // 挤进去卡片不会出现在我们能到达的页面上（真实事故：注册 active 但用户看不见）。
        // 我们是 profile 里 `dsh.profile.bundles` 声明的 bundle，配置按 bundle 注册，
        // **key 就是 bundle 的包名**——与 dsh-context / dshmarket / codegraph 同款：
        //   plugins.bundle.config: "A bundle's own configuration, keyed by the bundle's package name
        //   and rendered on the bundle's page between its description and its rows."
        //
        // 但**真正让用户看到它的入口是设置窗口**：`settings.section` 才是「设置左栏一栏一页」。
        // 左栏里的插件市场 / 宠物 / 专家 / 浏览器 / 使用统计 全是插件往这个槽位注册出来的
        // （占用者名单里 @linxin666/dsh-usage、dsh-builtin-browser、dsh-market 都是外部插件）。
        // 所以两处都注册：设置窗口（主入口）+ bundle 详情页（配置区）。
        ctx.inject(['configForms', 'settingsSchema'], (scope) => {
          const form = scope.configForms.get(SETTINGS_NS);
          const mirror = scope.configForms.describe();
          const schema = scope.settingsSchema;
          const face = () => ({ form, mirror, schema });

          // ① 设置窗口里的一栏（用户实际会看到它的地方）
          const disposeSection = scope.configForms.whileServed([SETTINGS_NS], () =>
            scope.slots.inject('settings.section', () => {
              try {
                const unregister = scope.slots.register(
                  {
                    name: 'settings.section',
                    id: 'dsh-teams',
                    // 排在官方栏（最靠后 order 40）与浏览器（60）之后、桌面设置（100）之前
                    order: 65,
                    label: () => t('set.nav'),
                    locale: NS,
                    inject: face,
                  },
                  SettingsCard,
                );
                return () => unregister();
              } catch {
                /* 设置外壳缺失时不影响其余 UI */
                return () => {};
              }
            }),
          );
          track('settings.section:dsh-teams', disposeSection);

          // ② bundle 详情页里的配置区（插件页可达时的第二入口）
          const disposeBundle = scope.configForms.whileServed([SETTINGS_NS], () =>
            scope.slots.inject('plugins.bundle.config', () =>
              scope.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: BUNDLE_PACKAGE,
                  locale: NS,
                  inject: face,
                },
                SettingsCard,
              ),
            ),
          );
          track(`plugins.bundle.config:${BUNDLE_PACKAGE}`, disposeBundle);

          // ⚠️ 必须把释放函数**返回给 cordis**：只塞进外部数组的话，服务被重新提供时
          // 旧注册不会被释放，会累积出同 id/key 的重复卡片（真实缺陷，验证员静态复核发现）。
          return () => {
            if (typeof disposeSection === 'function') disposeSection();
            if (typeof disposeBundle === 'function') disposeBundle();
          };
        });

        // 角色矢量：全局拉一次并内联成 <g id>，所有卡片用 <use> 引用（实测见 .perf-bench.html）
        loadGirlArt();

        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose?.();
            } catch {
              /* 卸载期的清理失败不应阻断其余清理 */
            }
          }
        };
      }, 'dsh-teams: client resources');
    }

    return { apply, inject };
  },
});
