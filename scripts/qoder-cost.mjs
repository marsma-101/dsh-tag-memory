/**
 * qoder-cost.mjs — 在「缓存命中率 98%」的服务商上，插件固定注入的真实成本。
 *
 * ── 为什么必须单独算（这是本次诊断的核心发现）────────────────────
 * 计费的是**未命中缓存的新鲜 input**，不是总 token。
 * 缓存命中率越高，插件那份「每步必发的固定前缀」在账单里的占比就越大：
 *
 *   trae      缓存 0%   → 每步新鲜 112,000，插件 4,600 → 占 4.1%
 *   workbuddy 缓存 80%  → 每步新鲜  53,400，插件 4,600 → 占 8.6%
 *   qoder     缓存 98%  → 每步新鲜   8,857，插件 4,600 → 占 52.0%
 *
 * 同一份插件开销，在缓存好的服务商上被放大 13 倍。
 * 所以「插件只占 4.7%」这个结论**只对 trae 成立**，对 qoder 完全不成立。
 *
 * ── 口径 ──────────────────────────────────────────────────────
 *   inputTokens     = 未命中（全价）→ 真正付钱的部分
 *   cacheReadTokens = 命中（约 1/10 价）
 *
 * 用法：node scripts/qoder-cost.mjs [sessions根目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.argv[2] || 'F:/AppDataStore/.dsh/sessions';
const TARGET = process.argv[3] || 'qoder';
const SECTION_BYTES = 3988; // renderInjection 实测，55 行
const TOK = (b) => Math.round(b / 2.6);

const bytes = (s) => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');
const num = (n) => Math.round(n).toLocaleString();
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function readSession(file) {
  const buf = fs.readFileSync(file);
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

/* ---------- 采集 ---------- */
const steps = [];   // 步级样本
const sessions = []; // 会话级汇总

for (const slug of fs.readdirSync(ROOT)) {
  const slugDir = path.join(ROOT, slug);
  if (!fs.statSync(slugDir).isDirectory()) continue;

  for (const sid of fs.readdirSync(slugDir)) {
    const file = path.join(slugDir, sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    let events;
    try { events = readSession(file); } catch { continue; }

    const marks = [];
    for (const e of events) {
      if ((e.type === 'request/context' || e.type === 'model/selection') && e.data?.provider) {
        marks.push({ seq: e.seq, key: e.data.provider });
      }
    }
    marks.sort((a, b) => a.seq - b.seq);
    const provAt = (s) => { let k = '?'; for (const m of marks) { if (m.seq <= s) k = m.key; else break; } return k; };

    const headers = events.filter((e) => e.type === 'request/header');
    const dtmHeaders = headers.filter((h) =>
      (h.data?.header?.tools ?? []).some((t) => String(t.name).startsWith('dtm_')));
    const dtmToolBytes = dtmHeaders.length
      ? dtmHeaders[dtmHeaders.length - 1].data.header.tools
        .filter((t) => String(t.name).startsWith('dtm_')).reduce((a, t) => a + bytes(t), 0)
      : 0;

    const msgs = events.filter((e) => e.type === 'assistant/message' && e.data?.usage);
    if (msgs.length === 0) continue;

    const per = new Map();
    let firstTime = null;
    for (const m of msgs) {
      const p = provAt(m.seq);
      if (p !== TARGET) continue;
      const u = m.data.usage;
      const cur = per.get(p) ?? { fresh: 0, cached: 0, out: 0, n: 0 };
      cur.fresh += u.inputTokens ?? 0;
      cur.cached += u.cacheReadTokens ?? 0;
      cur.out += u.outputTokens ?? 0;
      cur.n++;
      per.set(p, cur);
      if (firstTime === null || m.time < firstTime) firstTime = m.time;

      steps.push({ hasDtm: dtmToolBytes > 0, fresh: u.inputTokens ?? 0, cached: u.cacheReadTokens ?? 0 });
    }

    for (const [, v] of per) {
      sessions.push({
        date: new Date(firstTime).toISOString().slice(0, 10),
        sid: sid.replace('session-', '').slice(0, 8),
        hasDtm: dtmToolBytes > 0,
        dtmToolBytes,
        ...v,
        total: v.fresh + v.cached,
      });
    }
  }
}

if (steps.length === 0) {
  console.error(`没有 ${TARGET} 的会话样本。`);
  process.exit(1);
}

const fixedPerStep = (SECTION_BYTES + (sessions.find((s) => s.hasDtm)?.dtmToolBytes ?? 0)) / 2.6;

/* ---------- 1. 同服务商内对照 ---------- */
console.log(`=== 1. ${TARGET} 内部对照：有无 dtm ===\n`);
const A = steps.filter((s) => s.hasDtm);
const B = steps.filter((s) => !s.hasDtm);
const avgFresh = (l) => Math.round(l.reduce((a, s) => a + s.fresh, 0) / l.length);
const rateOf = (l) => {
  const t = l.reduce((a, s) => a + s.fresh + s.cached, 0);
  return t > 0 ? l.reduce((a, s) => a + s.cached, 0) / t : 0;
};

console.log('分组'.padEnd(12) + '步数'.padStart(7) + '命中率'.padStart(9) + '每步新鲜input'.padStart(15) + '合计新鲜'.padStart(14));
for (const [label, l] of [['有 dtm', A], ['无 dtm', B]]) {
  if (l.length === 0) continue;
  console.log(
    label.padEnd(12) + String(l.length).padStart(7) + pct(rateOf(l)).padStart(9) +
    num(avgFresh(l)).padStart(15) + num(l.reduce((a, s) => a + s.fresh, 0)).padStart(14),
  );
}
if (A.length && B.length) {
  console.log(`\n  → 有插件时每步新鲜 input 是没插件时的 ${(avgFresh(A) / avgFresh(B)).toFixed(2)}×`);
  console.log(`  → 每步多付 ${num(avgFresh(A) - avgFresh(B))} tokens（插件固定注入约 ${num(fixedPerStep)}）`);
}

/* ---------- 2. 会话明细 ---------- */
console.log(`\n=== 2. ${TARGET} 会话明细（插件固定注入占新鲜 input 的比例）===\n`);
console.log(
  '日期'.padEnd(12) + '会话'.padEnd(10) + '步'.padStart(5) + '命中率'.padStart(8) +
  '新鲜input'.padStart(12) + '每步新鲜'.padStart(10) + '插件固定'.padStart(11) + '占新鲜'.padStart(9),
);

let sumFresh = 0, sumFixed = 0, sumOut = 0;
for (const s of sessions.filter((x) => x.hasDtm).sort((a, b) => b.fresh - a.fresh)) {
  const fixedTotal = ((SECTION_BYTES + s.dtmToolBytes) / 2.6) * s.n;
  sumFresh += s.fresh;
  sumFixed += fixedTotal;
  sumOut += s.out;
  console.log(
    s.date.padEnd(12) + s.sid.padEnd(10) + String(s.n).padStart(5) +
    pct(s.total > 0 ? s.cached / s.total : 0).padStart(8) +
    num(s.fresh).padStart(12) + num(s.fresh / s.n).padStart(10) +
    num(fixedTotal).padStart(11) +
    pct(s.fresh > 0 ? fixedTotal / s.fresh : 0).padStart(9),
  );
}

console.log('');
console.log(`  合计新鲜 input ${num(sumFresh)}；输出 ${num(sumOut)}`);
console.log(`  插件固定注入约 ${num(sumFixed)} tokens → 占新鲜 input 的 ${pct(sumFixed / sumFresh)}`);

/* ---------- 3. 跨服务商放大倍数 ---------- */
console.log('\n=== 3. 同一份插件开销，在不同缓存命中率下的占比 ===\n');
console.log('服务商/缓存'.padEnd(26) + '每步新鲜'.padStart(11) + '插件固定'.padStart(11) + '插件占比'.padStart(10) + '相对 trae'.padStart(10));
const scenarios = [
  ['trae（缓存 0%）', 112000],
  ['workbuddy（缓存 80%）', 53400],
  [`${TARGET}（缓存 ${(rateOf(A) * 100).toFixed(0)}%）`, avgFresh(A)],
  [`${TARGET} 最优步`, 3000],
];
const base = fixedPerStep / 112000;
for (const [label, perStep] of scenarios) {
  const share = fixedPerStep / perStep;
  console.log(
    label.padEnd(26) + num(perStep).padStart(11) + num(fixedPerStep).padStart(11) +
    pct(share).padStart(10) + `${(share / base).toFixed(0)}×`.padStart(10),
  );
}

/* ---------- 4. 修复后能省多少 ---------- */
console.log('\n=== 4. 若把插件固定注入砍掉一半，能省多少 ===\n');
const halfSaved = sumFixed * 0.5;
console.log(`  当前插件固定注入 ${num(sumFixed)} tokens（占新鲜 input ${pct(sumFixed / sumFresh)}）`);
console.log(`  砍掉一半可省     ${num(halfSaved)} tokens → 新鲜 input 降 ${pct(halfSaved / sumFresh)}`);
console.log(`  每步省           ${num(fixedPerStep * 0.5)} tokens`);

console.log('\n  可砍的地方（按体积排序）：');
console.log(`    ① 标签网络重复注入两遍   约 ${num((6412 * 2) / 2.6)} tokens/步（dtm_write + dtm_recall 各一份）`);
console.log(`    ② section 固定段         约 ${num(SECTION_BYTES / 2.6)} tokens/步`);
console.log(`    ③ 其余 10 个工具定义      约 ${num((fixedPerStep - (6412 * 2) / 2.6 - SECTION_BYTES / 2.6))} tokens/步`);
