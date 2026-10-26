// Opt-in real macOS native integration. Every Store/config/mount is under tmp/h14/native-*.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync('/Users/jiangkoumo/LayerFS/tmp/h14', { recursive: true });
const dir = process.env.H14_RESUME || mkdtempSync('/Users/jiangkoumo/LayerFS/tmp/h14/native-');
const repo = join(dir, 'repo'), state = join(dir, 'state'), config = join(dir, 'config');
for (const p of [repo, state, config]) mkdirSync(p, { recursive: true });
const env = { ...process.env, HERDR_PLUGIN_ID: '', HERDR_PLUGIN_CONTEXT_JSON: '{}', HERDR_PLUGIN_CONFIG_DIR: config,
  HERDR_PLUGIN_STATE_DIR: state, LFS_STATE_DIR: state, LFS_CWD: repo, LAYERFS_SANDBOX: 'native',
  LAYERFS_API: '/Users/jiangkoumo/LayerFS/layerfs/api', LAYERFS_DAEMON: '/Users/jiangkoumo/LayerFS/layerfs/core/target/release/layerfs-daemon',
  LAYERFS_LOCAL_DIR: join(dir, 'local'), LAYERFS_HOME: join(dir, 'home'), LAYERFS_STORE_PATH: join(dir, 'vol/p/global/store.sqlite'),
  HERDR_WORKSPACE_ID: 'w1S', HERDR_BIN_PATH: 'herdr' };
const report = [];
function command(label, bin, args, extra = {}, expected = 0) {
  const t = performance.now();
  const r = spawnSync(bin, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const ms = Math.round(performance.now() - t);
  report.push({ label, command: [bin, ...args], cwd: repo, timeout: 15000, code: r.status, ms });
  assert.equal(r.status, expected, `${label}: ${r.error || ''} ${r.stderr} ${r.stdout}`);
  return r;
}
const git = (...args) => command(`git ${args.join(' ')}`, 'git', ['--no-pager', '-C', repo, ...args]);
const cli = (label, args, extra, expected) => command(label, process.execPath, [join(root, 'lfs.mjs'), ...args], extra, expected);
const read = () => JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
function leave(name) {
  const id = Object.entries(read().workspaces).find(([, e]) => e.branch === name)?.[0];
  assert.ok(id);
  const panes = JSON.parse(command(`panes ${name}`, 'herdr', ['pane', 'list', '--workspace', id]).stdout).result.panes;
  for (const pane of panes) {
    command(`leave ${name}`, 'herdr', ['pane', 'run', pane.pane_id, `cd '${repo}'`]);
    let away = false;
    for (let i = 0; i < 50; i++) {
      command('allow shell event', process.execPath, ['-e', 'setTimeout(()=>{},200)']);
      const p = JSON.parse(command(`inspect ${name}`, 'herdr', ['pane', 'get', pane.pane_id]).stdout).result.pane;
      if (p.foreground_cwd === repo) { away = true; break; }
    }
    assert.ok(away, 'test shell left mount before drop');
  }
}
const drop = (name, ...flags) => { if (Object.values(read().workspaces).some(e => e.branch === name)) leave(name); return cli(`drop ${name}`, ['drop', name, ...flags]); };
let success = false, sourceId;
try {
  if (!process.env.H14_RESUME) {
  git('init', '-q'); git('config', 'user.name', 'H14'); git('config', 'user.email', 'h14@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'base\n'); git('add', 'a.txt'); git('commit', '-qm', 'seed');
  cli('init', ['init', 'h14']);
  cli('non-Git caller fork', ['fork', 'outside']);
  let s = read(), id = Object.keys(s.workspaces)[0];
  assert.equal(s.projects.h14.herdrWs, null);
  const side = JSON.parse(command('sidebar outside', 'herdr', ['workspace', 'list']).stdout).result.workspaces;
  assert.ok(side.some(w => w.workspace_id === id && w.label === 'lfs:outside'));
  const list = JSON.parse(command('source group', 'herdr', ['worktree', 'list', '--cwd', repo]).stdout);
  sourceId = list.result.source.source_workspace_id;
  assert.ok(sourceId, 'Herdr created source workspace group');
  cli('commit', ['commit'], { HERDR_WORKSPACE_ID: id });
  cli('merge', ['merge', 'main', '--name', 'merged'], { HERDR_WORKSPACE_ID: id });
  cli('reopen merged', ['reopen', 'merged']);
  cli('startup', ['startup']);
  } else {
    sourceId = JSON.parse(command('resume source group', 'herdr', ['worktree', 'list', '--cwd', repo]).stdout).result.source.source_workspace_id;
  }
  drop('merged');
  drop('outside');
  cli('repository caller fork', ['fork', 'inside'], { HERDR_WORKSPACE_ID: sourceId });
  assert.equal(read().projects.h14.herdrWs, sourceId);
  drop('inside');
  // This executable only rejects worktree open; every other Herdr action uses the real CLI.
  const shim = join(dir, 'herdr-fail');
  writeFileSync(shim, '#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = open ]; then\n  echo "injected herdr worktree open failure" >&2\n  exit 1\nfi\nexec herdr "$@"\n'); chmodSync(shim, 0o755);
  cli('injected open failure', ['fork', 'broken'], { HERDR_BIN_PATH: shim }, 1);
  const s = read(); const closed = s.projects.h14.closed.broken;
  assert.match(closed.failed, /injected herdr/); assert.ok(!closed.cleanupFailed);
  const mounts = command('mount verification', 'mount', []).stdout;
  assert.ok(!mounts.includes(` on ${closed.path} `));
  assert.ok(!git('worktree', 'list', '--porcelain').stdout.includes('refs/heads/lfs/broken'));
  assert.match(cli('list failure', ['list']).stdout, /closed\s+broken \(fork failed:/);
  const duplicate = cli('duplicate fork', ['fork', 'broken'], {}, 1);
  assert.match(duplicate.stderr + duplicate.stdout, /reopen broken/);
  cli('reopen failed', ['reopen', 'broken']);
  drop('broken');
  // No record remains, but Store history and its Git branch still exist.
  cli('reopen unrecorded', ['reopen', 'broken']);
  assert.equal(Object.values(read().workspaces)[0].gitBranch, 'lfs/broken');
  leave('broken');
  cli('close hook', ['on-close'], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ workspace_id: Object.keys(read().workspaces)[0] }) });
  for (const w of JSON.parse(command('closed UI list', 'herdr', ['workspace', 'list']).stdout).result.workspaces.filter(w => w.label === 'lfs:broken')) command('close hook UI', 'herdr', ['workspace', 'close', w.workspace_id]);
  cli('drop closed', ['drop', 'broken', '--delete-git-branch']);
  cli('repeated drop', ['drop', 'broken']);
  assert.deepEqual(read().workspaces, {});
  const final = command('final mount verification', 'mount', []).stdout;
  assert.ok(!final.includes(dir));
  const entries = JSON.parse(command('final UI', 'herdr', ['workspace', 'list']).stdout).result.workspaces;
  const owned = entries.filter(w => w.workspace_id === sourceId);
  for (const w of owned) command('close source UI', 'herdr', ['workspace', 'close', w.workspace_id]);
  command('close sandbox', process.execPath, ['--input-type=module', '-e', `const {LayerFS}=await import(process.env.LAYERFS_API+'/agent/sdk/src/index.js');const lf=await LayerFS.open('h14');await lf.sandbox.close('1');await lf.close();`]);
  const du = command('disk usage', 'du', ['-sk', dir]).stdout.trim();
  console.log(JSON.stringify({ dir, success: true, report, diskKiB: du }, null, 2));
  success = true;
} finally {
  if (success) rmSync(dir, { recursive: true });
  else console.error(JSON.stringify({ dir, success: false, report, note: 'Preserved for inspection; do not blindly replay mutations.' }, null, 2));
}
