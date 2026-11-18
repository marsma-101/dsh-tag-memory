/** afd41-focus.mjs — 单会话步级输入规模分析（只读） */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'F:/AppDataStore/.dsh/sessions';
const SID_PREFIX = process.argv[2] || 'session-afd41997';
const DAY = process.argv[3] || '2026-11-17';

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

const num = (n) => Math.round(n).toLocaleString();
const dayKey = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const hourKey = (ts) => new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 13);

for (const slug of fs.readdirSync(ROOT)) {
  const slugDir = path.join(ROOT, slug);
  if (!fs.statSync(slugDir).isDirectory()) continue;
  for (const sid of fs.readdirSync(slugDir)) {
    if (!sid.startsWith(SID_PREFIX)) continue;
    const file = path.join(slugDir, sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    const events = readSession(file);
    const marks = [];
    for (const e of events) {
      if ((e.type === 'request/context' || e.type === 'model/selection') && e.data?.provider) {
        marks.push({ seq: e.seq, key: `${e.data.provider}/${e.data.model ?? '?'}` });
      }
    }
    marks.sort((a, b) => a.seq - b.seq);
    const modelAt = (seq) => { let k = '?'; for (const m of marks) { if (m.seq <= seq) k = m.key; else break; } return k; };

    const steps = [];
    for (const e of events) {
      if (e.type !== 'assistant/message' || !e.data?.usage) continue;
      const u = e.data.usage;
      steps.push({ ts: e.ts ?? e.time ?? e.at, model: modelAt(e.seq), fresh: u.inputTokens ?? 0, cached: u.cacheReadTokens ?? 0, out: u.outputTokens ?? 0 });
    }
    const today = steps.filter((s) => dayKey(s.ts) === DAY);
    console.log(`会话 ${sid} 项目 ${slug}`);
    console.log(`今天(${DAY}) ${today.length} 步`);
    const tot = today.reduce((a, s) => ({ f: a.f + s.fresh, c: a.c + s.cached, o: a.o + s.out }), { f: 0, c: 0, o: 0 });
    if (today.length) {
      console.log(`  输入总量: 未命中 ${num(tot.f)} + 命中 ${num(tot.c)} = 总输入 ${num(tot.f + tot.c)}`);
      console.log(`  平均每步总输入: ${num((tot.f + tot.c) / today.length)}  最大: ${num(Math.max(...today.map((s) => s.fresh + s.cached)))}`);
      console.log(`  输出总量: ${num(tot.o)}  平均每步输出: ${num(tot.o / today.length)}`);
      const byModel = new Map();
      for (const s of today) {
        const v = byModel.get(s.model) ?? { n: 0, f: 0, c: 0, o: 0 };
        v.n++; v.f += s.fresh; v.c += s.cached; v.o += s.out;
        byModel.set(s.model, v);
      }
      console.log('  按模型:');
      for (const [m, v] of byModel) {
        const t = v.f + v.c;
        console.log(`    ${m.padEnd(32)} 步${String(v.n).padStart(5)}  命中${(t ? v.c / t * 100 : 0).toFixed(1).padStart(5)}%  每步总输入${num(t / v.n).padStart(10)}  输出${num(v.o).padStart(8)}`);
      }
      const byHour = new Map();
      for (const s of today) {
        const h = hourKey(s.ts);
        const v = byHour.get(h) ?? { n: 0, eq: 0 };
        v.n++; v.eq += s.fresh + s.cached * 0.1;
        byHour.set(h, v);
      }
      console.log('  按小时等效全价:');
      for (const [h, v] of [...byHour.entries()].sort()) console.log(`    ${h}  步${String(v.n).padStart(4)}  等效 ${num(v.eq)}`);
      // 上下文膨胀曲线：每 30 步取样平均每步总输入
      console.log('  上下文膨胀（每30步平均每步总输入）:');
      for (let i = 0; i < today.length; i += 30) {
        const seg = today.slice(i, i + 30);
        const avg = seg.reduce((a, s) => a + s.fresh + s.cached, 0) / seg.length;
        console.log(`    步${String(i + 1).padStart(4)}-${String(i + seg.length).padStart(4)}  平均每步总输入 ${num(avg)}`);
      }
    }
  }
}
