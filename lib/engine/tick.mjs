/**
 * tick.mjs — 时距后台累加
 *
 * 依据：《流程_读取》§六。
 *
 * 规则：
 *   - 一条记忆**被这次读取返回**时，它的 `时距` +1
 *   - **其余条目完全不动**——没被调用就不改数
 *   - 上限 tickCap（出厂 10）封顶
 *   - 累加走后台队列，召回时只往队列追加一行，后台慢慢消费；
 *     **上一轮没做完不会叠下一轮**
 *
 * 边界：本文件只算「该变成几」，不改文件。落盘由 host 调 core.writeLibraryCsv。
 *
 * ⚠️ 两个「10」别混：
 *   - 本文件的 tickCap = 10 → **时距字段值上限**（计数器封顶）
 *   - scoring.json 的 weights.tickMaxScore = 10 → **打分权重上限**（read.mjs 用）
 *   含义完全不同，整理调参时只该动前者以外的东西（时距分不参与调整）。
 */

/**
 * 对若干编号的条目 +1，其余条目原样返回（**不改、不新建**）。
 *
 * @param {object[]} records
 * @param {string[]} ids       本次被召回返回的编号
 * @param {{ cap?: number }} [opts]
 * @returns {{ records: object[], changed: Array<{编号:string, before:number, after:number}>, capped: string[] }}
 */
export function applyTick(records, ids, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : 10;
  const targets = new Set(Array.from(ids ?? [], (id) => String(id ?? '').trim()).filter((id) => id !== ''));

  const changed = [];
  const capped = [];

  const next = (records ?? []).map((record) => {
    const id = String(record?.['编号'] ?? '').trim();
    if (!targets.has(id)) return record; // 没被召回：一个字段都不动

    const before = Number(record['时距']);
    const safeBefore = Number.isFinite(before) && before >= 0 ? before : 0;

    if (safeBefore >= cap) {
      capped.push(id);
      return record; // 已封顶，不动
    }

    const after = safeBefore + 1;
    changed.push({ 编号: id, before: safeBefore, after });
    return { ...record, 时距: after };
  });

  return { records: next, changed, capped };
}

/**
 * 时距累加队列。
 *
 * 设计要点（《流程_读取》§六）：「上一轮没做完不会叠下一轮」——
 * drain() 在 isRunning 时不再启动第二次消费，只是把新编号合进 pending 或排到下一轮，
 * 避免同一编号被并发 +1 两次。
 *
 * flush(ids) 由 host 提供：在锁内读表 → applyTick → writeLibraryCsv → 追加 read/tick 记录。
 *
 * @param {{
 *   cap?: number,
 *   flush: (ids:string[]) => Promise<void>|void,
 *   onError?: (err:unknown)=>void,
 * }} opts
 */
export function createTickQueue({ cap = 10, flush, onError } = {}) {
  /** @type {Set<string>} */
  let pending = new Set();
  let running = false;
  let rerun = false;

  const takeAll = () => {
    const ids = Array.from(pending);
    pending = new Set();
    return ids;
  };

  async function drain() {
    if (running) {
      // 上一轮没做完：标记需要再来一轮，**不并发**
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        const ids = takeAll();
        if (ids.length === 0) break;
        try {
          await flush(ids, { cap });
        } catch (err) {
          if (typeof onError === 'function') onError(err);
          else console.error('[tick] flush 失败：', err);
        }
      } while (rerun || pending.size > 0);
    } finally {
      running = false;
    }
  }

  return {
    /** 追加一批待 +1 的编号（召回后调这个，立即返回，不阻塞） */
    push(ids) {
      for (const id of Array.from(ids ?? [])) {
        const t = String(id ?? '').trim();
        if (t !== '') pending.add(t);
      }
      return pending.size;
    },
    drain,
    /** 内部：取出并清空 pending（host 单测可能想直接看） */
    _takeAll: takeAll,
    get pendingSize() {
      return pending.size;
    },
    get isRunning() {
      return running;
    },
  };
}
