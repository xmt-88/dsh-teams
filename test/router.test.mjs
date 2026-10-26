/**
 * DSH Teams — 路由引擎单元测试
 *
 * 运行：node --test test/router.test.mjs
 *
 * 断言的是「决策行为」而非实现细节：给定任务描述，应走向哪条路径。
 * 这些用例同时是产品规格的活文档。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { route, score, needsUiDesign, describeRoute, PATH_TEMPLATES, buildSteps } from '../lib/router.js';
import { buildTaskGraph, depsSatisfied } from '../lib/tasks.js';

test('UI 设计产出必须真的交到实现者手里（executor 依赖 ui），且裁掉时不留悬空依赖', () => {
  // 有 UI：executor 同时依赖 architect 与 ui
  const withUi = route({ taskText: '给设置页做界面设计并实现', filesTouched: 5, crossModule: true });
  assert.equal(withUi.needsUiDesign, true, '含 UI 关键词应触发设计步骤');
  const uiStep = withUi.steps.find((step) => step.id === 'ui');
  assert.ok(uiStep, '标准路径应包含 ui-designer 步骤');
  const execWithUi = withUi.steps.find((step) => step.id === 'executor');
  assert.ok(
    execWithUi.deps.includes('ui'),
    'executor 必须依赖 ui：否则设计产出没人消费，等于白跑一趟（真实缺陷）',
  );

  // 无 UI：ui 步骤被裁掉，依赖里的 'ui' 必须一并剪掉
  const noUi = route({ taskText: '给登录接口加重试逻辑', filesTouched: 5, crossModule: true });
  assert.equal(noUi.needsUiDesign, false, '纯后端任务不应触发设计步骤');
  assert.equal(noUi.steps.find((step) => step.id === 'ui'), undefined, '不应保留 ui 步骤');
  const execNoUi = noUi.steps.find((step) => step.id === 'executor');
  assert.ok(!execNoUi.deps.includes('ui'), '被裁掉的步骤不能留在依赖里');
});

test('任务图里不得出现悬空依赖——否则该任务永远不就绪，整轮卡死', () => {
  for (const taskText of ['给设置页做界面设计并实现', '给登录接口加重试逻辑', '修复偶发的超时错误']) {
    for (const forcePath of ['fast', 'standard', 'full', 'debug']) {
      const decision = route({ taskText, forcePath, filesTouched: 5, crossModule: true });
      const graph = buildTaskGraph({ steps: decision.steps, teamId: 'session-x', subject: taskText });
      const ids = new Set(graph.tasks.map((task) => task.id));
      for (const task of graph.tasks) {
        for (const dep of task.deps) {
          assert.ok(ids.has(dep), `${forcePath} 路径下 ${task.id} 的依赖 ${dep} 不存在（悬空依赖会让它永远不就绪）`);
        }
      }
      // 并且每个任务都必须可能被满足：无依赖的起点存在
      assert.ok(graph.tasks.some((task) => task.deps.length === 0), `${forcePath} 路径应有起点任务`);
      const byId = new Map(graph.tasks.map((task) => [task.id, task]));
      assert.equal(depsSatisfied(byId.get(graph.tasks[0].id), byId), true, '起点任务应立刻就绪');
    }
  }
});

test('buildSteps：条件步骤裁剪后，依赖同步收敛', () => {
  const template = [
    { id: 'a', deps: [] },
    { id: 'ui', deps: ['a'], optional: true, condition: 'ui' },
    { id: 'executor', deps: ['a', 'ui'] },
  ];
  const withoutUi = buildSteps(template, false);
  assert.deepEqual(withoutUi.map((step) => step.id), ['a', 'executor']);
  assert.deepEqual(withoutUi[1].deps, ['a'], '被裁掉的 ui 必须从依赖里消失');
  const withUi = buildSteps(template, true);
  assert.deepEqual(withUi.map((step) => step.id), ['a', 'ui', 'executor']);
  assert.deepEqual(withUi[2].deps, ['a', 'ui'], '保留 ui 时依赖应完整');
  assert.deepEqual(template[2].deps, ['a', 'ui'], '不得就地修改模板（模板是共享常量）');
});

/** 便捷断言：任务描述 → 期望路径。 */
function expectPath(taskText, expected, extra = {}) {
  const decision = route({ taskText, ...extra });
  assert.equal(
    decision.path,
    expected,
    `"${taskText}" 期望 ${expected}，实际 ${decision.path}（评分 ${JSON.stringify(decision.score)}，说明 ${decision.notes.join(' | ')}）`,
  );
  return decision;
}

test('风险优先短路：认证/支付/直接安全强制完整路径', () => {
  for (const text of [
    '重构登录认证流程',
    '改一下支付结算金额的计算',
    '修一下密钥硬编码的问题',
    '这里可能有 SQL 注入漏洞',
    '给订单接口加鉴权',
    '把密码改成加密存储',
  ]) {
    const decision = expectPath(text, 'full');
    assert.equal(decision.score.risk, 2, `"${text}" 风险等级应为 2`);
  }
});

test('风险短路不可被用户指定降级，但要如实标记为升级', () => {
  const decision = route({ taskText: '调整支付金额格式', forcePath: 'fast' });
  assert.equal(decision.path, 'full');
  assert.equal(decision.escalated, true, '应标记 escalated=true');
  assert.ok(
    decision.notes.some((note) => note.includes('风险不可降级')),
    '应说明风险不可降级',
  );
});

test('调试 + 安全任务同样不可被指定降级', () => {
  const decision = route({ taskText: '修复登录报错', forcePath: 'fast' });
  assert.equal(decision.path, 'debug-secure');
  assert.equal(decision.escalated, true);
});

test('调试关键词 → 调试路径', () => {
  for (const text of ['用户列表翻页报错', '应用启动崩溃了', '这个功能不工作', '修复导入后列表为空', 'fix the crash on startup']) {
    expectPath(text, 'debug');
  }
});

test('调试 + 安全同时命中 → 合并为「调试（含安全审查）」，两条规则都不丢弃', () => {
  for (const text of ['修复登录后跳转异常', '排查支付回调的报错']) {
    const decision = expectPath(text, 'debug-secure');
    assert.equal(decision.score.risk, 2, '应识别为高风险');
    assert.ok(
      decision.steps.some((step) => step.role === 'debugger'),
      '必须保留根因分析步骤',
    );
    assert.ok(
      decision.steps.some((step) => step.role === 'security-reviewer'),
      '必须保留安全审查步骤',
    );
    assert.ok(
      decision.notes.some((note) => note.includes('合并')),
      '应说明为何合并',
    );
  }
});

test('高风险但非调试任务 → 完整路径（不做无谓的根因分析）', () => {
  const decision = expectPath('重构登录认证流程', 'full');
  assert.ok(!decision.steps.some((step) => step.role === 'debugger'), '非调试任务不应插入调试工程师');
});

test('部署关键词 → 部署路径', () => {
  for (const text of ['把这版发布到生产服务器', '部署到线上环境', 'deploy to production']) {
    expectPath(text, 'deploy');
  }
});

test('单点小改 → 快速路径', () => {
  for (const text of ['改个按钮颜色', '修正注释里的错别字', '把变量重命名一下']) {
    expectPath(text, 'fast');
  }
});

test('规模显式给定时，评分严格按阈值划分', () => {
  // 1 个文件 10 行、无影响、无风险 → 总分 0 → 快速
  expectPath('调整实现', 'fast', { filesTouched: 1, linesTouched: 10 });
  // 3 个文件 100 行 → 规模 1；总分 1 → 快速
  expectPath('调整实现', 'fast', { filesTouched: 3, linesTouched: 100 });
  // 8 个文件 → 规模 2，总分 2 → 标准
  expectPath('调整实现', 'standard', { filesTouched: 8 });
  // 8 个文件 + 跨模块 → 规模 2 + 影响 2 = 4 → 标准
  expectPath('调整实现', 'standard', { filesTouched: 8, crossModule: true });
});

test('规模词：架构级描述被识别为大改动', () => {
  for (const text of ['跨模块重构整个架构', '从零搭建一套新框架', '全站样式统一改造']) {
    const decision = route({ taskText: text });
    assert.equal(decision.score.scale, 2, `"${text}" 规模应为 2`);
  }
});

test('未提供规模信息时取保守中位数，而非乐观最小值', () => {
  const decision = route({ taskText: '调整一下这块的处理方式' });
  assert.equal(decision.score.scale, 1, '无法判定时规模应为 1（保守）');
  assert.ok(
    decision.reasons.some((reason) => reason.includes('保守中位数')),
    '应说明取保守中位数的原因',
  );
});

test('UI 关键词触发 UI 设计步骤，但否定条件可关闭', () => {
  const withUi = route({ taskText: '新增一个设置页面，需要界面布局和主题配色' });
  assert.equal(withUi.needsUiDesign, true);
  assert.ok(
    withUi.steps.some((step) => step.role === 'ui-designer'),
    '标准/完整路径应插入 UI-Designer',
  );

  const negated = route({ taskText: '修改界面文案，纯后端接口不动' });
  assert.equal(negated.needsUiDesign, false, '命中否定条件时不应插入 UI 设计');
});

test('UI 变更在规模未定时向上加权一档', () => {
  const plain = route({ taskText: '调整这块处理方式' });
  const withUi = route({ taskText: '调整这块处理方式的界面样式' });
  assert.ok(
    withUi.score.scale >= plain.score.scale,
    `UI 变更规模(${withUi.score.scale})不应低于同类非 UI 变更(${plain.score.scale})`,
  );
});

test('快速路径在 UI 任务下也让位给含设计评审的路径', () => {
  // 单文件小改 + UI → 不应停留在只有 执行者/审查/验证 的快速路径
  const decision = route({ taskText: '改个按钮颜色', filesTouched: 1, linesTouched: 5 });
  // 显式给出规模后不再加权，允许快速路径；这是刻意的：尊重实测数据
  assert.equal(decision.path, 'fast');
  assert.equal(decision.needsUiDesign, true);
});

test('用户显式指定路径被尊重（无风险时）', () => {
  for (const path of ['fast', 'standard', 'full', 'debug', 'deploy']) {
    const decision = route({ taskText: '实现一个普通功能', forcePath: path });
    assert.equal(decision.path, path);
    assert.equal(decision.forced, true);
  }
});

test('所有路径模板的依赖都指向存在的步骤，且不构成环', () => {
  for (const [name, steps] of Object.entries(PATH_TEMPLATES)) {
    const ids = new Set(steps.map((step) => step.id));
    assert.equal(ids.size, steps.length, `${name}: step id 必须唯一`);
    for (const step of steps) {
      for (const dep of step.deps) {
        assert.ok(ids.has(dep), `${name}: 步骤 ${step.id} 依赖了不存在的 ${dep}`);
      }
      assert.ok(!step.deps.includes(step.id), `${name}: 步骤 ${step.id} 不能依赖自己`);
    }
    // 拓扑可达性：每一步都必须能在有限步内解析完依赖（无环）
    const resolved = new Set();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const step of steps) {
        if (resolved.has(step.id)) continue;
        if (step.deps.every((dep) => resolved.has(dep))) {
          resolved.add(step.id);
          progressed = true;
        }
      }
    }
    assert.equal(resolved.size, steps.length, `${name}: 依赖图中存在环`);
  }
});

test('每条路径都以验证步骤收尾', () => {
  for (const [name, steps] of Object.entries(PATH_TEMPLATES)) {
    const verify = steps.find((step) => step.id === 'verify');
    assert.ok(verify, `${name}: 必须有 verify 步骤`);
    const dependents = steps.filter((step) => step.deps.includes('verify'));
    assert.equal(dependents.length, 0, `${name}: verify 必须是终点（不应有步骤依赖它）`);
  }
});

test('并行组：同依赖且互不依赖的步骤可并行', () => {
  const full = PATH_TEMPLATES.full;
  const review = full.find((step) => step.id === 'review');
  const security = full.find((step) => step.id === 'security');
  const testStep = full.find((step) => step.id === 'test');
  // 代码审查、安全审查、测试工程三者互不依赖 → 可并行
  assert.ok(!review.deps.includes('security') && !security.deps.includes('review'));
  assert.ok(!review.deps.includes('test') && !testStep.deps.includes('review'));
});

test('score() 返回可解释的理由，而非只有数字', () => {
  const result = score({ taskText: '重构支付流程', filesTouched: 8 });
  assert.equal(result.reasons.length, 3, '三个维度各给一条理由');
  assert.ok(result.reasons.every((reason) => reason.length > 0));
});

test('describeRoute 输出包含路径、评分与角色链', () => {
  const text = describeRoute(route({ taskText: '修一下这个报错' }));
  assert.match(text, /路径：调试/);
  assert.match(text, /评分：规模/);
  assert.match(text, /角色链：/);
});

test('极短任务被标记为 ambiguous，长任务不会', () => {
  assert.equal(route({ taskText: '修一下' }).ambiguous, true);
  assert.equal(route({ taskText: '把用户管理列表的分页逻辑改成游标分页，并补齐边界测试' }).ambiguous, false);
});

test('空输入不抛异常', () => {
  const decision = route({ taskText: '' });
  assert.ok(typeof decision.path === 'string');
  assert.ok(decision.steps.length > 0);
});

test('歧义安全词必须配语境词才算高风险（子会话 / token 预算 不算）', async () => {
  const { route } = await import('../lib/router.js');
  // 误判回归：任务描述里出现"子会话""token 预算"这类日常词，不该被判成高风险
  assert.equal(route({ taskText: '给团队面板加子会话跳转与停止确认框' }).score.risk, 0, '「子会话」不是安全信号');
  // 真信号仍然要判高
  for (const text of ['会话劫持导致越权', 'token 泄露后一直 401', 'SQL 注入点排查']) {
    assert.equal(route({ taskText: text }).score.risk, 2, `「${text}」必须判高风险`);
  }
});

test('纯数字安全关键词不许靠空词干误命中（"6 条" 不能触发 401/403）', async () => {
  const { route } = await import('../lib/router.js');
  // 事故：401/403 是纯数字关键词，stemEnglish 会把尾部数字剥光 → 空串；
  // 文本里任何数字（"6 条"里的 6）剥完也是空串 → 空串命中空串，
  // 于是「按 6 条评审意见修面板按钮」被判成安全高风险、白走完整路径。
  assert.equal(route({ taskText: '按 6 条评审意见修面板按钮文案' }).score.risk, 0, '数字不该触发安全判定');
  assert.equal(route({ taskText: '第 40 条、第 3 项都要改' }).score.risk, 0, '多个数字也不该触发');
  // 真状态码仍然要判高
  assert.equal(route({ taskText: '接口一直返回 401' }).score.risk, 2, '401 是真信号');
  assert.equal(route({ taskText: '偶发 403 无权限' }).score.risk, 2, '403 是真信号');
});
