// Real native SDK/NFS integration; only Herdr's UI is doubled. All resources are isolated.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = '/Users/jiangkoumo/LayerFS/tmp/h16';
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'native-'));
const repo = join(dir, 'repo'), state = join(dir, 'state');
for (const p of [repo, state, join(dir, 'config')]) mkdirSync(p);
const herdr = join(root, 'test/fixtures/herdr.mjs'); chmodSync(herdr, 0o755);
writeFileSync(join(state, 'herdr.json'), JSON.stringify({ calls: [], live: { 'repo-caller': true }, n: 0 }));
const env = { ...process.env, HERDR_PLUGIN_ID: '', HERDR_PLUGIN_CONTEXT_JSON: '{}', HERDR_PLUGIN_CONFIG_DIR: join(dir, 'config'),
  HERDR_PLUGIN_STATE_DIR: state, LFS_STATE_DIR: state, LFS_CWD: repo, HERDR_WORKSPACE_ID: 'repo-caller', HERDR_BIN_PATH: herdr,
  LAYERFS_SANDBOX: 'native', LAYERFS_API: '/Users/jiangkoumo/LayerFS/layerfs/api',
  LAYERFS_DAEMON: '/Users/jiangkoumo/LayerFS/layerfs/core/target/release/layerfs-daemon',
  LAYERFS_HOME: join(dir, 'home'), LAYERFS_LOCAL_DIR: join(dir, 'local'), LAYERFS_STORE_PATH: join(dir, 'vol/p/global/store.sqlite'),
  LAYERFS_WORKER_ENDPOINT: '', LAYERFS_NATIVE: '', LAYERFS_CONTAINER_PREFIX: 'layerfs-' };
const report = [], snapshots = [];
function command(label, bin, args, extra = {}, expected = 0) {
  const start = performance.now();
  const r = spawnSync(bin, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
  report.push({ label, command: [bin, ...args], code: r.status, ms: Math.round(performance.now() - start) });
  assert.equal(r.status, expected, `${label}: ${r.error || ''} ${r.stderr} ${r.stdout}`);
  return r;
}
const cli = (label, args, extra, expected) => command(label, process.execPath, [join(root, 'lfs.mjs'), ...args], extra, expected);
const sdk = (label, body) => command(label, process.execPath, ['--input-type=module', '-e', `const {LayerFS}=await import(process.env.LAYERFS_API+'/agent/sdk/src/index.js');const lf=await LayerFS.open('h16');try{${body}}finally{await lf.close();}`]);
function ps(label) {
  const lines = command(label, 'ps', ['-axo', 'pid,ppid,command']).stdout.split('\n').filter(l => /layerfs-daemon(?: |$)/.test(l));
  snapshots.push({ label, lines });
  return lines.filter(l => l.includes(dir));
}
const read = () => JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
let success = false;
try {
  for (const args of [['init', '-q'], ['config', 'user.name', 'H16'], ['config', 'user.email', 'h16@example.invalid']]) command('seed git', 'git', ['--no-pager', ...args]);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  command('seed add', 'git', ['--no-pager', 'add', 'a.txt']); command('seed commit', 'git', ['--no-pager', 'commit', '-qm', 'seed']);
  cli('init', ['init', 'h16']); assert.equal(ps('before failure').length, 0);
  cli('fresh open failure', ['fork', 'broken'], { H14_FAULT: 'herdr' }, 1);
  assert.ok(read().projects.h16.closed.broken.failed);
  assert.ok(!command('failed mount check', 'mount', []).stdout.includes(dir));
  const leaked = ps('after fresh failure');
  if (process.env.H16_EXPECT_LEAK === '1') {
    assert.equal(leaked.length, 1, 'baseline leaves its daemon alive');
    sdk('baseline explicit cleanup', "await lf.sandbox.close('1');");
  } else {
    assert.equal(leaked.length, 0, 'failed fork must stop its new unused daemon');
    cli('normal fork', ['fork', 'normal']);
    const id = Object.keys(read().workspaces)[0], entry = read().workspaces[id];
    assert.equal(ps('shared before failure').length, 1);
    cli('shared open failure', ['fork', 'shared-broken'], { H14_FAULT: 'herdr' }, 1);
    assert.equal(ps('shared after failure').length, 1, 'existing shared daemon stays alive');
    sdk('shared view still readable', `const w=await lf.sandbox.list_workspaces('${entry.sandbox}');if(!w.items.some(w=>w.path===${JSON.stringify(entry.path)}))throw Error('shared view lost');`);
    cli('normal close', ['on-close'], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ workspace_id: id }) });
    assert.deepEqual(read().workspaces, {});
    assert.ok(read().projects.h16.closed.normal);
    sdk('normal explicit sandbox cleanup', `await lf.sandbox.close('${entry.sandbox}');`);
  }
  assert.equal(ps('final ps').length, 0);
  assert.ok(!command('final mounts', 'mount', []).stdout.includes(dir));
  success = true;
} finally {
  console.log(JSON.stringify({ dir, success, mode: process.env.H16_EXPECT_LEAK ? 'baseline' : 'fixed', report, snapshots }));
  if (success) rmSync(dir, { recursive: true });
  else console.error(`Preserved ${dir} for inspection; do not blindly replay mutations.`);
}
