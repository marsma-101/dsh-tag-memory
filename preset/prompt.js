/**
 * prompt.mjs — 每轮系统提示注入（精简版标签字典 + 当前会话身份状态）
 *
 * 依据：《标签字典》「注入边界」两条硬约束、《功能说明》§十四 插件层验收、
 *       Lead 2026-11-05 裁决（注入文案逐条"删不删"自查已通过）。
 *
 * ── 两条硬约束（主子明令，不许违反）────────────────────────────────
 *   ① 尽量精简：阈值推导、匹配原理、状态机细节**一律不进注入**（它们在流程文档里）
 *   ② 一个 dtm_* 入口都不能缺：每个工具都要有一行"叫什么、什么时候调"
 *
 *   判据：删掉某段后，模型**还能不能正确决定"要不要调、调哪个"**？能就删。
 *
 * ── 为什么不用 engine 的 renderCompactInjection ──────────────────
 *   engine 的 `dict.mjs#renderCompactInjection` 存在，但**信息量不足以让模型做对决定**：
 *   它没有「什么时候用」「不查重」「假查空不要重试」「通用 vs 引入」「形态判据」，
 *   这五条恰好都过了"删掉后模型会做错"的判据。本文件实现 Lead 已批准的那版文案。
 *   两者重复的问题已上报 Lead 裁决（见交付说明），本文件不擅自删 engine 的东西。
 *
 * ── 为什么 interpolate: false ───────────────────────────────────
 *   注入文本里有 `|`、`{}` 一类字符。system-prompt 默认会做 `{{variable}}` 插值，
 *   未解析的引用会让 **整个 assembly 失败**（不是降级，是抛错）。
 *   官方的开关就是 `interpolate: false`（探明结论 §2）。**这一条不能删。**
 */

import { TOOL_NAMES, TOOL_WHENS } from './tool-defs.js';

/** 系统提示 section 唯一名（同名重复注册会被覆盖而非并列，qa L7） */
export const SECTION_NAME = 'dsh-tag-memory';

/**
 * section 排序值。
 *
 * 不用 `ctx.systemPrompt.getSectionOrder(...)`：那张表是**第一方预留**的
 * `PromptSectionOrderName` 枚举，外部插件传自己的名字进去会抛。
 * 官方明确"External contributions may use any finite order"。
 *
 * 选 4200 的理由：第一方 order 全是离散哨兵值（…2900 REPORT、3000 COMPUTER_USE、
 * 3100 MCP_SERVERS、5000 TOOLS_SDK…），**3100→5000 是整张表最宽的空档**；
 * 4200 距两端各 1100/800，最不可能被日后新增的哨兵夹住。
 * 语义也对：排在所有工具指引之后、SDK/结构化输出之前。
 */
export const SECTION_ORDER = 4200;

/**
 * 渲染注入正文。
 *
 * @param {{
 *   identity?: { bound?: boolean, who?: string, project?: string },
 * }} [args]
 * @returns {string}
 */
export function renderInjection({ identity } = {}) {
  const lines = [];

  lines.push('## 长期记忆（dsh-tag-memory）');
  lines.push('');
  lines.push('库是一张表，行只追加。读写记忆**只用下面这 10 个工具**，不要用文件工具碰库文件。');
  lines.push('');

  /* ── 身份状态 ────────────────────────────────────────────────
   * 三种态都要能渲染：已绑定 / 未绑定 / 拿不到会话（按未绑定处理）。
   * 未绑定时**必须提示去问用户**（《功能说明》§4.3、开发流程闸门③）。 */
  lines.push(...renderIdentity(identity));
  lines.push('');

  /* ── 工具入口（一个不能缺）────────────────────────────────── */
  lines.push('### 入口');
  lines.push('');
  lines.push('| 工具 | 什么时候调 |');
  lines.push('|---|---|');
  for (const { name, when } of TOOL_WHENS) lines.push(`| \`${name}\` | ${when} |`);
  lines.push('');
  lines.push('写入只追加、读取只读、改库全归整理（`dtm_supersede`/`dtm_archive`/`dtm_retag`/`dtm_merge`）。');
  lines.push('');

  /* ── 什么时候用（决定性判据，不能删）───────────────────────── */
  lines.push('### 什么时候调');
  lines.push('');
  lines.push('- 用户要求记 / 定了约定 / 踩到坑 / 表达偏好或约束 → `dtm_write`');
  lines.push('- 提到「之前/上次/定过」、要做可能做过的事、说你漏了什么 → `dtm_recall`');
  lines.push('- 用户口头要求整理 → `dtm_review` 通览候选，再按需 `dtm_retag`/`dtm_archive`/`dtm_supersede`');
  lines.push('');

  /* ── 写 ──────────────────────────────────────────────────── */
  lines.push('### 写（`dtm_write` 填 5 个，程序补 编号/稳定性/时距/状态）');
  lines.push('');
  lines.push('- `主要内容`：记什么，一条一件事，不设字数上限。');
  lines.push(
    '- `形态` 6 选 1：单件事怎么做→`技能`；多件事次序→`流程`；必须/禁止→`规则`；' +
      '喜欢/倾向→`偏好`；客观陈述→`事实`；可复用格式→`模板`。**这个判错最难被召回，写时慎重。**',
  );
  lines.push(
    '- `项目` / `智能体`：`通用`=所有项目/身份都该知道；`引入`=外面搬来的、来源没写归属；' +
      '其余写具体名（项目=会话工作目录名，智能体=当前身份名）。' +
      '**不知道归属填 `引入`，别填 `通用`；同一个名字每次必须写成同一个字符串。**',
  );
  lines.push(
    '- `自由标签`：1~20 个离散词，从「作用 / 注意事项 / 内容关键词」三个方向拆；' +
      '用正文里会出现的实词，短词优于长句。**含 `|` 会被拒写并点名，换个写法再调一次。**',
  );
  lines.push('- **不查重**：不要先查再写，直接写。去重留给整理。');
  lines.push(
    '- **不记**：一次性问答、能从文件直接读到的、密钥口令、临时进度，' +
      '以及「我该怎么做人」这类行为守则——记的是项目知识，不是行为准则。',
  );
  lines.push('');

  /* ── 读 ──────────────────────────────────────────────────── */
  lines.push('### 读（`dtm_recall` 填 `项目` `智能体` `形态`（必填）`自由标签`（可选数组，≤20））');
  lines.push('');
  lines.push('- 想浏览某形态全部条目 → `自由标签` 留空。');
  lines.push(
    '- 查空会告诉你「真查空」还是「假查空」。**假查空时按无返回正常继续，不要「换个说法再试」**——' +
      '反复重试只会堆词、照样查空。要再找就：留空只按形态浏览、换形态、或调整标签。',
  );
  lines.push('');

  /* ── 未绑定时的行动指引（只在未绑定时出现，省 token）───────── */
  if (identity?.bound === false) {
    lines.push('### 现在该做的');
    lines.push('');
    lines.push('你还没绑定身份。**先问用户「这次会话我以什么名字负责」**，拿到名字后调 `dtm_bind`。');
    lines.push('用户问「都有什么身份」时：先确认他在做什么工作，再给出建议的身份名。');
    lines.push('未绑定期间不要猜身份、不要写入——写入会被拒、召回返回空。');
  }

  // 去掉尾部空行，保持稳定输出（利于 KV cache 前缀复用）
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/**
 * 身份状态段。三种态：已绑定 / 未绑定 / 拿不到会话（按未绑定处理）。
 *
 * 「拿不到会话」= assembly 没有 `agent`（官方注释 "absent on diagnostics"）。
 * 这时**仍要提示问用户**，不能因为读不到状态就什么都不说。
 */
function renderIdentity(identity) {
  const bound = identity?.bound !== false;
  const who = String(identity?.who ?? '').trim();
  const project = String(identity?.project ?? '').trim();

  if (bound && (who || project)) {
    const parts = [];
    if (who) parts.push(`智能体=\`${who}\``);
    if (project) parts.push(`项目=\`${project}\``);
    return [`### 身份：已绑定`, '', parts.join('，') + '。读写都用这个身份。'];
  }

  // 未绑定（含"拿不到会话"）：必须去问用户
  return [
    '### 身份：未绑定',
    '',
    '**先问用户「这次会话我以什么名字负责」**，拿到名字后调 `dtm_bind`。',
    '未绑定期间：写入会被拒、召回返回空——**不要猜身份**。',
  ];
}

/**
 * 注入用的工具入口行由 `tool-defs.js` 的 DEFS 单一来源导出（同源即"一个入口都不能缺"的保证）。
 * 这里重新导出，方便调用方只 import 本模块。
 */
export { TOOL_WHENS };

/** 自检：注入里必须出现的 10 个名字（qa L1 同款口径，便于单测直接引用） */
export function missingToolNames(text) {
  const src = String(text ?? '');
  return TOOL_NAMES.filter((n) => !src.includes(n));
}
