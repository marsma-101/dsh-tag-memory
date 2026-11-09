/**
 * seed.mjs —— 生成初始记忆（通用/通用）
 *
 * 用法：node scripts/seed.mjs [--data-dir <path>] [--apply]
 *   不带 --apply 只打印将写入什么（不落盘）
 *
 * ── 为什么是这几条，而不是「介绍一下插件 / 介绍工具 / 问身份」──────
 *
 * 那三件事**注入里已经写了**，而且更详细：
 *   · 标题「## 长期记忆（dsh-tag-memory）」+ 首句 → 插件存在
 *   · 「### 入口」10 行表格 → 每个工具什么时候调
 *   · dtm_bind 那行 + 「字段标准」+ 「被拒了怎么办」→ 问身份、别猜
 * 把注入抄进库里，只会让 dtm_recall 查「工具」时先召回一堆自我介绍，
 * 挤掉真正的条目——这正是主子要避免的「污染」。
 *
 * 所以种子只写**注入给不了、只有库里能有**的东西。判据是三条：
 *   ① 注入是每次会话都出现的固定前缀（5916 字节预算），种子是**按需召回**的；
 *      凡是「每次都需要」的应进注入，凡是「偶尔查一下」的才进库。
 *   ② 种子不该与注入重复，否则召回时互相挤占。
 *   ③ 种子必须对**任何**项目/身份都成立（通用/通用），不能假设具体环境。
 *
 * 据此写 5 条：
 *   S1 库在哪、怎么找回自己的记忆（注入里没有——注入不告诉路径）
 *   S2 这个库的来历与边界（哪些是种子、哪些该由用户自己写）
 *   S3 召回为空时的正确处置（注入讲了「假查空」，但没讲「空库怎么办」）
 *   S4 整理是什么、什么时候做（注入只列了 dtm_review 一行）
 *   S5 别把种子当事实用（防污染的反向保护）
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');

/**
 * 种子条目。`key` 仅用于本地去重判断，不落库。
 *
 * ── 标签为什么恰好 3 个（不是随手定的）──────────────────────────
 *
 * 召回有硬闸门（read.mjs L388）：`e_ratio = 命中数 / 条目标签数` 必须 **严格大于 0.5**。
 * 也就是说**条目一半以上的标签必须被 query 命中**，否则该条直接被否决。
 *
 * 由此推出的设计约束：
 *   · 5 个标签 + 查 1 个 → 1/5 = 0.20 → 否决（种子的初版就是这样，全查不回来）
 *   · 3 个标签 + 查 2 个 → 2/3 = 0.67 → 通过  ← 选这个
 *   · 2 个标签 + 查 1 个 → 1/2 = 0.50 → 否决（要严格大于，等于不算）
 *
 * 所以每个种子固定 3 个标签，且这 3 个要覆盖「用户最可能同时想起的两个词」。
 * 标签多不是好事——它会让条目**更难被召回**，这是反直觉但已验证的规则。
 *
 * 另一个后果：种子之间**不能共享标签**。若两条都带「备份」，查「备份,数据目录」
 * 会同时命中两条，抢占 Top-K。所以下面每个条目的标签互不重叠。
 */
export const SEED_ENTRIES = Object.freeze([
  {
    key: 'where',
    '主要内容':
      '记忆库是一个 CSV 文件，默认在 $DSH_HOME/tag-memory/store/memory.csv（容器里通常是 /opt/dsh/tag-memory/store/memory.csv，'
      + 'Windows 是 %USERPROFILE%\\.dsh\\tag-memory\\store\\memory.csv）。'
      + '实际位置以插件设置页显示的「数据目录」为准；若被 config.dataDir 或环境变量 DSH_TAG_MEMORY_DATA_DIR 指定，以那个为准。'
      + '库是纯文本，可直接用任何编辑器打开、可直接备份或拷走；卸载插件不会删它。',
    '形态': '事实',
    '自由标签': ['记忆库位置', '数据目录', 'CSV'],
  },
  {
    key: 'origin',
    '主要内容':
      '本库最初含若干条「种子记忆」，用于让新装的空库有基本说明，全部标为 项目=通用、智能体=通用。'
      + '种子只解释这个库本身怎么用，不含任何具体项目的结论或用户偏好。'
      + '种子可以被整理、改写或归档，但删之前先确认用户已理解用法。',
    '形态': '事实',
    '自由标签': ['种子记忆', '初始内容', '来历'],
  },
  {
    key: 'empty-recall',
    '主要内容':
      '新装或刚清空时库是空的，此时 dtm_recall 查不到任何东西是正常的，不代表记忆丢了。'
      + '正确处置：先确认数据目录对不对（设置页可看），再确认 形态 是否选对；'
      + '空库阶段不要去「换个说法再试」，那只会堆词、照样查空。'
      + '记忆要靠日常对话积累，装好当天库是空的很正常。',
    '形态': '技能',
    '自由标签': ['查空', '空库', '排错'],
  },
  {
    key: 'tidy',
    '主要内容':
      '整理是定期把库过一遍：合并重复、把该升 稳定 的升格、把过时的归档。'
      + '触发方式是设置页的整理间隔，到点只提示不自动改；实际改动走 dtm_review 通览 + dtm_retag / dtm_archive。'
      + '整理前会先自动备份，改坏了可以从 backup/ 目录恢复。',
    '形态': '技能',
    '自由标签': ['整理', '升格', '归档'],
  },
  {
    key: 'seed-not-fact',
    '主要内容':
      '种子记忆只描述「这个库怎么用」，不是关于用户或项目的事实。'
      + '不要因为库里有种子就以为已经了解用户；用户的偏好、项目的结论都要靠实际对话写入。'
      + '若种子与用户后来明确说的冲突，以用户说的为准，并用 dtm_supersede 顶替旧条。',
    '形态': '规则',
    '自由标签': ['不要臆测', '防污染', '优先级'],
  },
  {
    key: 'subagent',
    '主要内容':
      '给子智能体带身份：父会话绑定了某个身份（比如「小明」）后，希望子智能体也以小明的身份读写记忆时，'
      + '必须在派活的提示里明确要求它「先调 dtm_bind 绑定 智能体=小明」，否则子智能体一律报 UNBOUND_IDENTITY。'
      + '原因：子智能体是全新的 agent 对象和独立 session，插件身份存在进程内 WeakMap 里、不落事件，'
      + '所以 spawn/fork 都不会自动继承——fork 只播种父会话的对话历史，不含插件身份。'
      + '反过来，只要子智能体绑了同名身份，它就能读到父以该身份写的全部记忆；绑不同名字则完全隔离（读不到），这是设计意图。',
    '形态': '技能',
    '自由标签': ['子智能体', '身份传递', '绑定'],
  },
]);

/* ── 参数 ─────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith('-') ? v : undefined;
};
// 与 install.mjs 的写法保持一致：`apply`（不带横线）和 `--apply` 都认。
// 之前只认 `--apply`，而 install.mjs 传的是 `apply`——结果安装时"静默没播种"，
// 打印了计划却一个字节没写。这种"看起来成功了"的失败最危险，两种写法都收。
const doApply = argv.includes('apply') || argv.includes('--apply');
const dataDirFlag = flagValue('--data-dir');

const out = [];
const say = (line = '') => {
  out.push(line);
  process.stdout.write(`${line}\n`);
};

/* 被 import 时（测试要读 SEED_ENTRIES）不执行主流程 */
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (!isMain) {
  // 仅导出，不做任何 IO
} else {
const { SERVICE_NAME } = await import(pathToFileURL(path.join(PACKAGE_DIR, 'index.js')).href);
const mod = await import(pathToFileURL(path.join(PACKAGE_DIR, 'index.js')).href);

/* ── 建一个最小 ctx，把宿主服务拉起来 ─────────────────── */
const registry = new Map();
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  on: () => () => {},
  effect: (fn) => {
    try {
      return fn();
    } catch {
      return () => {};
    }
  },
  get: (n) => registry.get(n),
  provide: (n, v) => {
    registry.set(n, v);
    return () => registry.delete(n);
  },
  inject: () => {},
  typert: { register: () => () => {} },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
};

const config = {};
if (dataDirFlag !== undefined) config.dataDir = dataDirFlag;
await mod.apply(ctx, config);
// 项目名由程序取工作目录 basename（`projectOfSync`），模型传的 `项目` 会被忽略。
// 所以这里把工作目录末段设成「通用」——这是让种子落成 项目=通用 的唯一正确方式，
// 而不是指望 writeEntry 采纳参数里的 项目。
registry.set('workingDirectory', { get: () => path.join(path.sep, 'seed', '通用') });

const host = registry.get(SERVICE_NAME);
if (!host) {
  say('✗ 宿主服务没挂上，无法写种子。');
  process.exit(1);
}

const agent = { id: 'seed', session: { id: 'seed' } };

/* ── 先看库里已有什么，避免与用户已有内容重复 ─────────── */
const before = await host.getOverview();
if (before.ok === false) {
  say(`✗ 读不了当前库：${before.code ?? ''} ${before.message ?? ''}`);
  process.exit(1);
}

const existing = await host.listEntries({ limit: 5000 });
const existingRows = existing.ok === false ? [] : existing.items;
const existingTags = new Set();
for (const row of existingRows) {
  for (const t of String(row['自由标签'] ?? '').split(/[,，\s]+/)) {
    const v = t.trim();
    if (v !== '') existingTags.add(v);
  }
}

say(`数据目录：${before.dataDir}`);
say(`来源：${before.dataDirSource}`);
say(`现有条目：${before.total} 条`);
say('');

/* ── 非空库默认不播种 ─────────────────────────────────────
 *
 * 种子是给「新装、什么都看不见」的场景用的。用户已经积累了记忆之后再塞
 * 种子，只会稀释他自己的条目——这正是要避免的污染。
 * 想强制播（比如自己测试）用 --force。
 */
if (before.total > 0 && !argv.includes('--force')) {
  say(`库里已有 ${before.total} 条记忆，跳过播种（不打扰已有内容）。`);
  say('确实要加种子：加 --force。');
  process.exit(0);
}

// 去重：靠「自由标签」是否已被某条占用判断（种子都用独有标签）
const fresh = [];
for (const seed of SEED_ENTRIES) {
  const clash = seed['自由标签'].filter((t) => existingTags.has(t));
  if (clash.length >= 2) {
    say(`· 跳过「${seed.key}」：标签 ${clash.join('/')} 已被现有条目占用（疑似已写过）`);
    continue;
  }
  fresh.push(seed);
}

if (fresh.length === 0) {
  say('没有需要新增的种子（全部已存在）。');
  process.exit(0);
}

say(`将写入 ${fresh.length} 条种子（项目=通用，智能体=通用）：`);
say('');
for (const seed of fresh) {
  say(`【${seed['形态']}】${seed['主要内容'].slice(0, 60)}…`);
  say(`   标签：${seed['自由标签'].join(', ')}`);
}

if (!doApply) {
  say('');
  say('以上是预演（一个字节没动）。加 --apply 才真写。');
  process.exit(0);
}

say('');

/* ── 真写 ─────────────────────────────────────────────── */
await host.bindIdentity(agent, { 智能体: '通用', 项目: '通用' });

const written = [];
const failed = [];
for (const seed of fresh) {
  const r = await host.writeEntry(agent, {
    '主要内容': seed['主要内容'],
    '形态': seed['形态'],
    '自由标签': seed['自由标签'],
    '项目': '通用',
    '智能体': '通用',
  });
  if (r.ok) written.push({ key: seed.key, id: r.id });
  else failed.push({ key: seed.key, code: r.code, message: r.message });
}

say(`✓ 已写入 ${written.length} 条：`);
for (const w of written) say(`   ${w.id}  ${w.key}`);

if (failed.length > 0) {
  say('');
  say(`✗ ${failed.length} 条没写成：`);
  for (const f of failed) say(`   ${f.key}：${f.code} ${f.message ?? ''}`);
  process.exitCode = 1;
}

/* ── 写完立刻验证能召回 ───────────────────────────────── */
const after = await host.getOverview();
say('');
say(`库现在共 ${after.total} 条。`);

const recallAgent = { id: 'check', session: { id: 'check' } };
await host.bindIdentity(recallAgent, { 智能体: '任何人', 项目: '任何项目' });
const check = await host.recall(recallAgent, { '形态': ['事实'] });
if (check.ok) {
  say(`验证：以「任何项目/任何身份」召回 事实 → ${check.hits.length} 条（种子应可见）`);
  if (check.hits.length === 0) {
    say('✗ 种子写进去了却召不回来——通用 白名单没生效？');
    process.exitCode = 1;
  }
} else {
  say(`✗ 召回失败：${check.blocked ?? ''} ${check.message ?? ''}`);
  process.exitCode = 1;
}
}
