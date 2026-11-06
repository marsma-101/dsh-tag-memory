// qa 测试公共工具（tests/ 作用域内）
// 只做读取与匹配，不改任何业务文件。

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录（tests/ 的上一级） */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 扫描时排除的目录：不进包、非运行时、我自己。
 *
 * 分两类：
 *   ① 语义排除 —— 这些目录本来就不是插件运行时的一部分：
 *      `.git`（版本库）/ `node_modules`（依赖）/ `内部文档`（内部资料）/ `tests`（测试自身）
 *   ② 环境排除 —— 本地工具可能在仓库里留下的工作目录（2026-11-06 加）：
 *      `._cdp` 是 Chrome/Edge 被指到本仓库当用户数据目录时创建的（里面有扩展的
 *      js/png/db）。它被 `.gitignore` 忽略，但**测试扫描器原本没跳过它**，
 *      导致 R3（"无自建 HTTP 服务"）和 S6（"无位图截图"）在本地误报失败。
 *
 * ⚠️ 为什么用"排除"而不是"清掉完事"：
 *    清掉只能保证**我这边**干净。换台机器、或者本机又跑起调试浏览器，
 *    同一个误报会再次出现，还会被误当成产品缺陷。排除掉才是对"别人的机器上
 *    也有这些目录"免疫的做法。
 *
 * 匹配方式：精确名（`EXCLUDE_DIRS`）+ 前缀模式（`EXCLUDE_DIR_PREFIXES`），
 * 后者专门处理 `._*` 这类"名字不固定但形态固定"的本地产物。
 */
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '内部文档', 'tests'])

/**
 * 需要按前缀排除的目录名。
 * `._*` 覆盖 `._cdp` 以及编辑器/同步工具可能生成的其他 `._xxx` 目录。
 */
const EXCLUDE_DIR_PREFIXES = ['._']

/** 某个目录名是否应被扫描跳过（两类排除规则的唯一判定入口）。 */
function isExcludedDir(name) {
  if (EXCLUDE_DIRS.has(name)) return true
  return EXCLUDE_DIR_PREFIXES.some((p) => name.startsWith(p))
}

/**
 * 递归列出**全部**工作区文件（仍排除 .git / node_modules / 内部文档 / tests / ._*）。
 * 用于"残留文件扫描"这类需要看全貌的检查。
 */
export function listAllFiles(dir = ROOT, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue
      listAllFiles(join(dir, entry.name), acc)
    } else if (entry.isFile()) {
      acc.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return acc
}

/**
 * 递归列出「**运行时文件**」——即 npm 打包时必须被 files 白名单覆盖的文件。
 *
 * 与 listAllFiles 的区别（这层区分很重要，否则 P8 会误报）：
 *   - package.json 本身由 npm 自动包含，不需要出现在 files 里
 *   - .gitignore / .npmignore 是开发辅助，不是运行时文件
 *   - `.*.mjs` / `*.smoke.mjs` 这类临时冒烟脚本不是运行时文件（另见 P11 残留扫描）
 */
export function listRuntimeFiles() {
  const AUTO_INCLUDED = new Set(['package.json'])
  return listAllFiles().filter((f) => {
    const base = f.split('/').pop()
    if (AUTO_INCLUDED.has(base)) return false
    if (base.startsWith('.')) return false // dotfiles：.gitignore / .npmignore / .env...
    return true
  })
}

/** 列出指定扩展名的运行时源文件 */
export function listRuntimeSources(exts) {
  return listRuntimeFiles().filter((f) => exts.some((e) => f.endsWith(e)))
}

export function readText(relPath) {
  return readFileSync(join(ROOT, relPath.split('/').join(sep)), 'utf8')
}

export function exists(relPath) {
  return existsSync(join(ROOT, relPath.split('/').join(sep)))
}

export function sizeOf(relPath) {
  return statSync(join(ROOT, relPath.split('/').join(sep))).size
}

export function readJson(relPath) {
  return JSON.parse(readText(relPath))
}

/**
 * 把 npm `files` 白名单的 glob 转成正则。
 * 支持：字面名、`*`（单段内任意）、`**`（任意层）、`**​/`（零或多层目录）。
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** 某文件是否被白名单任一 pattern 覆盖 */
export function coveredBy(files, relPath) {
  return files.some((p) => globToRegExp(p).test(relPath))
}

/** 白名单某 pattern 能匹配到的运行时文件列表 */
export function matchesOf(files, pattern, all = listRuntimeFiles()) {
  const re = globToRegExp(pattern)
  return all.filter((f) => re.test(f))
}

/**
 * 解析 YAML 解析器。
 * Q2 裁定：必须真解析，正则不算。
 * 优先本地 node_modules 的 yaml（devDependency），
 * 缺失时回落到本机 DSH 自带的 yaml，并标注实际来源。
 */
export async function loadYaml() {
  try {
    const m = await import('yaml')
    return { parse: m.parse, source: 'local node_modules/yaml' }
  } catch {
    const fallback =
      'file:///C:/Users/Administrator/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/yaml/dist/index.js'
    try {
      const m = await import(fallback)
      return { parse: m.parse, source: 'npx cache yaml (本地 devDependency 未安装)' }
    } catch {
      return null
    }
  }
}
