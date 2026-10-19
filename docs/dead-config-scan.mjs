// 列出每个配置叶子的所有属性访问行，由人判定"这是消费者还是表单 getter"
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const files = {
  'index.js': read('index.js'),
  'lib/runner.js': read('lib/runner.js'),
  'lib/scheduler.js': read('lib/scheduler.js'),
  'lib/router.js': read('lib/router.js'),
  'client.js': read('client.js'),
  'lib/web-routes.js': read('lib/web-routes.js'),
};

const keys = [
  'riskShortCircuit', 'fastMax', 'standardMax', 'maxParallel', 'maxRetries',
  'maxReviewRounds', 'heavy', 'light', 'infrastructure', 'requireEvidence',
  'securityBlock', 'openTabOnPlan',
];

for (const key of keys) {
  console.log(`\n=== ${key} ===`);
  let found = 0;
  for (const [name, src] of Object.entries(files)) {
    src.split('\n').forEach((line, i) => {
      if (!new RegExp(`\\.${key}\\b`).test(line)) return;
      if (/\bz\.|description:|label:|hint:/.test(line)) return;      // schema 声明不算
      found += 1;
      const kind = /read\(config/.test(line) ? '【表单getter】' : /resolve\w+\(/.test(line) ? '【✅消费者】' : '【?其它】';
      console.log(`  ${kind} ${name}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  if (found === 0) console.log('  ❌ 无任何访问点');
}
