# 四维度体系化审计（摘要）

> **这是人工整理的摘要，不是原文。**
> 原始报告（4 份，约 45KB）随工作区状态被后续轮次覆盖；正文仍在子会话日志里：
> `~/.dsh/sessions/--F-XMT-DSHWorkspace-test--/<childId>/session.v4.jsonl.zstd`
> —— 多帧 zstd，按 magic `28 B5 2F FD` 切片后逐片解压；报告是**以 `### 结论` 开头**的那段正文。
> （试过自动恢复，抓到的是模型的思考流而非最终报告，故改为人工摘要，宁缺勿错。）
>
> 审计方式：注册 4 个 `readonly` 自定义角色，用触发词插入完整路径，**四个并行**跑 28–43 分钟，
> 各自只读、各管一个维度，产出汇入实现步骤。

---

## 一、宏观架构与链路完整性 —— **FAIL**

### 分层（单向无环）

```
index.js          宿主适配层：11 个工具 + 系统提示 + 装配 Web 路由与斜杠命令
lib/commands.js   7 个斜杠命令 → scheduler / state / roles
lib/web-routes.js 7 条路由    → scheduler / state / roles / runner
lib/scheduler.js  编排核心：plan/approve/start/runLoop/dispatch/settle/finalize/retry/stop
lib/runner.js     单个子代理：persona / 任务卡 / startActivation / 看门狗
tasks·roles·router·verdict  纯领域模块
state·config·role-state     基础设施
client.js         独立 bundle，只经 HTTP 与宿主通信
```

### 关键发现

| 等级 | 位置 | 问题 |
| --- | --- | --- |
| **HIGH** | `runner.js:444`、`scheduler.js:695`、`commands.js:174` | **运行结束只写磁盘，不回传队长**。`teams_run` 立即返回、提示又要求「不要反复轮询」→ 模型无从得知何时收口；`needing-decision` 也无人知。宿主 spec 有 `delivery: 'parent'`，当前用 `'caller'` |

### 最有价值的一句

> 「同一『启动』能力在**三个适配层各自获取 Agent**，而人工闸门只装在一处 —— 这是缺陷反复修不净的结构原因。」

---

## 二、运行逻辑与状态机 —— **PASS**

未发现重复派发、丢工作、无限热循环：

- 内存锁占位与检查之间**无 await 窗口**（`scheduler.js:344-360`）
- 批次并行受 `pickReady` 切片约束（`tasks.js:363`）
- `epoch` 世代守卫能丢弃迟到结果（`scheduler.js:1081`）
- 崩溃残留有懒惰自愈（`scheduler.js:393`）

查出 3 个 MEDIUM（收口/兜底缺口）+ 2 个 LOW，均非阻断。

### 状态机（摘）

| 对象 | 写点 | 读点 |
| --- | --- | --- |
| `phase` | 219 / 416 / 766 | 189 / 200 / 558 |
| `task.status` | 61/499/720/748/971/1121/1196 → 923 → 1098/1096/617/1121/974 | 347-358、326/334、756-764、489 |
| `task.epoch` | 379/719/747/1194/1208 | **唯一读点 1081** |
| `attempts[].status` | 925(start)/974(stopped)/1271(终态) | **丢弃分支无写点** |

---

## 三、代理体系与权限落地 —— **FAIL**（可移植性是好消息）

### 角色可移植性

- 内置 16 个角色：**项目名 / 技术栈 / 路径硬编码 0 处** ✓
- 唯一勉强算耦合的：`verifier.md` 以「纯 Python 无 mypy」举例
- **但**任务卡写死了 `win_bash` 与 `F:\MT\...`（实际工作区是 `F:\XMT\...`）—— 子代理当场发现
- 内置角色**不参与**触发插入（`router.js:414`）→ 「按项目自动适配专业」实际是**用户预注册角色 + 关键词命中**，不是技术栈识别
- 触发词子串匹配无词边界 → `ui`、`go` 会误命中 `build`、`google`

### 权限落地（关键）

| 声明 | 实际机制 | 能否绕过 |
| --- | --- | --- |
| readonly / readwrite / execute | 只生成 `toolFilter` 字段（`roles.js:54-67,145`），**派发时从不传入**（`runner.js:427-441`） | **能**：只读档实际持有 write / edit / bash |

审计当时判断「DSH 0.2.1 已移除 toolFilter」；**后续核实宿主仍支持** `composition.toolFilter`，
但要经 agentPreset/descriptor 通路，一次性派发拿不到。
最终处理：**不假装能限制** → 「提示词约束 + 事后越界检测」，并删掉 README 里的假说法。

### 三条沟通链

| 链路 | 现状 |
| --- | --- |
| 上游 → 下游 | `collectDependencyOutputs` 仅 done/skipped，6000/24000 上限，尾部保 VERDICT ✓ |
| 子代理 → 队长 | ❌ 单向，不能中途汇报或求助 |
| 用户 → 子代理 | `team.notes` 注入任务卡，**只影响之后派发的步骤**，已完成不回溯 |

---

## 四、交互与逐步操作 —— **FAIL**

### 操作路径（摘）

| 步 | 用户看到 | 死路 |
| --- | --- | --- |
| 提需求 | 对话；面板空态 | 否 |
| 看计划 | 运行卡 + 流程图 + 两个按钮 | 否 |
| 点批准 | 审批区**立即消失**，无 busy 态 | 15s 反馈真空 |
| 500 已批准 | 固定文案「已批准，但启动失败」 | **原因不可知** |
| failed / halted / 需决策 | 只有 findings 详情 | **无任何出口** |
| 崩溃后 running | 只有「停止」 | **点停止提示"已结束"** |

### 两条死路

| 条件 | 现象 | 位置 |
| --- | --- | --- |
| `phase` 为终态 | 无重试/继续按钮；全文检索 `teams-retry` 命中 0 | `web-routes.js:553/586/639/693/798/848/883` |
| 宿主重启后仍 running | `current` 恒 true、`canApprove` 要求 staged → 无启动入口 | `scheduler.js:414-418,1326-1328` |

### 三条 HIGH

1. **失败原因被丢弃**：已解析的 `reason` 在 `approved` 分支被固定文案覆盖；服务端 500 的
   `reason` 是常量、真异常在 `detail` 且前端从不读
   （审计纠正了上游定位：丢弃在 `client.js:1242`，不是 2550）
2. **终态无出口**
3. **僵尸轮次无恢复入口**

---

## 五、后续处理

| 审计结论 | 处理 |
| --- | --- |
| 三处各自取 Agent | ✅ `lib/captain.js` 收敛，工具/命令/路由共用 |
| 失败原因到不了面板 | ✅ 500 透传真实 reason，面板显示具体原因 |
| 终态无出口 | ✅ 新增 `POST /retry` + `resumeTeam`，面板「继续」 |
| 僵尸轮次无入口 | ✅ 快照 `stale`，面板「恢复派发」 |
| 权限不落地 | ⚠️ 改事后检测（`permissionViolation` + warn 事件）+ 文档如实，未强制隔离 |
| 任务卡硬编码环境 | ✅ 通用占位 + 不写死 shell 工具名 |
| 触发词无词边界 | ✅ 英文按词边界匹配 |
| 完成不回传队长 | ⏳ **未做**：`delivery: 'caller'` → `'parent'` 需真机验证 |
| 子代理不能中途汇报 | ⏳ **未做**：需常驻可续聊成员（换运行时） |
