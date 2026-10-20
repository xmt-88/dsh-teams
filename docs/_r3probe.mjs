/** 第三轮临时探针（用完删除）。 */
import { parseVerdict } from '../lib/verdict.js';

const cases = [
  ['裸判定', '结论如下。\nVERDICT: PASS'],
  ['空行+以上', 'VERDICT: PASS\n\n以上。'],
  ['项目符号-', '- VERDICT: PASS'],
  ['项目符号*', '* VERDICT: PASS'],
  ['编号 1.', '1. VERDICT: PASS'],
  ['带说明', 'VERDICT: PASS（无阻塞项，建议后续补测试）'],
  ['带破折号说明', 'VERDICT: PASS — 无阻塞项'],
  ['全角括号后断言', 'VERDICT：FAIL（已修复 3 处）'],
  ['末行后跟 3 行建议', '正文...\nVERDICT: PASS\n\n建议：\n1. 补测试\n2. 补文档'],
  ['末行后跟 6 行建议', '正文...\nVERDICT: PASS\n\n补充说明：\n1. 补测试\n2. 补文档\n3. 清理日志\n4. 更新 README'],
  ['整体包在围栏里', '```markdown\n结论正文\n\nVERDICT: PASS\n```'],
  ['判定行在围栏内+外部无', '佐证：\n```\nVERDICT: FAIL\n```'],
  ['加粗', '**VERDICT: PASS**'],
  ['中文判定', '判定：PASS'],
  ['两个不同', 'VERDICT: PASS\nVERDICT: FAIL'],
  ['两个相同', 'VERDICT: PASS\nVERDICT: PASS'],
  ['行内提到', '结论：我给出的判定是 VERDICT: PASS，以上'],
  ['尾随空格', 'VERDICT: PASS   '],
  ['结尾句号', 'VERDICT: PASS。'],
  ['表格式', '| VERDICT: PASS |'],
];

console.log('=== parseVerdict ===');
for (const [name, text] of cases) {
  const got = parseVerdict(text);
  console.log(`${got === undefined ? 'undefined(fail-closed)' : got}\t<- ${name}`);
}
