/**
 * inject-pos.mjs — 找出「注入进 loop 的消息」实际被插在消息数组的哪个位置。
 *
 * 判断依据（用户 2026-11-17 指出的原理）：
 *   前缀缓存要求「已发送过的内容字节不变」。消息数组是前缀的一部分，
 *   所以**任何插入到中间/前面的消息，都会让它之后的内容全部重算**。
 *   只有追加到末尾是安全的。
 *
 * agent/inbox/spliced 事件记录了 start（插入下标）与 inserted（插入内容），
 * 这是判断「插在哪」的直接证据。
 *
 * 用法：node scripts/inject-pos.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/inject-pos.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

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

/* ---- 1. inbox spliced：注入位置 ---- */
const spliced = events.filter((e) => e.type === 'agent/inbox/spliced');
console.log(`=== agent/inbox/spliced ${spliced.length} 次 ===\n`);

if (spliced.length > 0) {
  console.log('seq'.padStart(7) + 'start'.padStart(7) + '插入条数'.padStart(9) + '来源kind'.padEnd(24) + '内容前 60 字');
  for (const e of spliced) {
    const start = e.data?.start;
    const inserted = e.data?.inserted ?? [];
    const kinds = inserted.map((m) => m?.source?.kind ?? '?').join(',');
    const text = inserted
      .map((m) => (m?.content ?? []).map((c) => c.text ?? '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    console.log(
      String(e.seq).padStart(7) +
      String(start).padStart(7) +
      String(inserted.length).padStart(9) +
      String(kinds).padEnd(24) +
      text,
    );
  }
} else {
  console.log('  （无 spliced 事件）');
}

/* ---- 2. 各类注入消息的出现顺序 ---- */
console.log('\n=== 注入类消息的出现位置（按 seq）===\n');
const msgTypes = new Set(['user/message', 'assistant/message', 'system/message', 'tool/result']);
const all = events.filter((e) => msgTypes.has(e.type));
const injected = all.filter(
  (m) => m.type === 'user/message' && m.data?.source?.kind && m.data.source.kind !== 'user',
);

const byKind = new Map();
for (const m of injected) {
  const idx = all.filter((x) => x.seq < m.seq).length;
  const cur = byKind.get(m.data.source.kind) ?? [];
  cur.push(idx);
  byKind.set(m.data.source.kind, cur);
}
console.log('kind'.padEnd(24) + '次数'.padStart(5) + '位置（前面已有多少条消息）');
for (const [k, positions] of byKind) {
  const show = positions.slice(0, 12).join(', ');
  const more = positions.length > 12 ? ` …(+${positions.length - 12})` : '';
  console.log(k.padEnd(24) + String(positions.length).padStart(5) + ` ${show}${more}`);
}
console.log(`\n  （消息总数 ${all.length}）`);

/* ---- 3. 判定：哪些注入是「插在中间/前面」的 ---- */
console.log('\n=== 判定 ===');
for (const [k, positions] of byKind) {
  if (positions.length < 2) continue;
  // 若位置单调递增，说明是追加在末尾；若出现回退，说明插到了前面/中间
  let regress = 0;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) regress++;
  }
  // 首个位置很靠前也值得注意
  const first = positions[0];
  const flags = [];
  if (regress > 0) flags.push(`⚠ ${regress} 次位置回退（插到前面/中间）`);
  if (first <= 10 && positions.length > 1) flags.push(`⚠ 首次出现在第 ${first} 条`);
  console.log(`  ${k.padEnd(24)} ${flags.length ? flags.join('；') : '单调递增（追加在末尾，安全）'}`);
}
