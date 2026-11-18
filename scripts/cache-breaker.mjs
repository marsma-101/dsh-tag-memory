/**
 * cache-breaker.mjs — 找出「每次请求之间到底什么在变」，从而定位缓存失效源。
 *
 * 做法：对同一会话的每次 request/header 取三份指纹：
 *   ① tools 数组的 JSON 哈希（工具定义变 → 整个前缀废）
 *   ② system 提示词的哈希（section 变 → 其后全废）
 *   ③ 消息条数与首条消息哈希（历史被改写 → 中间插入会废掉后段）
 * 再与该次请求之后的缓存命中率对齐，看哪一项变化与掉缓存同步。
 *
 * 用法：node scripts/cache-breaker.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/cache-breaker.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const h = (v) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 8);
const bytes = (s) => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');

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
const headers = events.filter((e) => e.type === 'request/header');
const msgs = events.filter((e) => e.type === 'assistant/message' && e.data?.usage);
const sysMsgs = events.filter((e) => e.type === 'system/message');

console.log(`request/header ${headers.length} 次；assistant/message ${msgs.length} 条\n`);

/* ---- 逐次请求指纹 ---- */
console.log('=== 每次请求的指纹 ===');
console.log(
  'seq'.padStart(6) + '工具数'.padStart(7) + 'tools哈希'.padStart(11) +
  '系统哈希'.padStart(11) + '系统字节'.padStart(10) +
  '此后首步缓存'.padStart(13),
);

const rows = [];
let lastSys = null;
for (let i = 0; i < headers.length; i++) {
  const hd = headers[i];
  const tools = hd.data?.header?.tools ?? [];
  const nextSeq = i + 1 < headers.length ? headers[i + 1].seq : Infinity;

  // 该 header 之后第一条 assistant/message 的缓存率
  const m = msgs.find((x) => x.seq > hd.seq && x.seq < nextSeq);
  const rate = m
    ? (() => {
      const f = m.data.usage.inputTokens ?? 0;
      const c = m.data.usage.cacheReadTokens ?? 0;
      return f + c > 0 ? `${((c / (f + c)) * 100).toFixed(1)}%` : '—';
    })()
    : '—';

  // 该 header 时刻生效的 system 消息（seq 之前最后一条非空的）
  const sys = [...sysMsgs].filter((s) => s.seq < hd.seq && (s.data?.message?.content ?? []).length > 0).pop();
  const sysText = sys ? sys.data.message.content.map((c) => c.text ?? '').join('') : '';

  rows.push({
    seq: hd.seq,
    toolCount: tools.length,
    toolHash: h(tools),
    sysHash: sysText ? h(sysText) : '—',
    sysBytes: sysText ? bytes(sysText) : 0,
    rate,
  });

  console.log(
    String(hd.seq).padStart(6) +
    String(tools.length).padStart(7) +
    h(tools).padStart(11) +
    (sysText ? h(sysText) : '—').padStart(11) +
    String(sysText ? bytes(sysText) : 0).padStart(10) +
    rate.padStart(13),
  );
}

/* ---- 变化点 ---- */
console.log('\n=== 变化点（相邻两次请求的差异）===');
let changes = 0;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1];
  const b = rows[i];
  const diffs = [];
  if (a.toolHash !== b.toolHash) diffs.push(`tools 变了（${a.toolCount}→${b.toolCount} 个，${a.toolHash}→${b.toolHash}）`);
  if (a.sysHash !== b.sysHash) diffs.push(`system 变了（${a.sysBytes}→${b.sysBytes} 字节，${a.sysHash}→${b.sysHash}）`);
  if (diffs.length === 0) continue;
  changes++;
  console.log(`  seq ${a.seq} → ${b.seq}`);
  for (const d of diffs) console.log(`    · ${d}`);
  console.log(`    缓存率 ${a.rate} → ${b.rate}`);
}
if (changes === 0) {
  console.log('  无变化：所有请求的 tools 与 system 都逐字节相同。');
  console.log('  → 缓存失效不是插件改前缀造成的。');
}

/* ---- 消息数组是否被中间插入 ---- */
console.log('\n=== 消息是否被插入到历史中间（会废掉后段缓存）===');
const msgTypes = new Set(['user/message', 'assistant/message', 'system/message', 'tool/result']);
const all = events.filter((e) => msgTypes.has(e.type));
const injected = all.filter(
  (m) => m.type === 'user/message' && m.data?.source?.kind && m.data.source.kind !== 'user',
);
const byKind = new Map();
for (const m of injected) {
  const idx = all.filter((x) => x.seq < m.seq).length;
  const cur = byKind.get(m.data.source.kind) ?? { positions: [], n: 0 };
  cur.positions.push(idx);
  cur.n++;
  byKind.set(m.data.source.kind, cur);
}
for (const [k, v] of byKind) {
  const min = Math.min(...v.positions);
  const max = Math.max(...v.positions);
  const atFront = v.positions.filter((p) => p <= 1).length;
  console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)} 次  位置 ${min}~${max}${atFront ? `  ⚠ 有 ${atFront} 次插在最前面` : ''}`);
}
console.log(`  （消息总数 ${all.length}；位置 0 = 插在历史最前，那会废掉整段缓存）`);
