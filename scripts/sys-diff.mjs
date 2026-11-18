/**
 * sys-diff.mjs — 精确找出 system 提示词里「哪个字在变」。
 * 缓存失效的直接证据：同一会话的 system 提示词应当逐字节恒定。
 *
 * 用法：node scripts/sys-diff.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/sys-diff.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

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
const sys = events
  .filter((e) => e.type === 'system/message' && (e.data?.message?.content ?? []).length > 0)
  .map((e) => ({
    seq: e.seq,
    text: e.data.message.content.map((c) => c.text ?? '').join(''),
  }));

console.log(`system/message ${sys.length} 条\n`);
for (const s of sys) console.log(`  seq=${String(s.seq).padStart(6)}  ${bytes(s.text).toString().padStart(6)} 字节  ${s.text.length} 字符`);

// 逐对 diff
for (let i = 1; i < sys.length; i++) {
  const a = sys[i - 1].text;
  const b = sys[i].text;
  if (a === b) {
    console.log(`\n[${i - 1}] vs [${i}]：完全相同`);
    continue;
  }
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length && q < b.length && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;

  const aMid = a.slice(p, a.length - q);
  const bMid = b.slice(p, b.length - q);

  console.log(`\n[${i - 1}] seq=${sys[i - 1].seq} vs [${i}] seq=${sys[i].seq}`);
  console.log(`  共同前缀 ${p} 字符 / 共同后缀 ${q} 字符`);
  console.log(`  A 中段（${aMid.length} 字符）：${JSON.stringify(aMid.slice(0, 400))}`);
  console.log(`  B 中段（${bMid.length} 字符）：${JSON.stringify(bMid.slice(0, 400))}`);
  console.log(`  差异处上文：${JSON.stringify(a.slice(Math.max(0, p - 120), p))}`);
}
