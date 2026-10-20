# 审计发现 → 修复 → 验证 对照表

审计日期：2026-10-20
范围：第一轮（三路独立审计 + 探针）、第二轮（复审修复）、第三轮（复审新修复）

约定：**每条都能追到"怎么验证的"**。测试在 `test/gates.test.mjs` / `test/host.test.mjs`，
探针在 `docs/gate-probe-standalone.mjs`（手动运行）。

---

## 第一轮（P0：质量门名不副实）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| P0-1 | 验证员写「结论：FAIL」仍记 `done`，团队判绿 | 新增 `lib/verdict.js`：门类任务（review/verification）从产出解析 `VERDICT: PASS\|FAIL\|BLOCKED`，缺行按未通过（fail-closed）；`settleTask` 据此定状态；四个门角色的契约补判定小节 | 探针 H：`phase=failed`；测试「验证员判 FAIL → 团队失败」 |
| P0-2 | 质量门不存在（`maxReviewRounds` 零消费，没有驳回闭环） | `settleTask` 判 FAIL 时把实现步骤打回 `pending`，门自己也重排；轮数受 `maxReviewRounds`；驳回意见进 `reviewFrom` 并注入任务卡 | 测试「驳回退回重做」「预算用尽后仍判 FAIL」「评审意见带进任务卡」；实测执行者被派发 3 次后通过 |
| P0-3 | 派发期 TDZ 异常被 `allSettled` 吞 → 任务永久 running、团队假绿 | `let liveAgent` 提到 `finish()` 之前；`dispatchOne` 外层兜底落 `failed`；`allSettled` 的 rejection 记事件；收口要求无 `running`/`pending` | 探针 A：`phase=failed`（此前 `done`）；测试「预置 running 任务不得秒完成」 |
| P0-4 | 角色权限分层是死字段（`toolFilter` 从不下发） | 删掉「（宿主强制）」的虚假表述，改为「提示词约束，不是宿主沙箱」，并在任务卡里明说实际工具由宿主授予 | 静态（`runner.js:223` 附近） |
| P0-5 | 验收项写死「构建或类型检查通过」→ 非 JS/非软件项目必然 FAIL | `tasks.js` 与 `verifier.md`/`executor.md` 改为「项目自身可用的验证手段（构建/类型检查/测试/静态检查，按实际存在者）；不存在则记『不适用』」 | 测试断言「不得写死构建/类型检查环节」 |

## 第一轮（P1：闸门与一致性）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| P1-1 | 批准闸门判据是 `phase !== 'staged'`（黑名单），`done`/`idle` 都能不批准就跑 | 改白名单：`approvedAt` 存在 **且** 任务图指纹一致；`approveTeam` 不再改 `phase`（保持 staged），另记 `approvedGraph` | 探针 D/F：`started=false` 且零派发；测试「批准后改图拒绝启动」「记录重建后拒绝」 |
| P1-2 | 运行中 `teams_plan(rebuild)` 换图，新图被旧循环执行 | `planTeam` 在 `activeLoops` 有该队时直接拒绝 | 测试「运行中拒绝重建」 |
| P1-3 | 并发 `teams_run` 起两条循环（检查与占位之间有 await） | `activeLoops.set` 紧跟检查、同步完成；僵尸锁按心跳接管 | 测试「重复调用不起第二个循环」 |
| P1-4 | 8 个配置项是死的 | `routing.riskShortCircuit/fastMax/standardMax` 接进 `route()`；`gates.requireEvidence/securityBlock` 接进 `settleTask`；`maxReviewRounds` 接进驳回；`ui.locale` 传进路由；`ui.openTabOnPlan` 删除（客户端无法实现自动开标签） | 探针 G 显示开关有差别；测试「阈值改路径跟着变」「证据门开关行为不同」 |
| P1-5 | 无停止入口（`stopRun` 导入未用） | 新增 `teams_stop` 工具 + `/teams-stop` 命令；收口统一到 `finalizeRun`（正常/停止/异常三出口，停止落 `halted`） | 测试「停止后不再派发」「停止后不停在 running」 |
| P1-6 | 事件流无锁读-改-写（20 条并发落 1 条），读失败会覆盖整个历史 | `appendJsonl` 改真追加（`appendFile`）；`readJson` 区分 ENOENT 与解析失败（损坏改名留档） | 测试「20 条并发必须全部落盘」；实测 20/20 |
| P1-7 | 调度循环异常退出不落 phase | `finalizeRun` 也在 `.catch` 里调用 | 静态 + 探针 A |

## 第一轮（P2）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| P2-1 | 系统提示段只列 6 个工具 | 补到 10 个工具 + `/teams-stop`/`/teams-retry`，并写明判定与角色规则 | `host.test.mjs` 断言提示段含工具名 |
| P2-2 | 英文风险词只认单数（9/9 漏） | 改**词干比对**（`credentials`→`credential`、`authentication`→`authenticat`、`OAuth2`→`oauth`）；中文补退款/令牌/会话/签名/隐私/交易 | 测试「屈折形式命中」「不误报（author ≠ auth）」；探针 J 6/6 |
| P2-3 | `teams_approve` 是模型可自调的无参工具 | 接宿主审批通道：有 `approval` 服务时 `approval.request`，用户拒绝则不批准；无通道时记 `approve-unconfirmed` | 测试「用户拒绝 → 不批准」「无通道留痕」 |
| P2-4 | 重试时 attempt 条目永不闭合、编号每轮重算 | `continue` 前把当前 attempt 标 `failed`；编号从已有记录续 | 静态 + 面板可读性 |
| P2-5 | 3 个角色永不派发（document-specialist / explore / orchestrator） | **未改路径模板**（用户要求内置角色不扩展）；它们仍可通过自定义角色或后续自定义步骤使用。已知限制，记录在案 | — |

## 第二轮（复审发现的 6 项）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| R2-1（高） | **判定 fail-open**：正文后部贴一段示例 `VERDICT: PASS` 就能把真实 FAIL 翻成 PASS | `parseVerdict` 收紧：剥围栏代码块 → 只看结尾 5 行 → **必须独立成行** → 出现两个不同判定视为歧义（fail-closed） | 测试「结尾示例不能翻案」「回显指令不算」「围栏内示例剥离」「行内提到不算」「两个不同判定判歧义」 |
| R2-2（中） | 驳回时**在飞的门**会用旧代码的结论落盘且不再重跑；`simplify` 从不重做 | 新增**派发世代 epoch**：驳回时给"传递依赖闭包"里所有任务 `epoch+1`，`settleTask` 比对世代，不符就丢弃（`task.discarded`）；重开范围含 `kind=work` 的后置步骤 | 实测：延迟返回的 `test-engineer` 结果被丢弃并重跑；`code-simplifier` 也重做 |
| R2-3（中） | 僵尸锁接管后旧循环仍活着，`.finally` 会删掉新锁 → 重复派发 | handle 带 `runId`，`.finally` 只在 runId 匹配时删锁；接管时 abort 旧循环 + 给 running 任务 `epoch+1` 并改回 pending | 静态 + 接管路径有事件记录 |
| R2-4（中） | `roles-state.json` 无锁读改写（6 个并发停用只落 1 个）；接口接受不存在的角色 | 新增 `setRoleEnabled`（读-改-写全在 `withLock` 内）；toggle 前校验角色存在 | 测试「6 个并发停用全落盘」「不存在的角色被拒绝」；实测 6/6 |
| R2-5（中低） | 角色接口固定 `roots[0]`，多工作区读写错区；`/roles/body` 回整份 md（frontmatter 会混进契约） | 新增 `stateRootFor()`（按请求 workspace 解析，必须在候选根内）；body 接口剥掉 frontmatter；客户端带上 workspace | 测试「正文接口只回正文」 |
| R2-6（低） | 任务图指纹漏字段（subject/objective/order/workspace） | 指纹补这些字段 | 测试「改任一字段指纹必变」 |

## 第三轮（复审这批修复本身）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| R3-1（P0） | **派发无限热循环**：`dispatchEpoch` 的 `const` 声明晚于"找不到角色"早退路径 → TDZ ReferenceError 被循环吞掉（实测 3 秒 7395 条事件、任务恒 pending、phase 永停 running） | 声明上移到函数开头（任何早退之前） | 实测角色缺失 → `phase=failed` 且干净收口；探针 A 组同样通过 |
| R3-2（中） | `stateRootFor` 匹配不上时**静默回落 `roots[0]`** → 带别的工作区的请求写进了第一个工作区 | 匹配不上返回 400 `unknown workspace`；前缀比对按路径分隔符边界（`C:/work/a` 不再误配 `C:/work/ab`） | 测试「未知 workspace 返回 400」「带正确 workspace 时读写同一区」 |
| R3-3（中） | `parseVerdict` **误杀合法产出**：`VERDICT: PASS（无阻塞项）`、尾随破折号、整段被围栏包住、判定后还有几行 → 全判 undefined | 行首锚定（允许 `-`/`**`/`>` 装饰）+ 行尾允许说明 + 同一行多个判定词视为"回显格式" + 结尾 8 行 + 剥围栏后为空则退回原文 | 测试 13 种写法：8 种合法形式认得出，回显/歧义/缺行仍 fail-closed |
| R3-4（中低） | **`stop` 的 abort 是空操作**（`runTask` 没有 `signal` 形参）→ 停止只能等整批跑完，墙钟关闭时可能永远停不下来 | `runTask` 接收 `signal` 并桥接到内部 controller；`dispatchOne`/`runLoop` 串下去；错误信息区分"已停止"与"超时" | 测试「停止打断在跑的子代理」：实测 52ms 收到 abort |
| R3-5（中） | `task.discarded` **只写不读**：丢弃结果时用户完全看不到 | 丢弃时写一条 warn 事件；快照 `compactTask` 带上该字段 | 测试「丢弃过期结果时事件流留痕」 |

## 第二轮（测试质量）

| 问题 | 修复 |
|---|---|
| `gates.test.mjs` 里 `calls.lastIndexOf('executor')` 恒为 -1 → 排序断言恒真 | 改用 `calls.map(label => label.includes('t-executor:')).lastIndexOf(true)` |
| 「验证员写 FAIL」用例里 review 先挂，verifier 从未派发 | 只让 verifier 判 FAIL，review 保持 PASS |
| 缺测：判定边界、`maxReviewRounds=0`、并发停用、指纹漏字段、正文接口 | 全部补上（206 条） |

---

## 第四轮（验证第三轮修复 + 收尾）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| R4-1（P1） | **派发期异常没有兜底**：`dispatchOne` 抛错时任务恒 `pending`，下一轮又被挑中 → 事件流无界增长（实测 6 秒 3438 条）、phase 永停 running | `runLoop` 的 batch 加 `.catch` → `settleTask(failed)`；`settleTask` 对缺 `attempts`/`evidence` 的畸形记录做补齐（它自己一抛，兜底也失效） | 测试「零进展护栏」；实测缺 `attempts` 时 53ms 收口 |
| R4-2（P1） | **停止后不能续跑**：aborted 结果被判 `failed`，而 `halted` 只重置 `running` → 再 `teams_run` 零派发 | `runTask` 在用户停止时返回 `stopped:true`，调度器据此把任务留 `pending`（attempt 记 `stopped`） | 测试「停止后续跑（真实 abort 路径）」：`halted` → 全 `pending` → 续跑到 `done` |
| R4-3（建议） | `workspace` 用前缀匹配，传父目录会落到子工作区 | 改为**精确匹配**（剥掉 stateDir 后缀后比较） | 测试「未知 workspace 400」「正确 workspace 200」 |
| R4-4（建议） | `hasEvidence` 把 `08:52` 当"文件:行号" | 冒号前必须是路径（含目录分隔符或扩展名） | 单元测试：`src/app.js:42` 通过，`08:52`/`1:2` 不算 |
| R4-5（建议） | 只写不读字段：`staleVerdict`/`blockedBy`/`artifacts`/`stepId` | 前两个删除或改为事件，后两个本就不存在 | 扫描脚本确认清零 |

## 已知限制（记录在案，非缺陷）

1. **3 个内置角色未被任何路径派发**（`document-specialist` / `explore` / `orchestrator`）。
   按用户要求内置角色固定 16 个、不扩展路径，因此保持现状；需要时可作为自定义角色复制改造。
2. **角色权限不是沙箱**：DSH 0.2.1 起子代理不接受 `toolFilter`，`readonly` 只是契约里的行为约定。
   已在任务卡里如实说明，不假装是强制边界。
3. **看门狗的"假活跃"盲区**：子代理持续输出事件但不出结果时，只能靠墙钟（默认关闭）兜底。
   这是刻意的取舍（用户明确不要墙钟门），记录在案。
4. **停止后可以续跑**：`teams_stop` 把团队落到 `halted` 并把在飞任务改回 `pending`（结果作废），
   再次 `teams_run` 即从断点继续（不需要重新批准，任务图未变）。已在测试里覆盖。

---

## 复核方式

```bash
cd F:\XMT\DSHWorkspace\test\dsh-teams
node --test "test/*.test.mjs"          # 206 条
node docs/gate-probe-standalone.mjs    # 门控行为探针（A–J）
node docs/dead-config-scan.mjs         # 死配置扫描（应只剩 openTabOnPlan 的"已移除"提示）
```
