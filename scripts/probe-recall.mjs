/**
 * probe-recall.mjs — 召回健康度探针（只读、零副作用）
 *
 * ⚠️ 2026-11-16 重写。旧版只有一个「自查询探针」：对每条可见条目取它自己的前 k 个标签当查询，
 * 看它是否出现在 recall() 的 hits 里。
 *
 * 那个探针**测不出真实缺陷**，实测对比：
 *   自查询探针（k=3）报 97% 召回率，而真实会话里的召回成功率只有 27%。
 * 原因：自查询的查询词天生与条目标签 100% 重合，是「最理想查询」。
 * 真实查询是模型临时想的词，与条目标签的重合度天然更低。
 *
 * 这与「测试输入必须来自真实链路」是同一条纪律——理想输入测不出真实问题。
 *
 * ── 现在探针分两段 ─────────────────────────────────────────────
 *   ① 【真实查询回放】从 $DSH_HOME/sessions/*.zstd 解出历史上真实发生过的 dtm_recall 调用，
 *      逐条重放。这是**唯一能反映真实召回率**的口径。
 *   ② 【自查询基准】保留作回归基线（它验的是「条目能不能被自己的标签找到」，
 *      是必要条件但不是充分条件）。
 *
 * 用法：
 *   node scripts/probe-recall.mjs                 # 两段都跑（有会话日志时）
 *   node scripts/probe-recall.mjs --no-sessions   # 只跑自查询基准
 *   node scripts/probe-recall.mjs --lib <csv> --project <p> --agent <a>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { recall, checkIsolation, computeHit, buildEquivalenceIndex } from '../lib/engine/read.mjs';
import { readLibraryCsv } from '../lib/engine/core.mjs';
import schema from '../lib/engine/templates/schema.json' with { type: 'json' };
import scoring from '../lib/engine/templates/scoring.json' with { type: 'json' };
import equivalence from '../lib/engine/templates/tag-equivalence.json' with { type: 'json' };

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_LIB = path.join(os.homedir(), '.dsh', 'tag-memory', 'store', 'memory.csv');
const SEED_LIB = path.join(PACKAGE_DIR, 'data', 'store', 'memory.csv');
const SESS_DIR = path.join(os.homedir(), '.dsh', 'sessions');

function parseArgs(argv) {
  const out = { lib: null, project: 'dsh-tag-memory', agent: '萧潇', sessions: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lib') out.lib = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--agent') out.agent = argv[++i];
    else if (argv[i] === '--no-sessions') out.sessions = false;
  }
  return out;
}

/* ── 解多帧 zstd（DSH 会话日志格式：每帧一条 JSON） ── */
function loadSessionRows(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  const chunks = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 从会话目录 slug 还原项目名（slug 把路径分隔符换成了 '-'）。 */
function makeProjectResolver(knownProjects) {
  const real = knownProjects.filter((p) => p !== '通用' && p !== '引入');
  return (dir) => {
    const hit = real.filter((p) => dir.endsWith(p + '--'));
    return hit.length ? hit.sort((a, b) => b.length - a.length)[0] : '通用';
  };
}

const args = parseArgs(process.argv.slice(2));
const libPath = args.lib ?? (fs.existsSync(PROD_LIB) ? PROD_LIB : SEED_LIB);
const { records, errors } = await readLibraryCsv(libPath, schema);
if (errors.length > 0) {
  console.error(`库解析有 ${errors.length} 条错误（前 3 条）：`, errors.slice(0, 3));
}

const identity = { bound: true, who: args.agent };
const eq = buildEquivalenceIndex(equivalence);
const visible = records.filter((r) =>
  checkIsolation(r, { project: args.project, agent: args.agent }, schema).pass,
);
const tagged = visible.filter((r) => Array.isArray(r['自由标签']) && r['自由标签'].length > 0);
const avgTags = tagged.length > 0 ? tagged.reduce((s, r) => s + r['自由标签'].length, 0) / tagged.length : 0;

console.log(`库文件：${libPath}`);
console.log(`总条目 ${records.length} / 可见 ${visible.length} / 有标签 ${tagged.length} / 平均标签数 ${avgTags.toFixed(2)}`);
console.log(`视角：项目=${args.project} 智能体=${args.agent}`);
console.log(`判据：minHit=${scoring.veto.minHit} queryFloor=${scoring.veto.queryFloor} passLine=${scoring.passLine} 权重=${scoring.weights.shapeHit}/${scoring.weights.tagMax}/${scoring.weights.tickMaxScore}`);

/* ================================================================== *
 * ① 真实查询回放（主口径）
 * ================================================================== */
let realSummary = null;
if (args.sessions && fs.existsSync(SESS_DIR)) {
  const knownProjects = [...new Set(records.map((r) => r['项目']))];
  const resolveProject = makeProjectResolver(knownProjects);
  const queries = [];

  for (const dir of fs.readdirSync(SESS_DIR)) {
    const full = path.join(SESS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const project = resolveProject(dir);
    for (const sub of fs.readdirSync(full)) {
      const f = path.join(full, sub, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      let rows;
      try { rows = loadSessionRows(f); } catch { continue; }

      // 该会话绑定的身份（dtm_bind 的参数）
      let agent = args.agent;
      for (const r of rows) {
        if (r.type !== 'tool/call') continue;
        const d = r.data ?? {};
        if (d.name !== 'dtm_bind') continue;
        let a = d.arguments;
        if (typeof a === 'string') { try { a = JSON.parse(a); } catch { continue; } }
        if (a && a['智能体']) agent = a['智能体'];
      }

      for (const r of rows) {
        if (r.type !== 'tool/call') continue;
        const d = r.data ?? {};
        if (d.name !== 'dtm_recall') continue;
        let a = d.arguments;
        if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
        queries.push({
          project, agent,
          形态: a?.['形态'] ?? '',
          标签: Array.isArray(a?.['自由标签']) ? a['自由标签'] : [],
          sess: sub.slice(0, 12),
        });
      }
    }
  }

  console.log(`\n=== ① 真实查询回放（从会话日志解出 ${queries.length} 次 dtm_recall）===`);
  if (queries.length === 0) {
    console.log('（会话日志里没有 dtm_recall 调用，跳过）');
  } else {
    let withHits = 0, totalHits = 0, browse = 0;
    let rel = 0, irr = 0;
    const rows = [];
    for (const q of queries) {
      const isBrowse = q.标签.length === 0;
      if (isBrowse) browse++;
      const out = recall({
        records,
        query: { 项目: q.project, 智能体: q.agent, 形态: q.形态, 自由标签: q.标签 },
        identity: { bound: true, who: q.agent },
        schema,
        config: scoring,
        equivalence,
      });
      const hits = out.hits || [];
      if (hits.length > 0) withHits++;
      totalHits += hits.length;
      for (const h of hits) {
        if (isBrowse) continue; // 浏览没有相关性可言
        if (computeHit(q.标签, h['自由标签'], eq).hit.length > 0) rel++;
        else irr++;
      }
      rows.push({
        sess: q.sess, 形态: q.形态, 标签: q.标签.join(',') || '（浏览）',
        返回: hits.length, blocked: out.blocked ?? '',
      });
    }
    console.log(`有返回的查询：${withHits}/${queries.length}（${(withHits / queries.length * 100).toFixed(0)}%）`);
    console.log(`其中浏览类（标签为空）：${browse} 次`);
    console.log(`平均每次返回：${(totalHits / queries.length).toFixed(1)} 条`);
    console.log(`返回条目相关性：相关 ${rel} / 不相关 ${irr}${irr === 0 ? ' ✅ 零噪音' : ' ⚠️ 有噪音'}`);

    const empty = rows.filter((r) => r.返回 === 0);
    if (empty.length > 0) {
      console.log(`\n查空的 ${empty.length} 次（模型当时确实没查到）：`);
      for (const r of empty) console.log(`  [${r.sess}] ${r.形态} [${r.标签}] ${r.blocked ? 'blocked=' + r.blocked : ''}`);
    }
    realSummary = { total: queries.length, withHits, rel, irr };
  }
} else if (args.sessions) {
  console.log(`\n=== ① 真实查询回放 ===\n（会话日志目录不存在：${SESS_DIR}，跳过）`);
}

/* ================================================================== *
 * ② 自查询基准（回归基线，不是真实召回率）
 * ================================================================== */
console.log('\n=== ② 自查询基准（用条目自己的前 k 个标签查自己）===');
console.log('注意：这是**最理想查询**，只能当回归基线，不能代表真实召回率。');
console.log('| k | 召回 | 总数 | 召回率 |');
console.log('|---|---|---|---|');
for (const k of [1, 2, 3, 5]) {
  let ok = 0;
  for (const r of tagged) {
    const q = r['自由标签'].slice(0, Math.min(k, r['自由标签'].length));
    const out = recall({
      records,
      query: { 项目: args.project, 智能体: args.agent, 形态: r['形态'], 自由标签: q },
      identity,
      schema,
      config: scoring,
      equivalence,
    });
    if ((out.hits || []).some((h) => h['编号'] === r['编号'])) ok++;
  }
  console.log(`| ${k} | ${ok} | ${tagged.length} | ${(ok / tagged.length * 100).toFixed(1)}% |`);
}

/* ================================================================== *
 * ③ 隔离不变（判据改动不得让跨项目/跨身份条目变可见）
 * ================================================================== */
const foreign = records.filter(
  (r) => !checkIsolation(r, { project: args.project, agent: args.agent }, schema).pass,
);
console.log(`\n=== ③ 隔离 ===\n可见集合之外（跨项目/跨身份/非生效）条目数：${foreign.length}`);

/* ================================================================== *
 * ④ 数学死锁检查（回归旧缺陷：标签数是否决定召回）
 * ================================================================== */
console.log('\n=== ④ 标签数是否影响召回（旧判据的死锁检查）===');
const byTagCount = new Map();
for (const r of tagged) {
  const n = r['自由标签'].length;
  const k = n <= 3 ? '1-3' : n <= 6 ? '4-6' : n <= 10 ? '7-10' : '11+';
  if (!byTagCount.has(k)) byTagCount.set(k, { total: 0, ok: 0 });
  const g = byTagCount.get(k);
  g.total++;
  const q = r['自由标签'].slice(0, Math.min(2, n)); // 固定 2 个查询词
  const out = recall({
    records,
    query: { 项目: args.project, 智能体: args.agent, 形态: r['形态'], 自由标签: q },
    identity, schema, config: scoring, equivalence,
  });
  if ((out.hits || []).some((h) => h['编号'] === r['编号'])) g.ok++;
}
for (const k of ['1-3', '4-6', '7-10', '11+']) {
  const g = byTagCount.get(k);
  if (!g) continue;
  const rate = (g.ok / g.total * 100).toFixed(0);
  const flag = Number(rate) < 80 ? ' ⚠️ 明显偏低（旧判据的死锁征兆）' : '';
  console.log(`  标签 ${k.padEnd(4)} 个：${g.ok}/${g.total} = ${rate}%${flag}`);
}
console.log('  期望：各档召回率接近（标签数不应成为召回的决定因素）。旧判据下 7-10 档会明显掉。');
