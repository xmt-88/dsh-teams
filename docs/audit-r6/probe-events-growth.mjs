/**
 * 探针：/state 快照只需要 80 条事件，但 readEvents 每次都读完整 events.jsonl。
 *
 * 量化口径：
 *   - 放大倍数 = 文件行数 / 80（面板实际展示 80 条）；
 *   - 每次快照读取的字节数 = 整个文件大小；
 *   - 客户端轮询：运行中 1.2s/次（50 次/分钟），空闲 5s/次（12 次/分钟）。
 *
 * 假设：readEvents(limit) 的实现是 `readFile -> split -> slice(-limit)`
 * （state.js:315-319），所以读放大随事件历史线性增长。
 * 若 12000 行文件每次快照都读满 100%，假设成立（reproduced=true）。
 */
import { mkdtemp, rm, mkdir, writeFile, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEvents } from '../../lib/state.js';

export const id = 'probe-events-growth';
export const dim = 'over-consumption';
export const title = 'readEvents 每次快照全量读取 events.jsonl';

const LINES = 12_000;

function makeLine(index) {
  return JSON.stringify({
    ts: new Date(Date.UTC(2026, 9, 20, 0, 0, index % 60)).toISOString(),
    type: index % 7 === 0 ? 'member' : 'note',
    team: 'probe-events-session',
    data: {
      task: `t-task-${index % 12}`,
      role: 'executor',
      event: 'start',
      message: `event ${index} — 填充到接近真实事件的平均长度，确保按字节测量有意义`,
    },
  });
}

/** 只读尾部 64KB 的对照实现（不修改源码，仅用于量化差距）。 */
async function readTailBaseline(file, limit) {
  const info = await stat(file);
  const window = Math.min(info.size, 64 * 1024);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, info.size - window);
    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit);
  } finally {
    await handle.close();
  }
}

async function timeIt(fn, rounds) {
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)), totalMs: Number(samples.reduce((sum, item) => sum + item, 0).toFixed(2)) };
}

export async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-teams-probe-events-'));
  const file = join(dir, 'events.jsonl');
  try {
    await mkdir(dir, { recursive: true });
    const body = `${Array.from({ length: LINES }, (_, index) => makeLine(index)).join('\n')}\n`;
    await writeFile(file, body, 'utf8');
    const info = await stat(file);

    const full = await timeIt(() => readEvents(dir, 80), 20);
    const tail = await timeIt(() => readTailBaseline(file, 80), 20);

    const amplification = LINES / 80;
    const bytesPerSnapshot = info.size;
    const activeBytesPerMinute = bytesPerSnapshot * 50;
    const idleBytesPerMinute = bytesPerSnapshot * 12;
    const reproduced = amplification >= 10 && full.medianMs > tail.medianMs;

    return {
      reproduced,
      observed: {
        eventsInFile: LINES,
        fileBytes: info.size,
        displayedTail: 80,
        readAmplification: `×${amplification.toFixed(1)}`,
        readEvents: full,
        tail64kBaseline: tail,
        perSnapshotFullBytes: bytesPerSnapshot,
        runtimePollingPerMinute: {
          active: { requests: 50, bytesRead: activeBytesPerMinute, human: `${(activeBytesPerMinute / 1e6).toFixed(1)} MB/min` },
          idle: { requests: 12, bytesRead: idleBytesPerMinute, human: `${(idleBytesPerMinute / 1e6).toFixed(1)} MB/min` },
        },
      },
      expected: '按 limit 只读文件尾部（例如尾部 64KB），单次快照读取字节数应与 limit 相关，而不是与历史事件总量线性相关',
      note: '当前真实状态目录 events.jsonl 为 146 行 / 33113 字节；放大尚小，但实现是 O(历史)，随轮次线性增长。',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1]?.endsWith('probe-events-growth.mjs')) {
  run().then((result) => {
    console.log(JSON.stringify({ id, dim, title, ...result }, null, 2));
    if (result.reproduced !== true) console.log('（假设未复现）');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
