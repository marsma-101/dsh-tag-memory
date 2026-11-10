/**
 * lib/engine/diagnose.mjs —— 已有记忆库的**只读**体检
 *
 * 为什么要单独一个模块：
 *   · `index.js` 已经 2200 行，再往里塞体检逻辑会失控
 *   · 体检必须是**纯只读**的：这个文件不 import 任何写接口，
 *     从类型上保证它改不了用户的记忆库
 *   · 可单测：造几个畸形 CSV 就能验，不用起容器
 *
 * 设计原则（见 内部文档/已有库检测与处置规则.md）：
 *   能自动做的只有「没数据可丢」那一类；只要库里有数据，
 *   插件负责说清楚，用户负责决定，智能体负责转述。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseCsv, resolveColumnIndex } from './core.mjs';

/* ------------------------------------------------------------------ *
 * 一、旧格式识别
 *
 * 0.3.7 的库是 17 列，与新格式 9 列**没有可推导的对应关系**：
 *   类型(原文/记忆/固定) + 深度(情景/语义/程序) + 距离(常驻/按需/深藏)
 *   → 要合成一个「形态」(技能/流程/规则/偏好/事实/模板)
 * 这三列的组合推不出形态，任何自动映射都是编造。
 *
 * 所以这里只做**识别**，不做转换——识别出来交给用户决定。
 * ------------------------------------------------------------------ */

/**
 * 0.3.7 才有的列名。命中 2 个以上就判定为旧格式。
 *
 * 为什么用「命中数 ≥ 2」而不是「命中 1 个」：
 * 新格式也有「稳定性」「项目」「状态」这些同名列，
 * 单看一个列名会误判。要求至少两个**旧版独有**列同时出现。
 */
const LEGACY_ONLY_COLUMNS = [
  'id',
  '内容',
  '时间',
  '环境',
  '原因',
  '备注',
  '成熟度',
  '距离',
  '角色',
  '关键词',
  '工具',
  '版本',
  '依据',
  '类型',
  '深度',
];

/** 旧格式与新格式的语义关系，用来生成给人看的说明（不是映射表）。 */
const LEGACY_NOTES = [
  '旧格式用「类型 + 深度 + 距离」三列描述条目性质，新格式合并成一个「形态」列。',
  '这三列的组合无法推导出形态：比如 类型=记忆 + 深度=语义 + 距离=常驻，',
  '既可能是「事实」也可能是「技能」，取决于内容本身。程序猜就是编造。',
  '旧格式没有「时距」列（召回计数），新条目一律从 0 起算。',
];

/**
 * 判断表头是不是 0.3.7 旧格式。
 * @param {string[]} header
 * @returns {{ legacy: boolean, hits: string[] }}
 */
export function detectLegacyHeader(header) {
  const cells = (header ?? []).map((h) => String(h ?? '').trim());
  const hits = cells.filter((h) => LEGACY_ONLY_COLUMNS.includes(h));
  return { legacy: hits.length >= 2, hits };
}

/* ------------------------------------------------------------------ *
 * 二、体检主体
 * ------------------------------------------------------------------ */

/** 体检结论的严重度。 */
export const SEVERITY = {
  /** 库完全不可用：一条都读不出来。必须让用户知道。 */
  blocking: 'blocking',
  /** 库可用，但有值得说的问题（部分行坏、有多份库）。 */
  degraded: 'degraded',
  /** 一切正常。 */
  ok: 'ok',
};

/**
 * 体检一个库文件。**只读，不修改任何东西。**
 *
 * @param {string} libraryCsv  库文件绝对路径
 * @param {object} schema      由 loadSchema 得到的 schema
 * @returns {Promise<{
 *   ok: boolean,
 *   exists: boolean,
 *   severity: string,
 *   code: string|null,
 *   message: string|null,
 *   question: string|null,
 *   options: Array<{id: string, label: string, risk: string}>,
 *   found: object,
 * }>}
 */
export async function diagnoseLibrary(libraryCsv, schema) {
  const base = {
    ok: true,
    exists: false,
    severity: SEVERITY.ok,
    code: null,
    message: null,
    question: null,
    options: [],
    found: { path: libraryCsv },
  };

  /* ---- ① 文件在不在 ---- */
  let raw;
  try {
    raw = await fsp.readFile(libraryCsv, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // 不存在不是问题：首次安装就是这种状态，调用方会铺初始记忆库。
      return { ...base, found: { ...base.found, rows: 0 } };
    }
    // 读不了（权限/占用）——这是真问题，但**不是**「没有记忆」。
    // 教训7：绝不能把「读不到」伪装成「没有」。
    return {
      ...base,
      ok: false,
      exists: true,
      severity: SEVERITY.blocking,
      code: 'LIBRARY_UNREADABLE',
      message: `记忆库读不出来：${err?.message ?? err}。这不代表你没有记忆，是文件访问出了问题。`,
      question: '记忆库文件读不出来（可能是权限或文件被占用）。要我告诉你文件路径，你检查一下吗？',
      options: [{ id: 'keep-as-is', label: '先不动，我自己去看文件', risk: 'safe' }],
      found: { ...base.found },
    };
  }

  const existsInfo = { ...base, exists: true };

  /* ---- ② 解析 ---- */
  const parsed = parseCsv(raw);
  const header = parsed.header ?? [];
  const rows = parsed.rows ?? [];
  const dataRowCount = rows.filter((r) => r.length > 0 && r.some((c) => String(c ?? '').trim() !== '')).length;

  const found = {
    path: libraryCsv,
    rows: dataRowCount,
    columns: header,
    bytes: Buffer.byteLength(raw),
  };

  /* ---- ③ 旧格式？---- */
  const legacy = detectLegacyHeader(header);

  if (legacy.legacy && dataRowCount > 0) {
    // 有数据 + 旧格式 = **绝对不能自动迁移**。问人。
    return {
      ...existsInfo,
      ok: false,
      severity: SEVERITY.blocking,
      code: 'LEGACY_FORMAT_WITH_DATA',
      message:
        `这个库是 0.3.7 的旧格式（${header.length} 列：${legacy.hits.slice(0, 3).join('、')}…），` +
        `里面有 ${dataRowCount} 条记忆。新版是 9 列，旧格式的列无法自动对应到新格式——` +
        '硬转会把条目性质弄错（比如把「事实」写成「技能」）。',
      question:
        `发现旧版记忆库（${dataRowCount} 条）。旧格式用「类型/深度/距离」三列描述条目，` +
        '新版只有一个「形态」列，这三列的组合推不出形态，程序没法准确转换。你想怎么处理？',
      options: [
        { id: 'backup-and-fresh', label: '先备份旧库，再用新版初始记忆库开始', risk: 'loses-nothing-but-starts-empty' },
        { id: 'keep-as-is', label: '原样保留，先不装新版（我稍后自己处理）', risk: 'safe' },
        { id: 'manual-map', label: '我逐条告诉你旧条目该归到哪个形态', risk: 'needs-input' },
      ],
      found: { ...found, legacyHits: legacy.hits },
      notes: LEGACY_NOTES,
    };
  }

  if (legacy.legacy && dataRowCount === 0) {
    // 有旧表头但**零数据行** —— 没有数据可丢，可以自动处理。
    // 这正是容器里那份 0.3.7 残留文件的处境。
    return {
      ...existsInfo,
      ok: true,
      severity: SEVERITY.degraded,
      code: 'LEGACY_FORMAT_EMPTY',
      message:
        `记忆库是 0.3.7 的旧表头（${header.length} 列）且没有任何数据行。` +
        '里面没有记忆，可以直接换成新格式的初始库。',
      question: null, // 没有数据可丢，不需要问
      options: [{ id: 'backup-and-fresh', label: '备份这个空壳文件，换成新版初始记忆库', risk: 'safe' }],
      found: { ...found, legacyHits: legacy.hits },
      notes: LEGACY_NOTES,
      /** 调用方据此判断能否自动处理。 */
      autoFixable: true,
    };
  }

  /* ---- ④ 表头缺列？---- */
  const { missing } = resolveColumnIndex(header, schema);
  if (missing.length > 0) {
    return {
      ...existsInfo,
      ok: false,
      severity: SEVERITY.blocking,
      code: 'HEADER_INCOMPLETE',
      message: `记忆库表头缺少列：${missing.join('、')}。一行都读不出来——这不代表你没有记忆。`,
      question: `记忆库格式不完整（缺 ${missing.join('、')}），一条都读不出来。要我告诉你文件路径吗？`,
      options: [
        { id: 'keep-as-is', label: '先不动，我自己看文件', risk: 'safe' },
        { id: 'backup-and-fresh', label: '备份这份文件，改用初始记忆库', risk: 'loses-nothing-but-starts-empty' },
      ],
      found: { ...found, missing },
    };
  }

  /* ---- ⑤ 行级错误（列数不符等）---- */
  const rowErrors = (parsed.errors ?? []).filter((e) => e.code === 'ROW_CELL_COUNT');
  if (rowErrors.length > 0) {
    // 部分行坏：库可用（能读的行照样读），但必须报出来。
    // **不许自动丢弃坏行**——那是删用户数据。
    return {
      ...existsInfo,
      ok: true,
      severity: SEVERITY.degraded,
      code: 'ROWS_MALFORMED',
      message: `有 ${rowErrors.length} 行的列数与表头不符，这些行可能读不准。其余 ${dataRowCount} 行正常。`,
      question: `记忆库里有 ${rowErrors.length} 行列数不对。要我先备份再逐行检查，还是先这样用？`,
      options: [
        { id: 'keep-as-is', label: '先这样用，坏行我自己看', risk: 'safe' },
        { id: 'backup-then-inspect', label: '先备份，再告诉我哪几行坏了', risk: 'safe' },
      ],
      found: { ...found, badRows: rowErrors.length },
    };
  }

  /* ---- ⑥ 一切正常（含「合法表头但 0 行」）---- */
  return {
    ...existsInfo,
    ok: true,
    severity: SEVERITY.ok,
    code: null,
    message: dataRowCount === 0 ? '记忆库是空的（表头正常），可以正常使用。' : null,
    found: { ...found },
  };
}

/* ------------------------------------------------------------------ *
 * 三、多库检测
 * ------------------------------------------------------------------ */

/**
 * 找出同一台机器上所有可能存在记忆库的位置。
 *
 * 为什么需要：用户换过数据目录、或用过环境变量覆盖，就会留下多份库。
 * 只读其中一个 = 另一份记忆静默消失，而用户以为"插件把我数据弄丢了"。
 *
 * ⚠️ 只**列出**，不判断哪个该用——那是用户的决定。
 *
 * @param {{ current: string, candidates: string[] }} opts
 * @returns {Promise<Array<{ path: string, current: boolean, exists: boolean, rows: number, bytes: number }>>}
 */
export async function findLibraries({ current, candidates = [] } = {}) {
  const all = [...new Set([current, ...candidates].filter((p) => typeof p === 'string' && p !== ''))];
  const out = [];
  for (const p of all) {
    let rows = 0;
    let bytes = 0;
    let exists = false;
    try {
      const raw = await fsp.readFile(p, 'utf8');
      exists = true;
      bytes = Buffer.byteLength(raw);
      const parsed = parseCsv(raw);
      rows = (parsed.rows ?? []).filter(
        (r) => r.length > 0 && r.some((c) => String(c ?? '').trim() !== ''),
      ).length;
    } catch {
      exists = false;
    }
    out.push({ path: p, current: p === current, exists, rows, bytes });
  }
  return out;
}

/**
 * 把多个库的检测结果汇总成一个「要不要问用户」的结论。
 *
 * @param {Array<{path: string, current: boolean, exists: boolean, rows: number}>} libs
 * @returns {{ code: string|null, question: string|null, options: Array, found: object }|null}
 */
export function diagnoseMultiple(libs) {
  const withData = (libs ?? []).filter((l) => l.exists && l.rows > 0);
  if (withData.length < 2) return null;

  return {
    code: 'MULTIPLE_LIBRARIES',
    severity: SEVERITY.degraded,
    message:
      `发现 ${withData.length} 份有内容的记忆库：` +
      withData.map((l) => `${l.path}（${l.rows} 条）${l.current ? '【当前在用】' : ''}`).join('；'),
    question:
      `这台机器上有 ${withData.length} 份记忆库，其中 ${withData.filter((l) => !l.current).length} 份当前没在用。` +
      '要我帮你把它们合并进来吗？还是保持现状（只用当前这份）？',
    options: [
      { id: 'keep-as-is', label: '保持现状，只用当前这份', risk: 'safe' },
      { id: 'merge-all', label: '把其他几份合并进来（会先备份）', risk: 'needs-input' },
      { id: 'show-paths', label: '先告诉我每份都在哪、各有多少条', risk: 'safe' },
    ],
    found: { libraries: withData },
  };
}
