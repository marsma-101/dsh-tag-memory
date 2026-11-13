/**
 * core.mjs — 序列化层（CSV/RFC4180）+ 标签单元格 + 记录映射
 *            + 编号 M-YYYYMMDD-NNN + 文件锁 + 路径解析 + 文件读写薄封装
 *
 * 边界（《接口契约》§一）：
 *   - 不 import 任何 Cordis / DSH 东西，不碰 ctx
 *   - 不写 records/*.jsonl，只返回"该写什么"
 *   - 取值域全部来自入参 schema（templates/schema.json），不硬编码
 *
 * 本文件是 CSV 的唯一实现（《接口契约》Q3）：host 只调用，不重写解析。
 *
 * 时钟可注入：所有涉及"现在几点"的函数都接受 now 参数（默认 new Date()），
 * 便于测试 UTC 跨零点错天这类场景（qa C6）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * 一、CSV 标量层（RFC4180）
 * ------------------------------------------------------------------ */

/**
 * 判断一个字段落盘时是否必须用双引号包裹。
 * 凡是含 , " CR LF 的必须包（否则列会错位）；首尾空白也包，保证往返后空白不丢。
 */
export function needsQuote(value) {
  const v = String(value ?? '');
  if (v === '') return false;
  return v.includes(',') || v.includes('"') || v.includes('\r') || v.includes('\n') || /^\s|\s$/.test(v);
}

/**
 * 序列化单个字段（含转义）。内部 " 写成 ""。
 */
export function formatCsvField(value) {
  const v = String(value ?? '');
  if (!needsQuote(v)) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * 序列化一行（不含行尾换行）。
 */
export function formatCsvRow(cells) {
  return Array.from(cells ?? [], (c) => formatCsvField(c)).join(',');
}

/**
 * 序列化整表。header 必填（表头必须存在，程序按列名定位）。
 * 行尾统一 \r\n（RFC4180），解析侧两者都吃。
 */
export function serializeCsv({ header, rows, eol = '\r\n' } = {}) {
  if (!Array.isArray(header) || header.length === 0) {
    throw new Error('serializeCsv: header 必填且不能为空数组');
  }
  const out = [formatCsvRow(header)];
  for (const row of rows ?? []) out.push(formatCsvRow(row));
  return out.join(eol) + eol;
}

/**
 * RFC4180 解析器。**绝对不能用 split(',')** ——
 * 正文含一个 ASCII 逗号就会把 9 列变 10 列（《待查证问题》问题 4 实测）。
 *
 * 支持：引号包裹、内部 "" 转义、字段内的 , 与 CR/LF、CRLF / LF 混排、BOM、末尾无换行。
 *
 * 返回 { header, rows, errors }：
 *   header = 第一行（无表头时为 null）
 *   rows   = 数据行（不含表头），每行是 string[]
 *   errors = EngineError[]（结构性问题：引号未闭合、列数不符）
 */
export function parseCsv(text) {
  const errors = [];
  let src = typeof text === 'string' ? text : String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // 剥 BOM

  const allRows = [];
  let cells = [];
  let cell = '';
  let fieldQuoted = false; // 当前字段是否出现过引号包裹
  let inQuotes = false;
  let rowHadQuote = false;
  let quoteOpenLine = 1;
  let line = 1;
  let i = 0;

  const closeField = () => {
    cells.push(cell);
    cell = '';
    fieldQuoted = false;
  };

  const closeRow = () => {
    closeField();
    // 纯空行（既无内容也无引号）不算一条记录
    const isBlank = cells.length === 1 && cells[0] === '' && !rowHadQuote;
    if (!isBlank) allRows.push(cells);
    cells = [];
    rowHadQuote = false;
  };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'; // "" -> 一个 "
          i += 2;
          continue;
        }
        inQuotes = false; // 引号段结束
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1; // 字段内换行：原样保留，同时推进行号便于报错
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && cell === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      rowHadQuote = true;
      quoteOpenLine = line;
      i += 1;
      continue;
    }

    if (ch === ',') {
      closeField();
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      closeRow();
      if (ch === '\r' && src[i + 1] === '\n') i += 2;
      else i += 1;
      line += 1;
      continue;
    }

    // 未加引号字段中间的 " 按字面量收下（读侧宽容，写侧一定加引号）
    cell += ch;
    i += 1;
  }

  if (inQuotes) {
    errors.push({
      code: 'CSV_UNTERMINATED_QUOTE',
      field: null,
      message: `第 ${quoteOpenLine} 行起的引号字段到文件结束仍未闭合。`,
      detail: { line: quoteOpenLine },
    });
  }

  if (cell !== '' || cells.length > 0 || fieldQuoted) closeRow();

  const header = allRows.length > 0 ? allRows[0] : null;
  const rows = allRows.length > 1 ? allRows.slice(1) : [];

  if (header) {
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length !== header.length) {
        errors.push({
          code: 'ROW_CELL_COUNT',
          field: null,
          message:
            `第 ${r + 1} 条数据行有 ${rows[r].length} 格，表头是 ${header.length} 列。` +
            '（正文含未转义的逗号就会出现这种 9 列变 10 列）',
          detail: { row: r, cells: rows[r].length, expected: header.length },
        });
      }
    }
  }

  return { header, rows, errors };
}

/* ------------------------------------------------------------------ *
 * 二、自由标签单元格（全项目里唯一知道 "|" 语义的地方）
 * ------------------------------------------------------------------ */

/**
 * 标签数组 -> 单元格。join('|')。
 */
export function tagsToCell(tags) {
  return Array.from(tags ?? [], (t) => String(t).trim())
    .filter((t) => t !== '')
    .join('|');
}

/**
 * 单元格 -> 标签数组。split('|')，滤空、trim、去重保序。
 * 注意：标签内不得含 "|"，那是写入校验（write.mjs TAG_CONTAINS_PIPE）的事；
 * 读侧看到含 "|" 的值只会被切分成多个标签（这正是要拒写的原因）。
 */
export function tagCellToArray(cell) {
  const raw = typeof cell === 'string' ? cell : String(cell ?? '');
  if (raw === '') return [];
  const out = [];
  const seen = new Set();
  for (const piece of raw.split('|')) {
    const t = piece.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 三、表头定位与记录映射（按列名定位，列序变了也能读）
 * ------------------------------------------------------------------ */

/**
 * 按列名求索引。返回 { index: {列名: 下标}, missing: string[] }。
 */
export function resolveColumnIndex(header, schema) {
  const index = {};
  const missing = [];
  const head = Array.isArray(header) ? header.map((h) => String(h).trim()) : [];
  for (const col of schema.columns) {
    const at = head.indexOf(col);
    if (at === -1) missing.push(col);
    else index[col] = at;
  }
  return { index, missing };
}

/**
 * 一行单元格 -> Record。数值列转整数，自由标签转数组。
 * 空值不丢：项目/智能体为空照原样保留 ''（由读取侧按《流程_读取》§五 当 通用 并标记）。
 */
export function cellsToRecord(cells, columnIndex) {
  const errors = [];
  const get = (col) => {
    const at = columnIndex[col];
    return at === undefined ? '' : String(cells[at] ?? '');
  };

  const tickRaw = get('时距').trim();
  let tick = 0;
  if (tickRaw !== '') {
    const n = Number(tickRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      errors.push({
        code: 'TICK_INVALID',
        field: '时距',
        message: `时距 必须是整数，实际是「${tickRaw}」，按 0 处理。`,
        detail: { value: tickRaw },
      });
      tick = 0;
    } else {
      tick = n;
    }
  }

  return {
    record: {
      编号: get('编号').trim(),
      主要内容: get('主要内容'),
      形态: get('形态').trim(),
      项目: get('项目').trim(),
      智能体: get('智能体').trim(),
      自由标签: tagCellToArray(get('自由标签')),
      稳定性: get('稳定性').trim(),
      时距: tick,
      状态: get('状态').trim(),
    },
    errors,
  };
}

/**
 * Record -> 一行单元格。自由标签 join('|')，时距写十进制整数。
 */
export function recordToCells(record, schema) {
  return schema.columns.map((col) => {
    const v = record?.[col];
    if (col === '自由标签') return tagsToCell(v);
    if (col === '时距') return String(Number(v ?? 0) || 0);
    return String(v ?? '');
  });
}

/**
 * 解析结果 -> Record[]。表头缺失即报 HEADER_MISSING 并返回空（表头必须存在）。
 * 行列数不符的行已由 parseCsv 记 ROW_CELL_COUNT，这里仍按列名尽力取（缺的按 ''）。
 */
export function rowsToRecords(parsed, schema) {
  const errors = [];
  const { header, rows, errors: parseErrors } = parsed ?? {};
  errors.push(...(parseErrors ?? []));

  if (!header) {
    errors.push({
      code: 'HEADER_MISSING',
      field: null,
      message: '记忆库缺少表头行（第一行必须是列名），无法按列名定位。',
      detail: { expected: schema.columns },
    });
    return { records: [], errors };
  }

  const { index, missing } = resolveColumnIndex(header, schema);
  if (missing.length > 0) {
    errors.push({
      code: 'HEADER_MISSING',
      field: null,
      message: `表头缺少列：${missing.join('、')}。必须 9 列齐全（顺序可变，列名必须对）。`,
      detail: { missing, header },
    });
    return { records: [], errors };
  }

  const records = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 0) continue;
    const { record, errors: rowErrors } = cellsToRecord(cells, index);
    for (const e of rowErrors) {
      e.detail = { ...(e.detail ?? {}), row: r };
      errors.push(e);
    }
    records.push(record);
  }

  return { records, errors };
}

/* ------------------------------------------------------------------ *
 * 四、编号 M-YYYYMMDD-NNN
 *    全部可注入 now：本地时间取日期（不用 toISOString，跨零点会错天）
 * ------------------------------------------------------------------ */

/**
 * Date -> 'YYYYMMDD'，按**本地时间**。
 * 反例（qa C6）：2026-11-05T17:00:00Z 在 +08 已是 11-06 凌晨，
 * 用 toISOString 会得到 20261105（错天），本地时间才是入库当天。
 */
export function formatLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('formatLocalDate: 无效日期');
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Date -> 带本地时区偏移的 ISO 字符串，如 2026-11-05T20:57:37+08:00。
 * records/*.jsonl 的 ts 字段用这个（《流程_写入》§六要求"本地时间，ISO 格式"）。
 * 不用 toISOString()——那个是 UTC。
 */
export function localIsoString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('localIsoString: 无效日期');
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset(); // 分钟，东八区 = 480
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

const ID_RE = /^M-(\d{8})-(\d{3,})$/;

/**
 * 解析编号。返回 { date:'YYYYMMDD', seq:number } 或 null。
 */
export function parseId(id) {
  const m = ID_RE.exec(String(id ?? '').trim());
  if (!m) return null;
  return { date: m[1], seq: Number(m[2]) };
}

export function isValidId(id) {
  return parseId(id) !== null;
}

/**
 * 取当天下一个编号：扫已有编号里同日期前缀的最大序号 +1，3 位补零。
 * existingIds 传整库编号即可（只挑当天前缀的）。
 *
 * @param {string[]} existingIds
 * @param {Date} now  可注入时钟
 */
export function nextId(existingIds, now = new Date()) {
  const date = formatLocalDate(now);
  let maxSeq = 0;
  for (const id of existingIds ?? []) {
    const parsed = parseId(id);
    if (parsed && parsed.date === date && parsed.seq > maxSeq) maxSeq = parsed.seq;
  }
  const seq = String(maxSeq + 1).padStart(3, '0');
  return `M-${date}-${seq}`;
}

/* ------------------------------------------------------------------ *
 * 五、数据目录解析（4 级优先级，纯函数，不碰文件系统）
 * ------------------------------------------------------------------ */

/** 数据目录在 `$DSH_HOME` 下的固定子目录名（跨平台一致，不含版本号）。 */
export const DATA_DIR_NAME = 'tag-memory';

/**
 * 按《架构说明》§六 的优先级决定数据目录（5 级）：
 *   ① config.dataDir（profile 补丁里写死的）
 *   ② 环境变量 DSH_TAG_MEMORY_DATA_DIR
 *   ③ 设置页选的（<插件包>/config/data-dir.json 里的值）
 *   ④ `$DSH_HOME/tag-memory`（用户级默认，跨平台；见下）
 *   ⑤ `<插件包>/data`（**最后手段**，会随 pnpm 重装被删，必须告警）
 *
 * 返回 { dir, source }。source ∈ 'config'|'env'|'settings'|'dsh-home'|'package'，
 * 供 UI 判断"搬家为什么不生效"并说明改哪一行（① ② 优先级高于 ③）。
 *
 * ⚠️ 为什么 ④ 是 `$DSH_HOME/tag-memory` 而不是 `<插件包>/data`（2026-11-06 改）：
 *   插件包目录会被 pnpm 重装/升级整个删掉，把**用户数据**默认放进去等于随时可能丢。
 *   而且 Docker 容器里 `DSH_HOME=/opt/dsh`、宿主机默认 `~/.dsh`，两边各自落在
 *   `/opt/dsh/tag-memory` 与 `<home>/.dsh/tag-memory`——**自然对齐，不需要在
 *   bundle 补丁里写死任何绝对路径**。之前写死 `/opt/dsh/tag-memory` 的做法在
 *   Windows 上会静默指向不存在的路径（`pick()` 只判非空、不判存在），更危险。
 *
 * 本函数**不读 process.env**（引擎纯度约束，见 tests/engine/purity.j.test.mjs）：
 * `dshHomeDir` 由宿主解析好后传入。`packageDir` 仍保留为最后手段以兼容
 * 「连 DSH_HOME 都拿不到」的极端场景。
 */
export function resolveDataDir({ configDir, envDir, settingsDir, dshHomeDir, packageDir } = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const c = pick(configDir);
  if (c) return { dir: c, source: 'config' };
  const e = pick(envDir);
  if (e) return { dir: e, source: 'env' };
  const s = pick(settingsDir);
  if (s) return { dir: s, source: 'settings' };
  const home = pick(dshHomeDir);
  if (home) return { dir: path.join(home, DATA_DIR_NAME), source: 'dsh-home' };
  const base = pick(packageDir);
  if (!base) throw new Error('resolveDataDir: dshHomeDir 与 packageDir 至少要给一个（④⑤ 兜底依赖它）');
  return { dir: path.join(base, 'data'), source: 'package' };
}

/**
 * 数据目录内的固定布局。engine 只描述位置，不创建。
 */
export function layoutOf(dataDir) {
  return {
    dataDir,
    storeDir: path.join(dataDir, 'store'),
    libraryCsv: path.join(dataDir, 'store', 'memory.csv'),
    recordsDir: path.join(dataDir, 'records'),
    backupDir: path.join(dataDir, 'backup'),
    settingsFile: path.join(dataDir, 'settings.json'),
    lockFile: path.join(dataDir, 'store', '.memory.lock'),
  };
}

/* ------------------------------------------------------------------ *
 * 六、文件锁（Q5：取号必须在锁内，并发写不能撞号）
 * ------------------------------------------------------------------ */

/**
 * 简易单写者文件锁。以 O_EXCL 原子创建锁文件实现。
 *
 * staleness：锁文件存在但 mtime 早于 staleMs 视为残留（进程崩了没删），可以抢占。
 *
 * ── 2026-11-12 修复（容器审查 P0-1）：抢占必须原子，释放必须验归属 ──
 * 旧实现注释承诺「rename 抢占」，实际却是 stat→unlink→continue：
 *   A、B 同时判 stale → A unlink 后 wx 持锁 → B 再 unlink 删掉 A 的新锁 → B 也 wx 持锁
 *   → 两者同进临界区（撞号/整库互覆）。且 finally 无条件 unlink 会删掉抢占者的锁。
 * 现在三件事一起堵住：
 *   ① 抢占用 rename 到**唯一目标名**：同一源文件只有一个 racer 的 rename 成功，
 *      其余得 ENOENT。rename 后再验被搬文件的 mtime——若它是新鲜的（说明在
 *      stat 与 rename 之间被人重建/续期了），立刻搬回去，绝不吞掉活锁。
 *   ② 锁内容写 `token`（pid+时间+随机），释放前读回校验：**只删自己的锁**。
 *   ③ 临界区内定期 utimes 续期：大库重写/慢盘超过 staleMs 也不会被当残留抢走。
 * 残留窗口（诚实声明）：三个以上 racer 在「stat 判 stale」与「rename」之间恰好
 * 交错重建锁，仍可能短暂双持——这是 mtime 锁的固有边界（proper-lockfile 同款），
 * 但续期让活锁几乎永不显 stale，实际只在真崩溃残留时才走抢占路径。
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn 临界区
 * @param {{ staleMs?: number, retryMs?: number, timeoutMs?: number }} [opts]
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const { staleMs = 30_000, retryMs = 15, timeoutMs = 10_000 } = opts;
  const started = Date.now();
  // 每次获取唯一 token：写进锁文件，释放前据此验归属。
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let fd = null;
  let renewTimer = null;
  const isStale = (mtimeMs) => Date.now() - mtimeMs > staleMs;

  for (;;) {
    try {
      fd = await fsp.open(lockPath, 'wx');
      await fd.writeFile(`${token} ${new Date().toISOString()}\n`, 'utf8');
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;

      // 锁已被占：判断是否为残留
      let st = null;
      try {
        st = await fsp.stat(lockPath);
      } catch (e) {
        if (e && e.code === 'ENOENT') continue; // 刚被释放，重试
        throw e;
      }
      if (isStale(st.mtimeMs)) {
        // 原子抢占：rename 到唯一目标名。同源只有一个 racer 成功，其余 ENOENT。
        const claim = `${lockPath}.stale.${token}`;
        try {
          await fsp.rename(lockPath, claim);
        } catch (e) {
          if (e && e.code === 'ENOENT') continue; // 别人先抢/先放了，重试
          throw e;
        }
        // 验被搬文件的新鲜度：若它在 stat→rename 间隙被重建/续期，搬回去，不吞活锁。
        let claimed = null;
        try {
          claimed = await fsp.stat(claim);
        } catch {
          /* 被搬文件已消失，直接重试 */
        }
        if (claimed && !isStale(claimed.mtimeMs)) {
          try {
            await fsp.rename(claim, lockPath); // 还回去
          } catch {
            // 已有新锁占位：我们搬走的是活锁副本，留着不动（删了反而毁掉持锁者的文件）
          }
          // 落到下方超时/退避，不 continue 抢建
        } else {
          try {
            await fsp.unlink(claim); // 确属残留，清掉
          } catch {
            /* 已删忽略 */
          }
          continue; // 现在去 wx 建自己的锁
        }
      }
      if (Date.now() - started > timeoutMs) {
        const e = new Error(`获取文件锁超时（${timeoutMs}ms）：${lockPath}`);
        e.code = 'LOCK_TIMEOUT';
        throw e;
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  // 续期：临界区内定期 touch mtime，慢重写不会被误判残留。unref 不阻塞退出。
  renewTimer = setInterval(() => {
    const now = new Date();
    fsp.utimes(lockPath, now, now).catch(() => {});
  }, Math.max(1000, Math.floor(staleMs / 3)));
  if (typeof renewTimer.unref === 'function') renewTimer.unref();

  try {
    return await fn();
  } finally {
    clearInterval(renewTimer);
    try {
      await fd.close();
    } catch {
      /* 已关闭忽略 */
    }
    // 验归属再删：只删 token 仍是自己的锁，绝不删抢占者重建的锁。
    try {
      const content = await fsp.readFile(lockPath, 'utf8');
      if (content.startsWith(`${token} `)) {
        await fsp.unlink(lockPath);
      }
    } catch {
      /* 已不存在忽略 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 七、文件读写薄封装（host 只调这些，不自己拼 CSV）
 * ------------------------------------------------------------------ */

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 读整库。文件不存在 → 视为空库（records: []），不报错。
 * 返回 { records, raw, hadHeader, errors }。
 */
export async function readLibraryCsv(filePath, schema) {
  const raw = await readTextIfExists(filePath);
  if (raw === null) {
    return { records: [], raw: '', hadHeader: false, errors: [] };
  }
  const parsed = parseCsv(raw);
  const { records, errors } = rowsToRecords(parsed, schema);
  return { records, raw, hadHeader: Boolean(parsed.header), errors };
}

/**
 * 追加一条记录。文件不存在则先写表头（表头必须存在）。
 * **只追加，绝不重写旧行。**
 */
export async function appendRecordCsv(filePath, record, schema) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const exists = (await readTextIfExists(filePath)) !== null;
  let prefix = '';
  if (!exists) {
    prefix = serializeCsv({ header: schema.columns, rows: [] });
  } else {
    const raw = await fsp.readFile(filePath, 'utf8');
    // 文件末尾若没有换行，先补一个，否则新行会粘到最后一行上
    if (raw !== '' && !/[\r\n]$/.test(raw)) prefix = '\r\n';
    else if (raw === '') prefix = serializeCsv({ header: schema.columns, rows: [] });
  }

  const line = formatCsvRow(recordToCells(record, schema)) + '\r\n';
  await fsp.appendFile(filePath, prefix + line, 'utf8');
  return { appended: true, line };
}

/**
 * 按 编号 整行替换（整理路径：改状态/标签用）。找不到则返回 { replaced:false }。
 */
export async function replaceRecordCsv(filePath, record, schema) {
  const raw = await readTextIfExists(filePath);
  if (raw === null) return { replaced: false, reason: 'FILE_MISSING' };

  const parsed = parseCsv(raw);
  const { index, missing } = resolveColumnIndex(parsed.header ?? [], schema);
  if (missing.length > 0) {
    return { replaced: false, reason: 'HEADER_MISSING', missing };
  }

  const target = String(record?.['编号'] ?? '').trim();
  let hit = false;
  const rows = parsed.rows.map((cells) => {
    const id = String(cells[index['编号']] ?? '').trim();
    if (id !== target) return cells;
    hit = true;
    return recordToCells(record, schema);
  });

  if (!hit) return { replaced: false, reason: 'ID_NOT_FOUND' };

  const text = serializeCsv({ header: schema.columns, rows });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath); // 原子替换，避免写一半的文件
  return { replaced: true, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 全量重写（迁移 / 合并 / 时距批量落盘用）。
 */
export async function writeLibraryCsv(filePath, records, schema) {
  const rows = (records ?? []).map((r) => recordToCells(r, schema));
  const text = serializeCsv({ header: schema.columns, rows });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
  return { bytes: Buffer.byteLength(text, 'utf8'), count: rows.length };
}

/**
 * 追加一条 JSONL（records/*.jsonl）。只追加。
 * engine 不决定记什么，只负责把它写下去——"该记什么"由各流程函数返回。
 *
 * ── 2026-11-12 修复（容器审查 P1-5）：只读最后 1 字节判换行 ──────────
 * 旧实现为判断「末尾有没有换行」每次 append 都 readTextIfExists 读**整个文件**，
 * 于是单次召回成本随历史线性增长、总体 O(N²)。台账只追加、从不回读全文，
 * 这里只需知道最后一个字节是不是 \n / \r——用 fd 定位末尾读 1 字节即可。
 */
export async function appendJsonl(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let needsNewline = false;
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'a+');
    const { size } = await fh.stat();
    if (size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      const last = buf[0];
      needsNewline = last !== 0x0a && last !== 0x0d; // \n / \r
    }
    await fh.write((needsNewline ? '\n' : '') + JSON.stringify(obj) + '\n');
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return { appended: true };
}

/**
 * 读 JSONL，逐行 JSON.parse。坏行跳过并记进 errors（不因一行坏掉整份记录不可读）。
 */
export async function readJsonl(filePath) {
  const raw = await readTextIfExists(filePath);
  if (raw === null) return { items: [], errors: [] };
  const items = [];
  const errors = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      items.push(JSON.parse(line));
    } catch (err) {
      errors.push({
        code: 'JSONL_BAD_LINE',
        field: null,
        message: `第 ${i + 1} 行不是合法 JSON，已跳过。`,
        detail: { line: i + 1, raw: line.slice(0, 120) },
      });
    }
  }
  return { items, errors };
}

