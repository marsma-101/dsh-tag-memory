// snapshot.mjs —— 写前快照的「一份逻辑」（S-防-2）
//
// 和 backup.mjs 是**两层**，别混：
//   · backup.mjs  = 用户主动备、要设地址、四件套、有水位与完整性校验。没设备份地址就抛。
//   · snapshot.mjs = 改库语义**之前自动留一份**，落点固定、不依赖任何配置、保留最近 N 份。
//
// 为什么快照不能复用 runBackup：
//   runBackup 要求先配好备份地址（`BackupNoDirError`）。拿它做「改前留档」，
//   就会变成「用户没设备份地址 → 取代/归档/恢复/合并全做不了」——那是功能倒退。
//   快照必须自带固定落点（`<store>/snapshots/`），任何时候都能留。
//
// 为什么单独一个文件、不塞进 core.mjs：
//   core.mjs 文件头自述「纯函数、无副作用入口，只有 withLock 的等锁是唯一与时间相关的副作用」。
//   快照是**有状态的写盘动作**，塞进去会把「纯逻辑层」变成「写入器」，
//   以后想单测 core 就得先处理快照副作用。放这儿、共用 backup.mjs 的戳与哈希，分层最干净。
//
// 两个硬要求：
//   ① **tmp + rename**：中途崩溃不能留下半截快照——半截快照比没有更坏，
//      人以为「有档可回」，回过去是一份残档。
//   ② **先写快照，再动库**。顺序反了等于没留。

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, renameSync, statSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
/**
 * 打戳（本地时间，到秒）。**本地实现，不 import backup.mjs**——
 * `backup.mjs` 自己 import 了 `core.mjs`，而 `core.mjs` 又要用本文件的快照，
 * 三者形成 `core → snapshot → backup → core` 的循环。ESM 的循环会让某一方
 * 拿到还没初始化的命名空间（表现为 `xxx is not a function`）。
 * 这个函数只有三行，抄一份比留一条循环链划算得多。
 */
export function stampOf(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

/**
 * 快照文件名的形态：`memory-<戳>[-<序号>].csv`。
 *
 * 戳到**毫秒**（`YYYYMMDD-HHMMSSmmm`），同毫秒撞了再加序号后缀（`-2`、`-3`…）。
 * 为什么必须这么做：V3 的批量整理（一次归档/取代几十条）会在**同一秒内**连拍几十份快照，
 * 只到秒的戳必然互相覆盖——被盖掉的那份往往正是想回退到的那份。
 * 老快照只到秒、无后缀，正则照样认得出来（轮转不能把老档漏掉）。
 */
const SNAP_RE = /^memory-(\d{8}-\d{4,6}(?:\d{3})?)(?:-(\d+))?\.csv$/

/** 默认保留份数。总纲 S-防-2：保留最近 20 份。 */
export const SNAPSHOT_KEEP = 20

/** 快照目录（相对 store 目录）。 */
export function snapshotDirOf(storeDir) {
  return join(storeDir, 'snapshots')
}

/**
 * 列出现有快照（按戳升序 = 从旧到新）。
 * 目录不存在 → 空数组（不抛：第一次快照时目录还没建）。
 */
export function listSnapshots(storeDir) {
  const dir = snapshotDirOf(storeDir)
  if (!existsSync(dir)) return []
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .map((n) => { const m = n.match(SNAP_RE); return m === null ? null : { name: n, stamp: m[1], path: join(dir, n) } })
    .filter((x) => x !== null)
    .sort((a, b) => a.stamp.localeCompare(b.stamp))
}

/**
 * 拿一个不会盖掉别人的戳。
 *
 * 同一秒里连做两次快照会撞戳。撞了就往后挪一秒——**绝不覆盖已有快照**，
 * 因为「盖掉的那份」很可能正是你想回退到的那份（restore 的留档就踩过这个坑，
 * 见 backup.mjs 里 `STAMP_RE` 上方那段注释）。
 */
function millisStamp(d) {
  const p2 = (n) => String(n).padStart(2, '0')
  const p3 = (n) => String(n).padStart(3, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p3(d.getMilliseconds())}`
}

/**
 * 拿一个**不会盖掉别人**的文件名。
 *
 * 两级保险：
 *   ① 戳到毫秒——同一秒内的批量操作，绝大多数情况下毫秒就够区分了；
 *   ② 毫秒也撞了（同一毫秒内两次调用，测试里很常见）→ 加序号后缀 `-2`、`-3`…
 *      序号只解决「文件名撞车」，不再往后挪时间——挪时间会让快照的「拍摄时刻」失真，
 *      而快照日志里的时刻才是人用来对照的。
 */
function freshStamp(dir, d, taken) {
  const stamp = millisStamp(d)
  for (let seq = 0; seq < 100; seq++) {
    const name = seq === 0 ? `memory-${stamp}.csv` : `memory-${stamp}-${seq + 1}.csv`
    if (!existsSync(join(dir, name)) && !taken.has(name)) return { stamp, name }
  }
  throw new Error('快照文件名连续撞车（同一毫秒内已有 100 份），本次没有快照。')
}

/**
 * 滚动清理：只留最近 `keep` 份，更老的删掉。
 *
 * 删的是**快照**，不是库、不是备份。用户主动做的备份（backup.mjs 那四件套）
 * 一份都不动——这是两套目录，互不干扰。
 */
function rotate(dir, keep) {
  const all = listSnapshotsAt(dir)
  const over = all.length - keep
  if (over <= 0) return { removed: [] }
  const removed = []
  for (const s of all.slice(0, over)) {
    try { unlinkSync(s.path); removed.push(s.name) } catch { /* 删不掉就留着，不装作删了 */ }
  }
  return { removed }
}

/** 和 listSnapshots 同逻辑，但直接吃目录（rotate 内部用，避免重复拼路径）。 */
function listSnapshotsAt(dir) {
  if (!existsSync(dir)) return []
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .map((n) => { const m = n.match(SNAP_RE); return m === null ? null : { name: n, stamp: m[1], path: join(dir, n) } })
    .filter((x) => x !== null)
    .sort((a, b) => a.stamp.localeCompare(b.stamp))
}

/** 写一个文件：同目录 tmp + rename。跨盘 rename 不是原子的，所以 tmp 必须同目录。 */
function writeAtomic(targetPath, bytes) {
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, targetPath)
  } catch (e) {
    try { unlinkSync(tmpPath) } catch { /* 没写成或已 rename 掉 */ }
    throw e
  }
}

/**
 * 给库拍一份快照。**在改库之前调**。
 *
 * @param {object} o
 * @param {string} o.storeDir   `store/` 目录（快照落在它的 `snapshots/` 下）
 * @param {string} [o.csvPath]  库文件；默认 `<storeDir>/memory.csv`
 * @param {string} [o.label]    这份快照为什么拍的（写进 `.log`，事后能追）
 * @param {number} [o.keep]     保留份数，默认 20
 * @param {Date}   [o.now]      传进来便于测试
 * @returns {{ ok: boolean, name: string, stamp: string, bytes: number, kept: number, removed: string[], error: string }}
 */
export function snapshotStore({ storeDir, csvPath, label = '', keep = SNAPSHOT_KEEP, now = new Date() } = {}) {
  const csv = typeof csvPath === 'string' && csvPath.trim() !== '' ? csvPath.trim() : join(storeDir, 'memory.csv')
  const out = { ok: false, name: '', stamp: '', bytes: 0, kept: 0, removed: [], error: '' }

  if (!existsSync(csv)) {
    out.error = `找不到库文件 ${csv}，没有拍快照。`
    return out
  }

  const dir = snapshotDirOf(storeDir)
  try { mkdirSync(dir, { recursive: true }) } catch (e) {
    out.error = `快照目录建不出来（${dir}）：${String(e?.message ?? e)}`
    return out
  }

  let bytes
  try { bytes = readFileSync(csv) } catch (e) {
    out.error = `库文件读不出来，没有拍快照：${String(e?.message ?? e)}`
    return out
  }

  let stamp, name
  try {
    const picked = freshStamp(dir, now instanceof Date ? now : new Date(), new Set())
    stamp = picked.stamp
    name = picked.name
  } catch (e) {
    out.error = String(e?.message ?? e)
    return out
  }
  try {
    writeAtomic(join(dir, name), bytes)
  } catch (e) {
    out.error = `快照写盘失败：${String(e?.message ?? e)}`
    return out
  }

  out.ok = true
  out.name = name
  out.stamp = stamp
  out.bytes = bytes.length

  const rot = rotate(dir, Math.max(1, Number.isFinite(keep) ? Math.floor(keep) : SNAPSHOT_KEEP))
  out.removed = rot.removed
  out.kept = listSnapshotsAt(dir).length

  // 留一行流水：谁在什么时候、因为什么拍的。失败不影响快照本身。
  try {
    const line = `${new Date().toISOString()}  ${name}  ${out.bytes}B  ${label || '未注明'}${rot.removed.length ? `  滚掉 ${rot.removed.length} 份` : ''}\n`
    const logPath = join(dir, 'snapshots.log')
    if (existsSync(logPath)) {
      const prev = readFileSync(logPath, 'utf8')
      writeAtomic(logPath, Buffer.from(prev + line, 'utf8'))
    } else {
      writeAtomic(logPath, Buffer.from(line, 'utf8'))
    }
  } catch { /* 流水写不了不影响快照 */ }

  return out
}

/**
 * 拍快照，失败就抛。
 *
 * 给「改库语义」的四个调用点用（取代 / 归档 / 恢复 / 合并）：**留档失败就不许动库**，
 * 与 `restoreFromLocked` 里「恢复前留档没成功，已中止」是同一条规矩。
 * 用 `snapshotStore` 拿到 ok:false 却继续往下走，等于把「有档可回」这句承诺作废。
 */
export function snapshotOrThrow(opts, action) {
  const r = snapshotStore(opts)
  if (!r.ok) {
    throw new Error(`「${action}」之前留档没成功，已中止（库没动）：${r.error}`)
  }
  return r
}

/**
 * 快照现状（界面 / 自检用）：几份、最老最新、占多少字节。
 *
 * **口径：数份数一律走 `listSnapshots()`，不要数目录里的文件个数。**
 * `snapshots/` 底下还躺着 `snapshots.log`（流水），它 `.csv` 都不是、也不该算进份数；
 * 数文件个数会把日志当成一份快照，界面上就多报一份、轮转也会算错该删谁。
 */
export function snapshotStatus(storeDir) {
  const all = listSnapshots(storeDir)
  let bytes = 0
  for (const s of all) {
    try { bytes += statSync(s.path).size } catch { /* 数不到就算 0 */ }
  }
  return {
    dir: snapshotDirOf(storeDir),
    count: all.length,
    keep: SNAPSHOT_KEEP,
    oldest: all.length ? all[0].stamp : '',
    newest: all.length ? all[all.length - 1].stamp : '',
    bytes,
  }
}
