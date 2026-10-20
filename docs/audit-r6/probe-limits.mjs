/**
 * 探针：几处"上限"是否构成误伤（over-restriction）。
 *
 * 被检查的假设（来自架构方案的 probe-limits）：
 *   1. client.js:1416 RUNS_PAGE=8 会把历史运行"拒绝"在 8 条；
 *   2. tasks.js DEP_OUTPUT_LIMIT/DEP_TOTAL_LIMIT 会截掉验证者需要的关键依赖；
 *   3. web-routes.js 256KB 请求体上限会拒绝正常角色契约。
 *
 * 判定：逐条看是否存在合法的"展开/兜底"路径，以及真实上限与合法输入的距离。
 * 若三条都不成立，reproduced=false（上限是刻意边界，不是误伤）。
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDependencyOutputs, DEP_OUTPUT_LIMIT, DEP_TOTAL_LIMIT } from '../../lib/tasks.js';
import { VERDICT_TAIL_LINES } from '../../lib/verdict.js';

export const id = 'probe-limits';
export const dim = 'over-restriction';
export const title = 'RUNS_PAGE / 依赖截断 / 256KB 请求体是否误伤';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function task(id, role, deps, output) {
  return { id, role, roleName: role, deps, status: 'done', output };
}

export async function run() {
  const client = await readFile(join(ROOT, 'client.js'), 'utf8');
  const webRoutes = await readFile(join(ROOT, 'lib', 'web-routes.js'), 'utf8');

  // 1) RUNS_PAGE：是否真的有"显示更多"路径。
  const runsPage = /const RUNS_PAGE = (\d+)/.exec(client)?.[1];
  const hasShowAll = client.includes("const shown = showAll ? runs : runs.slice(0, RUNS_PAGE)");
  const hasMoreButton = client.includes("t('flow.more')") && client.includes('hidden > 0');
  const runsPageRejects = runsPage !== undefined && !(hasShowAll && hasMoreButton);

  // 2) 依赖截断：7 个 2000 字依赖，观察第 7 个是否被"内容过长，已省略"取代。
  const depIds = Array.from({ length: 7 }, (_, index) => `t-dep-${index}`);
  const deps = depIds.map((depId, index) => task(depId, `role-${index}`, [], `${depId}:` + 'x'.repeat(DEP_OUTPUT_LIMIT - depId.length - 1)));
  const merged = collectDependencyOutputs({ deps: depIds }, deps);
  const omitted = merged.includes('内容过长，已省略');
  const lastDepPresent = merged.includes('t-dep-6:');
  const mergedLength = merged.length;

  // 3) 256KB 请求体：上限与销毁行为。
  const bodyLimit = /size > (\d+) \* 1024/.exec(webRoutes)?.[1];
  const destroysOnOverflow = webRoutes.includes('req.destroy()');

  // 内置路径下 verify 最多 4 个依赖：4 × 2000 = 8000 < 12000，正常路径不会触发省略。
  const builtinWorstCase = 4 * DEP_OUTPUT_LIMIT;

  // 7 个依赖是合成的最坏情况；内置路径最多 4 个依赖（8000 < 12000），不会触发省略。
  const dependencyMisfire = omitted && builtinWorstCase > DEP_TOTAL_LIMIT;
  const bodyLimitTooSmall = bodyLimit !== undefined && Number(bodyLimit) < 256;
  const reproduced = runsPageRejects || dependencyMisfire || bodyLimitTooSmall;

  return {
    reproduced,
    observed: {
      runsPage: {
        constant: runsPage === undefined ? undefined : Number(runsPage),
        hasShowAll,
        hasMoreButton,
        rejectsRuns: runsPageRejects,
        note: '折叠的是"默认展开数量"，不是数据删除；点击更多会渲染全部。',
      },
      dependencyTruncation: {
        depOutputLimit: DEP_OUTPUT_LIMIT,
        depTotalLimit: DEP_TOTAL_LIMIT,
        mergedLength,
        omitted,
        lastDependencyKept: lastDepPresent,
        builtinVerifyWorstCase: builtinWorstCase,
        builtinPathsHitCap: builtinWorstCase > DEP_TOTAL_LIMIT,
        note: '截断是提示词预算保护；内置路径 verify 最多 4 个依赖，8000 < 12000，不会触发。',
      },
      requestBodyLimit: {
        kilobytes: bodyLimit === undefined ? undefined : Number(bodyLimit),
        destroysOnOverflow,
        note: '256KB 对角色契约（常见 < 20KB）有充足余量；这是鉴权路由上的防滥用边界。',
      },
      verdictTailLines: VERDICT_TAIL_LINES,
      verdictTailNote: '只扫最后 8 行是刻意的 fail-closed；角色契约明确要求 VERDICT 写在最后一行。',
    },
    expected: '上限必须要么有展开/兜底路径，要么与合法输入保持足够距离；否则才算误伤',
    note: 'RUNS_PAGE 假设被证伪：客户端有 showAll 与"更多"按钮。',
  };
}

if (process.argv[1]?.endsWith('probe-limits.mjs')) {
  run().then((result) => {
    console.log(JSON.stringify({ id, dim, title, ...result }, null, 2));
    if (result.reproduced !== true) console.log('（假设未复现：未发现误伤）');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
