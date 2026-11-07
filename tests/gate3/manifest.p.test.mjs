// 闸门③ P 组：清单校验（10 条）
//
// 依据：《功能说明》§十四「安装与发布」、《架构说明》§4/§6、
//       官方 references/host-plugin.md、Lead 裁定 Q2/Q3。
// 注意：只读不改。绝不写 package.json / cordis.patch.yml。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  listRuntimeFiles,
  listAllFiles,
  readJson,
  readText,
  exists,
  sizeOf,
  globToRegExp,
  matchesOf,
  loadYaml,
} from '../_helpers.mjs'

const pkg = readJson('package.json')
const allFiles = listRuntimeFiles()

/* ------------------------------------------------------------------ *
 * P1 package.json 合法
 * ------------------------------------------------------------------ */
test('P1 package.json 合法：name / version / type:module 存在', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.ok(pkg.name.length > 0, 'name 不能为空')
  assert.equal(typeof pkg.version, 'string')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'version 必须是语义化版本')
  assert.equal(pkg.type, 'module', '必须是 ESM（type: module）')
})

/* ------------------------------------------------------------------ *
 * P2 exports 四项齐全且指向真实文件
 * ------------------------------------------------------------------ */
test('P2 exports 含 . / ./client / ./locale/*.json / ./icon，且指向文件真实存在', () => {
  const ex = pkg.exports ?? {}
  for (const key of ['.', './client', './locale/*.json', './icon']) {
    assert.ok(key in ex, `exports 缺少 "${key}"，实际有：${Object.keys(ex).join(', ')}`)
  }

  // 非通配的三项：目标文件必须存在
  for (const key of ['.', './client', './icon']) {
    const target = ex[key]
    assert.equal(typeof target, 'string', `exports["${key}"] 必须是字符串`)
    const rel = target.replace(/^\.\//, '')
    assert.ok(exists(rel), `exports["${key}"] 指向的 ${rel} 不存在`)
  }

  // locale 通配：至少要真能匹配到文件
  const localeMatches = matchesOf([ex['./locale/*.json']], ex['./locale/*.json'].replace(/^\.\//, ''), allFiles)
  assert.ok(localeMatches.length >= 2, `./locale/*.json 至少应匹配 zh/en 两个文件，实际 ${localeMatches.length} 个`)
})

/* ------------------------------------------------------------------ *
 * P3 dsh.bundle.patch 存在且文件存在
 * ------------------------------------------------------------------ */
test('P3 dsh.bundle.patch 存在，且指向的文件真实存在', () => {
  assert.ok(pkg.dsh, 'package.json 缺少 dsh 字段')
  assert.ok(pkg.dsh.bundle, '缺少 dsh.bundle')
  assert.ok(pkg.dsh.bundle.patch, '缺少 dsh.bundle.patch')

  const rel = String(pkg.dsh.bundle.patch).replace(/^\.\//, '')
  assert.ok(exists(rel), `dsh.bundle.patch 指向的 ${rel} 不存在`)
})

/* ------------------------------------------------------------------ *
 * P4 dsh.client 声明合理
 * ------------------------------------------------------------------ */
test('P4 dsh.client 声明合理：platform web + immediately 布尔', () => {
  assert.ok(pkg.dsh?.client, '缺少 dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web', 'platform 必须是 web')
  assert.equal(typeof pkg.dsh.client.immediately, 'boolean', 'immediately 必须是布尔')
})

/* ------------------------------------------------------------------ *
 * P5 cordis.patch.yml 真解析（Q2 裁定：正则不算验过）
 * ------------------------------------------------------------------ */
test('P5 cordis.patch.yml 用 yaml 真解析，能读出 insert + id/name（Q2：正则不算）', async () => {
  const yaml = await loadYaml()
  assert.ok(
    yaml !== null,
    '缺少 YAML 解析器：本地 devDependency 未安装，且回退路径也不可用 → P5 无法真解析，按 Q2 裁定判失败',
  )

  const text = readText('cordis.patch.yml')
  const doc = yaml.parse(text) // 解析失败会抛，由测试框架报出

  assert.ok(Array.isArray(doc), `patch 顶层必须是数组，实际 ${typeof doc}`)
  assert.ok(doc.length > 0, 'patch 不能是空数组')

  const entry = doc.find((d) => d && d.insert)
  assert.ok(entry, 'patch 必须含 insert 项')

  const inserted = entry.insert
  assert.ok(Array.isArray(inserted), 'insert 必须是数组')
  assert.ok(inserted.length > 0, 'insert 不能为空')

  const plugin = inserted[0]
  assert.equal(typeof plugin.id, 'string', 'insert 项必须有 id')
  assert.ok(plugin.id.length > 0)
  assert.equal(typeof plugin.name, 'string', 'insert 项必须有 name')
  assert.ok(plugin.name.length > 0, 'name 不能为空')

  // 交叉校验：patch 里的 name 应与包名一致，否则装不上
  assert.equal(plugin.name, pkg.name, `patch 的 name「${plugin.name}」应等于包名「${pkg.name}」`)
})

/* ------------------------------------------------------------------ *
 * P6 locale 中英各一份，meta.title / meta.description 非空，key 集一致
 * ------------------------------------------------------------------ */
test('P6 locale/zh.json + en.json 都有非空 meta.title/description，key 集一致', () => {
  for (const lang of ['zh', 'en']) {
    const rel = `locale/${lang}.json`
    assert.ok(exists(rel), `缺少 ${rel}`)

    const data = readJson(rel)
    assert.ok(data.meta, `${rel} 缺少 meta`)
    assert.equal(typeof data.meta.title, 'string', `${rel} 的 meta.title 必须是字符串`)
    assert.ok(data.meta.title.trim().length > 0, `${rel} 的 meta.title 不能为空`)
    assert.equal(typeof data.meta.description, 'string', `${rel} 的 meta.description 必须是字符串`)
    assert.ok(data.meta.description.trim().length > 0, `${rel} 的 meta.description 不能为空`)
  }

  const zhKeys = Object.keys(readJson('locale/zh.json').meta).sort()
  const enKeys = Object.keys(readJson('locale/en.json').meta).sort()
  assert.deepEqual(zhKeys, enKeys, `中英 key 集必须一致：zh=${zhKeys.join(',')} en=${enKeys.join(',')}`)
})

/* ------------------------------------------------------------------ *
 * P7 icon.svg 存在、≤256KiB、合法 SVG 文本
 *     只做文本+尺寸校验，绝不做光栅化/导出预览（官方铁律）
 * ------------------------------------------------------------------ */
test('P7 icon.svg 存在、≤256KiB、以 <svg 开头且含 xmlns（只做文本+尺寸校验）', () => {
  const rel = 'icon.svg'
  assert.ok(exists(rel), '缺少 icon.svg')

  const bytes = sizeOf(rel)
  const limit = 256 * 1024
  assert.ok(bytes <= limit, `icon.svg 必须 ≤ 256KiB，实际 ${bytes} 字节（上限 ${limit}）`)

  const text = readText(rel).trim()
  assert.ok(text.startsWith('<svg'), `icon.svg 必须以 <svg 开头，实际开头「${text.slice(0, 20)}」`)
  assert.ok(text.includes('xmlns'), 'icon.svg 必须含 xmlns 声明')
  assert.ok(text.includes('</svg>'), 'icon.svg 必须有闭合标签')
})

/* ------------------------------------------------------------------ *
 * P8 files 白名单覆盖全部运行时文件（含 标签字典.md —— Q3 裁定）
 * ------------------------------------------------------------------ */
test('P8 files 白名单覆盖全部运行时文件，且必须含 标签字典.md（Q3 裁定）', () => {
  const files = pkg.files
  assert.ok(Array.isArray(files) && files.length > 0, 'files 必须是非空数组')

  // Q3：dict.mjs 从磁盘读它，必须进包
  assert.ok(
    files.includes('标签字典.md'),
    `Q3 裁定：files 必须含 "标签字典.md"（dict.mjs 从磁盘读），实际：${files.join(', ')}`,
  )

  // 覆盖性：每个运行时文件都必须被某条 pattern 覆盖
  //
  // ⚠️ npm 的硬规则：无论 files 白名单写什么，下面这些**永远会进包**
  //    （npm-packlist 内置）：package.json / README* / LICENSE* / LICENCE* /
  //    CHANGELOG* / CHANGES* / HISTORY*，以及 main/exports 指向的文件。
  //    它们不需要、也无法通过 files 表达"排除"，所以不算"漏发布"。
  //    之前这里把 LICENSE / README.md 误报成漏发布 —— 是断言过严，不是真缺陷。
  const NPM_ALWAYS_PACKED = [
    /^(package\.json)$/,
    /^readme(\.[^/]*)?$/i,
    /^(licen[cs]e|copying)(\.[^/]*)?$/i,
    /^(changelog|changes|history)(\.[^/]*)?$/i,
  ]

  const alwaysPacked = (f) => {
    const base = f.split('/').pop()
    return NPM_ALWAYS_PACKED.some((re) => re.test(base))
  }

  const uncovered = allFiles.filter((f) => !alwaysPacked(f) && !files.some((p) => globToRegExp(p).test(f)))

  // Lead 2026-11-05 建议：把"疑似临时文件"单独点名，帮助区分
  // 「真漏发布」与「有人把临时脚本/测试数据留在包根」。
  // 判据：以 `_` 或 `.` 开头，或落在 `_xxx/` 这类目录下。
  const looksTemp = (f) => /(^|\/)(_|\.)/.test(f)
  const tempLike = uncovered.filter(looksTemp)
  const realUncovered = uncovered.filter((f) => !looksTemp(f))

  if (tempLike.length > 0) {
    console.log(
      `\n[P8 提示] 以下文件疑似临时文件（以 _ 或 . 开头），请确认是否应被 .gitignore 排除：\n` +
        tempLike.map((f) => `  · ${f}`).join('\n') +
        '\n',
    )
  }

  assert.deepEqual(
    uncovered,
    [],
    `以下运行时文件未被 files 白名单覆盖（会漏发布）：\n` +
      realUncovered.map((f) => `  · ${f}`).join('\n') +
      (tempLike.length > 0
        ? `\n\n其中以下 ${tempLike.length} 个疑似临时文件（_ 或 . 前缀），` +
          `请确认是"该排除"还是"该进包"：\n` +
          tempLike.map((f) => `  · ${f}`).join('\n')
        : ''),
  )
})

/* ------------------------------------------------------------------ *
 * P9 files 绝不包含 内部文档/（同时查 .npmignore）
 * ------------------------------------------------------------------ */
test('P9 files 与 .npmignore 都不放行 内部文档/（内部文档绝不进包）', () => {
  const files = pkg.files ?? []

  const leaked = files.filter((p) => String(p).includes('内部文档'))
  assert.deepEqual(leaked, [], `files 白名单绝不允许含 内部文档，实际含：${leaked.join(', ')}`)

  // .npmignore 必须显式排除内部文档
  assert.ok(exists('.npmignore'), '缺少 .npmignore（需要它兜底排除内部文档）')
  const npmignore = readText('.npmignore')
  assert.ok(
    /^\s*内部文档\s*\/?\s*$/m.test(npmignore),
    `.npmignore 必须显式排除 内部文档/，实际内容：\n${npmignore}`,
  )

  // 反过来验：白名单确实没有把 内部文档 目录下任何东西匹配进来
  const docFiles = ['内部文档/功能说明.md', '内部文档/架构说明.md']
  for (const f of docFiles) {
    const covered = files.some((p) => globToRegExp(p).test(f))
    assert.equal(covered, false, `白名单不得覆盖 ${f}`)
  }
})

/* ------------------------------------------------------------------ *
 * P10 白名单每项都必须能真实匹配到文件
 *      Lead 裁定：允许某些 pattern 当前空匹配（如 client.*.js 在还没有子模块时），
 *      但核心项必须有实际匹配。
 * ------------------------------------------------------------------ */
test('P10 白名单每项语法合法；核心项必须有实际匹配（client.*.js 允许当前空匹配）', () => {
  const files = pkg.files ?? []

  // 所有 pattern 都必须语法合法（能编译成正则）
  for (const p of files) {
    assert.doesNotThrow(() => globToRegExp(p), `白名单项「${p}」不是合法 glob`)
  }

  // 核心项：必须有实际匹配（Lead 裁定列出的这几个）
  const mustMatch = ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', '标签字典.md']
  for (const p of mustMatch) {
    const hits = matchesOf(files, p, allFiles)
    assert.ok(hits.length > 0, `白名单核心项「${p}」当前匹配不到任何文件`)
  }

  // client.*.js：允许当前无子模块（尚未交付时），但若目录里真有 client.xxx.js 就必须匹配上
  const clientSubs = allFiles.filter((f) => /^client\.[^/]+\.js$/.test(f))
  const clientPatternHits = (files.find((p) => p === 'client.*.js') ? clientSubs : []).length
  assert.equal(
    clientPatternHits,
    clientSubs.length,
    `目录里有 ${clientSubs.length} 个 client.xxx.js，白名单 client.*.js 应全部覆盖`,
  )
})

/* ------------------------------------------------------------------ *
 * P11 残留文件扫描
 *     目的：把散落在包根、不该发布的东西点名报出来，而不是靠"不算运行时文件"默默绕过。
 *     这类文件若留在包根，本地目录安装（链接）会把它们一起带进 profile。
 * ------------------------------------------------------------------ */
test('P11 包根无开发期残留文件（临时冒烟脚本 / 备份 / 编辑器残留）', () => {
  const all = listAllFiles()

  // 1) 临时脚本与备份：engine-dev 自测用的 `.smoke-*.mjs` 之类
  const scratch = all.filter((f) => /(^|\/)(\.smoke|smoke[.-]|_scratch|tmp[.-]|\.bak$|\.orig$|~$)/.test(f))

  // 2) 编辑器/系统残留
  const junk = all.filter((f) => /(^|\/)(\.DS_Store|Thumbs\.db|\.swp)$/.test(f) || f.endsWith('.log'))

  const offenders = [...scratch, ...junk]
  assert.deepEqual(
    offenders,
    [],
    `包根发现开发期残留文件（本地目录安装会把它们一起带进 profile，应清理）：\n  ${offenders.join('\n  ')}`,
  )
})
