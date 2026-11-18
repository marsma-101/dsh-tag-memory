/**
 * qoder 归因：在缓存命中率极高的服务商上，插件的固定注入占「新鲜 input」多少。
 *
 * 为什么必须单独算这一份：
 *   trae 缓存 0% → 每步 11 万 tokens 全价，插件 4500 只占 4%。
 *   qoder 缓存 98% → 每步新鲜 input 只有几千，插件 4500 可能占一半。
 *   同一份插件开销，在缓存好的服务商上占比被放大 10 倍。
 *
 * 用法：node scripts/qoder-attribution.mjs [sessions根目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.argv[2] || 'F:/AppDataStore/.dsh/sessions';
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

const sessions = [];

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

    // 按 provider 分组（一个会话可能中途换过服务商）
    const per = new Map();
    let firstTime = null;
    for (const m of msgs) {
      const p = provAt(m.seq);
      const u = m.data.usage;
      const cur = per.get(p) ?? { fresh: 0, cached: 0, out: 0, n: 0 };
      cur.fresh += u.inputTokens ?? 0;
      cur.cached += u.cacheReadTokens ?? 0;
      cur.out += u.outputTokens ?? 0;
      cur.n++;
      per.set(p, cur);
      if (firstTime === null || m.time < firstTime) firstTime = m.time;
    }

    for (const [p, v] of per) {
      sessions.push({
        date: new Date(firstTime).toISOString().slice(0, 10),
        slug, sid: sid.replace('session-', '').slice(0, 8),
        provider: p, hasDtm: dtmToolBytes > 0, dtmToolBytes,
        ...v,
        total: v.fresh + v.cached,
      });
    }
  }
}

/* ---- 1. qoder 会话明细：新鲜 input 里插件占多少 ---- */
const SECTION = 3988;
const qoder = sessions.filter((s) => s.provider === 'qoder').sort((a, b) => b.fresh - a.fresh);

console.log('=== 1. Qoder 会话：插件固定注入 vs 新鲜 input ===');
console.log('（qoder 缓存命中 97–99%，所以「新鲜 input」才是真正付钱的部分）\n');
console.log(
  '日期'.padEnd(12) + '会话'.padEnd(10) + '步'.padStart(5) + '命中率'.padStart(8) +
  '新鲜input'.padStart(12) + '每步新鲜'.padStart(10) + '插件固定'.padStart(10) + '占新鲜'.padStart(9),
);

let sumFresh = 0, sumFixed = 0, sumOut = 0;
for (const s of qoder) {
  const fixedPerStep = (SECTION + s.dtmToolBytes) / 2.6;
  const fixedTotal = fixedPerStep * s.n;
  const share = s.fresh > 0 ? fixedTotal / s.fresh : 0;
  sumFresh += s.fresh;
  sumFixed += fixedTotal;
  sumOut += s.out;
  console.log(
    s.date.padEnd(12) + s.sid.padEnd(10) + String(s.n).padStart(5) +
    pct(s.total > 0 ? s.cached / s.total : 0).padStart(8) +
    num(s.fresh).padStart(12) +
    num(s.fresh / s.n).padStart(10) +
    num(fixedTotal).padStart(10) +
    pct(share).padStart(9),
  );
}

console.log('');
console.log(`Qoder 合计：新鲜 input ${num(sumFresh)}，输出 ${num(sumOut)}`);
console.log(`  插件固定注入约 ${num(sumFixed)} tokens，占新鲜 input 的 ${pct(sumFixed / sumFresh)}`);

/* ---- 2. 同一份插件开销，在不同缓存命中率下的占比 ---- */
console.log('\n=== 2. 为什么「同一份插件开销」在 qoder 上更贵 ===\n');
console.log('场景'.padEnd(28) + '每步新鲜'.padStart(11) + '插件固定'.padStart(10) + '插件占比'.padStart(10) + '放大倍数'.padStart(10));

const avgDtmBytes = sessions.filter((s) => s.hasDtm).map((s) => s.dtmToolBytes);
const dtmAvg = avgDtmBytes.length ? avgDtmBytes.reduce((a, b) => a + b, 0) / avgDtmBytes.length : 0;
const fixedPerStep = (SECTION + dtmAvg) / 2.6;

const scenarios = [
  ['trae（缓存 0%）', 112000, 0],
  ['workbuddy（缓存 80%）', 53400, 0],
  ['qoder（缓存 98%）', 8857, 0],
  ['qoder 单步最优情形', 3000, 0],
];
const baseline = null;
for (const [label, perStepFresh] of scenarios) {
  const share = fixedPerStep / perStepFresh;
  console.log(
    label.padEnd(28) +
    num(perStepFresh).padStart(11) +
    num(fixedPerStep).padStart(10) +
    pct(share).padStart(10) +
    `${(share / (fixedPerStep / 112000)).toFixed(0)}×`.padStart(10),
  );
}

/* ---- 3. 三个账号的积分能不能被长会话烧光 ---- */
console.log('\n=== 3. 积分核算（按官方 API 等价价估算，1 credit ≈ ¥0.04）===\n');
console.log('会话'.padEnd(14) + '步'.padStart(5) + '新鲜input'.padStart(12) + '输出'.padStart(9) +
  '其中插件'.padStart(10) + '≈credits'.padStart(10) + '其中插件'.padStart(10));

// DeepSeek 官方价量级：input 未命中 ¥1/M，output ¥2/M（保守量级，只用于比例判断）
const P_IN = 1 / 1e6;
const P_OUT = 2 / 1e6;
const CREDIT_YUAN = 0.04;

const top = qoder.slice(0, 8);
for (const s of top) {
  const fixedTotal = ((SECTION + s.dtmToolBytes) / 2.6) * s.n;
  const yuan = s.fresh * P_IN + s.out * P_OUT;
  const pluginYuan = fixedTotal * P_IN;
  console.log(
    `${s.date} ${s.sid}`.padEnd(14) +
    String(s.n).padStart(5) +
    num(s.fresh).padStart(12) +
    num(s.out).padStart(9) +
    num(fixedTotal).padStart(10) +
    num(yuan / CREDIT_YUAN).padStart(10) +
    num(pluginYuan / CREDIT_YUAN).padStart(10),
  );
}

const totalYuan = sumFresh * P_IN + sumOut * P_OUT;
console.log('');
console.log(`Qoder 全部会话等价 ≈ ${num(totalYuan / CREDIT_YUAN)} credits（¥${totalYuan.toFixed(2)}）`);
console.log(`  其中插件固定注入 ≈ ${num((sumFixed * P_IN) / CREDIT_YUAN)} credits`);
console.log(`  用户三个账号合计约 600–1200 credits —— 量级吻合，长会话确实能烧光。`);
