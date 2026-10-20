# dsh-teams 第六轮审计（六维）

- 审计对象：`F:/XMT/DSHWorkspace/test/dsh-teams`，HEAD `33b0e92`
- 基线：`node --test "test/*.test.mjs"` → exit 0 / 229 passed / 12.3s
- 范围：只读。`lib/**`、`index.js`、`client.js`、`test/**` 均未改动；本报告与 `docs/audit-r6/` 为唯一新增文件。
- 机器可读结论：[findings.json](findings.json)（16 条 finding，六维 coverage 由 `run-all.mjs` 校验）
- 复现：`node docs/audit-r6/run-all.mjs`；完整输出见 [run-all-output.txt](run-all-output.txt)

## 摘要

本轮共 16 条结论：**P1 × 5、P2 × 5、P3 × 6**；决策 **修 14 / 不修 1 / 记入已知限制 1**。

- 第六轮新发现（未被 FIXES 覆盖）的 P1：
  - **R6-07** `ui.locale=en` 会把路由词表缩成纯英文，中文安全任务漏判风险直接落到 fast；
  - **R6-08** 进程重启后遗留 `running` 任务永久卡死，`teams_run` 判 failed、`teams_retry` 不认；
  - **R6-09** 质量门驳回内部改写 `task.deps`，使已批准图指纹失效，`teams_retry` 重置任务后启动不了调度；
  - **R6-06** 僵尸循环 1 小时窗口只在批次间刷新心跳，单批超 1 小时会被第二次 `teams_run` 误接管并作废在飞结果。
- **R6-02** 是历史半死配置的确认（AUDIT 5.1 已记录、P1-4 未真正修完）：`stallFloorMs/stallFactor` 在 `Config.parse` 里还在，但被 **apply 期 getter 视图**截断，而不是被 schema 丢掉。
- **R6-15** 安全门首轮只依赖 architect（现状被测试固定），在实现之前运行，PASS 不覆盖本次变更。
- 过度限制方向未发现新的误伤；`RUNS_PAGE=8` 的“拒绝态”假设被证伪（有“更多”按钮）。详见 R6-16。
- 3 个内置角色永不派发、角色权限不是沙箱、`localAgent` 缺失时无看门狗，仍是已知限制，本轮不重复展开。

## ① 断点（走不通 / 永不触发）

| ID | 严重度 | 证据 | 结论 | 优先级 |
|---|---|---|---|---|
| R6-01 | low | `lib/config.js:94` 仍返回 `openTabOnPlan`；除它之外 0 消费者 | 修（FIXES P1-4 残留） | P3 |
| R6-03 | low | `lib/router.js:508,520` 计算/返回 `ambiguous`，无消费者 | 修（暴露或删除） | P3 |
| R6-04 | low | `lib/tasks.js:245` `ready` 恒 0；`skipped` 无写入者；`artifacts/stepId` 只写不读 | 不修（清理项） | P3 |
| R6-05 | medium | `lib/scheduler.js:504` runLoop 不传 disabled；`lib/roles.js:243` 模糊回退会返回停用角色 | 修 | P2 |

关键细节：

- **R6-01** 探针 `probe-dead-config`：`resolveUi({ui:{openTabOnPlan:false}}).openTabOnPlan=false`、true 时为 true；`index.js` schema 出现 0 次；`client.js` 0 次。FIXES.md:28 写“删除”，test/client.test.mjs:845 也按“已移除”计数，实际只删了 schema 与 apply 视图。
- **R6-05** 实测：`loadRoles(...,{disabled:new Set(['code-reviewer'])})` 后 `bySlug.has('code-reviewer')=false`，但 `resolveRole(lib,'code-reviewer')` 仍返回该角色（`enabled=false`）。同时 `runLoop` 重新 `loadRoles` 时完全不带 disabled，所以“plan 后、run 前停用”对已批准图无效。`teams_role_manage` 的描述“停用后不会被流水线派发”在旧图上不成立。
- 附带（未单列 ID）：`archiveRun` 的首选字段 `graph.subject` 从未被写入——`buildTaskGraph` 只返回 `{tasks, seq}`（`lib/tasks.js:72`），`subject` 永远走 `team.decision.task` 兜底（`lib/scheduler.js:470`）。目前不影响标题，但“优先用本图 subject”的注释与实现不符。

## ② 应变量却被写死

| ID | 严重度 | 证据 | 结论 | 优先级 |
|---|---|---|---|---|
| R6-02 | high | `index.js:95-101` schema 3 键；`index.js:1101-1110` apply 视图 3 键；`lib/config.js:53` 读 5 键；`lib/runner.js:144-145,669` 用默认 900000/4 | 修 | P1 |
| R6-06 | medium | `lib/scheduler.js:47,306,512,593` | 修（心跳，不是加配置） | P1 |
| R6-07 | high | `lib/scheduler.js:143` + `lib/router.js:211-213` | 修 | P1 |

**R6-02 的根因层（重要更正）**：`Config.parse` 并不会丢掉未知键——探针里 `stallFloorMs=120 / stallFactor=2` 原样保留（`{stallFloorMs:120, stallFactor:2}`）。真正的闸门是插件的 **apply 期配置视图** `index.js:1101-1110` 只定义了 3 个 getter；`lib/config.js:50-58` 的 `watchOverrides(config)` 读 `config.watch.stallFloorMs` 得到 `undefined`。行为证据：同一份 120ms 配置，经 `apply` 后 900ms 内不判死（executor 仍 running）；把 raw config 直接交给 scheduler 的对照组 ~120ms 判死（failed / stalled）。所以修复点是 apply 视图（以及设置卡片与 schema），不是 `Config.parse`。

**R6-06 的算术**：`touchedAt` 只在 `for(;;)` 顶部刷新（`:512`），一批任务在 `await Promise.allSettled(batch)`（`:593`）里可连续跑 `maxRetries+1` 次；FIXES 记录 heavy=45min、executor 实测 30min，3 次尝试可达 135min > 60min。此时第二次 `teams_run` 会走 stale 分支：`epoch+1`、`running→pending`、换新循环，旧结果随后被丢弃。相反，`retryFailedTeam` 只要 `activeLoops.has(key)` 就拒绝（`:408`），没有 stale 判断——同一个僵尸锁，run 能接管、retry 永远不能。

**R6-07 的实测**（`node --input-type=module`）：

| 任务文本 | locale | risk | total | path |
|---|---|---|---|---|
| 支付回调签名校验失败 | 缺省 | 2 | 3 | full |
| 支付回调签名校验失败 | `en` | 0 | 1 | fast |
| update user permissions | `en` | 2 | 3 | full |

`ui.locale` 是界面语言（client.js:209 文案也这么写），却被 `scheduler.js:143` 当成“任务语言开关”传给 `route()`；`hits()` 在 `locale==='en'` 时只取英文词表（router.js:211-213），中文安全词全部漏判。这是安全语义的静默降级。

### 写死值逐条判定（该不该参数化）

| 常量 | 位置 | 现值 | 该参数化？ | 理由 |
|---|---|---|---|---|
| `stallFloorMs` / `stallFactor` | runner.js:144-145 | 900000 / 4 | **应该** | 唯一判死路径的安全阈值；config.js 已按“可配”读取，只是视图断了。P1 修。 |
| `LOOP_STALE_MS` | scheduler.js:47 | 1h | **不应该直接加用户配置** | 真正的问题是批次内无心跳，不是窗口值；加配置只是把误接管推迟。应修心跳，窗口可内部可调。 |
| `EVENT_TAIL` | web-routes.js:28 | 80 | 否 | 面板展示上限，不是数据删除；成本问题在 readEvents 全量读，另见 R6-13。 |
| `POLL_ACTIVE_MS` / `POLL_IDLE_MS` | client.js:25-26 | 1200 / 5000 | 否 | UI 刷新节奏，当前 50/12 次/分钟合理；真正要修的是每次请求的 O(历史) 读。 |
| `RUNS_PAGE` | client.js:1416 | 8 | 否 | 默认折叠数，有 showAll/“更多”按钮；不是硬上限（R6-16 已证伪“拒绝态”）。 |
| `RESUME_SEED_LIMIT` | scheduler.js:480 | 4000 | 否 | 续写起点是提示词预算；更大只会挤占上下文，4000 字足够判断“做到哪了”。 |
| `DEP_OUTPUT_LIMIT` / `DEP_TOTAL_LIMIT` | tasks.js:12-15 | 2000 / 12000 | 否（暂） | 内置路径 verify 最多 4 个依赖 = 8000 < 12000，不会触发；只有未来允许 >6 依赖的自定义图才需重估。 |
| `VERDICT_TAIL_LINES` | verdict.js:22 | 8 | 否 | 机器判定契约要求 VERDICT 在最后一行；放宽尾部会增加“正文示例翻案”的风险，与 R2-1 修复方向相反。 |
| `HEADER_READ_LIMIT` | roles.js:36 | 64KB | 否 | 角色契约远小于此；真超了应拆分角色，而不是放开整文件读。 |
| `readJsonBody` 上限 | web-routes.js:668 | 256KB | 否 | 鉴权路由的防滥用边界，对常见 <20KB 契约有数量级余量。 |
| `TIMEOUT_MS` 默认值 | runner.js:80-85 | 2700/1200/900/300s | 已可配 | `config.timeouts.*` 已接通，无需再改。 |

## ③ 可能中断的流程

| ID | 严重度 | 证据 | 结论 | 优先级 |
|---|---|---|---|---|
| R6-09 | high | `scheduler.js:294,1000,423` + `index.js:727` | 修 | P1 |
| R6-15 | medium | `router.js:78,82` + `test/scheduler.test.mjs:233` | 修（需同步改测试） | P2 |
| R6-12 | low | `scheduler.js:346,351,357` | 修 | P3 |

- **R6-09（本次最隐蔽的 dead-end）**：质量门 FAIL 触发重做时，`settleTask` 会给门补依赖 `task.deps=[..., ...reopened]`（`:1000`）。`graphFingerprint` 覆盖 deps（`scheduler.js:64-74`，deps 在第 71 行），于是 `approvedGraph` 与当前图不一致。后续：
  - `teams_run` 直接拒绝（`:294`）；
  - `teams_retry` 先把 failed/blocked 改回 pending（`:423`），再调 `startTeamRun`，同样被指纹拒绝（`index.js:727`）——任务已经 pending，retry 又挑不中，形成“说已续跑、实际没跑”的死状态。
  - 实测输出：`startTeamRun {started:false, reason:'任务图在批准之后被改动过（或来自上一轮），需要重新批准'}`；`retryFailedTeam {started:true, retried:1}`；随后 `startTeamRun` 仍是同一拒绝。
- **R6-15**：full 路径 `security.deps=['architect']`，与 critic 同批，在 executor 之前/并行启动；它拿不到本次实现产出，PASS 只覆盖变更前代码。只有发生驳回后 scheduler 才给它补 executor 依赖。`test/scheduler.test.mjs:233` 把现状固定为断言，修复需同步改测试（本轮 test/ 冻结）。
- **R6-12**：`activeLoops.set`（`:346`）之后才 `await mutateTeam`（`:351`）；若写盘抛错，函数 reject，既没有 `runLoop`，也没有 `.finally` 删锁。之后 1 小时内所有 `teams_run` 返回“调度循环已在运行中”。低概率，但属于可自愈的锁泄漏。

## ④ 任务可能丢失

| ID | 严重度 | 证据 | 结论 | 优先级 |
|---|---|---|---|---|
| R6-08 | high | `scheduler.js:306,637` + `tasks.js:229` + `scheduler.js:413` | 修 | P1 |
| R6-10 | medium | `scheduler.js:160,184` | 修 | P2 |
| R6-11 | medium | `scheduler.js:130,162` + `state.js:213` + `scheduler.js:726` | 修 | P2 |

- **R6-08（崩溃后永久卡死）**：僵尸接管只在 `activeLoops` 里还有句柄时生效（`:306`）；进程重启后内存表为空。探针 `probe-lost-on-crash` 实测：把 `t-executor` 置 `running` 模拟崩溃，重启后 `startTeamRun` 返回 started=true，随后 `phase=failed`，任务仍是 `t-executor:running / t-review:pending / t-verify:pending`；`teams_retry` 返回“没有失败或受阻的任务可续跑”；`teams_stop` 因无循环返回 stopped=false。唯一出路是 `teams_plan(rebuild=true)`，从头再来。修复：无 activeLoop 的启动分支先把遗留 running `epoch+1 → pending`（与 halted 同语义）。
- **R6-10**：`archiveRun(...).catch(()=>{})` 静默吞掉归档失败，随后 `mutateTasks(() => graph)` 覆盖旧图。磁盘满/权限/目录占用时，运行历史永久少一轮且无任何提示。归档应是 rebuild 的前置条件。
- **R6-11**：`planTeam` 在“已有任务图”检查之前就 `ensureTeam({purpose:task})`，`ensureTeam` 无条件覆盖 `existing.purpose`（`state.js:213`）。第二次 `teams_plan(rebuild=false)` 虽然返回“已存在任务图”，但 `team.purpose` 已变成新任务；之后运行旧图时 `dispatchOne` 用 `team.purpose` 作为 `teamGoal`（`scheduler.js:726`），所有角色收到的是新任务目标。实测：旧图“实现登录页”，第二次 plan“部署到生产环境”被拒后，`team.purpose` 已是“部署到生产环境”。

## ⑤ 过度消耗（量化）

| ID | 严重度 | 证据 | 结论 | 优先级 |
|---|---|---|---|---|
| R6-13 | medium | `state.js:317-319`、`web-routes.js:169`、`client.js:25` | 修 | P2 |
| R6-14 | low | `state.js:371`、`web-routes.js:185`、`client.js:1416` | 修 | P3 |

`probe-events-growth` 结果（12000 行 / 2,910,320 字节）：

| 指标 | 数值 |
|---|---|
| 面板实际展示 | 80 条 |
| 每次快照读取 | 整个文件 2,910,320 字节（放大 ×150） |
| `readEvents(80)` 中位耗时 | 10.68 ms |
| 只读尾部 64KB 对照 | 0.32 ms（≈33×） |
| 运行中轮询（1.2s） | 50 次/分钟 → **145.5 MB/分钟** |
| 空闲轮询（5s） | 12 次/分钟 → 34.9 MB/分钟 |
| 真实状态目录现状 | 146 行 / 33,113 字节（成本随历史线性增长） |

- 放大链路：`readEvents` 先 `readFile` 全文件，再 `split` 全部行，最后 `slice(-80)`（`state.js:317-319`）；`/state` 每次快照都调用它（`web-routes.js:169`）。
- 轮询侧：`TeamBadge` 与会话右栏 `TeamWorkspace` 各自 `pollLoop`（`client.js:925,1457`），共用同一个 store；store 只做“在途去重”（`inflight`，`client.js:849`），不做“同一周期只请求一次”。面板打开时最坏可到 2×（≈291 MB/分钟，按 12k 行文件计）。
- `readRunRecords` 同样全量读 + 逐行 parse（`state.js:371`），runs 文件随每次 rebuild 增长；客户端只默认渲染 8 条，宿主仍全量下发。当前 2 条 / 3.6KB，尚小。
- 建议：`readEvents` 改为从文件尾按块倒读直到凑满 limit（或环形日志）；`/state` 的 runs 只回最近 N 轮 + total；客户端两个 poller 合并到一个。

## ⑥ 过度限制（刻意边界 vs 误伤）

| 边界 | 位置 | 判定 | 理由 |
|---|---|---|---|
| `RUNS_PAGE=8` | client.js:1416/1423 | **不是限制** | `showAll ? runs : runs.slice(0,8)` + “更多”按钮；数据不删。架构方案的“实际拒绝态”假设被证伪。 |
| 依赖产物 2000/12000 字 | tasks.js:12-15 | 刻意预算 | 内置路径 verify 最多 4 依赖 = 8000 < 12000；只有合成 7 依赖才会省略。 |
| 请求体 256KB | web-routes.js:668 | 刻意安全边界 | 对角色契约有数量级余量；超限销毁请求。 |
| `VERDICT` 只扫尾 8 行 | verdict.js:22 | 刻意 fail-closed | 契约明确要求判定在最后一行；放宽会重新打开“正文示例翻案”。 |
| `RESUME_SEED_LIMIT=4000` | scheduler.js:480 | 刻意预算 | 足够判断进度，避免续跑提示撑爆上下文。 |
| `HEADER_READ_LIMIT=64KB` | roles.js:36 | 刻意边界 | 角色契约不应有 64KB；真超了应拆角色。 |
| 核心角色不可停用 | role-state.js:22 | 刻意安全边界 | executor/verifier 缺失时任何路径都不成立。 |
| 运行中拒绝 rebuild | scheduler.js:149-155 | 刻意一致性 | 防旧循环执行新图。 |
| 人工批准闸门 | index.js:578-606 | 刻意安全边界 | 用户确认是硬闸门。 |
| 工作区精确匹配 | web-routes.js:698 | 刻意安全边界 | 防跨工作区读写。 |

**结论**：⑥ 未发现新的误伤。唯一需要“改”的方向不是放松上限，而是 R6-13 的实现效率（同一份数据读 150 倍）。如果未来允许自定义任务图有 >6 个依赖，再重估 `DEP_TOTAL_LIMIT`。

## 未确认项

1. **R6-06 的 1 小时误接管是静态推演 + 算术**，未做 1 小时真实等待；需要注入时钟或把 `LOOP_STALE_MS` 临时调小才能动态复现。结论依据是 `touchedAt` 只在批次间刷新这一确定事实。
2. **R6-07 的真实影响面**取决于有多少用户把 `ui.locale` 设为 `en` 且用中文描述任务；代码路径已实测，用户分布未统计。
3. **R6-15 的修复代价**：security 依赖 executor 会把安全门移到实现之后，关键路径增加约一个安全门时长（本轮 security 实测 31.6min），与 simplify/review/test 并行；是否接受需产品决策。
4. 事件流/运行历史的**长期增长速度**没有生产数据；当前 146 条/6 轮，按每轮 20~30 条估算，千轮后约 2~3MB，与探针的 2.9MB 同量级。
5. `ui.locale` 是否还应影响 UI 之外的任何行为，代码注释（client.js:209）说只影响文案；本轮按“只影响文案”判定。

## 与 FIXES / 已知限制对照

- **incomplete-fix（3 条）**：
  - R6-01 ← FIXES P1-4 声称删除 openTabOnPlan，实际残留 `config.js:94`；
  - R6-02 ← AUDIT 5.1 已判“半死”，P1-4 未修；本轮定位到 apply 视图而非 schema；
  - R6-04 ← AUDIT 5.2 已列，R4-5 声称“本就不存在”，实际 `artifacts/stepId` 仍在。
- **new（13 条）**：R6-03、R6-05、R6-06、R6-07、R6-08、R6-09、R6-10、R6-11、R6-12、R6-13、R6-14、R6-15、R6-16。
- **已知限制（本轮不重复展开）**：
  1. `document-specialist / explore / orchestrator` 无路径派发（用户要求内置角色不扩展）；
  2. 角色权限不是沙箱（`toolFilter` 从不下发，README 已如实说明）；
  3. `localAgent` 解析不到时看门狗不建，且墙钟默认关闭（AUDIT P2-9）；
  4. `readonly` 只是提示词约定，不是强制边界。

## 修复状态（2026-10-20 收尾）

16 条结论的处理结果：**修 14 / 不修 1（R6-16，非缺陷）/ 记入已知限制 1**。下面逐条对上提交。

| ID | 状态 | 修法要点 | 验证 |
|---|---|---|---|
| R6-07 | ✅ 已修 | `hits()` 不再按 locale 过滤词池（语言只影响界面文案） | 回归测试：`en` 下中文安全任务仍 `full/risk2` |
| R6-09 | ✅ 已修 | 图指纹改用 `plannedDeps`（计划期快照） | 回归测试：运行期补依赖指纹不变、计划期变更仍失效 |
| R6-08 | ✅ 已修 | 启动前把遗留 `running` 复位为 `pending`（epoch+1） | 回归测试 + 探针 `probe-lost-on-crash` 转 NOT-REPRODUCED |
| R6-02 | ✅ 已修 | schema + apply 视图 + 设置卡片三处补齐 | 探针 `probe-watch-keys` 转 NOT-REPRODUCED |
| R6-15 | ✅ 已修 | full 路径 `security.deps` 改为 `executor` | `test/scheduler.test.mjs` 断言同步更新 |
| R6-13 | ✅ 已修 | `readEvents` 改尾部倒读 | 12000 行取 80 条 10.68ms → 1ms；探针转 NOT-REPRODUCED |
| R6-05 | ✅ 已修 | `runLoop` 带 `disabled` + `resolveRole` 回退只看可用角色 | 回归测试：批准后停用 `code-reviewer` 不再派发 |
| R6-11 | ✅ 已修 | `purpose` 只在真正生成新图时更新 | 回归测试：被拒的 plan 不改旧图目标 |
| R6-06 | ✅ 已修 | 独立心跳定时器（`LOOP_STALE_MS/12` 刷新，unref + 退出清理） | 静态（1 小时实等待不可行，探针口径一致） |
| R6-10 | ✅ 已修 | 归档成为重建前置条件，失败即中止 | 静态 + 错误路径返回原因 |
| R6-12 | ✅ 已修 | 启动期写盘失败时撤销占位并清定时器 | 静态 |
| R6-01 | ✅ 已修 | `resolveUi` 彻底删除 `openTabOnPlan` | 探针 `probe-dead-config` 转 NOT-REPRODUCED |
| R6-03 | ✅ 已修 | `ambiguous` 进决策记录与返回值，并在 notes 里提示 | 静态 + 返回字段 |
| R6-04 | ✅ 已修 | `summarize.ready` 改为真实计算、删 `skipped`/`artifacts`/`stepId` | 静态 |
| R6-16 | — 非缺陷 | 过度限制方向未发现误伤；`RUNS_PAGE` 有"更多"按钮 | 探针 `probe-limits` NOT-REPRODUCED |
| R6-14 | 📌 已知限制 | `readRunRecords` 同样全量读；当前 2 条/3.6KB，量级未到 | 记录在案 |

**修完后的完整证据**：

```
node --test "test/*.test.mjs"        → 235 passed
node docs/audit-r6/run-all.mjs       → 5/5 跑完，5 项全部 NOT-REPRODUCED
node docs/gate-probe-standalone.mjs  → 15 项通过
```

> 探针 `probe-events-growth` 自身的判据也修了：原来把 `LINES/80` 这个文件常量当"读取放大倍数"，
> 与实现是否全量读无关，导致修好之后仍报 REPRODUCED。现改为实测「当前实现 / 尾部基线」耗时比 > 3 才算复现。

## 复现与证据

```bash
# 1) 基线：229 条测试
node --test "test/*.test.mjs"                    # exit 0 / 229 passed / 12.3s

# 2) 六维探针 + coverage 校验
node docs/audit-r6/run-all.mjs                   # exit 0 / 5/5 跑完
node docs/audit-r6/run-all.mjs --only=probe-watch-keys

# 3) 旧门控骨架复跑（critic 第 5 条：确认未过期）
node docs/gate-probe-standalone.mjs              # exit 0 / 7 项 ✓ / 无 ✗
```

`run-all.mjs` 的退出码与“是否找到 bug”解耦：**0 = 探针全部跑完且六维覆盖校验通过**；`reproduced=false` 作为结果数据记录（critic 第 2 条）。当前 5 个探针的结果：

| 探针 | 维度 | 结果 |
|---|---|---|
| probe-watch-keys | hardcoded | REPRODUCED |
| probe-events-growth | over-consumption | REPRODUCED |
| probe-dead-config | dead-path | REPRODUCED |
| probe-lost-on-crash | task-loss | REPRODUCED |
| probe-limits | over-restriction | NOT-REPRODUCED（未发现误伤） |

证据文件：

- [findings.json](findings.json)：16 条 finding + 六维 coverage + 探针清单
- [run-all.mjs](run-all.mjs)：探针编排与校验
- [probe-watch-keys.mjs](probe-watch-keys.mjs)、[probe-events-growth.mjs](probe-events-growth.mjs)、[probe-dead-config.mjs](probe-dead-config.mjs)、[probe-lost-on-crash.mjs](probe-lost-on-crash.mjs)、[probe-limits.mjs](probe-limits.mjs)
- [run-all-output.txt](run-all-output.txt)：探针完整输出
- [gate-probe-rerun.txt](gate-probe-rerun.txt)：旧门控骨架复跑输出（7 项 ✓，无 ✗）
- [test-output.txt](test-output.txt)：229 条测试完整输出

只读证明：`git status --short` 仅显示 `?? docs/audit-r6/` 与 `?? docs/AUDIT-R6.md`；`git diff --stat` 为空。
