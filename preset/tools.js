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

    const r = await callHost(h.host, 'bindIdentity', [agentOf(exec), { 智能体: args['智能体'], 项目: args['项目'] }]);
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
function executeWrite(ctx, config) {
  return async (args, exec) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'writeEntry', [
      agentOf(exec),
      {
        主要内容: args['主要内容'],
        形态: args['形态'],
        项目: args['项目'],
        智能体: args['智能体'],
        自由标签: args['自由标签'],
        // ⚠️ `稳定性` 必须透传：它是**模型判**的字段（2026-11-08 裁定）。
        // 漏传的后果不是报错而是静默降级——engine 收不到就当没给，
        // 落到状态机起点 `观察`，模型的判断被悄悄丢掉，还不报错。
        // 实测踩过：模型明确传 稳定，落库却是 观察。
        稳定性: args['稳定性'],
      },
    ]);
    if (!r.ok) return r;
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
        项目: args['项目'],
        智能体: args['智能体'],
        形态: args['形态'],
        自由标签: args['自由标签'],
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
        项目: args['项目'],
        智能体: args['智能体'],
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
    const patch = {};
    for (const field of ['形态', '项目', '智能体', '自由标签', '稳定性', '状态']) {
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
          '形态 / 项目 / 智能体 / 自由标签 / 稳定性 / 状态。\n' +
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
  return async (args) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'listEntries', [
      {
        形态: args['形态'],
        项目: args['项目'],
        智能体: args['智能体'],
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
  return async (args) => {
    const h = requireHost(ctx);
    if (!h.ok) return h.result;

    const r = await callHost(h.host, 'readRecords', [
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
 * @param {object} config 插件 Config（可覆盖取值域）
 * @returns {{defs: Array, dispose: Function[]}}
 */
export function registerTools(ctx, config) {
  const defs = buildToolDefs({
    shapes: config?.shapes,
    stabilities: config?.stabilities,
    statuses: config?.statuses,
  });

  const executors = {
    dtm_bind: executeBind(ctx),
    dtm_write: executeWrite(ctx, config),
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
