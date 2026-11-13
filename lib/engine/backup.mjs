/**
 * backup.mjs — 备份 / 校验（整理前置，无开关必须做）
 *
 * 依据：《流程_整理》§〇。
 *
 *   备份 → 校验（字节数 + 记录数）→ 通过才允许整理 → 不通过则中止并报错
 *
 * **这一步没有开关，不能跳过。** 整理是唯一会改动已有行的环节，
 * 改错没有回滚点就等于数据丢失。
 *
 * 边界：本文件只管"复制 + 校验 + 列出备份"，不含整理逻辑本身。
 * 产物落 <dataDir>/backup/，文件名带时间戳，**绝不覆盖旧的**。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readLibraryCsv } from './core.mjs';

/**
 * 时间戳文件名片段：20261105-205737（本地时间，便于人看）。
 */
export function backupStamp(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 备份记忆库 + 校验。
 *
 * 校验两条（《流程_整理》§〇）：字节数、记录数。
 * 任一不符 → { ok:false }，调用方**必须中止整理**。
 *
 * @param {{
 *   libraryCsv: string,     // 源：<dataDir>/store/memory.csv
 *   backupDir: string,      // 目标：<dataDir>/backup/
 *   schema: object,
 *   now?: Date,             // 可注入时钟（文件名可复现）
 *   suffix?: string,        // 同名冲突时的区分后缀（如 '-tidy'）
 *   keep?: number,          // 保留最近多少份备份（默认 30，0=不清理）。2026-11-12 P1-5
 * }} args
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, records?:number, errors:Array}>}
 */
export async function backupLibrary({ libraryCsv, backupDir, schema, now = new Date(), suffix = '', keep = 30 } = {}) {
  const errors = [];

  let srcBytes;
  try {
    const st = await fsp.stat(libraryCsv); // 不存在会抛 ENOENT，统一走下面的失败分支
    srcBytes = st.size;
    if (!st.isFile()) throw new Error('不是普通文件');
  } catch (err) {
    return {
      ok: false,
      errors: [{ code: 'BACKUP_SOURCE_MISSING', field: null, message: `备份失败：找不到记忆库 ${libraryCsv}`, detail: { err: String(err) } }],
    };
  }

  // 记录数以"解析出的条数"为准（不是数行）——正文里的换行会影响行数
  const before = await readLibraryCsv(libraryCsv, schema);
  const srcRecords = before.records.length;

  await fsp.mkdir(backupDir, { recursive: true });

  const base = `memory-${backupStamp(now)}${suffix}`;
  const raw = await fsp.readFile(libraryCsv);

  // 绝不覆盖旧的：用 O_EXCL（wx）原子创建，已存在就换名重试。
  // 2026-11-12（P1-5 / P2 备份抢占非原子）：旧实现 access→writeFile 有竞态，
  // 两进程可同名互覆，违背「绝不覆盖旧的」。wx 把「检查+创建」合成一步原子操作。
  let target = path.join(backupDir, `${base}.csv`);
  let n = 0;
  for (;;) {
    try {
      await fsp.writeFile(target, raw, { flag: 'wx' });
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        n += 1;
        target = path.join(backupDir, `${base}-${n}.csv`);
        continue;
      }
      throw err;
    }
  }

  // ---- 校验 1：字节数 ----
  const dstStat = await fsp.stat(target);
  if (dstStat.size !== srcBytes) {
    errors.push({
      code: 'BACKUP_SIZE_MISMATCH',
      field: null,
      message: `备份校验失败：源 ${srcBytes} 字节，副本 ${dstStat.size} 字节，不一致，已中止整理。`,
      detail: { srcBytes, dstBytes: dstStat.size, path: target },
    });
  }

  // ---- 校验 2：记录数 ----
  const after = await readLibraryCsv(target, schema);
  if (after.records.length !== srcRecords) {
    errors.push({
      code: 'BACKUP_COUNT_MISMATCH',
      field: null,
      message: `备份校验失败：源 ${srcRecords} 条，副本 ${after.records.length} 条，不一致，已中止整理。`,
      detail: { srcRecords, dstRecords: after.records.length, path: target },
    });
  }

  // 副本解析出的错误也要暴露（说明备份本身就带着坏行）
  if (after.errors.length > 0) {
    errors.push({
      code: 'BACKUP_DST_PARSE_ERRORS',
      field: null,
      message: `备份副本解析出 ${after.errors.length} 个问题（库本身可能已有坏行）。`,
      detail: { errors: after.errors },
    });
  }

  if (errors.length > 0) {
    // 校验不过就删掉半成品，避免留下"看着像备份其实不可用"的文件
    try {
      await fsp.unlink(target);
    } catch {
      /* 忽略 */
    }
    return { ok: false, errors };
  }

  // 保留上限（2026-11-12 P1-5）：备份无限增长会写满磁盘。只清插件自己的
  // memory-*.csv，按 mtime 留最近 keep 份；keep=0 表示不清理。清理失败不影响备份成功。
  if (keep > 0) {
    try {
      await pruneBackups(backupDir, keep);
    } catch {
      /* 清理是锦上添花，失败不该让一次成功的备份变成失败 */
    }
  }

  return { ok: true, path: target, bytes: srcBytes, records: srcRecords, errors: [] };
}

/**
 * 清理旧备份：只动 `memory-*.csv`（插件自己的产物），按 mtime 留最近 keep 份。
 * 绝不碰其他文件（用户可能往 backup/ 放了别的东西）。
 *
 * @param {string} backupDir
 * @param {number} keep 保留份数（>=1）
 * @returns {Promise<{removed:string[]}>}
 */
export async function pruneBackups(backupDir, keep = 30) {
  const removed = [];
  if (!(keep >= 1)) return { removed };
  let names;
  try {
    names = await fsp.readdir(backupDir);
  } catch {
    return { removed };
  }
  const mine = [];
  for (const name of names) {
    if (!/^memory-.*\.csv$/.test(name)) continue; // 只认插件自己的备份
    const full = path.join(backupDir, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) mine.push({ name, full, mtime: st.mtimeMs });
    } catch {
      /* 读不到就跳过 */
    }
  }
  mine.sort((a, b) => b.mtime - a.mtime); // 新的在前
  for (const old of mine.slice(keep)) {
    try {
      await fsp.unlink(old.full);
      removed.push(old.name);
    } catch {
      /* 删不掉就留着，下次再清 */
    }
  }
  return { removed };
}

/**
 * 列出已有备份，新的在前。
 */
export async function listBackups({ backupDir } = {}) {
  let names;
  try {
    names = await fsp.readdir(backupDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { backups: [], errors: [] };
    throw err;
  }

  const backups = [];
  for (const name of names) {
    if (!name.endsWith('.csv')) continue;
    const full = path.join(backupDir, name);
    try {
      const st = await fsp.stat(full);
      backups.push({ name, path: full, bytes: st.size, mtime: st.mtimeMs });
    } catch {
      /* 读不到就跳过 */
    }
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  return { backups, errors: [] };
}

/**
 * 恢复：把某份备份写回记忆库。
 *
 * ⚠️ 这是**破坏性操作**，调用方应当只在用户明确要求时调，且最好先给当前库再备份一次。
 * 本函数只做校验 + 落盘，不做权限判断（授权类操作只给用户，《功能说明》§安全与接口）。
 */
export async function restoreBackup({ backupCsv, libraryCsv, schema } = {}) {
  const parsed = await readLibraryCsv(backupCsv, schema);
  if (parsed.errors.some((e) => e.code === 'HEADER_MISSING')) {
    return {
      ok: false,
      errors: [{ code: 'RESTORE_INVALID_SOURCE', field: null, message: '这份备份不是合法的记忆库（表头缺失），已拒绝恢复。' }],
    };
  }

  const raw = await fsp.readFile(backupCsv);
  await fsp.mkdir(path.dirname(libraryCsv), { recursive: true });
  const tmp = `${libraryCsv}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, raw);
  await fsp.rename(tmp, libraryCsv);

  return { ok: true, records: parsed.records.length, bytes: raw.length, errors: [] };
}
