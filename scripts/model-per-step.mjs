/**
 * model-per-step.mjs — 看一轮对话内部，各步用的模型是否相同；并看稳定前缀段内缓存是否真的命中。
 *
 * 要回答两个问题：
 *   ① 同一轮里，前面和后面的模型是否不同？（不同则每步都换 provider，缓存天然不共享）
 *   ② 当前缀逐字节不变时，后续步的缓存命中率是多少？（排除「首步本来就冷」的误判）
 *
 * 用法：node scripts/model-per-step.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/model-per-step.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const h = (v) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 8);

function readSession(f) {
  const buf = fs.readFileSync(f);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  starts.push(buf.length);
  let text = '';
  for (let i = 0; i < starts.length - 1; i++) {
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8'); } catch { }
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { }
  }
  return out;
}

const events = readSession(file);

/* ---- 每步的模型 ---- */
const marks = [];
for (const e of events) {
  if ((e.type === 'request/context' || e.type === 'model/selection') && e.data?.provider) {
    marks.push({ seq: e.seq, key: `${e.data.provider}/${e.data.model ?? '?'}` });
  }
}
marks.sort((a, b) => a.seq - b.seq);
const modelAt = (s) => { let k = '?'; for (const m of marks) { if (m.seq <= s) k = m.key; else break; } return k; };

const msgs = events.filter((e) => e.type === 'assistant/message' && e.data?.usage);

console.log('=== 每轮内部的模型序列 ===\n');
const byTurn = new Map();
for (const m of msgs) {
  const t = m.data.turn ?? -1;
  if (!byTurn.has(t)) byTurn.set(t, []);
  byTurn.get(t).push({ step: m.data.step, model: modelAt(m.seq), seq: m.seq });
}
for (const [t, list] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  const models = [...new Set(list.map((x) => x.model))];
  const flag = models.length > 1 ? `  ⚠ ${models.length} 种模型` : '';
  console.log(`  turn ${String(t).padStart(3)}  ${String(list.length).padStart(4)} 步  ${models.join(' → ')}${flag}`);
}

/* ---- 稳定前缀段内的缓存命中 ---- */
console.log('\n=== 当前缀（tools + system）逐字节不变时，后续步的缓存命中 ===\n');

const headers = events.filter((e) => e.type === 'request/header');
const sysMsgs = events.filter((e) => e.type === 'system/message' && (e.data?.message?.content ?? []).length > 0);

console.log(
  '段'.padStart(4) + '起始seq'.padStart(9) + '模型'.padEnd(26) +
  '段内步数'.padStart(9) + '第1步'.padStart(8) + '第2步'.padStart(8) +
  '第3步'.padStart(8) + '段内平均(除首步)'.padStart(18),
);

for (let i = 0; i < headers.length; i++) {
  const hd = headers[i];
  const from = hd.seq;
  const to = i + 1 < headers.length ? headers[i + 1].seq : Infinity;
  const seg = msgs.filter((m) => m.seq > from && m.seq < to);
  if (seg.length === 0) continue;

  const rateOf = (m) => {
    const f = m.data.usage.inputTokens ?? 0;
    const c = m.data.usage.cacheReadTokens ?? 0;
    return f + c > 0 ? c / (f + c) : 0;
  };
  const fmt = (m) => (m ? `${(rateOf(m) * 100).toFixed(0)}%` : '—');

  const rest = seg.slice(1);
  const avgRest = rest.length
    ? rest.reduce((a, m) => a + rateOf(m), 0) / rest.length
    : 0;

  console.log(
    String(i).padStart(4) +
    String(from).padStart(9) +
    modelAt(from).padEnd(26) +
    String(seg.length).padStart(9) +
    fmt(seg[0]).padStart(8) +
    fmt(seg[1]).padStart(8) +
    fmt(seg[2]).padStart(8) +
    `${(avgRest * 100).toFixed(1)}%`.padStart(18),
  );
}

/* ---- 同一模型连续段的缓存表现 ---- */
console.log('\n=== 按「模型连续段」聚合（同一模型内前缀应稳定）===\n');
const runs = [];
let cur = null;
for (const m of msgs) {
  const model = modelAt(m.seq);
  const f = m.data.usage.inputTokens ?? 0;
  const c = m.data.usage.cacheReadTokens ?? 0;
  if (!cur || cur.model !== model) {
    if (cur) runs.push(cur);
    cur = { model, n: 0, fresh: 0, cached: 0, startSeq: m.seq };
  }
  cur.n++;
  cur.fresh += f;
  cur.cached += c;
}
if (cur) runs.push(cur);

console.log('模型'.padEnd(26) + '步数'.padStart(7) + '新鲜input'.padStart(14) + '缓存命中'.padStart(14) + '命中率'.padStart(9));
for (const r of runs) {
  const total = r.fresh + r.cached;
  console.log(
    r.model.padEnd(26) + String(r.n).padStart(7) +
    r.fresh.toLocaleString().padStart(14) +
    r.cached.toLocaleString().padStart(14) +
    `${(total ? r.cached / total * 100 : 0).toFixed(1)}%`.padStart(9),
  );
}
