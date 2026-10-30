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
      'view.tasks': '任务板',
      'view.log': '运行日志',
      'view.empty': '当前会话还没有团队。用 teams_route 先做路径决策。',
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
      'flow.graphLabel': '依赖图：{n} 个任务',
      'flow.pin': '钉住并查看详情',
      'flow.unpin': '取消钉住',
      'flow.detail.title': '任务详情',
      'flow.detail.owner': '负责人',
      'flow.detail.unmet': '未满足前置',
      'flow.detail.unlocked': '下游解锁',
      'flow.detail.model': '模型',
      'flow.detail.unmetNone': '前置已满足',
      'flow.detail.unlockedNone': '暂无下游',
      'flow.detail.open': '打开会话',
      'flow.detail.failure': '失败原因',
      'flow.directDownstream': '直接下游',

      'watch.harvested': '回收',
      'watch.cancelled': '已取消',
      'watch.observed': '已观测',
      'phase.idle': '空闲',
      'phase.staged': '待审批',
      'phase.stagedApproved': '已批准 · 待启动',
      'phase.running': '运行中',
      'phase.halted': '已暂停',
      'phase.done': '已完成',
      'phase.failed': '失败',
      'phase.needing-decision': '需队长决策',
      'decision.title': '需队长决策',
      'decision.budget': '评审驳回预算已用尽（第 {round} 轮）',
      'decision.findings': '评审 findings',
      'decision.hint': '调整改动范围或实现方案后点「续跑」；续跑会重跑这一步。',
      'task.pending': '待派发',
      'task.ready': '就绪',
      'task.running': '进行中',
      'task.blocked': '受阻',
      'task.done': '已完成',
      'task.failed': '失败',
      'task.skipped': '已跳过',
      'log.empty': '暂无事件',
      'refresh': '刷新',

      // ---- 会话跳转、停止与批准（面板的两个写操作） ----
      'session.unavailable': '宿主没有提供打开会话的能力',
      'session.none': '还没有可打开的会话',
      'stop.button': '停止',
      'stop.confirmTitle': '停止这一轮？',
      'stop.unfinished': '未完成任务',
      'stop.busy': '忙碌成员',
      'stop.cancel': '取消',
      'stop.confirm': '确认停止',
      'stop.stopping': '停止中…',
      'stop.done': '已停止，正在收口…',
      'stop.alreadyEnded': '这一轮已经结束',
      'stop.failed': '停止失败，请重试',
      'stop.forbidden': '当前会话无权停止这一轮',
      'stop.noRoute': '宿主没有提供停止接口（插件版本过旧）',
      'stop.authUnavailable': '鉴权服务不可用，暂时无法停止',
      // ---- 批准并启动（面板第二个写操作） ----
      'approve.button': '批准并启动',
      'approve.start': '启动',
      'approve.startHint': '已批准，点这里启动调度',
      'approve.started': '已批准，正在启动…',
      'approve.approvedOnly': '已批准，未启动',
      'approve.failed': '批准失败，请重试',
      'approve.approvedStartFailed': '已批准，但启动失败，可再点一次重试',
      // 服务端把**原因本身**放在 reason 里（Agent 丢失 / 写盘失败 / 调度循环已在跑…）。
      // 只给固定文案时，用户就只剩「启动失败」四个字，无从判断该修什么（真机缺陷 A 的最后一环）。
      'approve.approvedStartFailedReason': '已批准，但启动失败：',
      'approve.failedReason': '批准失败：',
      'approve.retryHint': '（可再点一次重试）',
      // 点完到响应回来最长 15s：审批区已卸载，必须立刻给一条「进行中」，否则看到的是「点了没反应」。
      'approve.pending': '正在批准并启动…',
      'approve.forbidden': '当前会话无权批准这一轮',
      'approve.noRoute': '宿主没有提供批准接口（插件版本过旧）',
      'approve.authUnavailable': '鉴权服务不可用，暂时无法批准',
      // ---- 审批区（流程图下方整行）+「不批准，再商议」 ----
      'approve.groupLabel': '审批',
      'approve.disagree': '不批准，再商议',
      'approve.consultHint': '把要改的地方写清楚；提交后记为团队补充要求，之后每次派发都会带给子代理。',
      'approve.consultPlaceholder': '例如：按钮再大一点；这次不要动 lib/scheduler.js…',
      'approve.consultSubmit': '提交修改意见',
      'approve.consultCancel': '取消',
      'approve.consultEmpty': '请先写清要改什么',
      'approve.consultSaving': '提交中…',
      'approve.consultSaved': '已记录补充要求，之后每次派发都会带给子代理',
      'approve.consultFailed': '提交失败，请重试',
      'approve.consultTimeout': '提交超时，没收到宿主响应；请重试',
      'approve.consultForbidden': '当前会话无权记录补充要求',
      'approve.consultUnavailable': '宿主没有提供记录接口（插件版本过旧）',
      'approve.notesTitle': '已记录的补充要求',
      'approve.notesMore': '更早的还有 {n} 条，未显示',
      'approve.timeout': '请求超时，没收到宿主响应；请重试',

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
      'set.f.stallFloorMs': '停滞判死下限',
      'set.h.stallFloorMs': '真正的判死阈值：停滞窗口取「此值」与「已观测最长间隔 × 倍数」中的较大者。',
      'set.f.stallFactor': '停滞判死倍数',
      'set.h.stallFactor': '已观测最长进展间隔乘以该倍数，与下限取较大者作为判死窗口。',
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
      'view.tasks': 'Task board',
      'view.log': 'Run log',
      'view.empty': 'No team in this session yet. Run teams_route first to pick a path.',
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
      'flow.graphLabel': 'Dependency graph: {n} tasks',
      'flow.pin': 'Pin and show details',
      'flow.unpin': 'Unpin',
      'flow.detail.title': 'Task details',
      'flow.detail.owner': 'Owner',
      'flow.detail.unmet': 'Blocking deps',
      'flow.detail.unlocked': 'Unlocks',
      'flow.detail.model': 'Model',
      'flow.detail.unmetNone': 'All deps satisfied',
      'flow.detail.unlockedNone': 'Nothing yet',
      'flow.detail.open': 'Open session',
      'flow.detail.failure': 'Failure reason',
      'flow.directDownstream': 'Direct downstream',

      'watch.harvested': 'recovered',
      'watch.cancelled': 'cancelled',
      'watch.observed': 'observed',
      'phase.idle': 'Idle',
      'phase.staged': 'Awaiting approval',
      'phase.stagedApproved': 'Approved · waiting to start',
      'phase.running': 'Running',
      'phase.halted': 'Paused',
      'phase.done': 'Done',
      'phase.failed': 'Failed',
      'phase.needing-decision': 'Team lead decision needed',
      'decision.title': 'Team lead decision needed',
      'decision.budget': 'Review rework budget exhausted (round {round})',
      'decision.findings': 'Review findings',
      'decision.hint': 'Adjust the change scope or implementation, then hit Resume; resuming re-runs this step.',
      'task.pending': 'Pending',
      'task.ready': 'Ready',
      'task.running': 'Running',
      'task.blocked': 'Blocked',
      'task.done': 'Done',
      'task.failed': 'Failed',
      'task.skipped': 'Skipped',
      'log.empty': 'No events yet',
      'refresh': 'Refresh',

      // ---- session jump, stop and approval (the panel's two writes) ----
      'session.unavailable': 'This host does not expose session opening',
      'session.none': 'No session to open yet',
      'stop.button': 'Stop',
      'stop.confirmTitle': 'Stop this run?',
      'stop.unfinished': 'Unfinished tasks',
      'stop.busy': 'Busy members',
      'stop.cancel': 'Cancel',
      'stop.confirm': 'Stop run',
      'stop.stopping': 'Stopping…',
      'stop.done': 'Stopped, wrapping up…',
      'stop.alreadyEnded': 'This run has already ended',
      'stop.failed': 'Stop failed, please retry',
      'stop.forbidden': 'This session is not allowed to stop the run',
      'stop.noRoute': 'The host does not provide the stop endpoint (plugin too old)',
      'stop.authUnavailable': 'Authentication is unavailable, cannot stop right now',
      // ---- approve and start (the panel's second write) ----
      'approve.button': 'Approve & start',
      'approve.start': 'Start',
      'approve.startHint': 'Already approved — click to start the run',
      'approve.started': 'Approved, starting…',
      'approve.approvedOnly': 'Approved, not started',
      'approve.failed': 'Approval failed, please retry',
      'approve.approvedStartFailed': 'Approved, but starting failed — click again to retry',
      'approve.approvedStartFailedReason': 'Approved, but starting failed: ',
      'approve.failedReason': 'Approval failed: ',
      'approve.retryHint': ' (click again to retry)',
      'approve.pending': 'Approving and starting…',
      'approve.forbidden': 'This session is not allowed to approve the run',
      'approve.noRoute': 'The host does not provide the approve endpoint (plugin too old)',
      'approve.authUnavailable': 'Authentication is unavailable, cannot approve right now',
      // ---- approval zone below the flow diagram + "discuss further" ----
      'approve.groupLabel': 'Approval',
      'approve.disagree': 'Not approving — discuss further',
      'approve.consultHint': 'Write down what should change; it becomes a team note carried by every following dispatch.',
      'approve.consultPlaceholder': 'e.g. make the button bigger; do not touch lib/scheduler.js this time…',
      'approve.consultSubmit': 'Submit feedback',
      'approve.consultCancel': 'Cancel',
      'approve.consultEmpty': 'Describe what should change first',
      'approve.consultSaving': 'Submitting…',
      'approve.consultSaved': 'Recorded — every following dispatch will carry it',
      'approve.consultFailed': 'Submit failed, please retry',
      'approve.consultTimeout': 'Submit timed out without a host response; please retry',
      'approve.consultForbidden': 'This session is not allowed to record notes',
      'approve.consultUnavailable': 'The host does not provide the note endpoint (plugin too old)',
      'approve.notesTitle': 'Recorded requests',
      'approve.notesMore': '{n} earlier item(s) not shown',
      'approve.timeout': 'Request timed out without a host response; please retry',

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
      'set.f.stallFloorMs': 'Stall kill floor',
      'set.h.stallFloorMs': 'The real kill threshold: the window is the larger of this value and observed longest gap × factor.',
      'set.f.stallFactor': 'Stall kill factor',
      'set.h.stallFactor': 'Multiplier applied to the longest observed progress gap; the larger of that and the floor wins.',
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
/* 「需队长决策」不是错误态：用 warning 色，并给 findings 一个可扫读的缩进 */
.dsh-teams-decision{border-color:var(--dsw-alias-state-warn-primary);
  color:var(--dsw-alias-label-primary);}
.dsh-teams-decision-item{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary);}
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
  /* 外层不再垫色：浅色卡底落在折叠行上，行与行之间才看得出边界 */
  background:transparent;overflow:hidden;}
/* 折叠行：三列层级 —— 立绘 ｜（标题 + 元信息小字）｜ 状态与进度（靠右）。
   层级靠字号/字重/灰度：标题 13/500，元信息 11px 次级灰，数字等宽。
   折叠行自带独立卡底 + 圆角，与外层的 1px 描边共同勾出每一行的边界。
   卡底用 label-primary 4% 与透明混合，不直接复用容器 token：面板本身也是 layer-1，
   同色叠加看不出卡；这个着色落在任何底色上都能显出一档差，浅色/深色主题同理。 */
.dsh-teams-run-head{position:relative;display:grid;grid-template-columns:34px minmax(0,1fr) auto 12px;
  column-gap:10px;row-gap:2px;align-items:center;min-height:36px;padding:8px 10px 14px;
  cursor:pointer;list-style:none;font-size:13px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);border-radius:10px;}
/* 展开时只圆上角，并用底部细线把标题行与内容区分开 */
.dsh-teams-run[open] .dsh-teams-run-head{border-radius:10px 10px 0 0;
  box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l1);}
.dsh-teams-run-head::-webkit-details-marker{display:none;}
.dsh-teams-run-head:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}
.dsh-teams-run-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
/* 立绘牌：人物"站"在牌底，全身不裁头 */
.dsh-teams-run-avatar{grid-column:1;grid-row:1 / span 2;align-self:center;width:34px;height:38px;border-radius:11px;
  overflow:visible;display:flex;align-items:flex-end;justify-content:center;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-run-avatar .dsh-teams-whale{margin-bottom:-2px;}
.dsh-teams-run-subject{grid-column:2;grid-row:1;font-size:13px;font-weight:500;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dsh-teams-run-meta{grid-column:2;grid-row:2;display:flex;align-items:center;gap:6px;min-width:0;
  font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-run-meta > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-teams-run-meta > span + span::before{content:"·";margin-right:6px;opacity:.6;}
/* 第三列：状态胶囊在上、完成数在下，整体靠右；等宽数字避免刷新时抖动 */
.dsh-teams-run-stats{grid-column:3;grid-row:1 / span 2;display:flex;flex-direction:column;
  align-items:flex-end;gap:3px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dsh-teams-run-count{font-size:12px;font-weight:600;line-height:15px;color:var(--dsw-alias-label-primary);}
.dsh-teams-run-chevron{grid-row:1 / span 2;grid-column:4;justify-self:end;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);transition:transform .16s ease;}
.dsh-teams-run[open] .dsh-teams-run-chevron{transform:rotate(135deg);}
/* 分段进度贴折叠行底边：一段 = 一个任务（拓扑序），段数随任务数自动增减；
   绿=完成、黄=进行中/就绪、灰=未开始、红=失败。 */
.dsh-teams-run-bar{position:absolute;left:12px;right:12px;bottom:6px;height:4px;
  display:flex;gap:2px;border-radius:2px;}
.dsh-teams-run-seg{flex:1 1 0;min-width:2px;height:100%;border-radius:2px;
  background:var(--dsw-alias-border-l2);}
.dsh-teams-run-seg[data-status="done"]{background:var(--dsw-alias-state-success-primary);}
.dsh-teams-run-seg[data-status="running"]{background:var(--dsw-alias-state-warn-primary);}
.dsh-teams-run-seg[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}
.dsh-teams-run-seg[data-status="pending"]{background:var(--dsw-alias-border-l2);}
.dsh-teams-run-body{padding:0 10px 10px;}
.dsh-teams-run[data-phase="running"]{border-color:var(--dsw-alias-brand-primary);}
/* 标题行动作位：只剩「停止」（运行中）。批准并启动已移到流程图下方的整行审批区
   （用户实测：标题旁 11px 的小按钮又挤又不显眼，点完还只变灰不消失）。 */
.dsh-teams-run-head[data-has-action="true"]{grid-template-columns:34px minmax(0,1fr) auto auto 12px;}
.dsh-teams-run-head[data-has-action="true"] .dsh-teams-run-chevron{grid-column:5;}
.dsh-teams-run-head[data-has-action="true"] .dsh-teams-run-stop{grid-column:4;}
.dsh-teams-run-stop{grid-row:1 / span 2;grid-column:4;justify-self:end;font-size:11px;
  padding:2px 9px;white-space:nowrap;
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 65%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));}
.dsh-teams-run-stop:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
  color:var(--dsw-alias-label-primary);}
/* 审批区：流程图下方、占满整行。点「批准并启动」后整块**立即卸载**（乐观 UI），
   失败再挂回来并给原因——所以这里没有 disabled/busy 态，消失本身就是防重。 */
.dsh-teams-approval{margin-top:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);}
.dsh-teams-approval-actions{display:flex;flex-wrap:wrap;gap:8px;}
.dsh-teams-approval-primary,.dsh-teams-approval-secondary,.dsh-teams-consult-submit{flex:1 1 120px;min-height:36px;
  padding:0 14px;font-size:13px;border-radius:10px;white-space:nowrap;}
.dsh-teams-approval-primary{font-weight:600;border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dsh-teams-approval-primary:hover{filter:brightness(.94);background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);}
.dsh-teams-approval-secondary,.dsh-teams-consult-submit{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dsh-teams-approval-primary:focus-visible,.dsh-teams-approval-secondary:focus-visible{
  outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px;}
.dsh-teams-consult{margin-top:8px;display:flex;flex-direction:column;gap:6px;}
.dsh-teams-consult-hint{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-consult-input{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;
  font-family:inherit;font-size:12px;line-height:1.5;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);}
.dsh-teams-consult-actions{display:flex;flex-wrap:wrap;gap:8px;}
.dsh-teams-note-history{display:flex;flex-direction:column;gap:3px;}
.dsh-teams-note-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dsh-teams-note-list{margin:0;padding-left:16px;max-height:96px;overflow:auto;
  font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-note-list li{overflow-wrap:anywhere;}
.dsh-teams-note-more{font-size:11px;color:var(--dsw-alias-label-secondary);}
/* 停止确认条：非模态，warning 语义（删除才是 error） */
.dsh-teams-confirm[data-tone="warn"]{
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-2));}
.dsh-teams-confirm-title{font-weight:600;color:var(--dsw-alias-label-primary);}
.dsh-teams-confirm-count{font-size:11px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;}
.dsh-teams-stop-note{font-size:11px;padding:2px 0 4px;color:var(--dsw-alias-label-secondary);
  overflow-wrap:anywhere;}
.dsh-teams-stop-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}

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

/* 流程图：绝对定位节点画布 + 单层像素坐标 SVG 曲线（viewBox 与像素 1:1，箭头不变形） */
/* 流程图区不垫底色：只有折叠行带 layer-1 卡底，流程图直接坐在面板底色上（设计师实测指出） */
.dsh-teams-flow{position:relative;padding:8px 6px 16px;}
/* 只有画布横向滚动：详情在滚动容器之外，向右滚也不会把「负责人」滚出视野 */
.dsh-teams-flow-viewport{overflow-x:auto;overflow-y:hidden;}
.dsh-teams-flow-canvas{position:relative;flex:none;}
.dsh-teams-flow-node{position:absolute;z-index:1;}
.dsh-teams-flow-edges{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:visible;}
/* 边按下游状态着色：绿=两侧都完成、红=失败、黄=指向进行中、灰虚线=尚未到达 */
.dsh-teams-flow-edge{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1;opacity:.45;
  transition:opacity .15s ease,stroke .15s ease,stroke-width .15s ease;}
.dsh-teams-flow-edge[data-status="done"]{stroke:var(--dsw-alias-state-success-primary);
  stroke-width:1.5;opacity:.75;stroke-dasharray:none;}
.dsh-teams-flow-edge[data-status="failed"]{stroke:var(--dsw-alias-state-error-primary);
  stroke-width:1.5;opacity:.85;stroke-dasharray:none;}
.dsh-teams-flow-edge[data-status="running"]{stroke:var(--dsw-alias-state-warn-primary);
  stroke-width:1.5;opacity:.9;stroke-dasharray:none;}
.dsh-teams-flow-edge[data-status="pending"]{stroke:var(--dsw-alias-label-secondary);stroke-dasharray:5 4;}
/* 上下游链高亮只加粗/提亮，不覆盖状态色（否则"到哪一步"的信息就丢了） */
.dsh-teams-flow-edge[data-active="true"]{stroke-width:2;opacity:1;}
.dsh-teams-flow-edge[data-dim="true"]{opacity:.12;}
/* 连线流光：光带沿折线去程 → 停在卡边，绕卡一周后原路返回，3.2s 一个循环。
   相位与卡片环带共用（0–34% 去程、34–68% 绕卡、68–94% 回程）。 */
.dsh-teams-flow-edge-pulse{fill:none;stroke:var(--dsw-alias-state-warn-primary);stroke-width:2;
  stroke-linecap:round;stroke-dasharray:12 88;stroke-dashoffset:100;pointer-events:none;
  animation:dsh-teams-flow-travel 3.2s linear infinite;}
.dsh-teams-flow-edge-pulse[data-dim="true"]{opacity:.15;}
@keyframes dsh-teams-flow-travel{
  /* dashoffset 100 = 光带停在起点（上游卡右边）；12 = dash 长度，光带正好走到终点（目标卡左边）。
     34–66% 停在卡边，等环带绕完一周再原路返回，94% 回到起点，循环无跳变。 */
  0%{stroke-dashoffset:100;}
  34%{stroke-dashoffset:12;}
  66%{stroke-dashoffset:12;}
  94%,100%{stroke-dashoffset:100;}
}
@media (prefers-reduced-motion:reduce){
  /* 减少动效：流光静止——连线光带直接隐藏，环带画成完整的静态黄边 */
  .dsh-teams-flow-edge-pulse{display:none;}
  .dsh-teams-flow-ring-band{animation:none;stroke-dasharray:none;stroke-dashoffset:0;opacity:1;}
  .dsh-teams-skeleton > span::after,
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
/* 进行中 / 就绪：琥珀边框打底；环带只给「进行中」（就绪还没开始跑，不占环） */
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
/* 依赖图状态：钉住 / 上下游链 / 淡化。淡化只退舞台与边框，正文保持对比度。 */
.dsh-teams-flow-card[data-pinned="true"]{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;
  box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}
.dsh-teams-flow-card[data-chain="true"]:not([data-pinned="true"]){
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-border-l1));}
.dsh-teams-flow-card[data-dim="true"] .dsh-teams-flow-stage{opacity:.35;}
.dsh-teams-flow-card[data-dim="true"] .dsh-teams-flow-ring{display:none;}
/* 进行中：黄色流光沿卡片边框环绕一周（SVG 描边 + pathLength=100）。
   路径从左中起笔 → 上 → 右 → 下 → 回左中，与入边流光同一相位衔成一条连续路径。
   ⚠️ z-index 必须高于舞台（舞台有不透明底色）：旧实现把光层垫在下面，被舞台挡住大半，
   只剩信息区露出一块转动的黄块——这就是"黄色方块在卡片里旋转"的真正成因。 */
.dsh-teams-flow-ring{display:none;position:absolute;inset:0;width:100%;height:100%;z-index:2;
  overflow:visible;pointer-events:none;}
.dsh-teams-flow-card[data-status="running"] .dsh-teams-flow-ring{display:block;}
.dsh-teams-flow-ring-band{fill:none;stroke:var(--dsw-alias-state-warn-primary);stroke-width:2;
  stroke-linecap:round;stroke-dasharray:14 86;stroke-dashoffset:100;
  animation:dsh-teams-flow-ring 3.2s linear infinite;}
.dsh-teams-flow-card > .dsh-teams-flow-stage,
.dsh-teams-flow-card > .dsh-teams-flow-info{position:relative;z-index:1;}
@keyframes dsh-teams-flow-ring{
  0%,34%{stroke-dashoffset:100;opacity:0;}
  35%{stroke-dashoffset:99;opacity:1;}
  68%{stroke-dashoffset:0;opacity:1;}
  70%,100%{stroke-dashoffset:0;opacity:0;}
}
/* 依赖图详情：钉住后展开，2×2 四栏（负责人 / 未满足前置 / 下游解锁 / 模型） */
.dsh-teams-flow-detail{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2);padding:8px 10px;color:var(--dsw-alias-label-primary);}
.dsh-teams-flow-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dsh-teams-flow-detail-title{font-size:12px;font-weight:600;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.dsh-teams-flow-detail-status{display:inline-flex;flex:none;}
.dsh-teams-flow-detail-status .dsh-teams-flow-state{margin-top:0;}
.dsh-teams-flow-detail-open{margin-left:auto;}
.dsh-teams-flow-detail-close{flex:none;border:0;background:transparent;cursor:pointer;padding:2px 5px;
  border-radius:6px;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary);}
.dsh-teams-flow-detail-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);}
.dsh-teams-flow-detail-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dsh-teams-flow-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:8px;}
.dsh-teams-flow-detail-item{display:flex;flex-direction:column;gap:1px;min-width:0;}
.dsh-teams-flow-detail-label{font-size:10px;color:var(--dsw-alias-label-secondary);}
.dsh-teams-flow-detail-value{font-size:11.5px;line-height:1.35;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-teams-flow-detail-failure{margin-top:6px;padding:5px 8px;border-radius:6px;font-size:11px;
  line-height:1.35;white-space:pre-wrap;word-break:break-word;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 65%,var(--dsw-alias-label-primary));}
/* 详情里的状态色（卡片那套选择器只作用于 .dsh-teams-flow-card） */
.dsh-teams-flow-detail-status[data-status="done"]{--state-color:var(--dsw-alias-state-success-primary);}
.dsh-teams-flow-detail-status[data-status="failed"]{--state-color:var(--dsw-alias-state-error-primary);}
.dsh-teams-flow-detail-status[data-status="blocked"],
.dsh-teams-flow-detail-status[data-status="running"]{--state-color:var(--dsw-alias-state-warn-primary);}
.dsh-teams-flow-detail-status[data-status="ready"]{--state-color:var(--dsw-alias-brand-primary);}
.dsh-teams-flow-detail-status[data-status="pending"],
.dsh-teams-flow-detail-status[data-status="skipped"]{--state-color:var(--dsw-alias-border-l2);}
.dsh-teams-flow-detail-status .dsh-teams-flow-state{
  --state-text:color-mix(in srgb,var(--state-color) 55%,var(--dsw-alias-label-primary));}
/* 鲸鱼图标 + 装扮挂件 */
.dsh-teams-whale{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;}
.dsh-teams-whale-accessory{position:absolute;right:-3px;top:-3px;font-size:11px;line-height:1;}
/* ============ 子会话横幅 ============ */
/* 行尾「去会话」提示（任务标题行共用；成员卡已移除，这里只剩任务行） */
.dsh-teams-open{flex:none;color:var(--dsw-alias-label-secondary);font-size:16px;opacity:.45;}
.dsh-teams-task-head[data-clickable="true"]:hover .dsh-teams-open{opacity:1;color:var(--dsw-alias-brand-primary);}
/* 能力缺失时禁用而不是假装可点：cursor + 降透明，点击由「没有 onClick」兜底 */
.dsh-teams-task-head[data-disabled="true"]{cursor:not-allowed;}
.dsh-teams-task-head[data-clickable="true"]{cursor:pointer;border-radius:6px;}
.dsh-teams-task-head[data-clickable="true"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px;}
.dsh-teams-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 8px;
  padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;}
.dsh-teams-banner .dsh-teams-btn{margin-left:auto;}
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
     * 取宿主 `uiWorkspace` 服务（软依赖）。
     *
     * `ctx.get()` 本身在宿主启动顺序变化时可能拿到 undefined，个别实现还会抛错；
     * 这里统一兜住——面板永远可用，只是"打开会话"降级为不可点。
     */
    function uiWorkspaceOf(ctx) {
      try {
        return ctx.get('uiWorkspace');
      } catch {
        return undefined;
      }
    }

    /** 宿主是否提供「打开会话」能力（渲染期能力探测用）。 */
    function canOpenSessionVia(ctx) {
      const uiWorkspace = uiWorkspaceOf(ctx);
      return uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function';
    }

    /**
     * 打开某个会话：成员卡片 → 它的子会话；子会话横幅 → 队长会话。
     *
     * 走宿主的 `uiWorkspace.openSession(target)`（`SessionTarget = SessionId | SubagentAddress`）。
     * 软依赖：宿主没提供该服务时静默返回 false，面板照常可用（只是卡片不可点）。
     */
    function openSessionVia(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const uiWorkspace = uiWorkspaceOf(ctx);
      if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') return false;
      try {
        uiWorkspace.openSession(sessionId);
        return true;
      } catch {
        return false;
      }
    }

    /** 写请求超时：fetch 悬挂时必须自己收口，否则乐观卸载的审批区永远不回来（评审 #4）。 */
    const WRITE_TIMEOUT_MS = 15_000;

    /**
     * POST 一条 JSON 写请求，并带超时收口。
     *
     * 超时用 AbortController 打断 fetch，返回 `{ response }` 或 `{ timedOut }`，
     * 不向上抛：调用方要靠 timedOut 区分「超时」与「网络错误」，给出不同文案。
     */
    async function postJsonWithTimeout(url, payload, timeoutMs = WRITE_TIMEOUT_MS) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      let timedOut = false;
      const timer =
        controller === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
          ...(controller === undefined ? {} : { signal: controller.signal }),
        });
        return { response };
      } catch {
        return { timedOut };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /**
     * 面板的写操作之一：停止当前团队。
     *
     * 只 POST 到 `/plugins/dsh-teams/stop`，鉴权与状态根定位都在宿主路由里做；
     * 取消确认框不会调用它，所以取消不改变任何状态。任何失败都折成结果对象，
     * **绝不上抛**——面板不能因为一次停止请求而崩掉。
     *
     * @returns {Promise<{ok:boolean, stopped?:boolean, retryable?:boolean, status?:number}>}
     */
    async function requestTeamStop(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, retryable: false, status: 400 };
      }
      try {
        const response = await fetch('/plugins/dsh-teams/stop', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId }),
          cache: 'no-store',
        });
        if (response.ok !== true) {
          // 鉴权/装配失败重试也没用；只有 5xx（503 除外）与网络错误值得再点一次
          const retryable = response.status >= 500 && response.status !== 503;
          return { ok: false, retryable, status: response.status };
        }
        const body = await response.json();
        return { ok: true, stopped: body?.stopped === true };
      } catch {
        return { ok: false, retryable: true, status: 0 };
      }
    }

    /**
     * 面板的第二个写操作：批准并启动当前团队。
     *
     * 只 POST 到 `/plugins/dsh-teams/approve-start`，鉴权与状态根定位都在宿主路由里做。
     * 任何失败都折成结果对象，**绝不上抛**——面板不能因为一次批准请求而崩掉。
     * 返回体区分「批准了」与「启动了」：`approved=true` 但 `started=false` 是真实的
     * 部分成功（宿主没提供启动能力 / 循环已在跑），界面必须如实显示，不能假装成功。
     *
     * @returns {Promise<{ok:boolean, approved?:boolean, started?:boolean, reason?:string, retryable?:boolean, status?:number}>}
     */
    async function requestTeamApproveStart(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, retryable: false, status: 400 };
      }
      const { response, timedOut } = await postJsonWithTimeout('/plugins/dsh-teams/approve-start', {
        session: sessionId,
      });
      if (response === undefined) {
        // 超时同样是可重试失败：审批区必须挂回来并说明是超时，不能永久消失
        return { ok: false, retryable: true, status: 0, timeout: timedOut === true };
      }
      try {
        if (response.ok !== true) {
          const retryable = response.status >= 500 && response.status !== 503;
          // 服务端的 500 可能带着「批准已落盘、只是启动失败」的磁盘真相
          // （见 web-routes 里 approve-start 的 catch）。以前这里直接丢掉响应体，
          // 前端只能显示「批准失败，请重试」——与磁盘事实矛盾，用户会重复批准。
          let approvedOnDisk = false;
          let reason;
          try {
            const body = await response.json();
            approvedOnDisk = body?.approved === true;
            reason = typeof body?.reason === 'string' ? body.reason : undefined;
          } catch {
            /* 响应体不是 JSON 就按"未知"处理，不冒充任何结论 */
          }
          return { ok: false, retryable, status: response.status, approved: approvedOnDisk, reason };
        }
        const body = await response.json();
        return {
          ok: true,
          approved: body?.approved === true,
          started: body?.started === true,
          reason: typeof body?.reason === 'string' ? body.reason : undefined,
        };
      } catch {
        return { ok: false, retryable: true, status: 0 };
      }
    }

    /** 批准失败的文案：与停止同款分档（鉴权/路由缺失不值得重试）。 */
    function approveFailureText(t, result) {
      // 超时与普通网络错误分开说：用户等过，得知道"没收到响应"而不是"被拒绝"
      if (result?.timeout === true) return t('approve.timeout');
      const status = result?.status;
      if (status === 401 || status === 403) return t('approve.forbidden');
      if (status === 404) return t('approve.noRoute');
      if (status === 503) return t('approve.authUnavailable');
      // 服务端把**真实原因**放在 reason 里（批准已落盘时即启动失败的原因）。丢掉它，
      // 用户就只能看见「启动失败」，无从判断是 Agent 丢失、写盘失败还是循环已在跑。
      const reason = typeof result?.reason === 'string' ? result.reason.trim() : '';
      // 批准已落盘、只是启动失败：说「已批准，启动失败」，别说成「批准失败」——
      // 那与磁盘事实矛盾，用户会以为没批过而重复点。
      if (result?.approved === true) {
        return reason === ''
          ? t('approve.approvedStartFailed')
          : `${t('approve.approvedStartFailedReason')}${reason}${t('approve.retryHint')}`;
      }
      return reason === '' ? t('approve.failed') : `${t('approve.failedReason')}${reason}`;
    }

    /**
     * 记录一条「用户中途补充的要求」（「不批准，再商议」里提交的修改意见）。
     *
     * 只写团队记录（`team.notes`）：不批准、不启动、不碰闸门与在跑的任务；
     * 下一次派发时由 `buildTaskPrompt` 带进任务卡。失败同样折成结果对象，绝不上抛。
     *
     * @returns {Promise<{ok:boolean, count?:number, reason?:string, retryable?:boolean, status?:number}>}
     */
    async function requestTeamNote(sessionId, text) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, retryable: false, status: 400 };
      }
      const { response, timedOut } = await postJsonWithTimeout('/plugins/dsh-teams/note', {
        session: sessionId,
        text,
      });
      if (response === undefined) {
        return { ok: false, retryable: true, status: 0, timeout: timedOut === true };
      }
      try {
        if (response.ok !== true) {
          const retryable = response.status >= 500 && response.status !== 503;
          return { ok: false, retryable, status: response.status };
        }
        const body = await response.json();
        return {
          ok: body?.ok === true,
          count: Number.isFinite(body?.count) ? body.count : undefined,
          reason: typeof body?.reason === 'string' ? body.reason : undefined,
        };
      } catch {
        return { ok: false, retryable: true, status: 0 };
      }
    }

    /** 记录补充要求失败的文案（与批准同款分档）。 */
    function noteFailureText(t, result) {
      if (result?.timeout === true) return t('approve.consultTimeout');
      const status = result?.status;
      if (status === 401 || status === 403) return t('approve.consultForbidden');
      if (status === 404) return t('approve.consultUnavailable');
      if (status === 503) return t('approve.authUnavailable');
      return t('approve.consultFailed');
    }

    /** 停止失败的文案：鉴权/路由缺失是不可重试的灰字，其余按错误色提示。 */
    function stopFailureText(t, result) {
      const status = result?.status;
      if (status === 401 || status === 403) return t('stop.forbidden');
      if (status === 404) return t('stop.noRoute');
      if (status === 503) return t('stop.authUnavailable');
      return t('stop.failed');
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

    /* ---------------- 依赖图布局（纯函数：像素坐标 = 列号 × 行号，不测量 DOM） ---------------- */
    const FLOW_CARD_W = 116; // 与 .dsh-teams-flow-card 的固定尺寸一致
    const FLOW_CARD_H = 180;
    const FLOW_GAP_X = 56; // 列间直角折线通道（竖线走在这里，不压卡片）
    // 环带路径（viewBox 同卡片 116×180）：左中起笔 → 上 → 右 → 下 → 回左中，
    // 与入边流光的落点（左中）重合，两段动画因此能接成一条连续路径。
    const FLOW_RING_PATH =
      'M1 90 L1 16 A15 15 0 0 1 16 1 L100 1 A15 15 0 0 1 115 16 L115 164 A15 15 0 0 1 100 179 L16 179 A15 15 0 0 1 1 164 Z';
    const FLOW_GAP_Y = 10; // 同层行距

    /** 依赖 → 层级（列号）；同层按前驱平均行号 → deps → id 稳定排序。环按 0 层。 */
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
      // 环可能让最浅的节点不在 0 层（例如 x↔y 得到 1/2）：整体平移，避免空列
      const knownDepth = steps.map((step) => depth.get(step.id) ?? 0);
      const baseDepth = knownDepth.length === 0 ? 0 : Math.min(...knownDepth);
      const raw = [];
      for (const step of steps) {
        const level = (depth.get(step.id) ?? 0) - baseDepth;
        if (raw[level] === undefined) raw[level] = [];
        raw[level].push(step);
      }
      const layers = [];
      const rowOf = new Map();
      // 极端环可能让层号出现空洞：只保留有节点的层，列号因此始终连续
      for (const layer of raw.filter((item) => Array.isArray(item) && item.length > 0)) {
        // barycenter：父节点在上一层排第几，决定本节点排第几，跨层边才不交叉
        const ranked = layer.map((step) => {
          const parents = (step.deps ?? [])
            .map((id) => rowOf.get(id))
            .filter((row) => row !== undefined);
          return {
            step,
            bary: parents.length === 0 ? -1 : parents.reduce((sum, row) => sum + row, 0) / parents.length,
            deps: [...new Set(step.deps ?? [])].map(String).sort().join(','),
            id: String(step.id),
          };
        });
        ranked.sort((a, b) => a.bary - b.bary || a.deps.localeCompare(b.deps) || a.id.localeCompare(b.id));
        const ordered = ranked.map((item) => item.step);
        ordered.forEach((step, row) => rowOf.set(step.id, row));
        layers.push(ordered);
      }
      return layers;
    }

    /** 分层结果 → 每个节点的像素坐标 + 画布尺寸 + 每个节点的直接下游数。 */
    function flowNodes(steps) {
      const layers = layersOf(steps);
      const nodeById = new Map();
      const childCount = new Map();
      let rows = 0;
      layers.forEach((layer, col) => {
        rows = Math.max(rows, layer.length);
        layer.forEach((step, row) => {
          nodeById.set(step.id, {
            step,
            id: step.id,
            col,
            row,
            x: col * (FLOW_CARD_W + FLOW_GAP_X),
            y: row * (FLOW_CARD_H + FLOW_GAP_Y),
            w: FLOW_CARD_W,
            h: FLOW_CARD_H,
          });
        });
      });
      for (const step of steps) {
        for (const depId of new Set(step.deps ?? [])) {
          if (depId === step.id || !nodeById.has(depId)) continue;
          childCount.set(depId, (childCount.get(depId) ?? 0) + 1);
        }
      }
      const count = layers.length;
      return {
        layers,
        nodeById,
        childCount,
        width: count === 0 ? 0 : count * FLOW_CARD_W + (count - 1) * FLOW_GAP_X,
        height: rows === 0 ? 0 : rows * FLOW_CARD_H + (rows - 1) * FLOW_GAP_Y,
      };
    }

    /** 依赖边：去重、忽略未知/自依赖/同层及反向边（环）——曲线穿过卡片比不画更糟。 */
    function flowEdges(steps, nodeById) {
      const edges = [];
      const seen = new Set();
      for (const step of steps) {
        for (const depId of step.deps ?? []) {
          const from = nodeById.get(depId);
          const to = nodeById.get(step.id);
          if (from === undefined || to === undefined || from.id === to.id) continue;
          if (to.col <= from.col) continue;
          const key = `${String(depId)}->${String(step.id)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ key, from, to });
        }
      }
      return edges;
    }

    /** 直角折线（正交路径）：右中点 → 竖走 → 左中点。
     *  只含 M/L/A，拐角 2px 圆角（不用贝塞尔）；`offset` 让同一列对的并行分支各占一条通道。 */
    function flowEdgePath(from, to, offset = 0) {
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x - 2; // 箭头尖贴住卡片左边，不盖住边框
      const y2 = to.y + to.h / 2;
      if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`; // 同排：一条水平直线
      const midX = Math.round(x1 + (x2 - x1) / 2 + offset);
      const dir = y2 > y1 ? 1 : -1;
      const r = Math.min(2, Math.abs(y2 - y1) / 2);
      const sweep1 = dir > 0 ? 1 : 0; // 东→南 / 东→北
      const sweep2 = dir > 0 ? 0 : 1; // 南→东 / 北→东
      return `M${x1} ${y1} L${midX - r} ${y1} A${r} ${r} 0 0 ${sweep1} ${midX} ${y1 + dir * r} L${midX} ${
        y2 - dir * r
      } A${r} ${r} 0 0 ${sweep2} ${midX + r} ${y2} L${x2} ${y2}`;
    }

    /** 边状态 = 光带流向的节点状态；上游已失败时整条边判红（下游永远到不了）。 */
    function flowEdgeStatus(edge) {
      const fromStatus = String(edge.from.step?.status ?? 'pending');
      const toStatus = String(edge.to.step?.status ?? 'pending');
      if (fromStatus === 'failed' || toStatus === 'failed') return 'failed';
      if (toStatus === 'done' || toStatus === 'skipped') return 'done';
      if (toStatus === 'running' || toStatus === 'ready') return 'running';
      return 'pending';
    }

    /** 同一列对的并行边各给一条通道（±3px 起，6px 一档），竖线不重叠、不压卡片。 */
    function flowEdgeChannels(edges) {
      const groups = new Map();
      for (const edge of edges) {
        const key = `${edge.from.col}->${edge.to.col}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(edge);
      }
      const channels = new Map();
      for (const group of groups.values()) {
        group.forEach((edge, index) => {
          channels.set(edge.key, Math.round((index - (group.length - 1) / 2) * 6));
        });
      }
      return channels;
    }

    
        /** 完整上下游链：上溯到根、下溯到叶（含自身）；环安全。 */
    function flowChain(steps, id) {
      const chain = new Set();
      if (!steps.some((step) => step.id === id)) return chain;
      const byId = new Map(steps.map((step) => [step.id, step]));
      const children = new Map();
      for (const step of steps) {
        for (const depId of step.deps ?? []) {
          if (!children.has(depId)) children.set(depId, []);
          children.get(depId).push(step.id);
        }
      }
      // 上溯只看 deps，下溯只看 children：不能从祖先再走到它的其它子节点
      for (const walk of ['up', 'down']) {
        const queue = [id];
        while (queue.length > 0) {
          const current = queue.shift();
          chain.add(current);
          const nexts = walk === 'up' ? (byId.get(current)?.deps ?? []) : (children.get(current) ?? []);
          for (const next of nexts) {
            if (chain.has(next)) continue;
            chain.add(next);
            queue.push(next);
          }
        }
      }
      return chain;
    }

    const isSettledStep = (step) => step !== undefined && (step.status === 'done' || step.status === 'skipped');
    const stepLabel = (step) => step.roleName ?? step.role ?? String(step.id);

    /**
     * 进度线段：一段一个任务，顺序 = 拓扑层序（上游在前）再按层内行序。
     * 段数直接由 steps 长度决定：中途插入任务，段数自动增减。
     */
    function runSegments(steps) {
      return layersOf(steps)
        .flat()
        .map((step) => ({ id: step.id, label: stepLabel(step), status: String(step.status ?? 'pending') }));
    }

    /** 任务状态 → 线段色调：绿=完成、黄=进行中/就绪、红=失败、灰=未开始（受阻算未开始）。 */
    function segmentTone(status) {
      if (status === 'done' || status === 'skipped') return 'done';
      if (status === 'failed') return 'failed';
      if (status === 'running' || status === 'ready') return 'running';
      return 'pending';
    }

    /**
     * 钉住后的详情：负责人 / 未满足前置（done、skipped 之外都算）/ 下游解锁 / 模型。
     * 快照当前没有 model 字段，缺省显示「—」，不臆造。
     */
    function flowDetail(steps, id) {
      const step = steps.find((item) => item.id === id);
      if (step === undefined) return undefined;
      const byId = new Map(steps.map((item) => [item.id, item]));
      const deps = Array.isArray(step.deps) ? [...new Set(step.deps)] : [];
      const unmet = [];
      for (const depId of deps) {
        const dep = byId.get(depId);
        if (dep === undefined) unmet.push(String(depId)); // 悬空依赖不可能完成，如实算未满足
        else if (!isSettledStep(dep)) unmet.push(stepLabel(dep));
      }
      const unlocked = [];
      for (const other of steps) {
        const otherDeps = Array.isArray(other.deps) ? [...new Set(other.deps)] : [];
        if (!otherDeps.includes(id)) continue;
        const blocked = otherDeps.some((depId) => depId !== id && !isSettledStep(byId.get(depId)));
        if (!blocked) unlocked.push(stepLabel(other));
      }
      return {
        step,
        owner: step.roleName ?? step.role ?? '—',
        unmet: [...new Set(unmet)],
        unlocked: [...new Set(unlocked)],
        model: typeof step.model === 'string' && step.model !== '' ? step.model : '—',
        failure: typeof step.failure === 'string' && step.failure !== '' ? step.failure : undefined,
        // 待队长决策（返工预算耗尽）：详情里直接列出 findings，不要求用户再进会话找结论
        needsDecision: step.needsDecision,
        findings: Array.isArray(step.findings) ? step.findings : [],
      };
    }

    /** 方向键导航：左右跨层，上下同层；焦点顺序与视觉的列→行一致。 */
    function flowNavigate(layers, id, key) {
      for (let col = 0; col < layers.length; col += 1) {
        if (!Array.isArray(layers[col]) || layers[col].length === 0) continue;
        const row = layers[col].findIndex((step) => step.id === id);
        if (row < 0) continue;
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          const next = Math.max(0, Math.min(layers[col].length - 1, row + (key === 'ArrowUp' ? -1 : 1)));
          return layers[col][next]?.id ?? id;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          const nextCol = Math.max(0, Math.min(layers.length - 1, col + (key === 'ArrowLeft' ? -1 : 1)));
          const layer = layers[nextCol];
          return layer[Math.min(row, layer.length - 1)]?.id ?? id;
        }
        return undefined;
      }
      return undefined;
    }

    /** 边层：单层 SVG，画在节点之下；标记 id 带 runId 前缀，避免多轮/多队冲突。
     *  每条边按目标状态着色（绿/红/黄/灰虚线），指向进行中的边再叠一条流光带。 */
    function FlowEdges({ edges, layout, chain, markerId }) {
      const arrow = (fill) =>
        h('path', { d: 'M0 0 L6 3 L0 6 Z', style: { fill } });
      const markerOf = (status) => `${markerId}-${status}`;
      const arrowFills = {
        done: 'var(--dsw-alias-state-success-primary)',
        failed: 'var(--dsw-alias-state-error-primary)',
        running: 'var(--dsw-alias-state-warn-primary)',
        pending: 'var(--dsw-alias-label-secondary)',
      };
      const channels = flowEdgeChannels(edges);
      const edgeOf = (edge) => ({
        active: chain !== undefined && chain.has(edge.from.id) && chain.has(edge.to.id),
        dimmed: chain !== undefined && !(chain.has(edge.from.id) && chain.has(edge.to.id)),
        status: flowEdgeStatus(edge),
        d: flowEdgePath(edge.from, edge.to, channels.get(edge.key) ?? 0),
      });
      return h(
        'svg',
        {
          className: 'dsh-teams-flow-edges',
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          width: layout.width,
          height: layout.height,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'defs',
          null,
          ...Object.entries(arrowFills).map(([status, fill]) =>
            h(
              'marker',
              {
                key: status,
                id: markerOf(status),
                viewBox: '0 0 6 6',
                refX: 5,
                refY: 3,
                markerWidth: 6,
                markerHeight: 6,
                orient: 'auto',
              },
              arrow(fill),
            ),
          ),
        ),
        ...edges.map((edge) => {
          const info = edgeOf(edge);
          return h('path', {
            key: edge.key,
            className: 'dsh-teams-flow-edge',
            d: info.d,
            'data-status': info.status,
            'data-active': info.active ? 'true' : undefined,
            'data-dim': info.dimmed ? 'true' : undefined,
            markerEnd: `url(#${markerOf(info.status)})`,
          });
        }),
        // 流光只画在"指向进行中任务的边"上：同一相位与卡片环带衔接（见 CSS keyframes）
        ...edges
          .filter((edge) => flowEdgeStatus(edge) === 'running')
          .map((edge) => {
            const info = edgeOf(edge);
            return h('path', {
              key: `${edge.key}-pulse`,
              className: 'dsh-teams-flow-edge-pulse',
              d: info.d,
              pathLength: '100',
              'aria-hidden': 'true',
              'data-dim': info.dimmed ? 'true' : undefined,
            });
          }),
      );
    }

    /**
     * 一张身份牌（UI 设计师规范）：上半立绘舞台 + 下半信息区。
     *
     * 信息层级：角色名（2 行 clamp）→ 用量（label/value 右对齐 + tabular-nums）→ 状态胶囊。
     * 状态不单靠颜色（有文字），并带 aria-label。点击 = 钉住（会话入口在详情里）。
     */
    function FlowCard({
      step,
      t,
      detailId,
      pinned,
      highlighted,
      dimmed,
      tabIndex,
      childCount,
      depsText,
      onPin,
      onHover,
      onFocusNode,
      onBlurNode,
      onNavigate,
    }) {
      const look = lookOf(step.role);
      const status = String(step.status ?? 'pending');
      const metrics = step.metrics ?? {};
      const tokens =
        metrics.inputTokens === undefined && metrics.outputTokens === undefined
          ? undefined
          : (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
      const usage = [
        [t('flow.steps'), metrics.steps === undefined ? undefined : String(metrics.steps)],
        [t('flow.tokens'), tokens === undefined ? undefined : formatTokens(tokens)],
        [t('flow.cache'), metrics.cacheReadTokens === undefined ? undefined : formatTokens(metrics.cacheReadTokens)],
      ].filter((pair) => pair[1] !== undefined);
      const roleName = step.roleName ?? step.role ?? '—';
      const statusLabel = t(`task.${status}`);
      const described = usage.map(([label, value]) => `${label} ${value}`).join('，');
      const parents = Array.isArray(step.deps) ? [...new Set(step.deps)].length : 0;
      const parentsText = parents === 0 ? t('task.noDeps') : `${t('task.deps')} ${parents}`;
      return h(
        'div',
        {
          className: 'dsh-teams-flow-card',
          'data-status': status,
          // 卡片永远可点：点击 = 钉住（会话入口在详情面板里）
          'data-clickable': 'true',
          'data-pinned': pinned ? 'true' : undefined,
          'data-chain': highlighted ? 'true' : undefined,
          'data-dim': dimmed ? 'true' : undefined,
          'data-step-id': String(step.id),
          role: 'button',
          tabIndex,
          'aria-pressed': pinned ? 'true' : 'false',
          'aria-controls': pinned ? detailId : undefined,
          'aria-label': `${roleName}，${statusLabel}，${depsText ?? parentsText}${
            childCount === undefined ? '' : `，${t('flow.directDownstream')} ${childCount}`
          }${described === '' ? '' : `，${described}`}`,
          title: pinned ? t('flow.unpin') : t('flow.pin'),
          style: { '--role-accent': look.accent },
          onClick: () => onPin(step.id),
          onMouseEnter: () => onHover(step.id),
          onMouseLeave: () => onHover(undefined),
          onFocus: () => onFocusNode(step.id),
          onBlur: () => onBlurNode(step.id),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onPin(step.id);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onNavigate(step.id, 'Escape');
              return;
            }
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              onNavigate(step.id, event.key);
            }
          },
        },
        // 流光环带：只有"进行中"才显示（SVG 描边绕卡片一周，不是旋转的锥形渐变方块）
        h(
          'svg',
          {
            className: 'dsh-teams-flow-ring',
            viewBox: '0 0 116 180',
            preserveAspectRatio: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            className: 'dsh-teams-flow-ring-band',
            d: FLOW_RING_PATH,
            pathLength: '100',
            vectorEffect: 'non-scaling-stroke',
          }),
        ),
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
          depsText === undefined
            ? null
            : h('span', { className: 'dsh-teams-flow-deps', title: depsText }, depsText),
        ),
      );
    }

    /** 钉住后的详情面板：负责人 / 未满足前置 / 下游解锁 / 模型 + 会话入口。 */
    function FlowDetail({ steps, id, detailId, t, onUnpin, openSession, canOpenSession }) {
      const info = flowDetail(steps, id);
      if (info === undefined) return null;
      const step = info.step;
      const status = String(step.status ?? 'pending');
      const hasChild = typeof step.childId === 'string' && step.childId !== '';
      const canOpen = hasChild && canOpenSession === true;
      const openTitle = canOpen ? t('flow.openSession') : hasChild ? t('session.unavailable') : t('session.none');
      const field = (label, value) =>
        h(
          'div',
          { className: 'dsh-teams-flow-detail-item' },
          h('span', { className: 'dsh-teams-flow-detail-label' }, label),
          h('span', { className: 'dsh-teams-flow-detail-value', title: value }, value),
        );
      return h(
        'div',
        {
          className: 'dsh-teams-flow-detail',
          id: detailId,
          role: 'region',
          'aria-label': t('flow.detail.title'),
          'aria-live': 'polite',
        },
        h(
          'div',
          { className: 'dsh-teams-flow-detail-head' },
          h('strong', { className: 'dsh-teams-flow-detail-title', title: info.owner }, info.owner),
          h(
            'span',
            { className: 'dsh-teams-flow-detail-status', 'data-status': status },
            h(
              'span',
              { className: 'dsh-teams-flow-state' },
              h('i', { className: 'dsh-teams-dot', 'aria-hidden': 'true' }),
              t(`task.${status}`),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-teams-btn dsh-teams-flow-detail-open',
              disabled: !canOpen,
              title: openTitle,
              onClick: canOpen ? () => openSession(step.childId) : undefined,
            },
            t('flow.detail.open'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-teams-flow-detail-close',
              'aria-label': t('flow.unpin'),
              title: t('flow.unpin'),
              onClick: onUnpin,
            },
            '×',
          ),
        ),
        h(
          'div',
          { className: 'dsh-teams-flow-detail-grid' },
          field(t('flow.detail.owner'), info.owner),
          field(
            t('flow.detail.unmet'),
            info.unmet.length === 0 ? t('flow.detail.unmetNone') : info.unmet.join('、'),
          ),
          field(
            t('flow.detail.unlocked'),
            info.unlocked.length === 0 ? t('flow.detail.unlockedNone') : info.unlocked.join('、'),
          ),
          field(t('flow.detail.model'), info.model),
        ),
        info.failure === undefined
          ? null
          : h(
              'div',
              { className: 'dsh-teams-flow-detail-failure', title: info.failure },
              `${t('flow.detail.failure')}：${info.failure}`,
            ),
        // 需队长决策：把评审 findings 摊在详情里（不是普通失败，颜色用 warning）
        info.needsDecision === undefined && info.findings.length === 0
          ? null
          : h(
              'div',
              { className: 'dsh-teams-flow-detail-failure' },
              info.needsDecision === undefined
                ? `${t('decision.findings')}（${info.findings.length}）`
                : `${t('decision.title')}${typeof info.needsDecision.round === 'number' ? ` · ${t('decision.budget').replace('{round}', String(info.needsDecision.round))}` : ''}`,
              ...(Array.isArray(info.needsDecision?.findings) && info.needsDecision.findings.length > 0
                ? info.needsDecision.findings
                : info.findings
              ).map((item, index) =>
                h('div', { key: index, className: 'dsh-teams-decision-item' }, `· ${String(item)}`),
              ),
            ),
      );
    }

        /**
     * 一轮运行的依赖图：列 = 依赖层级，左→右。
     *
     * 只有一种排布：绝对定位节点 + 单层 SVG 折线（像素坐标，不测量节点）。
     * 面板多窄都不改卡片形状，超出就靠 `.dsh-teams-flow-viewport` 横向滚动。
     */
    function FlowDiagram({ run, t, openSession, canOpenSession }) {
      const steps = Array.isArray(run.steps) ? run.steps : [];
      const [hoverId, setHoverId] = React.useState(undefined);
      const [focusId, setFocusId] = React.useState(undefined);
      const [pinnedId, setPinnedId] = React.useState(undefined);
      const rootRef = React.useRef(null);

      const layout = React.useMemo(() => flowNodes(steps), [steps]);
      const nodeById = layout.nodeById;
      // 渲染期先降级：刷新后钉住的节点没了就不显示详情（effect 再清 state）
      const pinned = pinnedId !== undefined && nodeById.has(pinnedId) ? pinnedId : undefined;
      const hovered = hoverId !== undefined && nodeById.has(hoverId) ? hoverId : undefined;
      const focused = focusId !== undefined && nodeById.has(focusId) ? focusId : undefined;
      // 键盘焦点优先于鼠标悬停：鼠标离开别的卡片不能清掉键盘正在浏览的链路
      const activeId = pinned ?? focused ?? hovered;
      const chain = activeId === undefined ? undefined : flowChain(steps, activeId);

      React.useEffect(() => {
        if (pinnedId !== undefined && !nodeById.has(pinnedId)) setPinnedId(undefined);
      }, [pinnedId, steps]);

      // Esc 取消钉住；停止确认框已 preventDefault 的事件让位（它自己处理 Esc）
      React.useEffect(() => {
        if (pinned === undefined) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented === true) return;
          setPinnedId(undefined);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [pinned]);

      if (steps.length === 0) return h('div', { className: 'dsh-teams-muted' }, t('flow.empty'));

      const suffix = String(run.runId ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '-');
      const detailId = `dsh-teams-flow-detail-${suffix}`;
      const markerId = `dsh-teams-flow-${suffix}-arrow`;
      const edges = flowEdges(steps, nodeById);
      const setPin = (id) => {
        setPinnedId((current) => (current === id ? undefined : id));
        setHoverId(undefined);
      };
      const clearPin = () => setPinnedId(undefined);
      const focusStep = (id, key) => {
        if (key === 'Escape') {
          clearPin();
          return;
        }
        const next = flowNavigate(layout.layers, id, key);
        if (next === undefined) return;
        const root = rootRef.current;
        if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return;
        for (const element of root.querySelectorAll('[data-step-id]')) {
          if (element.getAttribute('data-step-id') !== String(next)) continue;
          if (typeof element.focus === 'function') element.focus();
          break;
        }
      };
      // 只有一种布局：横向依赖图 + 容器横向滚动。
      // 面板再窄也不改卡片形状（116px 固定宽），靠 overflow-x 滚动看全图。
      const body = h(
              'div',
              {
                className: 'dsh-teams-flow-canvas',
                role: 'group',
                'aria-label': t('flow.graphLabel').replace('{n}', String(steps.length)),
                style: { width: layout.width, height: layout.height },
              },
              edges.length === 0 ? null : h(FlowEdges, { edges, layout, chain, markerId }),
              ...steps.map((step) => {
                const node = nodeById.get(step.id);
                return h(
                  'div',
                  { className: 'dsh-teams-flow-node', key: step.id, style: { left: node.x, top: node.y } },
                  h(FlowCard, {
                    step,
                    t,
                    detailId,
                    pinned: pinned === step.id,
                    highlighted: chain !== undefined && chain.has(step.id),
                    dimmed: chain !== undefined && !chain.has(step.id),
                    // 每个节点都是独立 Tab 停靠点（验收要求 Tab 逐个进节点）
                    tabIndex: 0,
                    childCount: layout.childCount.get(step.id) ?? 0,
                    onPin: setPin,
                    onHover: (id) => {
                      if (pinned === undefined) setHoverId(id);
                    },
                    onFocusNode: () => setFocusId(step.id),
                    onBlurNode: (id) => setFocusId((current) => (current === id ? undefined : current)),
                    onNavigate: focusStep,
                  }),
                );
              }),
            );
      return h(
        'div',
        {
          className: 'dsh-teams-flow',
          ref: rootRef,
          onKeyDown: (event) => {
            if (event.key === 'Escape' && pinned !== undefined) {
              event.stopPropagation();
              clearPin();
            }
          },
          // 点空白取消钉住：卡片/详情里的点击会冒泡到这里，靠 target 判定，避免刚钉住就被清掉
          onClick: (event) => {
            if (pinned === undefined) return;
            const target = event?.target;
            const blank =
              target === event?.currentTarget ||
              target?.className === 'dsh-teams-flow-viewport' ||
              target?.className === 'dsh-teams-flow-canvas' ||
              target?.className === 'dsh-teams-flow-canvas';
            if (blank) clearPin();
          },
        },
        // 详情放在滚动视口之外：横向滚到最右时「负责人」等核心信息仍在视野内
        h('div', { className: 'dsh-teams-flow-viewport' }, body),
        pinned === undefined
          ? null
          : h(FlowDetail, {
              steps,
              id: pinned,
              detailId,
              t,
              onUnpin: clearPin,
              openSession,
              canOpenSession,
            }),
      );
    }

    /** 一轮运行的折叠项：头部一行（立绘牌 + 标题 + meta + 箭头 + 进度条），展开是流程图。 */
    function RunItem({ run, t, openSession, canOpenSession, defaultOpen, busyMembers, onStop, onApproveStart, onNote, approvedAt, notes, onRefresh }) {
      // 折叠时不挂载流程图：DOM 里只有头部（历史再长，挂载的卡片数 = 展开那一轮的步数）
      const [open, setOpen] = React.useState(defaultOpen === true);
      // 停止确认框：确认之前**不发任何请求**，所以取消不会改变任何状态
      const [confirming, setConfirming] = React.useState(false);
      const [stopping, setStopping] = React.useState(false);
      const [stopError, setStopError] = React.useState(undefined);
      const [stopNotice, setStopNotice] = React.useState(undefined);
      // 批准并启动：一次点击 = 批准 + 启动，失败必须显示原因（不能假装成功）
      const [approveError, setApproveError] = React.useState(undefined);
      const [approveNotice, setApproveNotice] = React.useState(undefined);
      // 乐观 UI：点完**立即卸载整块审批区**，再发请求；失败才挂回来并给原因。
      // 以前只 disabled，用户点完画面没变化，以为没点上（用户实测反馈）。
      const [approvalHidden, setApprovalHidden] = React.useState(false);
      // 本组件内已知「批准成功」：快照刷新前，主钮文案也要立刻从「批准并启动」降级为「启动」
      const [approvedHere, setApprovedHere] = React.useState(false);
      // 「不批准，再商议」：只本地展开输入框，**不发任何请求**；提交时才写团队记录
      const [consultOpen, setConsultOpen] = React.useState(false);
      const [consultText, setConsultText] = React.useState('');
      const [consultBusy, setConsultBusy] = React.useState(false);
      const [consultError, setConsultError] = React.useState(undefined);
      const [noteNotice, setNoteNotice] = React.useState(undefined);
      const approveBusy = React.useRef(false);
      const noteBusy = React.useRef(false);
      const stopButtonRef = React.useRef(null);
      // 停止是异步收口的定时器：卸载时清掉，避免面板关掉后还在请求
      const settleTimers = React.useRef([]);
      React.useEffect(
        () => () => {
          for (const timer of settleTimers.current) clearTimeout(timer);
          settleTimers.current = [];
        },
        [],
      );
      const steps = Array.isArray(run.steps) ? run.steps : [];
      const done = steps.filter((step) => step.status === 'done').length;
      const failed = steps.filter((step) => step.status === 'failed').length;
      const running = steps.filter((step) => step.status === 'running').length;
      const total = steps.length;
      const phase = run.phase ?? 'idle';
      // ⚠️ 批准**故意不改 phase**（改了会让 teams_run 的闸门放行），所以"批准成功"只能从
      // approvedAt 读出来。面板以前只认 phase，于是批准后仍显示「待审批」——这里补上。
      const approved =
        approvedHere ||
        (typeof approvedAt === 'string' && approvedAt !== '' && !Number.isNaN(Date.parse(approvedAt)));
      const phaseLabel = phase === 'staged' && approved ? t('phase.stagedApproved') : t(`phase.${phase}`);
      // 停止入口只在「正在跑的这一轮」出现：历史轮次与已收口的轮次都没有可停止的循环。
      // （快照里 current 对最新一轮恒为 true，所以还要看 phase——否则已完成的轮次也显示「停止」）
      const canStop = run.current === true && phase === 'running' && typeof onStop === 'function';
      // 「批准并启动」只在当前这一轮 + 待审批 + 有任务图时出现。
      // ⚠️ 已批准（approvedAt 已落盘）但循环没起来时**也要保留入口**：
      //    否则一旦批准成功而启动失败（宿主没有可用的 Agent、或启动抛错），按钮消失、
      //    面板只剩「已批准 · 待启动」文案，用户再没有任何启动入口，只能去敲 teams_run。
      const canApprove =
        run.current === true &&
        phase === 'staged' &&
        total > 0 &&
        typeof onApproveStart === 'function';
      // 已批准过：按钮语义从「批准并启动」降级为「启动」
      const approveLabel = approved ? t('approve.start') : t('approve.button');
      // 计数：未完成任务直接从这一轮的步骤算；忙碌成员来自团队快照（缺数据就显示「—」）
      const unfinished =
        total === 0
          ? undefined
          : steps.filter((step) => step.status !== 'done' && step.status !== 'failed' && step.status !== 'skipped').length;
      const countText = (value) => (Number.isFinite(value) ? String(value) : '—');
      const confirmTitleId = `dsh-teams-stop-title-${String(run.runId ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      const confirmCountId = `${confirmTitleId}-count`;
      const askStop = (event) => {
        // summary 的默认行为是折叠/展开：不截断会"点停止却把这一轮收起来"
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        setStopError(undefined);
        setStopNotice(undefined);
        setConfirming(true);
      };
      const closeConfirm = () => {
        setConfirming(false);
        stopButtonRef.current?.focus?.();
      };
      const submitStop = async () => {
        if (stopping) return;
        setStopping(true);
        setStopError(undefined);
        let result;
        try {
          result = await onStop();
        } catch {
          // 注入的停止实现抛错也不能让面板锁死在「停止中」
          result = { ok: false, retryable: true, status: 0 };
        }
        setStopping(false);
        if (result !== undefined && result.ok === true) {
          setConfirming(false);
          setStopNotice(result.stopped === true ? t('stop.done') : t('stop.alreadyEnded'));
          if (typeof onRefresh === 'function') {
            onRefresh();
            if (result.stopped === true) {
              // 停止是异步收口的：stopRun 只 abort，调度器还要跑完 finally 才写 halted。
              // 正常轮询间期 1.2s，补两次定向刷新让面板在 1 秒内看到 halted / 不残留 running。
              for (const delay of [350, 900]) {
                settleTimers.current.push(setTimeout(() => onRefresh(), delay));
              }
            }
          }
          return;
        }
        // 鉴权/路由缺失重试也没用：收起确认条，只留一条灰字；网络/5xx 保留确认条可再点
        setStopError({ text: stopFailureText(t, result), retryable: result?.retryable === true });
        if (result === undefined || result.retryable !== true) setConfirming(false);
      };
      /**
       * 点击「批准并启动」：一次请求同时批准 + 启动。
       *
       * 三重防重复：ref 守卫（同步，挡连点）+ aria-busy（读屏/视觉）+ 只发一次请求。
       * 任何结果都要有可见反馈——阶段不变（批准不改 phase）时尤其不能让用户以为没生效。
       */
      const submitApprove = async (event) => {
        // 折叠行的默认行为是折叠/展开：不截断会"点批准却把这一轮收起来"
        if (event !== undefined && typeof event.preventDefault === 'function') {
          event.preventDefault();
          event.stopPropagation();
        }
        if (approveBusy.current) return;
        approveBusy.current = true;
        // ① 乐观卸载：整块审批区在**同一提交内**消失，再发请求（用户：点完即消失）
        setApprovalHidden(true);
        setApproveError(undefined);
        // 卸载后到响应回来最长 15s，不能是真空：立刻挂一条「进行中」，结束再改写或清掉
        setApproveNotice(t('approve.pending'));
        let result;
        try {
          result = await onApproveStart();
        } catch {
          result = { ok: false, retryable: true, status: 0 };
        }
        approveBusy.current = false;
        // 提示条只在展开时可见，所以有话说就把这一轮展开（否则等于什么都没提示）
        setOpen(true);
        if (result !== undefined && result.ok === true) {
          if (result.approved !== true) {
            // 批准被拒绝（任务图为空 / 没有计划）：如实报原因，不刷新成"已批准"
            setApprovalHidden(false);
            setApproveNotice(undefined);
            setApproveError({ text: result.reason ?? t('approve.failed'), retryable: false });
            return;
          }
          setApprovedHere(true);
          // 部分成功要分开说：批准了但没启动 → 恢复审批区，主钮降级「启动」，理由如实说
          setApprovalHidden(result.started === true);
          setApproveNotice(
            result.started === true
              ? t('approve.started')
              : `${t('approve.approvedOnly')}${result.reason ? `：${result.reason}` : ''}`,
          );
          if (typeof onRefresh === 'function') {
            onRefresh();
            if (result.started === true) {
              // 启动是异步收口的：补两次定向刷新，让面板在 1 秒内看到运行中
              for (const delay of [350, 900]) {
                settleTimers.current.push(setTimeout(() => onRefresh(), delay));
              }
            }
          }
          return;
        }
        // 失败：审批区挂回来（否则用户再也没有重试入口），并给出真实原因
        setApprovalHidden(false);
        setApproveNotice(undefined);
        // 服务端说「批准已落盘、只是启动失败」时，按钮语义要跟着降级，不能又写回「批准并启动」
        if (result?.approved === true) setApprovedHere(true);
        setApproveError({ text: approveFailureText(t, result), retryable: result?.retryable === true });
      };
      /** 展开/收起「不批准，再商议」：纯本地状态，不发请求、不改任何团队记录。 */
      const toggleConsult = (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') {
          event.preventDefault();
          event.stopPropagation();
        }
        setConsultError(undefined);
        setConsultOpen((previous) => previous !== true);
      };
      /** 提交修改意见：写入团队记录（下一次派发随任务卡带给子代理），不批准、不启动。 */
      const submitConsult = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        if (noteBusy.current) return;
        const text = consultText.trim();
        if (text === '') {
          setConsultError(t('approve.consultEmpty'));
          return;
        }
        noteBusy.current = true;
        setConsultBusy(true);
        setConsultError(undefined);
        setNoteNotice(undefined);
        let result;
        try {
          result =
            typeof onNote === 'function' ? await onNote(text) : { ok: false, retryable: false, status: 404 };
        } catch {
          result = { ok: false, retryable: true, status: 0 };
        }
        noteBusy.current = false;
        setConsultBusy(false);
        if (result !== undefined && result.ok === true) {
          setConsultOpen(false);
          setConsultText('');
          setNoteNotice(t('approve.consultSaved'));
          if (typeof onRefresh === 'function') onRefresh();
          return;
        }
        setConsultError(result?.reason ?? noteFailureText(t, result));
      };
      // 立绘牌固定用蓝色初版形象（与需求分析师卡片同一个蓝），不随运行状态变色——
      // 状态已经由边框颜色/状态胶囊表达，头像再变一次只会让"这个人是谁"变得难认。
      const accent = WHALE_BLUE;
      const pathLabel = run.pathLabel ?? run.path ?? '-';
      const timeText = formatTime(run.finishedAt ?? run.at);
      // 分段进度：一段一个任务（拓扑序），段数随任务数自动增减
      const segments = total > 0 ? runSegments(steps) : [];
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
          { className: 'dsh-teams-run-head', 'data-has-action': canStop ? 'true' : undefined },
          // 列①：立绘牌，全身人物站在牌底（不裁头）
          h('span', { className: 'dsh-teams-run-avatar' }, h(GirlArt, { accent, size: 34 })),
          // 列②上行：标题（单行省略，不挤压③）；下行：元信息小字
          h('span', { className: 'dsh-teams-run-subject', title: subject }, subject),
          h(
            'span',
            { className: 'dsh-teams-run-meta' },
            h('span', null, pathLabel),
            h('span', null, phaseLabel),
            timeText === '' ? null : h('span', null, timeText),
          ),
          // 列③：状态胶囊 + 完成数，整体靠右
          h(
            'span',
            { className: 'dsh-teams-run-stats' },
            run.current === true
              ? h('span', { className: 'dsh-teams-chip', 'data-state': 'running' }, t('flow.current'))
              : null,
            h('span', { className: 'dsh-teams-run-count' }, total > 0 ? `${done}/${total}` : '—'),
          ),
          canStop
            ? h(
                'button',
                {
                  type: 'button',
                  ref: stopButtonRef,
                  className: 'dsh-teams-btn dsh-teams-run-stop',
                  'aria-label': `${t('stop.button')}：${subject}`,
                  title: t('stop.button'),
                  onClick: askStop,
                },
                t('stop.button'),
              )
            : null,
          h('span', { className: 'dsh-teams-run-chevron', 'aria-hidden': 'true' }, '⌄'),
          // 分段进度贴折叠行底边：一段一个任务，折叠时也能看出走到第几段
          total > 0
            ? h(
                'span',
                {
                  className: 'dsh-teams-run-bar',
                  role: 'progressbar',
                  'aria-valuenow': String(done),
                  'aria-valuemin': '0',
                  'aria-valuemax': String(total),
                  'aria-valuetext': `${t('field.progress')} ${done}/${total}`,
                },
                ...segments.map((segment) =>
                  h('i', {
                    key: segment.id,
                    className: 'dsh-teams-run-seg',
                    'data-status': segmentTone(segment.status),
                    title: `${segment.label} ${t(`task.${segment.status}`)}`,
                  }),
                ),
              )
            : null,
        ),
        open
          ? h(
              'div',
              { className: 'dsh-teams-run-body' },
              confirming
                ? h(
                    'div',
                    {
                      className: 'dsh-teams-confirm',
                      'data-tone': 'warn',
                      role: 'group',
                      'aria-labelledby': confirmTitleId,
                      'aria-describedby': confirmCountId,
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          closeConfirm();
                        }
                      },
                    },
                    h('span', { className: 'dsh-teams-confirm-title', id: confirmTitleId }, t('stop.confirmTitle')),
                    h(
                      'span',
                      { className: 'dsh-teams-confirm-count', id: confirmCountId },
                      `${t('stop.unfinished')} ${countText(unfinished)} · ${t('stop.busy')} ${countText(busyMembers)}`,
                    ),
                    h(
                      'div',
                      { className: 'dsh-teams-role-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-teams-btn',
                          autoFocus: true,
                          disabled: stopping,
                          onClick: () => setConfirming(false),
                        },
                        t('stop.cancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-teams-btn dsh-teams-run-stop',
                          disabled: stopping,
                          'aria-busy': stopping ? 'true' : undefined,
                          onClick: submitStop,
                        },
                        stopping ? t('stop.stopping') : t('stop.confirm'),
                      ),
                    ),
                  )
                : null,
              stopNotice ? h('div', { className: 'dsh-teams-stop-note', role: 'status' }, stopNotice) : null,
              stopError
                ? h(
                    'div',
                    { className: 'dsh-teams-stop-note', 'data-tone': stopError.retryable ? 'error' : 'muted', role: 'alert' },
                    stopError.text,
                  )
                : null,
              // 批准结果单独一条：与停止互斥显示，成功用 status、失败用 alert（读屏会主动播报）
              approveNotice
                ? h('div', { className: 'dsh-teams-stop-note', role: 'status' }, approveNotice)
                : null,
              approveError
                ? h(
                    'div',
                    { className: 'dsh-teams-stop-note', 'data-tone': approveError.retryable ? 'error' : 'muted', role: 'alert' },
                    approveError.text,
                  )
                : null,
              h(FlowDiagram, { run, t, openSession, canOpenSession }),
              // 审批区：流程图**下方**、占满整行（用户实测：标题旁 11px 小按钮太挤）。
              // 乐观 UI：点完立即卸载；失败/部分成功再挂回来并给原因。
              canApprove && approvalHidden !== true
                ? h(
                    'div',
                    {
                      className: 'dsh-teams-approval',
                      role: 'group',
                      'aria-label': t('approve.groupLabel'),
                    },
                    h(
                      'div',
                      { className: 'dsh-teams-approval-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-teams-btn dsh-teams-approval-primary',
                          'aria-label': `${approveLabel}：${subject}`,
                          title: approved ? t('approve.startHint') : t('approve.button'),
                          // 防连点：ref 守卫在 submitApprove 里同步挡住，消失本身也是防重手段
                          onClick: submitApprove,
                        },
                        approveLabel,
                      ),
                      // 已批准过（只差启动）时缩成单个「启动」：这时候"不批准"已经没有意义
                      approved
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-teams-btn dsh-teams-approval-secondary',
                              'aria-expanded': consultOpen ? 'true' : 'false',
                              onClick: toggleConsult,
                            },
                            t('approve.disagree'),
                          ),
                    ),
                    consultOpen
                      ? h(
                          'div',
                          { className: 'dsh-teams-consult' },
                          h('span', { className: 'dsh-teams-consult-hint' }, t('approve.consultHint')),
                          h('textarea', {
                            className: 'dsh-teams-consult-input',
                            rows: 3,
                            value: consultText,
                            placeholder: t('approve.consultPlaceholder'),
                            'aria-label': t('approve.consultPlaceholder'),
                            onChange: (input) => setConsultText(input.target.value),
                          }),
                          Array.isArray(notes) && notes.length > 0
                            ? h(
                                'div',
                                { className: 'dsh-teams-note-history' },
                                h('span', { className: 'dsh-teams-note-title' }, t('approve.notesTitle')),
                                h(
                                  'ul',
                                  { className: 'dsh-teams-note-list' },
                                  ...notes.slice(-5).map((note, index) =>
                                    h('li', { key: note?.id ?? index }, String(note?.text ?? '')),
                                  ),
                                ),
                                // 只回看最近 5 条：更早的必须**显式说明**，不能静默截断（评审 #5）
                                notes.length > 5
                                  ? h(
                                      'span',
                                      { className: 'dsh-teams-note-more' },
                                      t('approve.notesMore').replace('{n}', String(notes.length - 5)),
                                    )
                                  : null,
                              )
                            : null,
                          h(
                            'div',
                            { className: 'dsh-teams-consult-actions' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsh-teams-btn dsh-teams-consult-submit',
                                disabled: consultBusy,
                                onClick: submitConsult,
                              },
                              consultBusy ? t('approve.consultSaving') : t('approve.consultSubmit'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsh-teams-btn',
                                onClick: () => {
                                  setConsultOpen(false);
                                  setConsultError(undefined);
                                },
                              },
                              t('approve.consultCancel'),
                            ),
                          ),
                          consultError
                            ? h('div', { className: 'dsh-teams-stop-note', 'data-tone': 'error', role: 'alert' }, consultError)
                            : null,
                        )
                      : null,
                  )
                : null,
              // 「不批准，再商议」的结果：提交后写在审批区之外（区块会被卸载/折叠）
              noteNotice ? h('div', { className: 'dsh-teams-stop-note', role: 'status' }, noteNotice) : null,
            )
          : null,
      );
    }

    /** 历史上限：先渲染最近这些轮，更早的按需展开（兜住极端情况）。 */
    const RUNS_PAGE = 8;

    /** 运行列表：每次任务一项，最新在最上面。 */
    function RunsView({ team, t, openSession, canOpenSession, onStop, onApproveStart, onNote, onRefresh }) {
      const runs = Array.isArray(team.runs) ? team.runs : [];
      const [showAll, setShowAll] = React.useState(false);
      if (runs.length === 0) return h('div', { className: 'dsh-teams-empty' }, t('view.noTasks'));
      const shown = showAll ? runs : runs.slice(0, RUNS_PAGE);
      const hidden = runs.length - shown.length;
      // 确认框里的「忙碌成员」：没有成员数据时给 undefined，由 UI 显示「—」而不是 0
      const members = Array.isArray(team.members) ? team.members : [];
      const busyMembers =
        members.length === 0 ? undefined : members.filter((member) => member.status === 'working').length;
      return h(
        'div',
        { className: 'dsh-teams-runs' },
        ...shown.map((run, index) => h(RunItem, {
              // ⚠️ 同一会话里新一轮 plan 复用同一个 runId（`<session>#current`）。
              // key 必须带上本轮计划指纹（服务端 decision.decidedAt）：否则 RunItem 实例
              // 被复用，上一轮点过「批准并启动」留下的 approvalHidden/approvedHere 会让
              // 下一轮的审批区永远不渲染（评审 #1 的 HIGH）。
              key: `${run.runId ?? index}#${run.planId ?? ''}`,
              run,
              t,
              openSession,
              canOpenSession,
              busyMembers,
              onStop,
              onApproveStart,
              onNote,
              // 批准只写 approvedAt、不改 phase，所以「已批准」这个事实只能从快照顶层读进来
              approvedAt: team.approvedAt,
              // 已记录的补充要求（团队级）：审批区里可回看，下一次派发会带给子代理
              notes: Array.isArray(team.notes) ? team.notes : [],
              onRefresh,
              // 极端数据：步骤特别多的运行默认折叠，避免一次性挂载几百张卡。
              // ⚠️ 例外：当前轮正在等审批时**必须默认展开**——审批区在流程图下方，
              // 默认折叠会让 >30 步的计划连唯一的批准入口都看不到（评审 #2）。
              defaultOpen:
                index === 0 &&
                ((Array.isArray(run.steps) ? run.steps.length : 0) <= 30 ||
                  (run.current === true && run.phase === 'staged' && (run.steps?.length ?? 0) > 0)),
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
      // 渲染期能力探测：宿主没有 uiWorkspace 时，卡片渲染成禁用态而不是"看着能点"。
      // 探测本身也兜住异常——宿主服务状态变化不能让面板渲染失败。
      const canOpenSession =
        typeof props.onCanOpenSession === 'function' && props.onCanOpenSession() === true;

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
        // 成员列表已移除：角色数据仍在卡片上（头像/名称/用量），不再单开一页
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
        body = h(RunsView, {
          team,
          t,
          openSession,
          canOpenSession,
          // 面板的两个写操作：停止要确认后才 POST；批准并启动一点即发（幂等）
          onStop: () => requestTeamStop(team.captainSessionId),
          onApproveStart: () => requestTeamApproveStart(team.captainSessionId),
          // 「不批准，再商议」：只记录修改意见，不批准也不启动
          onNote: (text) => requestTeamNote(team.captainSessionId, text),
          onRefresh: () => store.refresh(),
        });
      } else if (tab === 'tasks') {
        body = h(TasksView, { team, t, openSession, canOpenSession });
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

    function TasksView({ team, t, openSession, canOpenSession }) {
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

          // 这一步的子会话入口：点标题行进它自己完整的对话（含工具调用与推理）
          const hasChild = typeof task.childId === 'string' && task.childId !== '';
          const clickable = hasChild && canOpenSession === true;
          const unavailable = hasChild && canOpenSession !== true;
          const openTask = () => {
            if (clickable) openSession(task.childId);
          };

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
              {
                className: 'dsh-teams-row dsh-teams-task-head',
                'data-clickable': clickable ? 'true' : undefined,
                'data-disabled': unavailable ? 'true' : undefined,
                role: clickable ? 'button' : undefined,
                tabIndex: clickable ? 0 : undefined,
                'aria-label': clickable
                  ? `${String(task.subject ?? task.id)}，${t('task.openSession')}`
                  : undefined,
                'aria-disabled': unavailable ? 'true' : undefined,
                title: clickable ? t('task.openSession') : unavailable ? t('session.unavailable') : t('session.none'),
                onClick: clickable ? openTask : undefined,
                onKeyDown: clickable
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openTask();
                      }
                    }
                  : undefined,
              },
              h('strong', null, String(task.subject ?? task.id)),
              h('span', { className: 'dsh-teams-chip', 'data-state': String(status) }, t(`task.${status}`)),
              watchBadge(task, t),
              // 可点/禁用都保留行尾的「去会话」提示；真正的点击目标是整条标题行
              hasChild ? h('span', { className: 'dsh-teams-open', 'aria-hidden': 'true' }, '↗') : null,
            ),
            h('div', { className: 'dsh-teams-muted', style: { marginTop: 4 } }, meta),
            budgetBar(task, t),
            task.failure ? h('div', { className: 'dsh-teams-failure' }, String(task.failure)) : null,
            // 返工预算耗尽：不是失败，是等人拍范围；把 findings 直接摊开，别让人再点进会话找
            task.needsDecision
              ? h(
                  'div',
                  { className: 'dsh-teams-failure dsh-teams-decision' },
                  h('strong', null, t('decision.title')),
                  typeof task.needsDecision.round === 'number'
                    ? h(
                        'div',
                        null,
                        t('decision.budget').replace('{round}', String(task.needsDecision.round)),
                      )
                    : null,
                  Array.isArray(task.needsDecision.findings) && task.needsDecision.findings.length > 0
                    ? h(
                        'div',
                        { className: 'dsh-teams-decision-item' },
                        `${t('decision.findings')}（${task.needsDecision.findings.length}）：`,
                      )
                    : null,
                  ...(Array.isArray(task.needsDecision.findings) ? task.needsDecision.findings : []).map(
                    (item, index) => h('div', { key: index, className: 'dsh-teams-decision-item' }, `· ${String(item)}`),
                  ),
                  h('div', { className: 'dsh-teams-muted' }, t('decision.hint')),
                )
              : null,
            // 安全阻断等终局失败也带出 findings（语义不变，只是别丢掉评审说了什么）
            !task.needsDecision && Array.isArray(task.findings) && task.findings.length > 0
              ? h(
                  'details',
                  { className: 'dsh-teams-details' },
                  h('summary', null, `${t('decision.findings')}（${task.findings.length}）`),
                  ...task.findings.map((item, index) =>
                    h('div', { key: index, className: 'dsh-teams-decision-item' }, `· ${String(item)}`),
                  ),
                )
              : null,
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
          // 动态判死的两道闸（审计 R6-02：以前只在 lib/config.js 里"可配"，实际取不到值）
          {
            path: ['watch', 'stallFloorMs'],
            kind: 'number',
            unit: 'set.unitMs',
            label: 'set.f.stallFloorMs',
            hint: 'set.h.stallFloorMs',
          },
          {
            path: ['watch', 'stallFactor'],
            kind: 'number',
            label: 'set.f.stallFactor',
            hint: 'set.h.stallFactor',
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
                    // 能力探测：宿主没有 uiWorkspace 时卡片渲染成禁用态并给 title 说明
                    onCanOpenSession: () => canOpenSessionVia(ctx),
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
