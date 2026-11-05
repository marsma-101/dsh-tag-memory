// 临时探针：用「文件重定向」而非管道捕获子进程输出（沙箱禁管道）
import { spawnSync } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'qa-probe-'))
const log = join(dir, 'out.txt')
const fd = openSync(log, 'w')

const ok = spawnSync(process.execPath, ['--check', 'index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', fd, fd],
})
closeSync(fd)
console.log('[ok-file]', 'status=', ok.status, 'error=', ok.error?.code ?? 'none', 'captured=', JSON.stringify(readFileSync(log, 'utf8')))

const fd2 = openSync(log, 'w')
const bad = spawnSync(process.execPath, ['--check', 'package.json'], {
  cwd: process.cwd(),
  stdio: ['ignore', fd2, fd2],
})
closeSync(fd2)
console.log('[bad-file]', 'status=', bad.status, 'error=', bad.error?.code ?? 'none', 'captured=', JSON.stringify(readFileSync(log, 'utf8').slice(0, 200)))
