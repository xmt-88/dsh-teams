/**
 * 评审/验证类任务的机器判定。
 *
 * 背景（审计 P0-1/P0-2）：子代理"跑完"不等于"通过"。以前 `settleTask` 只看
 * `stopReason === 'completed'` 且输出非空，于是验证员写「结论：FAIL」也会被记成
 * `done`，团队照常判绿——质量门形同虚设。
 *
 * 现在：门类任务（review / verification）必须在产出里给出一行机器可读的判定，
 * `settleTask` 据此决定任务状态；缺失判定按 **fail-closed** 处理（不能因为"没写"
 * 就当通过）。
 */

/** 需要机器判定的任务种类。 */
export const GATE_KINDS = Object.freeze(['review', 'verification']);

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'BLOCKED']);

/** 判定只在产出结尾这几行里找（再往后是正文，容易出现格式示例）。 */
export const VERDICT_TAIL_LINES = 5;

/**
 * 是否是门类任务（必须有 VERDICT）。
 * @param {string} [kind]
 * @returns {boolean}
 */
export function isGateKind(kind) {
  return GATE_KINDS.includes(kind);
}

/**
 * 从产出里解析判定。
 *
 * 容忍的写法：`VERDICT: PASS`、`verdict：pass`、`**VERDICT:** FAIL`、
 * 以及中文全角冒号。取**最后一个**匹配——模型常在正文里引用格式示例，
 * 真正的判定通常写在结尾。
 *
 * @param {string} [output]
 * @returns {'PASS'|'FAIL'|'BLOCKED'|undefined}
 */
export function parseVerdict(output) {
  if (typeof output !== 'string' || output === '') return undefined;

  // 判定规则（审计二轮问题 1：以前取全文最后一次匹配，正文后部贴一段示例就能
  // 把真实 FAIL 翻成 PASS —— fail-open）：
  //   1. 先剥掉围栏代码块（里面的多半是格式示例）
  //   2. 只在**结尾几行**里找
  //   3. 判定必须**独立成行**（允许加粗/下划线与全角冒号），行内提到不算
  //   4. 出现两个不同的判定 → 视为歧义，按未通过处理（fail-closed）
  const withoutFences = output.replace(/```[\s\S]*?```/g, '\n');
  const lines = withoutFences
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const tail = lines.slice(-VERDICT_TAIL_LINES);

  const standalone = /^[\s*_`>#-]*VERDICT[\s*_`]*[:：][\s*_`]*(PASS|FAIL|BLOCKED)[\s*_`.。]*$/i;
  const found = new Set();
  for (const line of tail) {
    const match = standalone.exec(line);
    if (match !== null) found.add(match[1].toUpperCase());
  }
  if (found.size === 1) return [...found][0];
  // 0 个 = 没写判定；≥2 个 = 自相矛盾。两者都按"未通过"处理（返回 undefined 让调用方 fail-closed）。
  return undefined;
}

/**
 * 给门类任务的契约附上判定要求（拼提示词用）。
 * @returns {string}
 */
export function verdictInstruction() {
  return [
    '## 判定行（宿主强制）',
    '产出**最后一行**必须是下面三者之一，逐字写，不要加粗、不要加标点：',
    'VERDICT: PASS',
    'VERDICT: FAIL',
    'VERDICT: BLOCKED',
    '宿主只认这一行来判定这一步的成败——正文写「通过」不算，缺这行按 FAIL 处理。',
  ].join('\n');
}

/**
 * 产出里是否带"可复核的证据"。
 *
 * 证据门（`gates.requireEvidence`）的判定依据：命令 + 退出码、文件:行号、
 * 或明确的"不适用/未验证"说明。宁可宽一点，也不要让合规产出被误杀。
 *
 * @param {string} [output]
 * @returns {boolean}
 */
export function hasEvidence(output) {
  if (typeof output !== 'string' || output === '') return false;
  // 文件:行号（含 Windows 盘符）
  if (/[\w./\\-]+:\d+/.test(output)) return true;
  // 退出码 / exit code / exit status
  if (/(退出码|退出状态|exit\s*cod(e|es)|exit\s*status|\bexit\s*\d)/i.test(output)) return true;
  // 代码块里出现过命令行
  if (/```[\s\S]*?\n\s*[$>]?\s*[a-zA-Z][\w./-]*\s+[\w./-]+[\s\S]*?```/.test(output)) return true;
  // 诚实声明"不适用/未验证"也算一种证据（本项目没有该环节）
  if (/(未验证|不适用|无法验证|未测量|not applicable|could not verify)/i.test(output)) return true;
  return false;
}
