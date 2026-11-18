/**
 * prefix-diff.mjs — 找出「被注入进请求前缀、并且会变化」的内容。
 *
 * 请求前缀的顺序是：tools → system prompt → messages。
 * 任何一项变化，都会让它**之后**的所有内容重算。
 * 所以只要定位「前缀里哪些字节变了」，就找到了缓存失效源。
 *
 * 本脚本对同一会话的每次 request/header 逐项比对：
 *   ① 每个工具定义（尤其 dtm_*）
 *   ② 工具顺序
 * 并打印变化的工具名与变化前后的差异片段。
 *
 * 用法：node scripts/prefix-diff.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/prefix-diff.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const h = (v) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 10);
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

console.log(`request/header ${headers.length} 次\n`);

/* ---- 1. 每次请求的工具指纹 ---- */
console.log('=== 1. 每次请求的工具清单指纹 ===');
console.log(
  'seq'.padStart(7) + '工具数'.padStart(7) + '整体哈希'.padStart(12) +
  '顺序哈希'.padStart(12) + 'dtm工具哈希'.padStart(14) + '此后首步缓存'.padStart(13),
);

const snaps = [];
for (let i = 0; i < headers.length; i++) {
  const hd = headers[i];
  const tools = hd.data?.header?.tools ?? [];
  const nextSeq = i + 1 < headers.length ? headers[i + 1].seq : Infinity;
  const m = msgs.find((x) => x.seq > hd.seq && x.seq < nextSeq);
  const rate = m
    ? (() => {
      const f = m.data.usage.inputTokens ?? 0;
      const c = m.data.usage.cacheReadTokens ?? 0;
      return f + c > 0 ? `${((c / (f + c)) * 100).toFixed(1)}%` : '—';
    })()
    : '—';

  const dtm = tools.filter((t) => String(t.name).startsWith('dtm_'));
  const snap = {
    seq: hd.seq,
    names: tools.map((t) => t.name),
    byName: new Map(tools.map((t) => [t.name, t])),
    hash: h(tools),
    orderHash: h(tools.map((t) => t.name)),
    dtmHash: h(dtm),
    rate,
  };
  snaps.push(snap);

  console.log(
    String(hd.seq).padStart(7) + String(tools.length).padStart(7) +
    snap.hash.padStart(12) + snap.orderHash.padStart(12) +
    (dtm.length ? snap.dtmHash : '—').padStart(14) + rate.padStart(13),
  );
}

/* ---- 2. 相邻两次的逐工具差异 ---- */
console.log('\n=== 2. 相邻两次请求之间，具体哪个工具变了 ===');
let found = 0;
for (let i = 1; i < snaps.length; i++) {
  const a = snaps[i - 1];
  const b = snaps[i];
  if (a.hash === b.hash) continue;

  found++;
  console.log(`\n  seq ${a.seq} → ${b.seq}   （缓存 ${a.rate} → ${b.rate}）`);

  const added = b.names.filter((n) => !a.byName.has(n));
  const removed = a.names.filter((n) => !b.byName.has(n));
  if (added.length) console.log(`    + 新增工具: ${added.join(', ')}`);
  if (removed.length) console.log(`    - 移除工具: ${removed.join(', ')}`);

  for (const name of b.names) {
    if (!a.byName.has(name)) continue;
    const ta = a.byName.get(name);
    const tb = b.byName.get(name);
    if (h(ta) === h(tb)) continue;

    // 找出这个工具内部哪一段变了
    const sa = JSON.stringify(ta);
    const sb = JSON.stringify(tb);
    let p = 0;
    while (p < sa.length && p < sb.length && sa[p] === sb[p]) p++;
    let q = 0;
    while (q < sa.length && q < sb.length && sa[sa.length - 1 - q] === sb[sb.length - 1 - q]) q++;

    console.log(`    · ${name} 变了（${bytes(ta)} → ${bytes(tb)} 字节）`);
    console.log(`        A: ${JSON.stringify(sa.slice(Math.max(0, p - 40), p + 160))}`);
    console.log(`        B: ${JSON.stringify(sb.slice(Math.max(0, p - 40), p + 160))}`);
  }
}
if (found === 0) console.log('  工具定义全程逐字节不变。');

/* ---- 3. 工具顺序是否变过 ---- */
const orderChanged = new Set(snaps.map((s) => s.orderHash)).size;
console.log(`\n=== 3. 工具顺序 ===`);
console.log(`  不同顺序版本数：${orderChanged}${orderChanged > 1 ? '  ⚠ 顺序变过，会毁缓存' : '（稳定）'}`);

/* ---- 4. 前缀里最靠前的易变项 ---- */
console.log('\n=== 4. 结论 ===');
const dtmVariants = new Set(snaps.filter((s) => s.dtmHash !== '—').map((s) => s.dtmHash));
console.log(`  dtm_* 工具定义出现过 ${dtmVariants.size} 个不同版本`);
const allVariants = new Set(snaps.map((s) => s.hash));
console.log(`  整个工具清单出现过 ${allVariants.size} 个不同版本`);
console.log('  工具定义位于请求最前端，任何一次变化都会让它之后的 system prompt 与全部历史重算。');
