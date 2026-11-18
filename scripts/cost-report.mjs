/**
 * cost-report.mjs — 积分/token 消耗归因（只读，不改库、不改插件）。
 *
 * 数据源是**真实会话日志**里的 usage 字段，不是字节数估算：
 *   F:\AppDataStore\.dsh\sessions\<slug>\session-<id>\session.v4.jsonl.zstd
 *
 * 口径（关键，别搞错）：
 *   · inputTokens       = 未命中缓存的部分 → **全价计费**
 *   · cacheReadTokens   = 命中的部分       → 通常约 1/10 价
 *   · 两者相加才是总输入
 *   只拿 inputTokens 比大小会把「缓存好的长会话」误判成「便宜」。
 *
 * 用法：
 *   node scripts/cost-report.mjs                 # 全部会话
 *   node scripts/cost-report.mjs <sessions根目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.argv[2] || 'F:/AppDataStore/.dsh/sessions';
const CACHE_DISCOUNT = 1 / 10; // 缓存命中按 1/10 计价的行业通行折算

const bytes = (s) => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');

/** 解多帧 zstd 会话日志（按 magic 28 B5 2F FD 切帧）。 */
function readSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  starts.push(buf.length);
  let text = '';
  for (let i = 0; i < starts.length - 1; i++) {
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8');
    } catch {
      /* 尾部残帧忽略 */
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 损坏行忽略 */
    }
  }
  return out;
}

/** 遍历全部会话，产出 {model, hasDtm, fresh, cached, out} 的步级样本。 */
function collectSteps(root) {
  const steps = [];
  let sectionBytes = null;

  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;

    for (const sid of fs.readdirSync(slugDir)) {
      const file = path.join(slugDir, sid, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;

      let events;
      try {
        events = readSession(file);
      } catch {
        continue;
      }

      // provider/model 时间线：按 seq 取「该步生效的模型」
      const marks = [];
      for (const e of events) {
        if ((e.type === 'request/context' || e.type === 'model/selection') && e.data?.provider) {
          marks.push({ seq: e.seq, key: `${e.data.provider}/${e.data.model ?? '?'}` });
        }
      }
      marks.sort((a, b) => a.seq - b.seq);
      const modelAt = (seq) => {
        let k = 'unknown';
        for (const m of marks) {
          if (m.seq <= seq) k = m.key;
          else break;
        }
        return k;
      };

      // 该会话是否加载了 dtm 工具（看真实 header，不看配置）
      const headers = events.filter((e) => e.type === 'request/header');
      const dtmHeaders = headers.filter((h) =>
        (h.data?.header?.tools ?? []).some((t) => String(t.name).startsWith('dtm_')),
      );
      const dtmToolBytes = dtmHeaders.length
        ? dtmHeaders[dtmHeaders.length - 1].data.header.tools
          .filter((t) => String(t.name).startsWith('dtm_'))
          .reduce((a, t) => a + bytes(t), 0)
        : 0;

      // 从 system/message 里量 section 真实字节（只量一次）。
      // ⚠️ 不能「找到下一个 ## 为止」——section 后面紧跟的正文未必以 ## 开头，
      // 那样会把别人的内容一起量进来（实测因此多算 2279 字节）。
      // 用 section 自己的**结尾标记**切：renderInjection 的最后一行是固定的。
      if (sectionBytes === null) {
        const sys = events.find(
          (e) =>
            e.type === 'system/message' &&
            (e.data?.message?.content ?? []).some?.((c) => String(c?.text ?? '').includes('长期记忆（dsh-tag-memory）')),
        );
        if (sys) {
          const txt = sys.data.message.content.map((c) => c.text ?? '').join('');
          const start = txt.indexOf('## 长期记忆（dsh-tag-memory）');
          const END_MARK = '需要时读插件内 `标签字典.md`。';
          const end = start >= 0 ? txt.indexOf(END_MARK, start) : -1;
          if (start >= 0 && end >= 0) {
            sectionBytes = bytes(txt.slice(start, end + END_MARK.length));
          }
        }
      }

      for (const e of events) {
        if (e.type !== 'assistant/message' || !e.data?.usage) continue;
        const u = e.data.usage;
        steps.push({
          model: modelAt(e.seq),
          hasDtm: dtmToolBytes > 0,
          dtmToolBytes,
          fresh: u.inputTokens ?? 0,
          cached: u.cacheReadTokens ?? 0,
          out: u.outputTokens ?? 0,
        });
      }
    }
  }

  return { steps, sectionBytes };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const num = (n) => Math.round(n).toLocaleString();

/* ================================================================== */

const { steps, sectionBytes } = collectSteps(ROOT);
if (steps.length === 0) {
  console.error(`未在 ${ROOT} 找到带 usage 的会话。`);
  process.exit(1);
}

console.log(`会话根目录：${ROOT}`);
console.log(`步级样本：${num(steps.length)}\n`);

/* ---- 1. 按服务商/模型归因 ---- */
console.log('=== 1. 按服务商/模型（真实计费口径）===');
console.log(
  'provider/model'.padEnd(34) + '步数'.padStart(7) + '命中率'.padStart(9) +
  '每步新鲜'.padStart(11) + '等效全价tokens'.padStart(17) + '占比'.padStart(8),
);

const byModel = new Map();
for (const s of steps) {
  const cur = byModel.get(s.model) ?? { fresh: 0, cached: 0, n: 0 };
  cur.fresh += s.fresh;
  cur.cached += s.cached;
  cur.n++;
  byModel.set(s.model, cur);
}

let grand = 0;
const ranked = [];
for (const [k, v] of byModel) {
  const eq = v.fresh + v.cached * CACHE_DISCOUNT;
  grand += eq;
  ranked.push([k, eq, v]);
}
ranked.sort((a, b) => b[1] - a[1]);

for (const [k, eq, v] of ranked) {
  const total = v.fresh + v.cached;
  console.log(
    k.padEnd(34) +
    String(v.n).padStart(7) +
    pct(total > 0 ? v.cached / total : 0).padStart(9) +
    num(v.fresh / v.n).padStart(11) +
    num(eq).padStart(17) +
    pct(eq / grand).padStart(8),
  );
}
console.log(`\n合计等效全价 ${num(grand)} tokens（缓存按 ${CACHE_DISCOUNT} 折算）`);

/* ---- 2. 同模型对照：有无 dtm ---- */
console.log('\n=== 2. 同模型对照：有无 dtm 工具 ===');
console.log(
  'provider/model'.padEnd(34) + 'dtm'.padEnd(6) + '步数'.padStart(7) +
  '命中率'.padStart(9) + '每步新鲜'.padStart(11),
);

const cross = new Map();
for (const s of steps) {
  const k = `${s.model}|${s.hasDtm ? '有' : '无'}`;
  const cur = cross.get(k) ?? { fresh: 0, cached: 0, n: 0 };
  cur.fresh += s.fresh;
  cur.cached += s.cached;
  cur.n++;
  cross.set(k, cur);
}

for (const m of [...byModel.keys()].sort()) {
  for (const flag of ['有', '无']) {
    const v = cross.get(`${m}|${flag}`);
    if (!v) continue;
    const total = v.fresh + v.cached;
    console.log(
      m.padEnd(34) + flag.padEnd(6) +
      String(v.n).padStart(7) +
      pct(total > 0 ? v.cached / total : 0).padStart(9) +
      num(v.fresh / v.n).padStart(11),
    );
  }
}
console.log('\n判读：同模型下「有 dtm」与「无 dtm」命中率接近 → 插件不是缓存失效原因。');

/* ---- 3. 插件固定开销 ---- */
console.log('\n=== 3. 插件每步固定开销 ===');
const dtmSizes = steps.filter((s) => s.hasDtm).map((s) => s.dtmToolBytes);
const avgDtm = dtmSizes.length ? Math.round(dtmSizes.reduce((a, b) => a + b, 0) / dtmSizes.length) : 0;
const fixed = (sectionBytes ?? 0) + avgDtm;
const dtmSteps = steps.filter((s) => s.hasDtm).length;
const fixedTokens = Math.round(fixed / 2.6);
const dtmTotal = fixedTokens * dtmSteps;
const allFresh = steps.reduce((a, s) => a + s.fresh, 0);

console.log(`  systemPrompt.section   ${String(sectionBytes ?? '未测得').padStart(6)} 字节`);
console.log(`  dtm 工具定义（均值）   ${String(avgDtm).padStart(6)} 字节（${dtmSizes.length} 个会话样本）`);
console.log(`  每步固定合计           ${String(fixed).padStart(6)} 字节 ≈ ${num(fixedTokens)} tokens`);
console.log(`  装插件的步数           ${num(dtmSteps)}`);
console.log(`  固定注入总量           ${num(dtmTotal)} tokens`);
console.log(`  全部新鲜 input         ${num(allFresh)} tokens`);
console.log(`  → 占全部新鲜 input 的   ${pct(dtmTotal / allFresh)}`);

/* ---- 4. 分桶对照（排除长会话混淆）---- */
console.log('\n=== 4. 分桶对照：同服务商 + 同上下文量级 ===');
console.log(
  'provider'.padEnd(20) + '上下文'.padEnd(11) +
  '有dtm步'.padStart(9) + '有dtm每步'.padStart(11) +
  '无dtm步'.padStart(9) + '无dtm每步'.padStart(11) + '差异'.padStart(9),
);

const buckets = [
  ['0-30k', 0, 30000],
  ['30-80k', 30000, 80000],
  ['80-150k', 80000, 150000],
  ['150k+', 150000, Infinity],
];
const providers = [...new Set(steps.map((s) => s.model.split('/')[0]))].sort();

for (const p of providers) {
  for (const [label, lo, hi] of buckets) {
    const inBucket = (dtm) =>
      steps.filter(
        (s) =>
          s.model.startsWith(`${p}/`) &&
          s.hasDtm === dtm &&
          s.fresh + s.cached >= lo &&
          s.fresh + s.cached < hi,
      );
    const A = inBucket(true);
    const B = inBucket(false);
    if (A.length < 20 || B.length < 20) continue; // 样本太少不下结论
    const avg = (l) => Math.round(l.reduce((a, s) => a + s.fresh, 0) / l.length);
    const a = avg(A);
    const b = avg(B);
    console.log(
      p.padEnd(20) + label.padEnd(11) +
      String(A.length).padStart(9) + num(a).padStart(11) +
      String(B.length).padStart(9) + num(b).padStart(11) +
      `${a >= b ? '+' : ''}${pct((a - b) / b)}`.padStart(9),
    );
  }
}

/* ---- 5. 潜在可省 ---- */
console.log('\n=== 5. 潜在可省（按「同模型里缓存最好的服务商」推算）===');
for (const [k, eq, v] of ranked.slice(0, 3)) {
  const total = v.fresh + v.cached;
  const rate = total > 0 ? v.cached / total : 0;
  if (rate > 0.5) continue; // 缓存已经很好，没什么可省的
  const best = ranked
    .filter(([k2]) => k2.split('/')[1] === k.split('/')[1] && k2 !== k)
    .map(([, , v2]) => (v2.fresh + v2.cached > 0 ? v2.cached / (v2.fresh + v2.cached) : 0))
    .sort((a, b) => b - a)[0];
  if (!best) continue;
  const wouldBe = v.fresh * (1 - best) + (v.fresh * best) * CACHE_DISCOUNT;
  console.log(`  ${k}`);
  console.log(`    当前命中 ${pct(rate)}，等效全价 ${num(eq)} tokens`);
  console.log(`    同模型最佳命中 ${pct(best)} → 可降到 ${num(wouldBe)} tokens（省 ${num(eq - wouldBe)}，降 ${pct(1 - wouldBe / eq)}）`);
}
