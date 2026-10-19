// 临时二次审计探针（用完删除）
import { parseVerdict, hasEvidence } from './lib/verdict.js';
import { adaptSteps, buildSteps, PATH_TEMPLATES, route } from './lib/router.js';
import { graphFingerprint } from './lib/scheduler.js';
import { applyRoleAction, buildRolesPayload, readRoleFileText } from './lib/web-routes.js';
import { loadRoles } from './lib/roles.js';
import { userRolesDir } from './lib/state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

console.log('A1 正文示例在后:', JSON.stringify(parseVerdict('实际结论 PASS\n\n格式示例\nVERDICT: PASS'.replace('实际结论 PASS', '实际结论 OK'))));
console.log('A2 FAIL 后附代码块示例:', JSON.stringify(parseVerdict('审查发现越权。\nVERDICT: FAIL\n\n格式说明（三种可选）：\nVERDICT: PASS')));
console.log('A3 分段判定:', JSON.stringify(parseVerdict('模块A VERDICT: PASS\n模块B VERDICT: FAIL\n总评：基本可用')));
console.log('A4 全角/加粗:', JSON.stringify(parseVerdict('**VERDICT：**  blocked')));
console.log('A5 反例（中文结论不算）:', JSON.stringify(parseVerdict('结论：通过')));
console.log('A6 指令被原样回显:', JSON.stringify(parseVerdict('我按要求输出：\nVERDICT: PASS\nVERDICT: FAIL\nVERDICT: BLOCKED')));

console.log('E1 时间/URL 当证据:', hasEvidence('版本 10:30 发布，http://x:8080'));
console.log('E2 "未验证" + PASS 过证据门:', hasEvidence('未验证'));

const roles = [];
// D 触发词 + deploy（无 implementation）
const deploy = buildSteps(PATH_TEMPLATES.deploy, false);
const depAdapted = adaptSteps(deploy, { roles: [{ slug: 'ops-expert', builtin: false, enabled: true, triggers: ['deploy'] }], matchText: 'deploy to prod' });
console.log('D1 deploy 插入:', depAdapted.map((s) => `${s.id}<-${s.deps.join('+')}`).join(' | '));
// 全部非 verify 步骤停用后插入
const dep2 = adaptSteps(deploy, {
  roles: [
    { slug: 'devops', builtin: true, enabled: false },
    { slug: 'deploy-auditor', builtin: true, enabled: false },
    { slug: 'ops-expert', builtin: false, enabled: true, triggers: ['deploy'] },
  ],
  matchText: 'deploy',
});
console.log('D2 deploy 只剩 verify:', dep2.map((s) => `${s.id}(${s.kind})<-${s.deps.join('+')}`).join(' | '));
// E 自定义角色覆盖 executor + 触发词
const over = route({ taskText: '改按钮颜色', filesTouched: 1, roles: [{ slug: 'executor', builtin: false, enabled: true, triggers: ['按钮'] }] });
console.log('E1 覆盖 executor 的插入:', over.steps.map((s) => `${s.id}(${s.role})<-${s.deps.join('+')}`).join(' | '));
const ids = new Set(over.steps.map((s) => s.id));
console.log('E2 悬空依赖:', over.steps.flatMap((s) => s.deps.filter((d) => !ids.has(d)).map((d) => `${s.id}->${d}`)));
console.log('E3 重复 id:', over.steps.length - ids.size);
// G 指纹字段覆盖
const baseTask = { id: 't-x', role: 'executor', roleName: '执行者', kind: 'implementation', deps: [], acceptance: ['a'], subject: '标题A', objective: '目标A', order: 0, workspace: '/w', verify: ['v1'] };
const g1 = { tasks: [baseTask] };
const g2 = { tasks: [{ ...baseTask, subject: '标题B', objective: '目标B', order: 99, workspace: '/other', verify: ['v2'] }] };
console.log('G 只改 subject/objective/order/workspace/verify → 指纹:', graphFingerprint(g1) === graphFingerprint(g2) ? '不变（漏字段）' : '变了');

// F roles-state 并发读改写
const dir = await mkdtemp(join(tmpdir(), 'probe-roles-'));
const slugs = ['critic', 'analyst', 'architect', 'reviewer-x', 'py-expert', 'ops-expert'];
await Promise.all(slugs.map((slug) => applyRoleAction({ stateRoot: dir, body: { action: 'toggle', role: slug, enabled: false } })));
const payload = await buildRolesPayload(dir);
console.log('F 并发停用 6 个，实际停用:', payload.roles.filter((r) => r.enabled === false).map((r) => r.slug).join(',') || '(0)');

// H roles/body 返回的是整份文件（含 frontmatter）？
const library = await loadRoles(userRolesDir(dir));
const executor = library.bySlug.get('executor');
const raw = await readRoleFileText(executor?.path);
console.log('H builtin executor body 前 40 字:', JSON.stringify(String(raw).slice(0, 40)));
await rm(dir, { recursive: true, force: true });
