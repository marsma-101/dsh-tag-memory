// 临时诊断：在 Linux 上打印 seedState 的每次赋值与调用序。用完即删。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const { makeHostCtx } = await import('../tests/_host-ctx.mjs');
const h = await makeHostCtx({ identity: { agent: 'a', project: 'p' }, seed: true });
try {
  // ① 什么都不等，立刻看（模拟 apply 后异步播种尚未完成）
  const ov0 = await h.host.getOverview();
  console.log('T0 (apply 后立即) seed =', JSON.stringify(ov0.seed), 'total =', ov0.total);

  // ② 显式初始化（测试就是这么做的）
  await h.host._ensureInitialized();
  const ov1 = await h.host.getOverview();
  console.log('T1 (显式 init 后) seed =', JSON.stringify(ov1.seed), 'total =', ov1.total);

  // ③ 再等一会看异步那次是否迟到覆盖
  await new Promise(r => setTimeout(r, 300));
  const ov2 = await h.host.getOverview();
  console.log('T2 (等 300ms 后) seed =', JSON.stringify(ov2.seed), 'total =', ov2.total);
} finally { h.cleanup(); }
