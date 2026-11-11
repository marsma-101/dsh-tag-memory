/**
 * probe-recall.mjs — §3 假查空探针（只读、零副作用）
 *
 * 口径（内部文档/改进与迭代方向-2026-11-11.md §3）：
 *   对每条「可见且有标签」的条目，取它自己的前 k 个标签当查询词，
 *   看它是否出现在 recall() 的 hits 里。查询词 100% 来自条目本身，
 *   语义必然指向它 —— 召回不到就是假查空。
 *
 * 可见集合 = 硬筛（项目=dsh-tag-memory / 智能体=萧潇 / 通用·引入白名单）+ 状态=生效。
 * 直接调 lib/engine/read.mjs 的纯函数 recall()：不写台账、不加时距、不落盘。
 *
 * 用法：
 *   node scripts/probe-recall.mjs [--lib <csv>] [--entry-ratio <n>] [--project <p>] [--agent <a>]
 *   --lib 省略时优先用生产库 C:\Users\Administrator\.dsh\tag-memory\store\memory.csv，
 *   读不到再回落本仓 data/store/memory.csv。
 *   --entry-ratio 省略时直接读 scoring.json 的出厂 veto.entryRatio（不覆盖）。
 *   传多个 --entry-ratio 可一次出对比表，例如：--entry-ratio 0.5 0.3 0.1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recall, checkIsolation } from '../lib/engine/read.mjs';
import { readLibraryCsv } from '../lib/engine/core.mjs';
import schema from '../lib/engine/templates/schema.json' with { type: 'json' };
import scoring from '../lib/engine/templates/scoring.json' with { type: 'json' };
import equivalence from '../lib/engine/templates/tag-equivalence.json' with { type: 'json' };

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_LIB = 'C:\\Users\\Administrator\\.dsh\\tag-memory\\store\\memory.csv';
const SEED_LIB = path.join(PACKAGE_DIR, 'data', 'store', 'memory.csv');

function parseArgs(argv) {
  const out = { ratios: null, lib: null, project: 'dsh-tag-memory', agent: '萧潇' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--entry-ratio') {
      out.ratios = [];
      while (i + 1 < argv.length && /^\d+(\.\d+)?$/.test(argv[i + 1])) out.ratios.push(Number(argv[++i]));
    } else if (argv[i] === '--lib') out.lib = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--agent') out.agent = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const libPath = args.lib ?? (fs.existsSync(PROD_LIB) ? PROD_LIB : SEED_LIB);
const ratios = args.ratios ?? [Number(scoring.veto.entryRatio)];

const { records, errors } = await readLibraryCsv(libPath, schema);
if (errors.length > 0) {
  console.error(`库解析有 ${errors.length} 条错误（前 3 条）：`, errors.slice(0, 3));
}

const identity = { bound: true, who: args.agent };
// 与宿主 dtm_recall 一致：query 里的 项目/智能体 用程序值。
const visible = records.filter((r) =>
  checkIsolation(r, { project: args.project, agent: args.agent }, schema).pass,
);
const tagged = visible.filter((r) => Array.isArray(r['自由标签']) && r['自由标签'].length > 0);
const blankTag = visible.length - tagged.length;
const avgTags = tagged.length > 0
  ? tagged.reduce((s, r) => s + r['自由标签'].length, 0) / tagged.length
  : 0;

console.log(`库文件：${libPath}`);
console.log(`总条目 ${records.length} / 可见集合 ${visible.length}（其中 ${blankTag} 条空标签）/ 有标签 ${tagged.length} / 平均标签数 ${avgTags.toFixed(2)}`);
console.log(`硬筛条件：项目=${args.project} 智能体=${args.agent}（含 通用/引入 白名单）\n`);

function runProbe(entryRatio) {
  const cfg = { ...scoring, veto: { ...scoring.veto, entryRatio } };
  const result = { entryRatio, rows: [] };
  for (const k of [1, 2, 3, 5]) {
    let passed = 0;
    let offDirection = 0;
    for (const r of tagged) {
      const q = r['自由标签'].slice(0, Math.min(k, r['自由标签'].length));
      const out = recall({
        records,
        query: { 项目: args.project, 智能体: args.agent, 形态: r['形态'], 自由标签: q },
        identity,
        schema,
        config: cfg,
        equivalence,
      });
      const hitIds = new Set(out.hits.map((h) => h['编号']));
      if (hitIds.has(r['编号'])) passed += 1;
      if (out.blocked === 'QUERY_OFF_DIRECTION') offDirection += 1;
    }
    result.rows.push({ k, passed, total: tagged.length, offDirection, falseEmptyRate: (1 - passed / tagged.length) * 100 });
  }
  return result;
}

const table = ratios.map(runProbe);
console.log('| entryRatio | k | passed / hits | QUERY_OFF_DIRECTION | 假查空率 |');
console.log('|---|---|---|---|---|');
for (const t of table) {
  for (const row of t.rows) {
    console.log(`| ${t.entryRatio} | k=${row.k} | ${row.passed} / ${row.total} | ${row.offDirection} | ${row.falseEmptyRate.toFixed(1)}% |`);
  }
}

// 顺带验隔离不变：跨项目/跨身份的条目仍查不到（§4.1 验收要求）。
const foreign = records.filter((r) => {
  const iso = checkIsolation(r, { project: args.project, agent: args.agent }, schema);
  return !iso.pass;
});
console.log(`\n可见集合之外（跨项目/跨身份/非生效）条目数：${foreign.length} —— 阈值改动不应使其变为可见。`);
