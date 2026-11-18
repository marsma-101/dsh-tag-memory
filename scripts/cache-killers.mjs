/**
 * cache-killers.mjs — 枚举「既注入进 loop、又会变化」的内容，按危害排序。
 *
 * ── 判定原理（用户 2026-11-17 指出）────────────────────────────
 * 请求前缀的顺序是：tools → system prompt → messages。
 * 已经发送过的内容在服务端是**锁死**的，命中就按折扣价。
 * 但只要前缀里任何一项变了，**它之后的全部内容都要重算**，缓存归零。
 *
 * 所以危害排序依据两条：
 *   ① 位置越靠前，变一次废掉的东西越多（tools 最前，system 其次，messages 最后）
 *   ② 变化越频繁，废掉越多次（每轮必变 ≫ 偶尔变 ≫ 一次不变）
 *
 * 用法：node scripts/cache-killers.mjs [sessions根目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = process.argv[2] || 'F:/AppDataStore/.dsh/sessions';
const h = (v) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 10);

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

/* 逐会话统计「前缀各项变化了几次」 */
const agg = {
  toolList: [],      // 每次会话：工具清单不同版本数
  toolDefs: [],      // 每个工具名：出现过几个版本
  sysText: [],
  turns: [],
  injectedKinds: new Map(),
};
const perTool = new Map(); // name -> Set(hash)

for (const slug of fs.readdirSync(ROOT)) {
  const slugDir = path.join(ROOT, slug);
  if (!fs.statSync(slugDir).isDirectory()) continue;
  for (const sid of fs.readdirSync(slugDir)) {
    const file = path.join(slugDir, sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    let ev;
    try { ev = readSession(file); } catch { continue; }

    const headers = ev.filter((e) => e.type === 'request/header');
    const sys = ev.filter((e) => e.type === 'system/message' && (e.data?.message?.content ?? []).length > 0);
    const turns = ev.filter((e) => e.type === 'turn/start').length;
    if (headers.length === 0) continue;

    // 工具清单版本
    const toolVersions = new Set();
    for (const hd of headers) {
      const tools = hd.data?.header?.tools ?? [];
      toolVersions.add(h(tools));
      for (const t of tools) {
        if (!perTool.has(t.name)) perTool.set(t.name, new Set());
        perTool.get(t.name).add(h(t));
      }
    }
    agg.toolList.push(toolVersions.size);

    // system 文本版本
    const sysVersions = new Set(sys.map((s) => h(s.data.message.content.map((c) => c.text ?? '').join(''))));
    agg.sysText.push(sysVersions.size);
    agg.turns.push(turns);

    // 注入消息种类
    for (const m of ev) {
      if (m.type !== 'user/message') continue;
      const k = m.data?.source?.kind;
      if (!k || k === 'user') continue;
      agg.injectedKinds.set(k, (agg.injectedKinds.get(k) ?? 0) + 1);
    }
  }
}

const avg = (l) => (l.length ? (l.reduce((a, b) => a + b, 0) / l.length).toFixed(2) : '—');
const sessions = agg.toolList.length;

console.log(`统计范围：${sessions} 个会话\n`);

console.log('=== 1. 请求前缀的三层，各变化几次（每会话平均）===\n');
console.log('层'.padEnd(22) + '位置'.padEnd(10) + '平均版本数'.padStart(12) + '说明');
console.log('工具清单 tools'.padEnd(22) + '最前'.padEnd(10) + avg(agg.toolList).padStart(12) + '   一变 → 全部重算');
console.log('系统提示词 system'.padEnd(22) + '其次'.padEnd(10) + avg(agg.sysText).padStart(12) + '   一变 → 历史全废');

console.log('\n=== 2. 逐个工具：会话内出现过几个版本 ===\n');
console.log('工具'.padEnd(22) + '会话数'.padStart(7) + '版本数'.padStart(7) + '是否易变');
const rows = [...perTool.entries()]
  .map(([name, set]) => ({ name, versions: set.size }))
  .sort((a, b) => b.versions - a.versions);
for (const r of rows) {
  const flag = r.versions > 1 ? `⚠ ${r.versions} 个版本` : '';
  console.log(r.name.padEnd(22) + String(sessions).padStart(7) + String(r.versions).padStart(7) + `  ${flag}`);
}

console.log('\n=== 3. 注入进 loop 的消息种类与频次 ===\n');
console.log('来源 kind'.padEnd(26) + '总次数'.padStart(9) + '位置特性');
const POSITION_NOTE = {
  'agent-instructions': '第 2 条起；CLAUDE.md 改动时重发 → 插在前部',
  'runtime-context': '第 3 条起；每轮重发 → 插在前部',
  'skill-catalog': '第 4 条起；技能列表变时重发 → 插在前部',
  'time-context': '第 5 条起；每轮都变（时间戳）→ 插在前部',
  'tag-memory': '第 10 条起；漏记提醒 → 插在前部',
  'model-selection': '追加在末尾（安全）',
  'tool-jobs': '追加在末尾（安全）',
  'compact-checkpoint': '追加在末尾（安全）',
};
for (const [k, n] of [...agg.injectedKinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(k.padEnd(26) + String(n).padStart(9) + `  ${POSITION_NOTE[k] ?? '（未归类）'}`);
}

console.log('\n=== 4. 结论：按危害排序 ===\n');
console.log('  位置越靠前 + 变化越频繁 = 危害越大。\n');
const verdicts = [
  ['① time-context（每轮的时间戳）', '每轮必变', '插在消息前部；一变，其后全部历史重算'],
  ['② runtime-context（每轮快照）', '每轮必变', '同上'],
  ['③ 工具清单本身（增删工具）', '每轮可能变', '位置最前，一变全部重算'],
  ['④ agent-instructions / skill-catalog', '内容变时重发', '插在前部'],
  ['⑤ tag-memory 漏记提醒', '每轮可能插', '插在前部；且内容固定但位置变'],
  ['⑥ dtm 工具定义里的标签网络', '库变则变', '位置最前；但同一会话内通常稳定'],
];
for (const [name, freq, why] of verdicts) console.log(`  ${name}\n      频次：${freq}\n      影响：${why}\n`);
