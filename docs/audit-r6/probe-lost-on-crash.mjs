/**
 * 探针：进程重启（activeLoops 内存表丢失）后，遗留的 running 任务还能不能恢复。
 *
 * 背景：僵尸锁接管只在 `activeLoops` 里**还有句柄**时生效（scheduler.js:306）。
 * 进程崩溃/重启后内存表为空，但任务文件里可能留着 status=running 的记录。
 *
 * 假设：
 *   - 再次 teams_run 会立刻"零派发收口"，因为 pickReady 只挑 pending；
 *   - finalizeRun 看到残留 running 会把团队判 failed；
 *   - 那个 running 任务不会被任何人改回 pending；
 *   - teams_retry 只收 failed/blocked，拒绝续跑。
 * 四件事同时成立 = 崩溃后该任务永久卡死，只能重建任务图（丢失在飞工作）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stateRootOf, readTasks, readTeam, mutateTasks } from '../../lib/state.js';
import { planTeam, approveTeam, startTeamRun, retryFailedTeam, isRunning } from '../../lib/scheduler.js';

export const id = 'probe-lost-on-crash';
export const dim = 'task-loss';
export const title = '进程重启后遗留 running 任务无法续跑';

const SESSION = 'probe-crash-session';
const CONFIG = {
  stateDir: '.dsh-teams',
  scheduler: { maxParallel: 1, maxRetries: 0, maxReviewRounds: 0 },
  gates: { requireEvidence: true, securityBlock: true },
  timeouts: { enabled: false },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-probe-crash-'));
  const stateRoot = stateRootOf(dir, '.dsh-teams');
  const base = {
    config: CONFIG,
    captainSessionId: SESSION,
    workspace: dir,
    agent: { id: SESSION, session: { header: { cwd: dir } } },
  };
  try {
    await planTeam({ ...base, task: '改个按钮颜色', forcePath: 'fast' });
    await approveTeam(base);

    // 模拟"进程在 executor 派发中途崩溃"：内存里的 activeLoops 没了，任务却停在 running。
    await mutateTasks(stateRoot, SESSION, (graph) => {
      const executor = graph.tasks.find((task) => task.id === 't-executor');
      executor.status = 'running';
      executor.updatedAt = new Date().toISOString();
      return graph;
    });

    // 重启后第一次 teams_run：没有 activeLoops 句柄，因此不会走僵尸接管。
    const restarted = await startTeamRun({ ...base, ctx: {}, providerName: 'spawn' });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isRunning(stateRoot, SESSION)) await sleep(20);
    await sleep(50);

    const graph = await readTasks(stateRoot, SESSION);
    const team = await readTeam(stateRoot, SESSION);
    const executor = graph.tasks.find((task) => task.id === 't-executor');
    const retry = await retryFailedTeam(base);

    const reproduced =
      restarted.started === true &&
      team?.phase === 'failed' &&
      executor?.status === 'running' &&
      retry.started === false;

    return {
      reproduced,
      observed: {
        startReturned: { started: restarted.started, tasks: restarted.tasks, pending: restarted.pending },
        phaseAfterRun: team?.phase,
        taskStatuses: graph.tasks.map((task) => `${task.id}:${task.status}`),
        lingeringRunning: executor?.status,
        retry: { started: retry.started, reason: retry.reason },
        stopAvailable: false,
      },
      expected: '重启后 startTeamRun 应把遗留 running 任务改回 pending（epoch+1，丢弃旧结果），或标 failed 并允许 teams_retry；不能永远停在 running',
      note: '同进程僵尸接管（scheduler.js:306-336）覆盖不到进程重启；tasks.js:229 的 pickReady 只看 pending。',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1]?.endsWith('probe-lost-on-crash.mjs')) {
  run().then((result) => {
    console.log(JSON.stringify({ id, dim, title, ...result }, null, 2));
    if (result.reproduced !== true) console.log('（假设未复现）');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
