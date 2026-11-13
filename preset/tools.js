/**
 * tools.js — 10 个 dtm_* 工具的实际注册（把定义接到宿主方法）
 *
 * 依据：《接口契约》§一（职责边界）、§五（preset 两条）、§七（错误码族）、《功能说明》§十三。
 *
 * ── 边界（硬约束）────────────────────────────────────────────────
 *   本文件**只做接线与排版**，绝不重写业务逻辑：
 *     · 校验（9 列/6 形态/≤20 标签/`|` 拒写）→ engine
 *     · 锁 + 取号 + 落盘 + 台账            → 宿主方法（内部调 engine）
 *     · 面向模型的排版                      → format.js
 *
 * ── 为什么 10 个工具全走宿主方法 ─────────────────────────────────
 *   host-dev 的 `writeEntry` / `recall` 说明得很清楚：engine 只返回"该写什么"，
 *   不做锁与落盘；而写一次要"锁内读表→取号→追加→台账"四步。若 preset 直调 engine，
 *   这四步就得在 preset 里再写一遍，与 UI 的宿主方法形成两套实现 —— 违反
 *   "一个操作两个调用者"（Lead 裁决 4 的本意）。所以**统一走宿主方法**。
 *   ⚠️ 这与 Lead 裁决 4 的字面（写/读/review/records 直调 engine）有出入，已上报待裁决。
 *
 * ── 依赖获取 ────────────────────────────────────────────────────
 *   用 `ctx.get(name)` **惰性**取，不写进 `inject`：inject 里列了不存在的服务会让
 *   整个插件挂不上。惰性取 + 缺了给明确错误 → qa 在 host 未完成时也能验 K1/K2/K3。
 *
 * ── 错误纪律 ────────────────────────────────────────────────────
 *   engine/宿主抛的错**原文透传**。`TAG_CONTAINS_PIPE` 必须保住"点名到具体标签"
 *   的措辞（主子明确要求），任何一层都不许改写它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from './define-tool.js';
import { buildToolDefs, TOOL_NAMES } from './tool-defs.js';
import {
  formatBindResult,
  formatWriteResult,
  formatRecallResult,
  formatListResult,
  formatRecordsResult,
  formatTidyResult,
  formatExportResult,
  formatMergeResult,
} from './format.js';

/** 宿主服务名。host-dev 定稿后改这一行即可。 */
export const HOST_SERVICE = 'dtmHost';

/** 模板目录（被拒细则的单一真源 `schema.json` 在这下面） */
const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'engine', 'templates',
);

/** 写入原则缓存（按 mtime 热更新，与 preset/index.js 的 schemaFor 同款） */
let principlesCache = { mtimeMs: -1, value: [] };

/** 统一的工具输出契约：10 个工具共用，避免各写一套 schema 漂移 */
const RESULT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', description: '这次调用是否成功。' },
      code: { type: 'string', description: '失败时的错误码（engine 定义的错误码族）。' },
      text: { type: 'string', description: '给模型看的可读正文。' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

/* ------------------------------------------------------------------ *
 * 依赖获取
 * ------------------------------------------------------------------ */

function hostOf(ctx) {
  try {
    return ctx?.get?.(HOST_SERVICE) ?? null;
  } catch {
    return null; // 服务未挂载时 ctx.get 可能抛
  }
}

/**
 * 取宿主服务；缺了返回一个明确失败的调用器。
 *
 * 消息要点：告诉模型**不要重试、不要改用文件工具**——这是插件内部未接通，
 * 不是它参数写错了。
 */
function requireHost(ctx) {
  const host = hostOf(ctx);
  if (host) return { ok: true, host };
  return {
    ok: false,
    result: {
      ok: false,
      code: 'NOT_WIRED',
      text:
        `记忆读写暂时不可用：宿主服务 \`${HOST_SERVICE}\` 还没挂载。\n` +
        '这是插件内部模块尚未接通，不是你的参数问题——**不要重试**，也不要用文件工具去改库文件。',
    },
  };
}

/** 取调用方 agent。拿不到就返回 undefined（按未绑定处理，不抛错以免中断轮次）。 */
function agentOf(exec) {
  return exec?.agent ?? undefined;
}

/* ------------------------------------------------------------------ *
 * 错误 → 工具结果
 * ------------------------------------------------------------------ */

/**
 * engine/宿主抛的错 → 模型可读结果。**原文透传** message，只加一层错误码前缀。
 */
function failFrom(err) {
  const code = err?.code ?? 'UNKNOWN';
  const message = err?.message ?? String(err);
  const lines = [`失败（${code}）：${message}`];

  // engine 的 validateWriteInput 一次报全部问题，逐条列出便于模型一次改完
  const all = Array.isArray(err?.errors) ? err.errors : [];
  for (const e of all) {
    if (e?.message && e.message !== message) lines.push(`- ${e.code ?? '?'}: ${e.message}`);
  }
  if (err?.detail?.allowed) lines.push(`允许的值：${[].concat(err.detail.allowed).join(' / ')}`);

  return { ok: false, code, text: lines.join('\n') };
}

/** 宿主返回 `{ok:false, errors:[...]}` → 失败结果（engine 校验走"返回 errors"而非抛错） */
function failFromErrors(errors, code) {
  const list = Array.isArray(errors) ? errors : [];
  const first = list[0];
  const lines = [`失败（${first?.code ?? code ?? 'INVALID'}）：${first?.message ?? '参数不合法'}`];
  for (const e of list.slice(1)) lines.push(`- ${e.code ?? '?'}: ${e.message}`);
  return { ok: false, code: first?.code ?? code ?? 'INVALID', text: lines.join('\n') };
}

/**
 * 写入被拒时附加的「按需细则」（2026-11-11 分层修订）。
 *
 * 这些内容原先每轮都在 section 里（写入原则 5 条 + 标签怎么打），
 * 但它们是「怎么写才好」的方法论，只在**真被拒**时才有用；
 * 挪到返回值 = 真按需、零常态成本，而且就在模型正需要的那一刻出现。
 *
 * 数据源仍是 `templates/schema.json` 的 `writeRoutes.principles`（单一真源）。
 * **直接同步读模板文件**，不依赖宿主新增方法 —— 曾试过调 `host.writePrinciplesSync()`，
 * 宿主没实现就静默返回空，等于「该给的没给」；这种隐藏依赖必须避免。
 */
function writePrinciplesSync() {
  try {
    const file = path.join(TEMPLATE_DIR, 'schema.json');
    const stat = fs.statSync(file);
    if (stat.mtimeMs === principlesCache.mtimeMs) return principlesCache.value;
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(schema?.writeRoutes?.principles)
      ? schema.writeRoutes.principles.filter((p) => String(p ?? '').trim() !== '')
      : [];
    principlesCache = { mtimeMs: stat.mtimeMs, value: list };
    return list;
  } catch {
    return [];
  }
}

function writeHintsForRejection() {
  const principles = writePrinciplesSync();
  if (!Array.isArray(principles) || principles.length === 0) return [];
  return ['', '**写入原则**（怎么写得更好）：', ...principles.map((p) => `- ${p}`)];
}

/** 标签怎么打（被拒时的最短要点）。详细规则见 `标签字典.md` 与被拒说明。 */
const TAG_HINT_ON_REJECT = [
  '',
  '**自由标签怎么打**：从「作用 / 注意事项 / 内容关键词」三方向拆短实词，一个标签一个概念；',
  '不打纯数字、来源标记、转述句、同义变体；不含 `|`；1~20 个，超过 6~8 个就该收。',
];

/**
 * 统一调用宿主方法的小包装：
 *   · 方法不存在 → NOT_WIRED（点名缺哪个方法，方便 host-dev 对账）
 *   · 返回 {ok:false} → 转失败结果
 *   · 抛错 → 原文透传
 */
async function callHost(host, method, args) {
  const fn = host?.[method];
  if (typeof fn !== 'function') {
    return {
      ok: false,
      code: 'NOT_WIRED',
      text:
        `记忆功能暂时不可用：宿主方法 \`${method}\` 还没实现。\n` +
        '这是插件内部模块尚未接通，不是你的参数问题——**不要重试**，不要改用文件工具去动库文件。',
    };
  }
  try {
    const result = await fn.apply(host, args);
    if (result && result.ok === false) {
      return failFromErrors(result.errors, result.code ?? result.blocked);
    }
    return { ok: true, result };
  } catch (err) {
    return failFrom(err);
  }
}

/* ------------------------------------------------------------------ *
 * 各工具 execute
 * ------------------------------------------------------------------ */

/** dtm_bind —— 绑定会话身份（host 侧写投影，preset 不碰 session.append） */
function executeBind(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    // 只传 `智能体`：`项目` 由宿主按会话工作目录自动取（2026-11-08 硬性裁定）。
    const r = await callHost(h.host, 'bindIdentity', [agentOf(exec), { 智能体: args['智能体'] }]);
    if (!r.ok) return r;
    return { ok: true, ...formatBindResult(r.result) };
  };
}

/**
 * dtm_write —— 追加一条记忆。
 *
 * 未绑定拒写由**宿主方法先于一切强制**（host-dev §3），preset 不再重复判定，
 * 直接透传它的 `UNBOUND_IDENTITY`。但注入文本里仍要写清"未绑定先问用户"。
 */
function executeWrite(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'writeEntry', [
      agentOf(exec),
      {
        主要内容: args['主要内容'],
        形态: args['形态'],
        自由标签: args['自由标签'],
        // 不传 `项目` / `智能体`：归属是**程序值**（2026-11-08 硬性裁定）。
        // 项目取会话工作目录名，智能体取本次会话绑定的身份——都是环境事实，
        // 不是模型的判断。宿主侧会用程序值覆盖，这里传了也会被丢弃。
        // 不传 `稳定性`：首次落库恒为「观察」，由使用过程经状态机事后演进。
      },
    ]);
    if (!r.ok) {
      // 被拒时才给「按需细则」（写入原则 + 标签怎么打）——零常态成本。
      const extra = [...writeHintsForRejection(), ...TAG_HINT_ON_REJECT];
      return { ...r, text: `${r.text}\n${extra.join('\n')}` };
    }
    if (r.result?.blocked === 'UNBOUND_IDENTITY') return unboundWrite();
    return { ok: true, ...formatWriteResult(r.result) };
  };
}

/** dtm_recall —— 按标签召回；未绑定返回空并标身份未绑定（不抛错） */
function executeRecall(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'recall', [
      agentOf(exec),
      {
        形态: args['形态'],
        自由标签: args['自由标签'],
        // 不传 `项目` / `智能体`：归属是程序值（2026-11-08 硬性裁定）。
        // 宿主侧会用工作目录名 + 绑定身份覆盖，这里传了也会被丢弃。
      },
    ]);
    if (!r.ok) return r;

    const formatted = formatRecallResult(r.result);
    if (formatted.code === 'UNBOUND_IDENTITY') return { ok: false, code: 'UNBOUND_IDENTITY', text: formatted.text };
    return { ok: true, ...formatted };
  };
}

/** dtm_supersede —— 新条顶替旧条（备份+锁+改状态+写新行+台账，全在宿主方法里） */
function executeSupersede(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'supersedeEntry', [
      agentOf(exec),
      {
        旧编号: args['旧编号'],
        主要内容: args['主要内容'],
        形态: args['形态'],
        // 不传 项目/智能体：归属由程序沿用旧条（2026-11-12 P1-9，与 write/recall 同裁定）。
        自由标签: args['自由标签'],
        basis: args.basis,
      },
    ]);
    if (!r.ok) return r;
    return { ok: true, ...formatTidyResult(r.result, 'supersede') };
  };
}

/** dtm_archive —— 退场（标已归档，行不删） */
function executeArchive(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'archiveEntry', [agentOf(exec), { 编号: args['编号'], basis: args.basis }]);
    if (!r.ok) return r;
    return { ok: true, ...formatTidyResult(r.result, 'archive') };
  };
}

/**
 * dtm_retag —— 改标签（**必须带 basis**）。
 *
 * `basis` 的必填由 `parameters.basis.required: true` 表达（Lead 裁决：不自己校验）。
 * 这里仍兜一层：即便有人绕过 schema 直接调 execute，也不能改出没有依据的改动
 * —— 《流程_整理》§七："没有依据的改动不允许做"。
 *
 * ⚠️ patch 必须**只包含模型真正给出的字段**（2026-11-06 修）。
 *
 * 真实事故：这里原来无条件把 5 个字段都塞进 patch ——
 *   patch: { 形态: args['形态'], 项目: ..., 智能体: ..., 自由标签: ..., 稳定性: ... }
 * 模型只传 `稳定性` 时，其余 4 个是 undefined，但 `Object.keys(patch).length === 5`，
 * 宿主以为"五个字段都要改"，先撞上 `形态 = undefined` 报 FIELD_EMPTY，
 * 再试又撞 TAGS_EMPTY —— **模型连续被拒 3 次才改成功**。
 *
 * 工具语义是「改某几个字段」，不是「整组替换」（那是 UI 编辑器的语义）。
 * 所以这里按"模型实际给了才放进 patch"来组装，undefined 一律跳过。
 */
function executeRetag(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const basis = String(args.basis ?? '').trim();
    if (basis === '') {
      return {
        ok: false,
        code: 'BASIS_REQUIRED',
        text:
          '缺 `basis`：改标签必须给出依据（哪条读写记录支持这次改动），没有依据的改动不允许做。\n' +
          '先调 `dtm_records` 找到相关记录，再带着依据重试。',
      };
    }

    // 只把模型**实际给出**的字段放进 patch。
    // undefined / 未出现 一律跳过 —— 漏传不等于"要清空"。
    // 2026-11-12 P1-9：归属（项目/智能体）不再由模型改——与 write/recall 同裁定，
    // 归属是环境事实。要搬家走 UI 手动通道或 merge，不走 retag。
    const patch = {};
    for (const field of ['形态', '自由标签', '稳定性', '状态']) {
      const v = args[field];
      if (v !== undefined && v !== null) {
        // 空数组/空串是**真给了空值**，要放进去让宿主报错（那是模型想清空，属于错误操作）
        patch[field] = v;
      }
    }

    // 一个字段都没给：不是"合法空操作"，是模型漏传，必须明确拒绝
    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        code: 'PATCH_EMPTY',
        text:
          '没有给出任何要改的字段。`dtm_retag` 至少要改一项：' +
          '形态 / 自由标签 / 稳定性 / 状态。\n' +
          '不想改的字段**直接省略**即可（省略 ≠ 清空），不用传原值。',
      };
    }

    const r = await callHost(h.host, 'retagEntry', [
      agentOf(exec),
      {
        编号: args['编号'],
        patch,
        basis,
      },
    ]);
    if (!r.ok) return r;
    return { ok: true, ...formatTidyResult(r.result, 'retag') };
  };
}

/**
 * dtm_review —— 只读通览。
 *
 * **不记 read.jsonl、不动时距**：它不是召回，只是看一眼（《功能说明》§十二）。
 */
function executeReview(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'listEntries', [
      agentOf(exec),
      {
        形态: args['形态'],
        // 不传 项目/智能体：工具通道由宿主按当前归属隔离（2026-11-12 P1-18）。
        状态: args['状态'],
        自由标签: args['自由标签'],
        limit: args.limit,
        offset: args.offset,
      },
    ]);
    if (!r.ok) return r;
    return { ok: true, ...formatListResult(r.result) };
  };
}

/** dtm_records —— 查台账。只读。 */
function executeRecords(ctx) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'readRecords', [
      agentOf(exec),
      { kind: args.kind, limit: args.limit, onlyFailed: args.onlyFailed },
    ]);
    if (!r.ok) return r;
    return { ok: true, ...formatRecordsResult(r.result, args.kind) };
  };
}

/** dtm_export —— 导出 CSV。与 UI 导出按钮共用同一个宿主方法。 */
function executeExport(ctx) {
  return async (args) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'exportLibrary', [{ path: args.path }]);
    if (!r.ok) return r;
    return { ok: true, ...formatExportResult(r.result) };
  };
}

/** dtm_merge —— 合并另一份库。与 UI 合并弹窗共用同一个宿主方法。 */
function executeMerge(ctx) {
  return async (args) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'mergeLibrary', [{ path: args.path, dryRun: args.dryRun === true }]);
    if (!r.ok) return r;
    return { ok: true, ...formatMergeResult(r.result, args.dryRun === true) };
  };
}

/** 未绑定拒写的统一文案（宿主返回 blocked 时用） */
function unboundWrite() {
  return {
    ok: false,
    code: 'UNBOUND_IDENTITY',
    text:
      '未绑定身份，拒绝写入。\n' +
      '先问用户「这次会话我以什么名字负责」，拿到名字后调 `dtm_bind`，再重试。\n' +
      '（显式传 通用/引入 也不放行——不知道我是谁，就不知道该把记忆归到谁的库里。）',
  };
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/**
 * 注册 10 个工具。
 *
 * @param {object} ctx    Cordis 上下文（需 `ctx.tools`）
 * @param {object} [domain] 取值域（形态 / 稳定性 / 状态），由 `domainFor()` 从 schema.json 读出。
 *                          不传时 `buildToolDefs` 用它自带的兜底（仅用于无 schema 的降级场景）。
 * @param {object} [options]
 * @param {string} [options.libraryCsv] 库 CSV 绝对路径。给了就把**标签共现网络**
 *        渲染进 `dtm_write` / `dtm_recall` 的参数描述（2026-11-11）。
 *        不给则跳过，工具照常可用。
 * @param {{project?:string, agent?:string}} [options.view]
 *        当前视角。网络只含「本项目或通用」×「本智能体或通用」的条目。
 *        ⚠️ 网络只在注册时算一次（工具描述是静态的），视角变化需重载刷新——
 *        这是有意的：每轮重算 description 会让工具清单不稳定，反而破坏缓存。
 * @returns {{defs: Array, dispose: Function[]}}
 */
export function registerTools(ctx, domain, options = {}) {
  const defs = buildToolDefs(domain, {
    libraryCsv: options.libraryCsv,
    view: options.view,
  });

  const executors = {
    dtm_bind: executeBind(ctx),
    dtm_write: executeWrite(ctx),
    dtm_recall: executeRecall(ctx),
    dtm_supersede: executeSupersede(ctx),
    dtm_archive: executeArchive(ctx),
    dtm_retag: executeRetag(ctx),
    dtm_review: executeReview(ctx),
    dtm_records: executeRecords(ctx),
    dtm_export: executeExport(ctx),
    dtm_merge: executeMerge(ctx),
  };

  const dispose = [];
  for (const def of defs) {
    const execute = executors[def.name];
    if (typeof execute !== 'function') {
      throw new Error(`preset: 工具 ${def.name} 有定义但没接线（执行器缺失）。`);
    }
    dispose.push(
      ctx.tools.register(
        defineTool({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          output: RESULT_OUTPUT,
          execute,
        }),
      ),
    );
  }

  return { defs, dispose };
}

export { TOOL_NAMES };
