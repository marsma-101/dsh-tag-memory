/**
 * today-report.mjs — 最近几天消耗暴增专项排查（只读）。
 * 按天、按会话、按小时拆解真实 usage，找除缓存命中率之外的消耗来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.argv[2] || 'F:/AppDataStore/.dsh/sessions';
const CACHE_DISCOUNT = 1 / 10;

function readSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  starts.push(buf.length);
  let text = '';
  for (let i = 0; i < starts.length - 1; i++) {
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8'); } catch {}
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

const rows = [];
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
        marks.push({ seq: e.seq, key: `${e.data.provider}/${e.data.model ?? '?'}` });
      }
    }
    marks.sort((a, b) => a.seq - b.seq);
    const modelAt = (seq) => {
      let k = 'unknown';
      for (const m of marks) { if (m.seq <= seq) k = m.key; else break; }
      return k;
    };

    for (const e of events) {
      if (e.type !== 'assistant/message' || !e.data?.usage) continue;
      const u = e.data.usage;
      rows.push({
        slug,
        sid,
        seq: e.seq,
        ts: e.ts ?? e.time ?? e.at ?? e.timestamp ?? null,
        model: modelAt(e.seq),
        fresh: u.inputTokens ?? 0,
        cached: u.cacheReadTokens ?? 0,
        out: u.outputTokens ?? 0,
      });
    }
  }
}

// 时间字段探测
const withTs = rows.filter((r) => r.ts != null);
console.log(`步级样本 ${rows.length}，带时间戳 ${withTs.length}`);
if (withTs.length) {
  const sample = withTs[0];
  console.log('时间戳样例:', JSON.stringify(sample.ts), '类型:', typeof sample.ts);
}

const num = (n) => Math.round(n).toLocaleString();
const dayKey = (ts) => {
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  return isNaN(d) ? null : d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
};
const hourKey = (ts) => {
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  return isNaN(d) ? null : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 13);
};

// 若事件无时间戳，回落用文件 mtime
if (!withTs.length) {
  console.log('事件无时间戳，改用会话文件 mtime（粗粒度）。');
  for (const r of rows) r.day = null;
}

// ---- A. 有时间戳：按天 ----
if (withTs.length) {
  const byDay = new Map();
  for (const r of withTs) {
    const d = dayKey(r.ts);
    if (!d) continue;
    const v = byDay.get(d) ?? { fresh: 0, cached: 0, out: 0, n: 0, sess: new Set() };
    v.fresh += r.fresh; v.cached += r.cached; v.out += r.out; v.n++;
    v.sess.add(r.sid);
    byDay.set(d, v);
  }
  console.log('\n=== A. 按天（等效全价 = fresh + cached×0.1）===');
  console.log('日期        步数   会话数   命中率   输出tokens   等效全价tokens');
  for (const [d, v] of [...byDay.entries()].sort()) {
    const eq = v.fresh + v.cached * CACHE_DISCOUNT;
    const tot = v.fresh + v.cached;
    console.log(`${d}  ${String(v.n).padStart(6)} ${String(v.sess.size).padStart(7)}   ${(tot ? v.cached / tot * 100 : 0).toFixed(1).padStart(5)}%  ${num(v.out).padStart(11)}   ${num(eq).padStart(15)}`);
  }

  // ---- B. 最近两天：按小时 ----
  const days = [...byDay.keys()].sort();
  const focusDays = days.slice(-2);
  for (const today of focusDays) {
  const byHour = new Map();
  for (const r of withTs) {
    if (dayKey(r.ts) !== today) continue;
    const h = hourKey(r.ts);
    const v = byHour.get(h) ?? { fresh: 0, cached: 0, out: 0, n: 0 };
    v.fresh += r.fresh; v.cached += r.cached; v.out += r.out; v.n++;
    byHour.set(h, v);
  }
  console.log(`\n=== B. ${today} 按小时 ===`);
  console.log('小时         步数   命中率   输出tokens   等效全价');
  for (const [h, v] of [...byHour.entries()].sort()) {
    const eq = v.fresh + v.cached * CACHE_DISCOUNT;
    const tot = v.fresh + v.cached;
    console.log(`${h}  ${String(v.n).padStart(5)}  ${(tot ? v.cached / tot * 100 : 0).toFixed(1).padStart(5)}%  ${num(v.out).padStart(11)}   ${num(eq).padStart(13)}`);
  }

  // ---- C. 当天：按会话 top10 ----
  const bySess = new Map();
  for (const r of withTs) {
    if (dayKey(r.ts) !== today) continue;
    const k = r.sid;
    const v = bySess.get(k) ?? { slug: r.slug, fresh: 0, cached: 0, out: 0, n: 0, models: new Map() };
    v.fresh += r.fresh; v.cached += r.cached; v.out += r.out; v.n++;
    v.models.set(r.model, (v.models.get(r.model) ?? 0) + 1);
    bySess.set(k, v);
  }
  const top = [...bySess.entries()].sort((a, b) => (b[1].fresh + b[1].cached * 0.1) - (a[1].fresh + a[1].cached * 0.1)).slice(0, 10);
  console.log(`\n=== C. ${today} 按会话 top10（等效全价）===`);
  for (const [sid, v] of top) {
    const eq = v.fresh + v.cached * CACHE_DISCOUNT;
    const tot = v.fresh + v.cached;
    const models = [...v.models.entries()].map(([m, n]) => `${m}×${n}`).join(', ');
    console.log(`${sid.slice(0, 13)}  步${String(v.n).padStart(5)}  命中${(tot ? v.cached / tot * 100 : 0).toFixed(1).padStart(5)}%  输出${num(v.out).padStart(8)}  等效${num(eq).padStart(12)}`);
    console.log(`    项目: ${v.slug}`);
    console.log(`    模型: ${models}`);
  }
  }
} else {
  // 无时间戳：按会话给文件 mtime 当天的 top
  console.log('\n=== 按会话（文件 mtime 近 3 天）===');
  const list = [];
  for (const slug of fs.readdirSync(ROOT)) {
    const slugDir = path.join(ROOT, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(slugDir)) {
      const file = path.join(slugDir, sid, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > 3 * 86400e3) continue;
      list.push({ slug, sid, mtime: st.mtime });
    }
  }
  for (const it of list) console.log(`${it.mtime.toLocaleString('sv-SE')}  ${it.sid.slice(0, 13)}  ${it.slug}`);
}
