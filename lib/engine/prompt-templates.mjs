/**
 * prompt-templates.mjs — 整理/合并提示词的生成（纯逻辑层）
 *
 * ── 为什么是「任务单」不是「完整手册」────────────────────────────
 * 用户定案（2026-11-16）：插件生成一段提示词，用户复制到**新会话**粘贴。
 * 新会话里同样加载着本插件，所以：
 *   · 10 个 dtm_* 工具天然可用   → 提示词不用列工具清单
 *   · 写入规则已经每轮注入       → 提示词不用重复「形态怎么判、标签怎么打」
 *   · 身份/项目由 dtm_bind + 程序填 → 不用交代归属怎么来
 * 提示词只补「日常注入里没有的」：本次任务、候选清单、输出格式、本任务专属约束。
 *
 * ── 边界 ──────────────────────────────────────────────────────────
 *   ✅ 纯逻辑：只拼字符串，无 IO、无框架依赖、可单测。
 *   ✅ 不写库：产出的是**文本**，不是动作。真正改库在新会话里由模型用现有工具做。
 *
 * 依据：《整理合并-复制提示词方案-2026-11-16.md》§2 / §3
 */

import { renderTags } from './parse-source.mjs';
import { issueLabel } from './pick-tidy-candidates.mjs';

/** 提示词开头统一声明：让模型原样展示，别自己改写。 */
const HEADER_NOTE =
  '> 【请原样展示这段提示词给用户，不要改写、不要总结、不要先执行】\n' +
  '> 用户会把它复制到**新会话**里，由那个会话的模型执行。\n';

/**
 * 渲染整理提示词。
 *
 * @param {object} args
 * @param {object[]} args.candidates  pickTidyCandidates 产出的候选
 * @param {object} args.stats         统计（含 commonWords）
 * @param {boolean} [args.truncated]  是否被 limit 截断
 * @returns {string}
 */
export function renderTidyPrompt({ candidates, stats, truncated = false } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const s = stats && typeof stats === 'object' ? stats : {};
  const lines = [];

  lines.push(HEADER_NOTE);
  lines.push('# 记忆库整理任务');
  lines.push('');
  lines.push(
    '你在整理 dsh-tag-memory 的记忆库。本会话已加载该插件，`dtm_*` 工具可直接用，' +
      '写入规则（形态怎么判、标签怎么打）也已每轮注入——按那些规则执行即可。',
  );
  lines.push('');

  /* ── 一、本次任务 ── */
  lines.push('## 一、本次任务');
  lines.push('');
  lines.push(
    `程序已按规则挑出 **${list.length} 条**需要整理的条目` +
      (truncated ? '（已按上限截断，还有更多，本批先处理这些）' : '') +
      '，清单在最后。',
  );
  lines.push('你的任务是**逐条判断该怎么处理**，然后用工具执行。');
  lines.push('');
  lines.push('先调 `dtm_review` 看清这些条目的完整内容——清单里只有编号和摘要，不够判断。');
  lines.push('');

  /* ── 二、可选动作 ── */
  lines.push('## 二、可选动作');
  lines.push('');
  lines.push('| 动作 | 什么时候用 | 用哪个工具 |');
  lines.push('|---|---|---|');
  lines.push('| **补标签** | 内容有价值，但标签空/不合格 | `dtm_retag`（传 形态 + 自由标签） |');
  lines.push('| **归档** | 内容已失效、过时，或本身不该存在 | `dtm_archive` |');
  lines.push('| **取代** | 这条已被另一条更好的取代 | `dtm_supersede` |');
  lines.push('| **跳过** | 看过没问题 | 不调工具，在报告里说明 |');
  lines.push('');
  lines.push('⚠️ `dtm_retag` **必须带 `basis`**（依据），缺了会被拒。依据写法：说明你为什么这么改，例如');
  lines.push('`"整理：原标签为空，按内容补为 技能 + [npm,发布,2FA]"`。');
  lines.push('');
  lines.push('⚠️ `dtm_retag` **不能改** `编号` / `主要内容` / `项目` / `智能体` / `时距`。');
  lines.push('- 内容写错了要改 → 用 `dtm_supersede` 写一条新的取代它；');
  lines.push('- 归属不对 → 那是环境事实，你不能改，报给用户。');
  lines.push('');

  /* ── 三、判断要点 ── */
  lines.push('## 三、判断要点');
  lines.push('');
  lines.push('### 3.1 空标签的条目');
  lines.push('读内容 → 按写入规则补 `形态` 和 `自由标签`。');
  lines.push('**补不出合格标签的，说明这条本身可能没价值 → 归档。**');
  lines.push('');
  lines.push('### 3.2 标签是噪声的条目');
  lines.push('纯数字（如 `3190`）、单字（如 `坑`）、来源标记（如 `原话`、`推断`）**不是有效标签**，');
  lines.push('它们几乎不可能被检索到。换成有检索价值的实词。');
  lines.push('');
  lines.push('### 3.3 疑似重复');
  lines.push('程序只能按「主要内容相似度」挑出来，**它不判语义**。你要**真的读完两条**再判：');
  lines.push('- 内容确实讲同一件事 → `dtm_supersede`（保留信息更全的那条）；');
  lines.push('- 只是主题相近（比如都讲 npm 发布，但一个讲 2FA、一个讲代理）→ **不算重复，保持独立**。');
  lines.push('');
  lines.push('### 3.4 形态为空的条目');
  lines.push('按「将来怎么找它」判形态，不要按「它长什么样」判。');
  lines.push('');

  /* ── 四、自由标签（用户重点要求）── */
  lines.push('## 四、自由标签的要求（本次任务重点）');
  lines.push('');
  lines.push('用户明确要求：**自由标签要尽量详细，并尽量跟其他条目区分开**。');
  lines.push('');
  lines.push('1. **从三个方向拆**：内容关键词 / 作用 / 注意事项。');
  lines.push('2. **避开泛词**。库里这些词已被用滥（附频次），靠它们找不到东西：');
  lines.push('');
  lines.push('   ```');
  lines.push(`   ${renderCommonWords(s.commonWords)}`);
  lines.push('   ```');
  lines.push('');
  lines.push('3. **给它独有词**。想「这条将来会因为什么被想起」，就把那个词打上。');
  lines.push('   - 差：`["npm","发布"]` —— 一堆条目都有；');
  lines.push('   - 好：`["npm","发布","2FA","Bypass token","Trusted Publishing"]`。');
  lines.push('');
  lines.push('4. 数量 1~20 个，**不含 `|`**；第一条优先放类别值（规矩/决策/交代/踩坑/纠正/流程…）。');
  lines.push('');

  /* ── 五、输出要求 ── */
  lines.push('## 五、输出要求');
  lines.push('');
  lines.push('每处理完一批，给一份**人读的报告**：');
  lines.push('');
  lines.push('```');
  lines.push('处理结果：');
  lines.push('- M-20261011-003  补标签  技能 + [npm,发布,2FA,Trusted Publishing]');
  lines.push('- M-20261012-007  归档    内容已被 M-20261116-011 覆盖');
  lines.push('- M-20261012-009  跳过    标签正常，无需改动');
  lines.push('```');
  lines.push('');
  lines.push('最后汇总：改了几条、归档几条、跳过几条。');
  lines.push('');
  lines.push(`**如果候选太多（本批 ${list.length} 条）**，先处理前 20 条并告诉我进度，别一次全做完。`);
  lines.push('');

  /* ── 六、候选清单 ── */
  lines.push(`## 六、本次候选清单（${list.length} 条）`);
  lines.push('');
  if (list.length === 0) {
    lines.push('（本次没有需要整理的条目——库很干净，什么都不用做。）');
  } else {
    lines.push('| 编号 | 当前形态 | 当前标签 | 问题 | 摘要 |');
    lines.push('|---|---|---|---|---|');
    for (const c of list) {
      lines.push(
        `| ${esc(c['编号'])} | ${esc(c['形态'] || '（空）')} | ${esc(renderTags(c['自由标签']))} | ` +
          `${esc(c['问题标签'] || (c['问题'] ?? []).map(issueLabel).join('、'))} | ${esc(c['摘要'])} |`,
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('统计：');
  lines.push(`- 库共 ${s.total ?? 0} 条，生效 ${s.active ?? 0} 条`);
  lines.push(`- 空标签 ${s.byIssue?.['empty-tags'] ?? 0} 条，噪声标签 ${s.byIssue?.['noise-tags'] ?? 0} 条，`);
  lines.push(`  形态为空 ${s.byIssue?.['empty-shape'] ?? 0} 条，疑似重复 ${s.byIssue?.duplicate ?? 0} 条（${s.duplicateGroups ?? 0} 组）`);

  return lines.join('\n');
}

/**
 * 渲染合并提示词。
 *
 * @param {object} args
 * @param {object} args.parsed   parseSource 的返回值
 * @param {string} [args.filename] 来源文件名（仅展示）
 * @param {Array<[string,number]>} [args.commonWords] 泛词频次
 * @param {{project?:string, agent?:string}} [args.currentView] 当前会话归属
 * @returns {string}
 */
export function renderMergePrompt({ parsed, filename = '', commonWords = [], currentView } = {}) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const candidates = Array.isArray(p.candidates) ? p.candidates : [];
  const warnings = Array.isArray(p.warnings) ? p.warnings : [];
  const fmtLabel = { csv: '本插件九列 CSV', markdown: 'Markdown', json: 'JSON', text: '纯文本（兜底切块）' };
  const lines = [];

  lines.push(HEADER_NOTE);
  lines.push('# 记忆库合并任务');
  lines.push('');
  lines.push(
    '你在把一份**外来记忆文件**并入 dsh-tag-memory 的记忆库。' +
      '本会话已加载该插件，`dtm_*` 工具可直接用，写入规则也已每轮注入。',
  );
  lines.push('');

  /* ── 一、来源信息 ── */
  lines.push('## 一、来源信息');
  lines.push('');
  lines.push(`- 文件：\`${esc(filename || '（未命名）')}\``);
  lines.push(`- 识别格式：**${fmtLabel[p.format] ?? p.format ?? '未知'}**`);
  lines.push(`- 解析出：**${candidates.length} 条**候选`);
  lines.push(`- 切分是否精确：**${p.exact === false ? '否' : '是'}**`);
  lines.push('');
  for (const w of warnings) {
    lines.push(`> ⚠️ ${w}`);
  }
  if (warnings.length > 0) lines.push('');

  /* ── 二、三条必须做的事（用户规则 1）── */
  lines.push('## 二、你必须做的三件事');
  lines.push('');
  lines.push(
    '**不论来源是什么格式／什么软件／什么智能体的记忆文件，都以记忆内容为主题。**' +
      '每条都要按**写入规则重新表达**，不是照搬原文：',
  );
  lines.push('');
  lines.push('### 1. 读懂内容');
  lines.push('先理解这条记忆在讲什么。**一条只记一件事**；如果原文混了几件事，**拆成多条分别写**。');
  lines.push('');
  lines.push('### 2. 判形态（6 选 1）');
  lines.push('单件事怎么做→`技能`；多件事次序→`流程`；必须/禁止→`规则`；');
  lines.push('喜欢/倾向→`偏好`；客观陈述→`事实`；可复用格式/清单→`模板`。');
  lines.push('判据是「**将来怎么找它**」，不是「它长什么样」。');
  lines.push('');
  lines.push('### 3. 打自由标签');
  lines.push('1~20 个离散实词，不含 `|`。从三方向拆：内容关键词 / 作用 / 注意事项。');
  lines.push('');
  lines.push('**本次重点：尽量详细，并尽量与其他条目区分开。**');
  lines.push('库里这些泛词已被用滥（附频次），别指望靠它们被找到：');
  lines.push('');
  lines.push('```');
  lines.push(`  ${renderCommonWords(commonWords)}`);
  lines.push('```');
  lines.push('');

  /* ── 三、不能改的字段（用户规则 2）── */
  lines.push('## 三、你不能改的字段（重要）');
  lines.push('');
  lines.push('| 字段 | 规则 |');
  lines.push('|---|---|');
  lines.push('| `项目` | **原样复制来源里的值**，不重新推断、不映射。来源为空 → `引入` |');
  lines.push('| `智能体` | **同上** |');
  lines.push('| `稳定性` | 一律 `观察`（首次落库规矩，不自称稳定） |');
  lines.push('| `时距` | 一律 `1`（写入初值） |');
  lines.push('| `状态` | 一律 `生效` |');
  lines.push('');
  lines.push(
    '`项目`/`智能体` 为什么必须原样复制：**归属是环境事实，不是模型的判断**。' +
      '一条记忆属于哪个项目／哪个身份，只有来源方知道，猜错会污染召回。',
  );
  lines.push('');
  if (currentView?.project || currentView?.agent) {
    lines.push(`当前会话的归属：项目=\`${esc(currentView.project || '（未知）')}\`，身份=\`${esc(currentView.agent || '（未绑定）')}\`。`);
    lines.push('**注意**：这不是让你把归属改成这个值，只是让你判断「来源归属是否与当前会话相同」（见第五节）。');
    lines.push('');
  }

  /* ── 四、执行方式（关键：dtm_write 会覆盖归属）── */
  lines.push('## 四、执行方式');
  lines.push('');
  lines.push('### 方式 A：用 `dtm_write` 逐条写（简单）');
  lines.push('对每条候选调一次 `dtm_write`：`主要内容` 按上面的规则重新表达，`形态` 你判，`自由标签` 你打。');
  lines.push('');
  lines.push('⚠️ **`项目`/`智能体` 由程序按当前会话填，你传不了也改不了。**');
  lines.push('所以**只有来源归属与当前会话相同（或来源归属为空）时才能用 A**，否则会静默写错归属。');
  lines.push('');
  lines.push('### 方式 B：先导出成九列 CSV 再 `dtm_merge`（保留原归属）');
  lines.push('1. 把每条整理成一行，九列：编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态；');
  lines.push('   - `项目`/`智能体` 填**来源里的原值**（空则 `引入`）；');
  lines.push('   - `自由标签` 用 `|` 分隔；`稳定性`=`观察`，`时距`=`1`，`状态`=`生效`；');
  lines.push('   - `编号` 用 M-YYYYMMDD-NNN 新号，别和库里已有的撞。');
  lines.push('2. 用 `dtm_export` 或文件工具写到数据目录内，再调 `dtm_merge` 该文件。');
  lines.push('');
  lines.push('**判断标准：来源的项目/身份 == 当前会话的（或为空）→ 用 A；不同 → 必须用 B。**');
  lines.push('');

  /* ── 五、输出要求 ── */
  lines.push('## 五、输出要求');
  lines.push('');
  lines.push('每写完一批给一份报告：');
  lines.push('');
  lines.push('```');
  lines.push(`已合并 12/${candidates.length}：`);
  lines.push('- 第 1 条 → 技能 + [npm,发布,2FA]');
  lines.push('- 第 2 条 → 规则 + [兜底,测试有效性]');
  lines.push('- 第 3 条：原文混了两件事，拆成两条');
  lines.push('```');
  lines.push('');
  lines.push('最后汇总：成功几条、跳过几条（及原因）、拆分成几条。');
  lines.push('');
  lines.push(`**如果候选太多（本次 ${candidates.length} 条）**，先处理前 20 条并告诉我进度。`);
  lines.push('');

  /* ── 六、候选内容 ── */
  lines.push(`## 六、候选内容（${candidates.length} 条）`);
  lines.push('');
  if (candidates.length === 0) {
    lines.push('（没解析出任何候选。请核对文件是否为空、格式是否正确。）');
  } else {
    for (const c of candidates) {
      lines.push(`### 第 ${c.seq} 条`);
      lines.push('');
      lines.push('```text');
      lines.push(safeBlock(c.raw));
      lines.push('```');
      const m = c.meta ?? {};
      lines.push('');
      lines.push(
        `来源归属：项目=${esc(m['项目'] || '（空）')}  身份=${esc(m['智能体'] || '（空）')}` +
          `${m['形态'] ? `  形态=${esc(m['形态'])}` : ''}` +
          `${(m['自由标签'] ?? []).length > 0 ? `  标签=${esc(renderTags(m['自由标签']))}` : ''}`,
      );
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('固定标签按写入规则执行；自由标签按写入规则写入，并做到尽量详细、可区分。');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 泛词频次渲染成一行；空表给明确说明而不是留白。 */
function renderCommonWords(words) {
  const arr = Array.isArray(words)
    ? words
        .filter((w) => Array.isArray(w) || typeof w === 'string')
        .slice(0, 10)
        .map((w) => (Array.isArray(w) ? `${w[0]}(${w[1]})` : String(w)))
    : [];
  return arr.length > 0 ? arr.join('  ') : '（库里暂无高频词，按写入规则正常打标签即可）';
}

/** 表格单元格转义：防止 | 和换行破坏 Markdown 表格。 */
function esc(v) {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 代码块内容：避免出现 ``` 提前闭合。 */
function safeBlock(v) {
  return String(v ?? '').replace(/```/g, '` ` `');
}
