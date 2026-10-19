// 临时探针：停用剪枝 × 触发插入 的图完整性矩阵
import { adaptSteps, buildSteps, PATH_TEMPLATES } from './lib/router.js';

const paths = Object.keys(PATH_TEMPLATES);
const roleSlugs = [...new Set(paths.flatMap((p) => PATH_TEMPLATES[p].map((s) => s.role)))];
let issues = 0;
for (const path of paths) {
  for (const ui of [false, true]) {
    const base = buildSteps(PATH_TEMPLATES[path], ui);
    for (const disabled of [undefined, ...roleSlugs]) {
      const roles = disabled === undefined ? [] : [{ slug: disabled, builtin: true, enabled: false }];
      const triggered = [{ slug: 'expert-x', builtin: false, enabled: true, triggers: ['按钮'] }];
      const steps = adaptSteps(base, { roles: [...roles, ...triggered], matchText: '改按钮' });
      const ids = new Set(steps.map((s) => s.id));
      if (ids.size !== steps.length) { issues += 1; console.log('重复 id', path, ui, disabled); }
      for (const step of steps) {
        for (const dep of step.deps) {
          if (!ids.has(dep)) { issues += 1; console.log('悬空', path, ui, disabled, step.id, '->', dep); }
          if (dep === step.id) { issues += 1; console.log('自环', path, ui, disabled, step.id); }
        }
      }
      // 环检测
      const byId = new Map(steps.map((s) => [s.id, s]));
      const mark = new Map();
      const dfs = (id) => {
        if (mark.get(id) === 2) return false;
        if (mark.get(id) === 1) return true;
        mark.set(id, 1);
        for (const dep of byId.get(id)?.deps ?? []) if (dfs(dep)) return true;
        mark.set(id, 2);
        return false;
      };
      for (const s of steps) {
        if (dfs(s.id)) { issues += 1; console.log('环', path, ui, disabled, '挂在', s.id); break; }
      }
    }
  }
}
console.log(issues === 0 ? '剪枝/插入矩阵：全部图完整、无悬空、无自环、无环' : `发现问题 ${issues} 处`);
