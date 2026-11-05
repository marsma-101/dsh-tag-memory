/**
 * preset/index.js — 预设入口：注册 10 个 dtm_* 工具 + 每轮系统提示注入
 *
 * 依据：《架构说明》§二/§四.1（预设入口职责）、《接口契约》§一、§五，
 *       `探明结论 §1/§2`（官方 API 确切形态），Lead 2026-11-05 裁决 6。
 *
 * ── 接线方式（Lead 裁决 6：答案 a 的变体）────────────────────────
 *   本包在 `cordis.patch.yml` 里插的是**一条普通宿主行**，指向 `dsh-tag-memory/preset`：
 *
 *     - insert:
 *         - id: dsh-tag-memory-tools
 *           name: 'dsh-tag-memory/preset'
 *
 *   **不是** `@deepseek-ai/dsh-agent-preset` 行。理由（查证结论）：
 *   `dsh-base` 的 `tool-fs` / `tool-todo` / `tool-goal` 全部是普通宿主行，
 *   不在任何 preset 里，但每个 agent 都能用——因为 `ctx.tools.register` 注册进**全局层**，
 *   `ToolRuntime.view()` 解析时全局层对所有 scope 可见。用户装上即自动可用，
 *   不需要选 preset、不需要改设置。
 *
 *   反过来，patch `preset-standard` 的 id 加进去会**清空整个 standard preset**：
 *   补丁方言是 `config` 整体替换、绝不深合并（`cordis-composition-reference` 原文）。
 *
 * ── 为什么用 ctx.get 惰性取服务 ─────────────────────────────────
 *   `inject` 里列了不存在的服务会让**整个插件挂不上**。记忆的宿主服务由
 *   `index.js` 提供，preset 不该因它没就绪就整体哑掉。所以只把确定存在的
 *   `tools` / `systemPrompt` 放进 inject，宿主服务惰性取。
 */

import { registerTools } from './tools.js';
import { renderInjection, SECTION_NAME, SECTION_ORDER } from './prompt.js';
import { HOST_SERVICE } from './tools.js';

/** Cordis 插件名（Loader 诊断用） */
export const name = 'dsh-tag-memory-preset';

/** 确定存在的服务（`ctx.tools` / `ctx.systemPrompt` 由 dsh-tools / dsh-system-prompt 提供） */
export const inject = ['tools', 'systemPrompt'];

/**
 * 插件 Config。
 *
 * 可调值放 Config，用户在 `cordis.patch.yml` 改（官方：用户的补丁层跨升级保留）。
 * 这里的字段都是**取值域覆盖**，出厂值来自 engine 的 `templates/schema.json`；
 * 不传就完全走 engine 出厂值（不在 preset 里硬编码第二份）。
 */
export const Config = {};

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx    Cordis 上下文
 * @param {object} config 插件 Config
 */
export function apply(ctx, config = {}) {
  /* ---- 1. 注册 10 个工具 ---- */
  const { dispose } = registerTools(ctx, config);
  // 注册是 effect：插件卸载时自动撤销。这里再挂一层保险，
  // 保证 ctx 被回收时不会留下悬空注册（官方 práctica：registration 由 owning context 拥有）。
  if (typeof ctx.effect === 'function') {
    for (const d of dispose) {
      if (typeof d === 'function') ctx.effect(() => d);
    }
  }

  /* ---- 2. 每轮注入（精简字典 + 身份状态）---- */
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      // ⚠️ 必须 false：注入文本含 `|` 与 `{}` 一类字符，
      // 默认的 `{{variable}}` 插值遇到未解析引用会让**整个 assembly 抛错**（探明结论 §2）。
      interpolate: false,
      // 身份每轮可能变（这轮绑没绑），所以用 provider 形式：
      // 官方支持 `text: (context) => string`（dsh-system-prompt 的 PromptSection.text）。
      text: (context) => renderInjection({ identity: identityFor(ctx, context) }),
    }),
  );
}

/**
 * 读当前会话的身份状态，供注入渲染。
 *
 * 三态：
 *   · 已绑定   → `{bound:true, who, project}`
 *   · 未绑定   → `{bound:false}`
 *   · 拿不到   → `{bound:false}`（assembly 没有 agent，官方注释 "absent on diagnostics"）
 *
 * **绝不抛错**：注入渲染失败会导致整个 prompt assembly 失败，比少一段文字严重得多。
 */
function identityFor(ctx, context) {
  try {
    const agent = context?.agent;
    if (!agent) return { bound: false };

    const host = ctx?.get?.(HOST_SERVICE);
    if (!host || typeof host.identityOfSync !== 'function') return { bound: false };

    const id = host.identityOfSync(agent);
    if (!id) return { bound: false };
    return { bound: true, who: id['智能体'] ?? id.who, project: id['项目'] ?? id.project };
  } catch {
    // 注入永远不该因为读身份失败而崩掉整个 prompt
    return { bound: false };
  }
}
