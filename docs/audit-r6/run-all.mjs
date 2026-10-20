/**
 * 第六轮审计：一键跑完所有探针，并校验 findings.json 的六维覆盖。
 *
 * 用法：
 *   node docs/audit-r6/run-all.mjs
 *   node docs/audit-r6/run-all.mjs --only=probe-watch-keys
 *
 * 退出码语义（刻意与“是否找到 bug”解耦）：
 *   0 = 六维覆盖校验通过，且所有被选中的探针都跑完了（reproduced 只作为结果数据记录）；
 *   1 = 覆盖校验失败，或任一探针抛错/没跑完。
 *
 * 为什么不是“未复现就 exit 1”：审计允许结论是“假设被证伪/无此问题”，
 * 那同样是有效交付；把“没找到 bug”判成失败会诱导凑数（见 critic 第 2 条）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIMS = ['dead-path', 'hardcoded', 'interrupted', 'task-loss', 'over-consumption', 'over-restriction'];
const DECISIONS = new Set(['fix', 'wontfix', 'known-limit']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const RELATIONS = new Set(['new', 'incomplete-fix', 'known-limit']);

function validate(findings) {
  const errors = [];
  const ids = new Set();
  const declaredDims = new Set((findings.dimensions ?? []).map((item) => item.key));

  if (findings.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (findings.round !== 6) errors.push('round 必须为 6');
  for (const dim of DIMS) {
    if (!declaredDims.has(dim)) errors.push(`dimensions 缺少 ${dim}`);
  }
  if (declaredDims.size !== DIMS.length) errors.push(`dimensions 数量应为 ${DIMS.length}，实际 ${declaredDims.size}`);

  for (const finding of findings.findings ?? []) {
    if (!/^R6-\d{2}$/.test(String(finding.id))) errors.push(`finding id 非法：${finding.id}`);
    if (ids.has(finding.id)) errors.push(`finding id 重复：${finding.id}`);
    ids.add(finding.id);
    if (!DIMS.includes(finding.dim)) errors.push(`${finding.id} dim 非法：${finding.dim}`);
    if (!DECISIONS.has(finding.decision)) errors.push(`${finding.id} decision 非法：${finding.decision}`);
    if (!PRIORITIES.has(finding.priority)) errors.push(`${finding.id} priority 非法：${finding.priority}`);
    if (!RELATIONS.has(finding.relation)) errors.push(`${finding.id} relation 非法：${finding.relation}`);
    if (typeof finding.title !== 'string' || finding.title === '') errors.push(`${finding.id} 缺 title`);
    const loc = finding.evidence?.loc;
    if (!Array.isArray(loc) || loc.length === 0) {
      errors.push(`${finding.id} 缺 evidence.loc`);
    } else {
      for (const entry of loc) {
        if (typeof entry.file !== 'string' || entry.file === '') errors.push(`${finding.id} loc 缺 file`);
        if (!Number.isInteger(entry.line) || entry.line <= 0) errors.push(`${finding.id} loc 缺 line`);
      }
    }
    if (typeof finding.evidence?.expected !== 'string' || finding.evidence.expected === '') {
      errors.push(`${finding.id} 缺 expected`);
    }
  }

  const coveredDims = new Set();
  for (const row of findings.coverage ?? []) {
    if (!DIMS.includes(row.dim)) errors.push(`coverage dim 非法：${row.dim}`);
    coveredDims.add(row.dim);
    if (!Array.isArray(row.findingIds) || row.findingIds.length === 0) {
      errors.push(`coverage ${row.dim} 缺 findingIds`);
    }
    for (const id of row.findingIds ?? []) {
      const finding = (findings.findings ?? []).find((item) => item.id === id);
      if (finding === undefined) errors.push(`coverage ${row.dim} 引用不存在的 ${id}`);
      else if (finding.dim !== row.dim) errors.push(`coverage ${row.dim} 引用了别的维度的 ${id}（实际 ${finding.dim}）`);
    }
  }
  for (const dim of DIMS) {
    if (!coveredDims.has(dim)) errors.push(`coverage 缺少维度 ${dim}`);
  }
  for (const finding of findings.findings ?? []) {
    const owned = (findings.coverage ?? []).some((row) => row.findingIds?.includes(finding.id));
    if (!owned) errors.push(`${finding.id} 没有被任何 coverage 覆盖`);
  }

  if (!Array.isArray(findings.probes) || findings.probes.length === 0) errors.push('probes 列表为空');
  return errors;
}

async function main() {
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  const only = onlyArg === undefined ? undefined : onlyArg.slice('--only='.length);

  const findings = JSON.parse(await readFile(join(HERE, 'findings.json'), 'utf8'));
  const errors = validate(findings);
  if (errors.length > 0) {
    console.error('findings.json 校验失败：');
    for (const message of errors) console.error(`  ✗ ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`findings.json 校验通过：${findings.findings.length} 条 finding，六维覆盖齐全`);

  const names = only === undefined ? findings.probes : [only];
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => !findings.probes.includes(name))) {
    console.error(`未知探针：${only ?? '(空)'}。可选：${findings.probes.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const modules = new Map();
  for (const name of findings.probes) {
    const loaded = await import(pathToFileURL(join(HERE, `${name}.mjs`)).href);
    if (loaded.id !== name) throw new Error(`${name}.mjs 导出的 id 是 ${loaded.id}`);
    if (typeof loaded.run !== 'function') throw new Error(`${name}.mjs 没有导出 run()`);
    modules.set(name, loaded);
  }

  const results = [];
  let failed = 0;
  for (const name of names) {
    const probe = modules.get(name);
    process.stdout.write(`\n=== ${name} (${probe.dim}) ===\n`);
    try {
      const result = await probe.run();
      results.push({ id: name, dim: probe.dim, reproduced: result.reproduced === true, result });
      console.log(JSON.stringify({ reproduced: result.reproduced, observed: result.observed }, null, 2));
    } catch (error) {
      failed += 1;
      results.push({ id: name, dim: probe.dim, reproduced: undefined, error: String(error?.stack ?? error) });
      console.error(`探针失败：${String(error?.message ?? error)}`);
    }
  }

  console.log('\n=== 汇总 ===');
  for (const row of results) {
    const verdict = row.error !== undefined ? 'ERROR' : row.reproduced ? 'REPRODUCED' : 'NOT-REPRODUCED';
    console.log(`${row.id.padEnd(24)} ${row.dim.padEnd(18)} ${verdict}`);
  }
  console.log(`\n六维覆盖：`);
  for (const row of findings.coverage) {
    console.log(`  ${row.dim.padEnd(18)} ${(row.findingIds ?? []).join(', ')}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} 个探针失败；按约定 exit 1（探针未跑完，不是“未复现”）。`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nOK：${names.length}/${names.length} 个探针跑完；reproduced 只作为结果数据，不影响退出码。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
