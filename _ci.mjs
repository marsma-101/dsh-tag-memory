import { execFileSync } from 'node:child_process';
const gh = process.env.LOCALAPPDATA + '\\gh-cli\\gh.exe';
function api(args) {
  return execFileSync(gh, ['api', ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const jobs = JSON.parse(api(['repos/marsma-101/dsh-tag-memory/actions/runs/' + process.argv[2] + '/jobs']));
const job = jobs.jobs[0];
const log = api(['--allow-escape-sequences', `repos/marsma-101/dsh-tag-memory/actions/jobs/${job.id}/logs`]);
const lines = log.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\S+\s/, ''));
const i = lines.findIndex(l => /failing tests:/.test(l));
if (i >= 0) lines.slice(i, i + 45).forEach(l => console.log(l.slice(0, 220)));
else console.log('未找到 failing tests 段；末尾 30 行：\n' + lines.slice(-30).join('\n').slice(0, 2000));
