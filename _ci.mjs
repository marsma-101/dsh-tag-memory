import { execFileSync } from 'node:child_process';
const gh = process.env.LOCALAPPDATA + '\\gh-cli\\gh.exe';
const runId = process.argv[2];
function api(args) {
  return execFileSync(gh, ['api', ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
  const j = JSON.parse(api(['repos/marsma-101/dsh-tag-memory/actions/runs/' + runId + '/jobs']));
  if (!j.jobs.length) { console.log('无 job（workflow 文件级失败）'); }
  for (const job of j.jobs) {
    console.log('job:', job.id, job.name, job.conclusion);
    for (const s of job.steps) console.log(`  ${s.number}. ${s.name} → ${s.conclusion}`);
    try {
      const log = api(['--allow-escape-sequences', `repos/marsma-101/dsh-tag-memory/actions/jobs/${job.id}/logs`]);
      const lines = log.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\S+\s/, ''));
      console.log('--- 日志 ---');
      lines.forEach(l => console.log(l.slice(0, 220)));
    } catch (e) { console.log('取日志失败:', ((e.stdout||'')+(e.stderr||'')).slice(0,200)); }
  }
} catch (e) { console.log('api 失败:', ((e.stdout||'')+(e.stderr||'')).slice(0,300)); }
// run 级注解（workflow 文件错误在这里）
try {
  const r = JSON.parse(api(['repos/marsma-101/dsh-tag-memory/actions/runs/' + runId]));
  console.log('\nrun conclusion:', r.conclusion);
  const ck = JSON.parse(api([`repos/marsma-101/dsh-tag-memory/check-runs/${r.check_suite_id ?? ''}/annotations`]).trim() || '[]');
  ck.forEach(a => console.log('注解:', a.message));
} catch {}
