# 封存说明（2026-11-01）

项目暂停开发，插件已从 DSH 插件库移除。本文件记录**恢复方法**与**已知未完成项**。

## 一、怎么重新装回去

插件是**符号链接**方式挂到 DSH profile 的（开发态），重装：

```
plugin_manager( action: "install_bundle", target: "F:\\XMT\\DSHWorkspace\\test\\dsh-teams" )
```

或命令行：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "file:F:\XMT\DSHWorkspace\test\dsh-teams"
```

装完**必须重启 DSH**（宿主侧 `index.js` 与客户端 `client.js` 都在加载时才生效）。

> 上一轮移除时 `remove_bundle` 只清了 profile 配置，`node_modules` 里的符号链接要手动删
> （删链接本身，不是删目标仓库）。本次已清干净。

## 二、当前状态

| 项 | 值 |
| --- | --- |
| 仓库 | `F:\XMT\DSHWorkspace\test\dsh-teams` |
| 分支 | `main` |
| 最后提交 | 见 `git log --oneline -1` |
| 远端 | https://github.com/xmt-88/dsh-teams |
| 测试 | `node --test "test/*.test.mjs"` → **386 通过** |
| 门控探针 | `node docs/gate-probe-standalone.mjs` → 7 ✓ |
| 依赖 | `node_modules/@deepseek-ai/*` 是指向 DSH 安装目录的联接，DSH 升级后可能需要重做 |

## 三、已知未完成项（明确留给以后）

1. **完成不回传队长**（审计 HIGH）
   当前 `lib/runner.js` 传 `delivery: 'caller'`（结果回到插件手里喂给下游），
   宿主 spec 支持 `delivery: 'parent'`（结果投递到父会话收件箱）。
   改成 `'parent'` 可能让 `activation.result` 不再返回，**必须先真机验证再改**。

2. **子代理不能中途汇报/求助**
   需要常驻可续聊成员（`ctx.agentTeams` + `spawn_teammate`），等于换运行时，
   与「一次性派发 + 单写者状态」的设计冲突，属于大改。

3. **权限档仍不是强制隔离**
   只读档子代理实际持有 write/edit/bash（`toolFilter` 只在 agentPreset 通路生效）。
   现在靠「提示词约束 + 事后检测」兜（越界会记 `permissionViolation` 并追加 warn 事件）。

4. **真机点击验证未完成**
   面板「批准并启动」在真实宿主里还没被人点过一次并确认派发成功
   （代码链路已用集成测试覆盖，但缺真机证据；上一轮测试门就是因此判 BLOCKED）。

## 四、文档索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 面向 GitHub 的总览：五条路径、闸门、角色契约、安装 |
| `docs/AUDIT-FOUR-DIMENSIONS.md` | 四维度审计摘要（宏观/运行/代理体系/交互） |
| `docs/VS-AGENT-TEAMS.md` | 与 `NanmiCoder/dsh-agent-teams` 的三轴对比 |
| `docs/FIXES.md` | 历次修复记录 |
| `docs/AUDIT-R6.md` | 早期审计报告 |
