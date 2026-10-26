#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const file = join(process.env.LFS_STATE_DIR, 'herdr.json');
const s = JSON.parse(readFileSync(file, 'utf8'));
s.calls.push(args); writeFileSync(file, JSON.stringify(s));
if (args[0] === 'notification') process.exit(0);
if (args[0] === 'workspace' && args[1] === 'list') console.log(JSON.stringify({ result: { workspaces: Object.keys(s.live).map(workspace_id => ({ workspace_id })) } }));
else if (args[0] === 'workspace' && args[1] === 'close') { delete s.live[args[2]]; writeFileSync(file, JSON.stringify(s)); }
else if (args[0] === 'worktree' && args[1] === 'list') {
  if (args.includes('bad-caller')) { console.error('not_git_worktree'); process.exit(1); }
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('git', ['-C', process.env.LFS_CWD, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 });
  console.log(JSON.stringify({ result: { source: { repo_key: r.stdout.trim() } } }));
}
else if (args[0] === 'worktree' && args[1] === 'open') {
  if (process.env.H14_FAULT === 'herdr') { console.error('injected herdr open failure'); process.exit(1); }
  if (args.includes('bad-caller')) { console.error('not_git_worktree'); process.exit(1); }
  const workspace_id = `test-${++s.n}`; s.live[workspace_id] = true; writeFileSync(file, JSON.stringify(s));
  console.log(JSON.stringify({ result: { workspace: { workspace_id } } }));
} else { console.error(`unexpected test herdr args ${args.join(' ')}`); process.exit(1); }
