/**
 * format.js — 把 engine / 宿主方法的返回值排成**模型可读**的文本
 *
 * 依据：《流程_读取》§4.4（返回格式带命中解释）、《流程_整理》§七（台账字段）、
 *       《功能说明》§7.4（真假查空必须区分）。
 *
 * ── 为什么单独一层 ───────────────────────────────────────────────
 *   engine 的职责是"返回结构化结果"，**面向模型的排版不属于 engine**
 *   （《接口契约》§一：engine 只返回该写什么）。所以排版收在 preset 这一层，
 *   一处改样式、十个工具同时生效。
 *
 * ── 一条硬纪律 ──────────────────────────────────────────────────
 *   引擎文案**不改写**。错误码、报错原文（尤其 TAG_CONTAINS_PIPE 的点名文案）
 *   一律照搬——重写措辞就会丢掉"哪个标签、为什么"这类关键信息。
 */

/** 摘要长度：模型瞥一眼就够，太长会挤占上下文（《流程_读取》§4.4 用前 60 字） */
const SUMMARY_CHARS = 60;

function clip(text, n = SUMMARY_CHARS) {
  const s = String(text ?? '').replace(/\r?\n/g, ' ');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ------------------------------------------------------------------ *
 * dtm_bind
 * ------------------------------------------------------------------ */

export function formatBindResult(bound) {
  const who = String(bound?.智能体 ?? '').trim();
  const project = String(bound?.项目 ?? '').trim();
  const parts = [];
  if (who) parts.push(`智能体=\`${who}\``);
  if (project) parts.push(`项目=\`${project}\``);

  return {
    text:
      `已绑定：${parts.join('，') || '（无）'}。\n` +
      '从现在起读写都用这个身份。名字要一直保持一致——改了就对不上旧记忆。',
  };
}

/* ------------------------------------------------------------------ *
 * dtm_write
 * ------------------------------------------------------------------ */

export function formatWriteResult(result) {
  const id = String(result?.id ?? result?.编号 ?? '').trim();
  // 宿主在返回值里已经带了 who（= 落库后的 智能体），直接读它。
  // 早先这里是第二个形参 identity.who，但调用方只传一个实参，
  // 导致归属行永远不输出——宿主那条 who 白算了。
  const who = String(result?.who ?? '').trim();

  const lines = [`已记下：${id || '（编号未返回）'}`];
  if (who) lines.push(`归属：智能体=\`${who}\``);
  if (result?.项目) lines.push(`项目：\`${result['项目']}\``);
  lines.push('（写入只追加；去重留给整理，不用再查一遍。）');

  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * dtm_recall
 * ------------------------------------------------------------------ */

/**
 * 召回结果排版。三条规格要求：
 *   ① 每条候选**必须带命中解释**（§4.4：没有解释的候选，模型无法判断可信度）
 *   ② 查空要区分**真查空 / 假查空**（§7.4）
 *   ③ **回显实际用的** `项目`/`智能体`（§二：名字写歪时能当场发现）
 */
export function formatRecallResult(result) {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const near = Array.isArray(result?.near) ? result.near : [];
  const echo = result?.echo ?? {};
  const browse = result?.browseMode === true;

  // 未绑定由宿主短路（host-dev：未绑定 → 返回空 + blocked），这里统一渲染
  if (result?.blocked === 'UNBOUND_IDENTITY') {
    return {
      code: 'UNBOUND_IDENTITY',
      text:
        '未绑定身份：召回返回空。\n' +
        '先问用户「这次会话我以什么名字负责」，拿到名字后调 `dtm_bind`，再重试。\n' +
        '（不知道我是谁，就连所有人都能看的条目也不读——避免串身份。）',
    };
  }

  const head =
    `查的是：项目=\`${echo['项目'] ?? '?'}\`，智能体=\`${echo['智能体'] ?? '?'}\`，形态=\`${echo['形态'] ?? '?'}\`` +
    (browse ? '（浏览模式：标签留空）' : '');

  if (hits.length === 0) {
    const kind = result?.empty;
    const isFalseEmpty = kind === 'false_but_near' || near.length > 0;

    if (isFalseEmpty) {
      // 假查空：库里**有**擦边条目，但没够上门槛
      const nearLines = near
        .map((n) => `  - ${n['编号']} 分=${n.score} e_ratio=${n.e_ratio}`)
        .join('\n');
      return {
        text:
          `${head}\n\n**假查空**：库里有擦边条目，但这次没够上返回门槛。\n` +
          (nearLines ? `擦边：\n${nearLines}\n` : '') +
          '\n按无返回正常继续，**不要「换个说法再试」**——反复重试只会堆词、照样查空。\n' +
          '要再找就：留空只按形态浏览、换形态、或调整标签。' +
          '\n（这次已记进台账，整理时会追根因。）',
      };
    }

    return {
      text:
        `${head}\n\n**真查空**：库里确实没有符合的条目。\n` +
        '按无返回继续即可；如果这件事值得留下，直接调 `dtm_write` 记一条。',
    };
  }

  const lines = [head, '', `命中 ${hits.length} 条：`];
  for (const h of hits) {
    const ex = h.explain ?? {};
    const why = [];
    if (ex.shapeHit) why.push('形态命中');
    if (Array.isArray(ex.tags) && ex.tags.length > 0) why.push(`标签(${ex.tags.join(', ')})`);
    if (typeof ex.e_ratio === 'number') why.push(`e_ratio=${ex.e_ratio}`);

    lines.push(`[${h['编号']}] 分=${h.score} 命中：${why.join('、') || '—'}`);
    lines.push(`  形态=${h['形态'] ?? '（空）'} 项目=${h['项目'] ?? '（空）'} 智能体=${h['智能体'] ?? '（空）'}`);
    lines.push(`  主要内容：${clip(h['主要内容'] ?? h['摘要'])}`);

    // 空值条目要标出来（《流程_读取》§五：空值不是黑名单，但要让模型知道）
    if (Array.isArray(h.blankFields) && h.blankFields.length > 0) {
      lines.push(`  ⚠️ 空值字段：${h.blankFields.join('、')}`);
    }
  }

  lines.push('');
  lines.push('（这些条目的时距会 +1。用完之后判断一下哪条真有用——整理时按这个演进稳定性。）');

  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * dtm_review
 * ------------------------------------------------------------------ */

export function formatListResult(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const total = result?.total ?? rows.length;

  if (rows.length === 0) {
    return { text: `没有符合条件的条目（共 ${total} 条匹配，本次返回 0 条）。` };
  }

  const lines = [`共 ${total} 条匹配，本次返回 ${rows.length} 条：`, ''];
  for (const r of rows) {
    lines.push(
      `[${r['编号']}] ${r['形态'] ?? '（空形态）'} · ${r['项目'] ?? '（空）'} · ${r['智能体'] ?? '（空）'} · ` +
        `${r['状态'] ?? '?'} · 稳定=${r['稳定性'] ?? '?'} · 时距=${r['时距'] ?? '?'}`,
    );
    lines.push(`  ${clip(r['主要内容'])}`);
    if (Array.isArray(r['自由标签']) && r['自由标签'].length > 0) {
      lines.push(`  标签：${r['自由标签'].join(' / ')}`);
    }
  }
  if (total > rows.length) {
    lines.push('', `（还有 ${total - rows.length} 条没显示，用 offset/limit 翻页。）`);
  }
  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * dtm_records
 * ------------------------------------------------------------------ */

const RECORDS_LABEL = { write: '写入台账', read: '读取台账', tidy: '整理台账' };

export function formatRecordsResult(result, kind) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const label = RECORDS_LABEL[kind] ?? kind;

  if (items.length === 0) {
    return { text: `${label}（records/${kind}.jsonl）里没有符合条件的记录。` };
  }

  const lines = [`${label}，最近 ${items.length} 条：`, ''];
  for (const it of items) {
    const ts = it.ts ?? '?';
    if (kind === 'write') {
      lines.push(`${ts} ${it.ok ? '✔' : '✘'} who=${it.who || '?'} ${it.id ? `id=${it.id}` : ''}`);
      lines.push(`  ${clip(it.summary, 40)}`);
      if (!it.ok) lines.push(`  失败原因：${it.reason ?? '?'}`);
    } else if (kind === 'read') {
      const cond = it.cond ?? {};
      lines.push(
        `${ts} who=${it.who || '?'} 项目=${cond['项目'] ?? '?'} 智能体=${cond['智能体'] ?? '?'} 形态=${cond['形态'] ?? '?'}`,
      );
      lines.push(
        `  total=${it.total ?? 0} filtered=${it.filtered ?? 0} passed=${it.passed ?? 0} ` +
          `hits=${Array.isArray(it.hits) ? it.hits.length : 0}`,
      );
      if (Array.isArray(it.near) && it.near.length > 0) lines.push(`  擦边：${it.near.join('；')}`);
    } else {
      lines.push(`${ts} ${it.action ?? '?'} who=${it.who || '?'} target=${it.target ?? '?'}`);
      if (it.basis) lines.push(`  依据：${it.basis}`);
      if (it.before !== undefined || it.after !== undefined) {
        lines.push(`  ${JSON.stringify(it.before)} → ${JSON.stringify(it.after)}`);
      }
    }
  }
  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * 整理类（supersede / archive / retag）
 * ------------------------------------------------------------------ */

const TIDY_VERB = {
  supersede: '已用新条顶替旧条',
  archive: '已归档',
  retag: '已改标签',
};

export function formatTidyResult(result, action) {
  const verb = TIDY_VERB[action] ?? '已完成';
  const id = String(result?.编号 ?? result?.id ?? '').trim();
  const oldId = String(result?.['旧编号'] ?? '').trim();

  const lines = [];
  if (action === 'supersede') {
    lines.push(`${verb}：旧条 ${oldId || '?'} → 新条 ${id || '?'}`);
    lines.push('两条都留在库里（行不删），读取时会跳过被取代的那条。');
  } else {
    lines.push(`${verb}：${id || '?'}`);
    lines.push('行没删，以后翻得回来。读取时会跳过它。');
  }

  if (result?.backupPath) lines.push(`改库前已自动备份：${result.backupPath}`);

  if (action === 'retag') {
    const changed = result?.changed ?? result?.after;
    if (changed && typeof changed === 'object') {
      const pairs = Object.entries(changed)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      if (pairs.length > 0) lines.push(`改成了：${pairs.join('，')}`);
    }
    lines.push('（这次改动已记进整理台账，附了依据。）');
  }

  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * dtm_export / dtm_merge
 * ------------------------------------------------------------------ */

export function formatExportResult(result) {
  const lines = [
    `已导出 ${result?.count ?? '?'} 条记忆到：`,
    String(result?.path ?? '（路径未返回）'),
  ];
  if (result?.bytes) lines.push(`（${result.bytes} 字节。库本体就是 CSV，可直接打开或交接。）`);
  else lines.push('（库本体就是 CSV，可直接打开或交接。）');
  return { text: lines.join('\n') };
}

export function formatMergeResult(result, dryRun) {
  const verb = dryRun ? '将要' : '已';
  const lines = [`${verb}合并：变更 ${result?.changed ?? 0} 条，新增 ${result?.added ?? 0} 条。`];

  if (dryRun) {
    lines.push('（dryRun：没有落盘。）');
  } else {
    lines.push(
      result?.backupPath
        ? `合并前已自动备份：${result.backupPath}`
        : '（合并前已自动备份，见 backup/ 目录。）',
    );
  }
  // conflicts 在预演与正式里都要可见（《记忆合并规则》§1 末行）。
  if (Number(result?.conflicts) > 0) {
    lines.push(
      `冲突 ${result.conflicts} 条：同号保留较新的那条。` +
        '聚合不掉的重复留给整理按相似度归并。',
    );
  }

  // §4.3 字段口径体检：纯只读报告，不自动改任何字段。工具与 UI 共用同一份数据。
  const a = result?.fieldAudit;
  if (a && typeof a === 'object') {
    lines.push('');
    lines.push('字段口径体检（只报告，不自动改）：');
    lines.push(
      `- 扫描 ${a.scanned ?? 0} 条：项目名 ${a.distinctProjects ?? 0} 种 / 身份名 ${a.distinctAgents ?? 0} 种；` +
        `空标签 ${a.blanks?.['自由标签'] ?? 0} 条；` +
        `噪声标签 纯数字 ${a.noiseTags?.numeric ?? 0} / 来源标记 ${a.noiseTags?.sourceMark ?? 0} 个。`,
    );
    lines.push(`- 疑似重复 ${a.suspiciousDuplicateGroups ?? 0} 组（编号不同但内容逐字相同）。`);
    for (const s of Array.isArray(a.suggestions) ? a.suggestions : []) lines.push(`- ${s}`);
  }

  return { text: lines.join('\n') };
}
