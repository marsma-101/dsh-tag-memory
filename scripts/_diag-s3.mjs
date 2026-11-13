// 临时诊断：在 Linux CI 上打印 S3 播种的真实中间状态。用完即删。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const seed = path.join(ROOT, 'data', 'store', 'memory.csv');
console.log('platform =', process.platform);
console.log('seed exists =', fs.existsSync(seed));
if (fs.existsSync(seed)) {
  const buf = fs.readFileSync(seed);
  console.log('seed bytes =', buf.length, ' hasCRLF =', buf.includes(Buffer.from('\r\n')));
  console.log('seed head =', buf.toString('utf8').split('\n')[0].slice(0, 80));
}

const { makeHostCtx } = await import('../tests/_host-ctx.mjs');
const h = await makeHostCtx({ identity: { agent: 'seed-agent', project: 'seed-project' }, seed: true });
try {
  const l = await h.host._resolveLayout();
  console.log('dataDir =', l.layout.dataDir, ' source =', l.source);
  console.log('csv before =', fs.existsSync(l.layout.libraryCsv));
  const r = await h.host._ensureInitialized();
  console.log('init issue =', JSON.stringify(r.issue));
  console.log('csv after =', fs.existsSync(l.layout.libraryCsv));
  if (fs.existsSync(l.layout.libraryCsv)) console.log('csv bytes =', fs.statSync(l.layout.libraryCsv).size);
  const ov = await h.host.getOverview();
  console.log('RESULT seed =', JSON.stringify(ov.seed), ' total =', ov.total);
} finally {
  h.cleanup();
}
