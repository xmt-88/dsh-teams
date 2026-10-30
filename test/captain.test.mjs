/**
 * 审计四条修复的单测：共享的取 Agent 解析器、触发词词边界、只读档越界扫描。
 *
 * 三条通路（工具 / 命令 / HTTP）不再各写一份取法：它们都调 `resolveCaptain`。
 * 这里直接测那**一份**实现，外加两边调用方必须满足的形状约束。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveCaptain, resetCaptainsForTests, CAPTAIN_REASONS, captainRegistrySize } from '../lib/captain.js';
import { buildTriggerMatcher, adaptSteps } from '../lib/router.js';
import { collectWriteCalls, buildTaskPrompt } from '../lib/runner.js';

const AGENT = { id: 'session-1', session: { header: { cwd: 'D:/work/team' } } };

test('取队长 Agent：入口自带的活 Agent 直接用，并登记下会话 id（HTTP 通路靠它兜底）', () => {
  resetCaptainsForTests();
  const resolved = resolveCaptain({ agent: AGENT, source: 'tool' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.agent, AGENT);
  assert.equal(resolved.captainSessionId, 'session-1');
  assert.equal(resolved.workspace, 'D:/work/team');
  assert.equal(captainRegistrySize(), 1, '工具/命令调用必须把活 Agent 登记下来');
});

test('取队长 Agent：没有 lookup 能力时，同一进程登记过的 Agent 仍能解析（面板点击与工具同进程）', () => {
  resetCaptainsForTests();
  resolveCaptain({ agent: AGENT, source: 'tool' });
  const viaHttp = resolveCaptain({ captainSessionId: 'session-1', source: 'http' });
  assert.equal(viaHttp.ok, true, '没有 agents 服务时不应直接判死');
  assert.equal(viaHttp.agent, AGENT);
  assert.equal(viaHttp.cached, true);
});

test('取队长 Agent：宿主 lookup 命中优先于登记表（会话 resume 后宿主里那个才算数）', () => {
  resetCaptainsForTests();
  resolveCaptain({ agent: AGENT, source: 'tool' });
  const fresh = { id: 'session-1', session: { header: { cwd: 'D:/work/fresh' } } };
  const resolved = resolveCaptain({ captainSessionId: 'session-1', lookup: () => fresh, source: 'http' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.agent, fresh, 'lookup 必须优先，避免用到陈旧句柄');
  assert.equal(resolved.workspace, 'D:/work/fresh');
});

test('取队长 Agent：失败原因分层且三入口共用（缺会话 / 无服务 / miss / 抛错 / 形状非法）', () => {
  resetCaptainsForTests();
  const noSession = resolveCaptain({ agent: undefined, source: 'tool' });
  assert.deepEqual(
    [noSession.ok, noSession.reasonCode],
    [false, 'no-session'],
    '工具没拿到 agent 时必须明确失败',
  );

  const noService = resolveCaptain({ captainSessionId: 's', source: 'http' });
  assert.equal(noService.reasonCode, 'no-service');

  const miss = resolveCaptain({ captainSessionId: 's', lookup: () => undefined, source: 'http' });
  assert.equal(miss.reasonCode, 'miss');
  assert.equal(miss.reason, CAPTAIN_REASONS.miss);

  const threw = resolveCaptain({
    captainSessionId: 's',
    lookup: () => {
      throw new Error('boom');
    },
    source: 'http',
  });
  assert.equal(threw.reasonCode, 'lookup-threw');
  assert.match(threw.reason, /boom/, '真实异常要透传，不能吞成一句话');

  const invalid = resolveCaptain({ captainSessionId: 's', lookup: () => ({ session: {} }), source: 'http' });
  assert.equal(invalid.reasonCode, 'invalid-agent', '缺 id 的 Agent 不能当 parent 用');
});

test('触发词：按词边界匹配，build 不再命中 ui、google 不再命中 go；中文仍按子串', () => {
  const uiMatcher = buildTriggerMatcher(['ui']);
  assert.equal(uiMatcher('重新 build 一下'), false, 'build 里的 ui 不算命中');
  assert.equal(uiMatcher('调整界面 ui 细节'), true, '独立出现的 ui 要命中');

  const goMatcher = buildTriggerMatcher(['go']);
  assert.equal(goMatcher('接入 google 登录'), false, 'google 里的 go 不算命中');
  assert.equal(goMatcher('用 go 写个服务'), true);

  // 中文没有词字符：必须保持子串语义
  const zhMatcher = buildTriggerMatcher(['界面']);
  assert.equal(zhMatcher('优化登录界面细节'), true);

  // 正则元字符要被转义，不能当量词用
  assert.equal(buildTriggerMatcher(['c++'])('迁移到 c++11'), true);
  assert.equal(buildTriggerMatcher(['c#'])('c# 项目'), true);
  assert.equal(buildTriggerMatcher([])('anything'), false);
});

test('触发词：大小写不敏感（角色写 UI / Go 也按词边界命中，不能因大小写漏召回）', () => {
  const uiMatcher = buildTriggerMatcher(['UI']);
  assert.equal(uiMatcher('调整 ui 间距'), true, '大写触发词要命中小写正文');
  assert.equal(uiMatcher('重新 build 一次'), false, '大小写不敏感也不能把 build 当 ui');

  const goMatcher = buildTriggerMatcher(['Go']);
  assert.equal(goMatcher('用 GO 写个服务'), true);
  assert.equal(goMatcher('接入 google 登录'), false);
});

test('触发词：路由插入专家时同样走词边界（integration）', () => {
  const steps = [
    { id: 't-executor', role: 'executor', kind: 'implementation', deps: [], order: 1 },
    { id: 't-verifier', role: 'verifier', kind: 'verification', deps: ['t-executor'], order: 2 },
  ];
  const expert = (slug, triggers) => ({ slug, name: slug, builtin: false, enabled: true, triggers });

  const notTriggered = adaptSteps(steps, { roles: [expert('ui', ['ui'])], matchText: '重新 build 一次' });
  assert.ok(!notTriggered.some((step) => step.id === 'expert-ui'), 'build 不应把 ui 专家拉进来');

  const triggered = adaptSteps(steps, { roles: [expert('ui', ['ui'])], matchText: '调一下 ui 间距' });
  assert.ok(triggered.some((step) => step.id === 'expert-ui'), '命中触发词时仍要插入专家');
});

test('三入口共用同一实现：工具 / 命令 / HTTP 都调 resolveCaptain，不再各自写一份取法', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const index = read('index.js');
  const commands = read('lib/commands.js');

  assert.match(index, /resolveCaptain\(\{ agent: exec\?\.agent, source: 'tool' \}\)/, '工具路径必须走共享解析器');
  assert.match(index, /source: 'http'/, '面板（HTTP）路径必须走共享解析器');
  assert.match(commands, /resolveCaptain\(\{ agent: invocation\?\.agent, source: 'command' \}\)/, '命令路径必须走共享解析器');
  // 旧的取法必须彻底消失：它就是缺陷 A/B 反复修不净的结构原因
  assert.doesNotMatch(index, /ctx\.get\('agents'\)\?\.get\?\./, 'index.js 不得再有裸 lookup 分支');
  assert.doesNotMatch(commands, /String\(invocation\.agent\.id\)/, '命令不得再自行拼 captainSessionId');
});

test('只读档越界：扫到 write/edit/bash 就报出来，只有读操作时不误报', () => {
  const writeChild = {
    session: {
      ownEvents: () => [
        { type: 'step/start', data: {} },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', toolName: 'Edit' }] } } },
        { type: 'tool/call', data: { name: 'bash' } },
        { type: 'turn/end', data: { turn: 1 } },
      ],
    },
  };
  assert.deepEqual(collectWriteCalls(writeChild), ['bash', 'edit'], '写操作要按名字去重排序报出');

  const readOnlyChild = {
    session: {
      ownEvents: () => [
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', toolName: 'read' }, { type: 'tool-call', toolName: 'grep' }] } } },
      ],
    },
  };
  assert.equal(collectWriteCalls(readOnlyChild), undefined, '只读操作不得误报越界');

  // 拿不到会话事件时不能抛错（否则会把一次正常的收口搞失败）
  assert.equal(collectWriteCalls(undefined), undefined);
  assert.equal(collectWriteCalls({ session: { ownEvents: () => { throw new Error('no events'); } } }), undefined);
  assert.equal(collectWriteCalls({ session: { ownEvents: () => 'nope' } }), undefined);
});

test('HTTP 通路必须把宿主 lookup 交给解析器（登记表陈旧时仍有权威来源）', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(
    index,
    /lookup: typeof agents\?\.get === 'function'/,
    '面板 HTTP 路径必须传 lookup = ctx.get("agents").get，否则会话 resume 后只能靠陈旧登记表',
  );
  assert.match(index, /source: 'http'/, '面板路径的 source 必须是 http（诊断用）');
});

test('文档如实：档位只是提示词约束 + 事后检测，不再声称运行时裁剪', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const readme = read('README.md');
  assert.match(readme, /不是运行时沙箱/, 'README 必须说清档位不是运行时沙箱');
  assert.match(readme, /事后检测/, 'README 必须说明越界靠事后检测');
  assert.match(readme, /permissionViolation/, 'README 要说明越界记进 evidence 的哪个字段');
  assert.doesNotMatch(readme, /toolFilter[^\n]{0,20}生效[^\n]{0,20}(裁剪|限制|不可见)/, '不得暗示 toolFilter 在本插件里强制生效');

  const roles = read('lib/roles.js');
  assert.match(roles, /不是运行时限制/, '角色定义注释必须如实');
  assert.match(roles, /与实现不符/, '旧的「未列入的工具一律不可见」必须被明说为与实现不符，而不是继续当事实');
});

test('任务卡不含具体仓库路径（跨仓库通用）', () => {
  const win = buildTaskPrompt({ task: { id: 't-exec', role: 'executor' }, platform: 'win32' });
  assert.ok(!/F:[\\/]/.test(win), '不得出现 F:\\ 或 F:/ 这类具体盘符示例');
  assert.match(win, /X:\\path\\to\\file/, '路径示例必须是盘符占位');
});

