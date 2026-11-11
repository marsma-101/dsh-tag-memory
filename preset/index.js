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

import { registerTools, HOST_SERVICE } from './tools.js';
import { installWriteReminder, isReminderEnabled } from './reminder.js';
import {
  renderInjection,
  renderIdentityContext,
  SECTION_NAME,
  SECTION_ORDER,
  IDENTITY_CONTEXT_NAME,
  IDENTITY_CONTEXT_ORDER,
} from './prompt.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis 插件名（Loader 诊断用） */
export const name = 'dsh-tag-memory-preset';

/**
 * 包根目录。schema.json 在 `lib/engine/templates/` 下，
 * 与 host 侧 `loadConfigs()` 读的是同一个文件——两边取同一份 `writeRoutes`，
 * 不各存一份（v0.3.7 的做法：判据只在 schema 里，渲染方各自读）。
 */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(PACKAGE_DIR, 'lib', 'engine', 'templates');

/** 确定存在的服务（`ctx.tools` / `ctx.systemPrompt` 由 dsh-tools / dsh-system-prompt 提供） */
export const inject = ['tools', 'systemPrompt'];

/**
 * ⚠️ **故意不导出 `Config`**（2026-11-05 装进真容器后发现的 bug）。
 *
 * Cordis 的 `resolveConfig`（cordis/lib/index.js:958）逻辑是：
 * ```js
 * if (!runtime.Config) return config;                    // 没有就放行
 * const result = runtime.Config['~standard'].validate(config);  // 有就必须是标准 schema
 * ```
 * 所以 `export const Config = {}`（空对象）**不等于"没有 schema"**——
 * 它过了第一道判断，然后 `Config['~standard']` 是 undefined，
 * 直接抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 整个插件行 activation 失败。
 *
 * **当前选择：不导出 Config。** 可调值一律走 engine 的 `templates/*.json`
 * （`schema.json` / `scoring.json` / `tag-equivalence.json`），
 * 它们是运行时从磁盘读的，改完即生效，不需要 Config 中转。
 *
 * 若将来确实需要"用户可在 cordis.patch.yml 里覆盖"的字段，
 * 必须导出真正的 Schemastery schema（带 `~standard`），**不能是普通对象**。
 */

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx    Cordis 上下文
 * @param {object} config 插件 Config
 */
export function apply(ctx, config = {}) {
  /* ---- 1. 注册 10 个工具 ---- */
  const { dispose } = registerTools(ctx, domainFor());
  // 注册是 effect：插件卸载时自动撤销。这里再挂一层保险，
  // 保证 ctx 被回收时不会留下悬空注册（官方 práctica：registration 由 owning context 拥有）。
  if (typeof ctx.effect === 'function') {
    for (const d of dispose) {
      if (typeof d === 'function') ctx.effect(() => d);
    }
  }

  /* ---- 2. 每轮注入（固定判据 + 动态身份）----
   *
   * ⚠️ 拆成 section + context 是 **KV cache 硬约束**，不是风格选择：
   *   · section 进系统提示词前缀，内容一变，**其后所有缓存全废**（工具定义、历史）。
   *     所以它只能放**与身份无关、字节恒定**的判据与字段标准。
   *   · context 官方定义为 "durable user-role snapshot"，按 order 进历史、
   *     以 user 角色追加。身份变了只多一条消息，**不动已有前缀**。
   * 把身份塞进 section 曾导致：`dtm_bind` 一执行，整段注入变化 → 每轮重建缓存。
   */
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      // ⚠️ 必须 false：注入文本含 `|` 与 `{}` 一类字符，
      // 默认的 `{{variable}}` 插值遇到未解析引用会让**整个 assembly 抛错**。
      interpolate: false,
      // 与身份无关 → 同一插件版本下字节恒定，缓存可复用。
      text: () => renderInjection({ writeRoutes: writeRoutesFor(), dimensions: dimensionsFor() }),
    }),
  );

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: IDENTITY_CONTEXT_NAME,
      order: IDENTITY_CONTEXT_ORDER,
      // 空文本贡献不了任何东西（官方："Empty text contributes nothing"），
      // 所以拿不到会话时返回空串而不是占位文字。
      text: (context) => renderIdentityContext(identityFor(ctx, context)),
      interpolate: false,
    }),
  );

  /* ---- 3. 轮级「漏记提醒」（§4.7，恢复 0.3.x 被重构删掉的兜底）----
   *
   * ⚠️ 只挂两个事件钩子，**不新增** section / context / 工具：
   *   tools.k.test.mjs 与 prompt.l.test.mjs 都断言「恰好 1 个 section、
   *   1 个 context、10 个工具」，多一个就挂。提醒走 pre-step 的
   *   decision.messages（消息历史），不进 system prompt —— 这是 KV cache 硬约束。
   *
   * 可关闭：`config.reminderEnabled === false` 时整段不注册。
   * 宿主未实现 ctx.on（例如旧版宿主 / 假 ctx 没补 on）时，reminder.js 内部
   * 会静默跳过注册，**apply 不抛错**（tools.k.test.mjs 断言宿主服务未挂载时
   * apply 不得抛错）。
   */
  if (isReminderEnabled(config)) {
    ctx.effect(() => installWriteReminder(ctx));
  }
}

/**
 * 读 schema 里的写入判据，供注入渲染。
 *
 * **每轮重读**（按 mtime 缓存），理由同 v0.3.7：
 * 用户改了 `schema.json` 的判据措辞，不该还要重启宿主才生效。
 *
 * **绝不抛错**：注入渲染失败会让整个 prompt assembly 失败，
 * 比少一段判据严重得多。读不到就返回 null，`renderWriteRoutes` 会跳过该节。
 *
 * 为什么同步读文件而不是用 `loadSchema`（async）：注入的 `text` 必须同步返回 string。
 * 判据文件很小（几 KB），且按 mtime 缓存，命中时零 IO。
 */
let routesCache = { mtimeMs: -1, routes: null };

function writeRoutesFor() {
  const schema = schemaFor();
  return schema?.writeRoutes ?? null;
}

/** 维度判据（照 v0.3.7 的 `dimensions` 结构），同一份缓存。 */
function dimensionsFor() {
  const schema = schemaFor();
  return schema?.dimensions ?? null;
}

/**
 * 工具参数里的取值域（形态 / 稳定性 / 状态），来自 `templates/schema.json`。
 *
 * ⚠️ 早先这里传的是 `config?.shapes`，但宿主**刻意不导出 Config**（见文件头 §"故意不导出 Config"），
 * 于是 config 恒为 `{}` → domain 恒为 undefined → `buildToolDefs` 只能走它自带的硬编码兜底。
 * 结果：用户改 schema.json 加一种形态，注入段会显示 7 个，工具 enum 还是 6 个，
 * 模型选了新值会被 schema 校验拒掉。现在改成与注入同一份来源（`schemaFor()`），两边永远一致。
 *
 * 读不到时返回 null，由 `buildToolDefs` 自行兜底（它必须能在无 schema 时工作）。
 */
function domainFor() {
  const schema = schemaFor();
  if (!schema) return null;
  return {
    shapes: schema.shapes,
    stabilities: schema.stabilities,
    statuses: schema.statuses,
  };
}

/** 同步读 schema（按 mtime 缓存）；读不到返回 null，绝不抛错。 */
function schemaFor() {
  try {
    const file = path.join(TEMPLATE_DIR, 'schema.json');
    const stat = fs.statSync(file);
    if (stat.mtimeMs === routesCache.mtimeMs) return routesCache.schema;

    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    routesCache = { mtimeMs: stat.mtimeMs, schema };
    return schema;
  } catch {
    return null;
  }
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
    // `项目` 取**实时**工作目录名（宿主 projectOfSync），不是绑定时的快照：
    // 落库用的是实时值，注入若显示旧值，模型看到的和实际写的就不是一回事。
    // 取不到时回落到绑定值（此时写入也会被 PROJECT_EMPTY 拒，注入只是提示）。
    let project = id['项目'] ?? id.project;
    if (typeof host.projectOfSync === 'function') {
      const live = host.projectOfSync(agent);
      if (live) project = live;
    }
    return { bound: true, who: id['智能体'] ?? id.who, project };
  } catch {
    // 注入永远不该因为读身份失败而崩掉整个 prompt
    return { bound: false };
  }
}
