/**
 * prompt.js — 每轮注入：**固定判据段**（section）+ **动态身份段**（context）
 *
 * 依据：《标签字典》「注入边界」两条硬约束、《功能说明》§十四 插件层验收、
 *       dsh-system-prompt 的 `PromptSection` / `PromptContext` 契约。
 *
 * ── 为什么拆成 section + context（KV cache 硬约束）──────────────
 *   `systemPrompt.section` 进的是**系统提示词前缀**。它的 `text` 是每轮重算的
 *   provider，一旦内容变化，**该段之后的所有缓存前缀全部作废**——工具定义、
 *   历史消息统统重算。身份（绑没绑、叫什么）恰恰每轮都会变，所以**不能放 section**。
 *
 *   `systemPrompt.context` 官方定义为 "durable user-role snapshot"：它按 order
 *   进历史、以 user 角色追加，**变化只多一条消息，不动已有前缀**。
 *   身份放这里，绑定时只追加一条，缓存照常命中。
 *
 *   于是分工是：
 *     · section  → 判据、字段标准、工具入口：**除非插件升级，字节恒定**
 *     · context  → 当前项目/身份：**每轮可变，变了也不毁缓存**
 *
 * ── 两条硬约束（主子明令，不许违反）────────────────────────────
 *   ① 尽量精简：阈值推导、匹配原理、状态机细节一律不进注入（它们在流程文档里）
 *   ② 一个 dtm_* 入口都不能缺：每个工具都要有一行"叫什么、什么时候调"
 *
 *   判据：删掉某段后，模型**还能不能正确决定"要不要调、调哪个、填什么"**？能就删。
 *
 * ── 为什么 interpolate: false ───────────────────────────────────
 *   注入文本里有 `|`、`{}` 一类字符。system-prompt 默认会做 `{{variable}}` 插值，
 *   未解析的引用会让 **整个 assembly 失败**（不是降级，是抛错）。
 *   官方的开关就是 `interpolate: false`。**这一条不能删。**
 */

import { TOOL_NAMES, TOOL_WHENS } from './tool-defs.js';

/** 系统提示 section 唯一名（同名重复注册会被覆盖而非并列） */
export const SECTION_NAME = 'dsh-tag-memory';

/**
 * section 排序值。
 *
 * 不用 `ctx.systemPrompt.getSectionOrder(...)`：那张表是**第一方预留**的
 * `PromptSectionOrderName` 枚举，外部插件传自己的名字进去会抛。
 * 官方明确"External contributions may use any finite order"。
 *
 * 选 4200：第一方 order 全是离散哨兵值（…2900 REPORT、3000 COMPUTER_USE、
 * 3100 MCP_SERVERS、5000 TOOLS_SDK…），**3100→5000 是整张表最宽的空档**；
 * 4200 距两端各 1100/800，最不可能被日后新增的哨兵夹住。
 */
export const SECTION_ORDER = 4200;

/** 动态身份 context 唯一名 */
export const IDENTITY_CONTEXT_NAME = 'dsh-tag-memory/identity';

/**
 * 身份 context 排序值。
 *
 * 同样不能用 `getContextOrder(...)`（第一方枚举）。第一方值是
 * WORKING_DIRECTORY 100 / SANDBOX_POLICY 110 / APPROVAL_POLICY 115 /
 * SUBAGENT_DELEGATION 120 / TEAM_IDENTITY 125 / HARNESS_SOURCE 200。
 * 选 130：紧接 TEAM_IDENTITY 之后、离 200 还有 70，语义也对（身份紧随团队身份）。
 */
export const IDENTITY_CONTEXT_ORDER = 130;

/**
 * 渲染**固定判据段**（进 system prompt section）。
 *
 * ⚠️ 本函数的输出必须**与身份无关**、字节恒定：同一插件版本下，
 * 不管模型绑没绑身份，返回的字符串必须完全一致。否则每轮都会毁掉
 * 系统提示词的 KV cache 前缀。身份一律走 `renderIdentityContext()`。
 *
 * @param {{
 *   writeRoutes?: { rules?: string[], principles?: string[] },
 *   dimensions?: object,
 * }} [args]
 * @returns {string}
 */
export function renderInjection({ writeRoutes, dimensions } = {}) {
  const lines = [];

  /*
   * ═══ 分层原则（2026-11-11 修订，主子定方向）═══════════════════════
   * 每轮注入只留「**这一轮就要判的**」：写不写、写哪类、什么时候读、调哪个工具。
   * 判据之外的细则（标签怎么打、字段怎么填、被拒怎么补、读写细则）**一律下沉**：
   *   · 工具**返回值** —— 被拒/查空时才给，真按需、零常态成本；
   *   · `标签字典.md` —— 模型主动读才看。
   * ⚠️ 工具 description 不算「按需」：它也每轮在上下文里（实测 7.8 KB）。
   * 若要再瘦身，先瘦 description，别把细则从 section 搬到 description 自我安慰。
   */

  lines.push('## 长期记忆（dsh-tag-memory）');
  lines.push('');
  lines.push('库是一张表，行只追加。读写**只用这 10 个工具**。');
  lines.push('');

  /* ── 工具入口（一个不能缺，这是「调哪个」）──────────────────── */
  lines.push('### 入口');
  lines.push('');
  lines.push('| 工具 | 什么时候调 |');
  lines.push('|---|---|');
  for (const { name, when } of TOOL_WHENS) lines.push(`| \`${name}\` | ${when} |`);
  lines.push('');

  /* ── 写入判据（核心：什么内容该进库。每轮必须有）──────────────
   * 只渲染 rules（判类），principles（方法论）下沉到文档与拒绝提示。
   * 判据本体在 schema.json 的 `writeRoutes`，这里只排版。 */
  lines.push(...renderWriteRoutes(writeRoutes));
  lines.push('');

  /* ── 什么时候读（核心：触发条件，每轮必须有）────────────────── */
  lines.push('### 什么时候读');
  lines.push('');
  lines.push('- 提到「之前/上次/定过」、要做可能做过的事、说你漏了什么 → `dtm_recall`。');
  lines.push('- 想浏览某形态全部条目 → `自由标签` 留空。');
  lines.push(
    '- 查空分「真查空 / 假查空」。**假查空按无返回继续，不要换个说法重试**；' +
      '要再找就留空按形态浏览、换形态、或调标签。',
  );
  lines.push('- 带`libraryIssue`→问人，转述`question`/`options`，别自行迁移合并');
  lines.push('');

  /* ── 字段（只留「填之前必须知道的最小集」）────────────────────
   * 完整含义、how、取值域解释已下沉：参数 enum 在工具定义里、被拒提示里有、
   * 标签字典.md 有全文。这里只回答「我该填什么、什么不用填」。 */
  lines.push('### 字段标准');
  lines.push('');
  lines.push(...renderDimensionsBrief(dimensions));
  lines.push('- `主要内容` 一条一件事，不设字数上限。');
  lines.push('- `自由标签` 1~20 个离散实词，**不含 `|`**；怎么打见被拒提示 / `标签字典.md`。');
  lines.push('');

  /* ── 被拒了怎么办（只留一句，细则由返回值点名）──────────────── */
  lines.push('### 被拒了怎么办');
  lines.push('');
  lines.push(
    '- 返回值会点名是哪个字段、合法值是什么、该怎么补——**按它补完再调一次**，别换说法绕。' +
      '`项目`/`智能体` 报错是**环境**没准备好（没绑身份/工作目录不明），去问用户或 `dtm_bind`，别猜值。',
  );
  lines.push('');
  lines.push('标签怎么打、字段怎么填、读写细则 → 需要时读插件内 `标签字典.md`。');

  // 去掉尾部空行，保持稳定输出（利于 KV cache 前缀复用）
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/**
 * 渲染**动态身份段**（进 system prompt context，不进 section）。
 *
 * 进历史、以 user 角色追加：绑定时只多一条消息，**不毁系统提示词缓存**。
 * 三种态：已绑定 / 未绑定 / 拿不到会话（按未绑定处理，官方注释 "absent on diagnostics"）。
 *
 * @param {{ bound?: boolean, who?: string, project?: string }} [identity]
 * @returns {string}
 */
export function renderIdentityContext(identity) {
  const bound = identity?.bound !== false;
  const who = String(identity?.who ?? '').trim();
  const project = String(identity?.project ?? '').trim();

  if (bound && (who || project)) {
    const lines = ['### 记忆身份（已绑定）', ''];
    if (who) lines.push(`- 当前身份：\`${who}\``);
    if (project) lines.push(`- 当前项目：\`${project}\``);
    lines.push('');
    lines.push('归属由程序填，`dtm_write`/`dtm_recall` 都不用传 `项目`/`智能体`——');
    lines.push('你只管决定**内容、形态、自由标签**。');
    // §4.7 配套：答复前自问（旧版 _work_preset.js L265 曾有一句，重构时丢了）。
    // 放 context 末尾而非 section：section 实测 5998/6000 字节只剩 2 字节，
    // 且内容一变会毁掉整段 KV cache 前缀；context 是 user 角色快照，加一句不毁缓存。
    lines.push('');
    lines.push('> **答复前自问**：这轮中了哪条必写？中了就先 `dtm_write` / `dtm_recall` 再答。');
    return lines.join('\n');
  }

  // 未绑定（含"拿不到会话"）：必须去问用户，且这是**硬性流程**，不是建议。
  return [
    '### 记忆身份：未绑定 —— 硬性流程，先做这一步',
    '',
    '**本轮第一件事：问用户「这次会话我以什么名字负责」，然后立刻调 `dtm_bind`。**',
    '- `智能体` = 用户给的名字（问不到就不要写记忆，不要自己起名）',
    '- `项目` 不用你填，程序按当前工作目录自动填',
    '',
    '为什么必须先问：记忆按身份归属，名字错了旧记忆就对不上，等于白记。',
    '未绑定期间：`dtm_write` 会被拒（`UNBOUND_IDENTITY`）、`dtm_recall` 返回空。',
    '**不要猜身份，也不要因为「这次好像不用记」就跳过绑定**——',
    '绑定是一次性的，绑完整个会话都用它。',
  ].join('\n');
}

/**
 * 写入判据段（源自 v0.3.7 的 `writeRoutes`）。
 *
 * v0.3.7 把这段放在 `tags.schema.json` 里、由 `renderDict` 渲染，注释写明
 * 「换措辞不用改代码，改 schema 就行」。本文件沿用同一分工：
 * **判据在 `lib/engine/templates/schema.json` 的 `writeRoutes`，这里只排版。**
 *
 * 为什么必须有这一段：1.2.x 的注入里只剩「用户要求记 / 定了约定 / 踩到坑」
 * 一行触发词，回答的是「什么时候调工具」，没回答「这句话算不算踩到坑」。
 * 实测结果就是模型整场不调 `dtm_write`——不是不愿意记，是没判据可依。
 *
 * 返回空数组时（schema 缺 `writeRoutes`）不渲染该节，不让空标题占位置。
 */
function renderWriteRoutes(writeRoutes) {
  const rules = Array.isArray(writeRoutes?.rules) ? writeRoutes.rules.filter((r) => String(r ?? '').trim() !== '') : [];
  if (rules.length === 0) return [];

  const lines = [];
  lines.push('### 什么情况该写（先判哪一类，再决定写不写）');
  lines.push('');
  for (const r of rules) lines.push(`- ${r}`);

  /*
   * `principles`（写入原则 5 条）**不再每轮注入**（2026-11-11）。
   * 理由：那 5 条是「怎么写得更好」的方法论，不是「这一轮该不该写」的判据；
   * 实测占 600 余字节，且模型是被拒绝/整理时才真正需要它。
   * 下沉位置：① `标签字典.md`「写入原则」全文；② `dtm_write` 被拒时的返回值
   * （见 format.js 的 formatWriteResult / 拒绝提示）。
   * schema.json 里保留 `principles`，供文档与拒绝提示读取，不删数据。
   */

  return lines;
}

/**
 * 字段标准的**极简版**（每轮注入用）。
 *
 * 与 `renderDimensions`（完整版：question + values + how）的分工：
 *   · 完整版留给**文档**与被拒提示；
 *   · 注入只回答「这一维我填不填、是什么」——`项目`/`智能体` 根本不填（程序填），
 *     `稳定性` 恒为观察（模型没参数），这两维在注入里只需一句「不用填」。
 *
 * 为什么这么砍：完整版实测 2128 字节（占 section 35%），其中大半是取值域解释
 * 和 `how`——而取值域已在工具参数 enum 里、被拒提示里也会点名，属于重复。
 */
function renderDimensionsBrief(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return [];

  const lines = [];
  const shape = dimensions['形态'];
  if (shape?.values) {
    lines.push(`- \`形态\`（必填，6 选 1）：${Object.keys(shape.values).join(' / ')}`);
    if (shape.how) lines.push(`  怎么判：${shape.how}`);
  }
  lines.push('- `项目` / `智能体`：**不用你填**，程序按工作目录名 + 绑定身份自动填。');
  lines.push('- `稳定性`：**不用你填**，首次落库恒为 `观察`，之后由程序按使用情况演进。');

  return lines;
}

/**
 * 渲染维度判据（源自 v0.3.7 的 `dimensions` 五段式结构）。
 *
 * v0.3.7 给每一维五样：`question`（回答什么问题）/ `values`（取值与含义）/
 * `when`（什么时候判）/ `how`（怎么判）/ `lifts`（怎么演进）。
 * 实测证明**只给取值域、不给判据**时模型判不准——它会挑一个听起来对的词，
 * 而不是按问题去推。所以 `how` 是必须保留的核心。
 *
 * 注入侧**只渲染 question + values + how**：
 *   · `when` 基本是「写入时必判」，冗余 → 合并进开头一句
 *   · `lifts` 由程序（`tidy.mjs` 状态机）自动做，模型不用管 → 不进注入
 *   · `note` 是给维护者看的补充说明 → 不进注入
 * 这是「精简」与「判得准」的平衡点：判据在，但不把维护者文档塞进每轮上下文。
 *
 * 返回空数组时（schema 缺 `dimensions`）不渲染该节。
 */
function renderDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return [];

  const DIM_ORDER = ['形态', '稳定性', '项目', '智能体'];
  const keys = DIM_ORDER.filter((k) => dimensions[k]);
  if (keys.length === 0) return [];

  const lines = [];
  lines.push('### 字段标准（缺了/不合规会被拒；写入时每一维都要判）');
  lines.push('');

  for (const key of keys) {
    const d = dimensions[key] ?? {};
    const question = String(d.question ?? '').trim();
    const how = String(d.how ?? '').trim();
    const values = d.values && typeof d.values === 'object' ? Object.entries(d.values) : [];

    if (values.length === 0) continue;

    // 小标题：字段名 + 它回答的问题
    lines.push(question ? `**\`${key}\`** — ${question}` : `**\`${key}\`**`);
    for (const [val, meaning] of values) {
      lines.push(`- \`${val}\`：${meaning}`);
    }
    if (how) lines.push(`- 怎么判：${how}`);
    lines.push('');
  }

  // 去掉尾部多余空行（renderInjection 会再补一个）
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines;
}

/**
 * 注入用的工具入口行由 `tool-defs.js` 的 DEFS 单一来源导出（同源即"一个入口都不能缺"的保证）。
 * 这里重新导出，方便调用方只 import 本模块。
 */
export { TOOL_WHENS };

/** 自检：注入里必须出现的 10 个名字（单测直接引用） */
export function missingToolNames(text) {
  const src = String(text ?? '');
  return TOOL_NAMES.filter((n) => !src.includes(n));
}
