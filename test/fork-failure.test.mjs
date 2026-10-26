import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (bin, args, opts) => spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, ...opts });
function fixture() {
  mkdirSync('/Users/jiangkoumo/LayerFS/tmp/h14', { recursive: true });
  const dir = mkdtempSync('/Users/jiangkoumo/LayerFS/tmp/h14/unit-');
  const repo = join(dir, 'repo'), state = join(dir, 'state');
  for (const path of [repo, state, join(dir, 'config')]) mkdirSync(path);
  const g = (...args) => { const r = run('git', ['--no-pager', '-C', repo, ...args]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.name', 'H14'); g('config', 'user.email', 'h14@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'base\n'); g('add', 'a.txt'); g('commit', '-qm', 'seed');
  const fakeHerdr = join(root, 'test/fixtures/herdr.mjs'); chmodSync(fakeHerdr, 0o755);
  writeFileSync(join(state, 'herdr.json'), JSON.stringify({ calls: [], live: { 'bad-caller': true, 'repo-caller': true }, n: 0 }));
  const env = { ...process.env, HERDR_PLUGIN_ID: '', HERDR_PLUGIN_CONTEXT_JSON: '{}', HERDR_PLUGIN_CONFIG_DIR: join(dir, 'config'), HERDR_PLUGIN_STATE_DIR: state,
    HERDR_BIN_PATH: fakeHerdr, HERDR_WORKSPACE_ID: 'repo-caller', LFS_CWD: repo, LFS_STATE_DIR: state,
    LAYERFS_API: join(root, 'test/fixtures'), LAYERFS_SANDBOX: 'native', LAYERFS_DAEMON: '/unused',
    LAYERFS_LOCAL_DIR: join(dir, 'local'), LAYERFS_HOME: join(dir, 'home'), LAYERFS_STORE_PATH: join(dir, 'vol/p/global/store.sqlite') };
  const call = (args, extra = {}) => run(process.execPath, [join(root, 'lfs.mjs'), ...args], { cwd: repo, env: { ...env, ...extra } });
  const ok = (args, extra) => { const r = call(args, extra); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  const stateFile = join(state, 'state.json');
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const set = s => writeFileSync(stateFile, JSON.stringify(s));
  ok(['init', 'h14']);
  return { dir, repo, state, g, call, ok, read, set, sdk: () => JSON.parse(readFileSync(join(state, 'sdk.json'), 'utf8')),
    herdr: () => JSON.parse(readFileSync(join(state, 'herdr.json'), 'utf8')), cleanup: () => rmSync(dir, { recursive: true }) };
}

test('fork failure is closed, unmounted and unlinked; reopen/drop keep Store history', () => {
  const f = fixture();
  try {
    const r = f.call(['fork', 'broken'], { H14_FAULT: 'herdr' });
    assert.equal(r.status, 1); assert.match(r.stderr + r.stdout, /reopen broken/);
    const s = f.read(), e = s.projects.h14.closed.broken;
    assert.match(e.failed, /injected herdr/); assert.equal(e.parent, 'main'); assert.equal(e.gitBranch, 'lfs/broken');
    assert.equal(Object.keys(f.sdk().mounts).length, 0);
    assert.doesNotMatch(f.g('worktree', 'list', '--porcelain'), /lfs\/broken/);
    assert.match(f.ok(['list']).stdout, /closed\s+broken \(fork failed:/);
    const duplicate = f.call(['fork', 'broken']); assert.equal(duplicate.status, 1); assert.match(duplicate.stderr + duplicate.stdout, /reopen broken/);
    f.ok(['reopen', 'broken']); assert.equal(Object.values(f.read().workspaces)[0].gitBranch, 'lfs/broken');
    f.ok(['drop', 'broken']); assert.ok(f.sdk().branches.broken);
    f.ok(['reopen', 'broken']); f.ok(['drop', 'broken', '--delete-git-branch']); assert.ok(f.sdk().branches.broken);
    assert.equal(f.call(['reopen', 'absent']).status, 1);
  } finally { f.cleanup(); }
});

test('sandbox and commit failures retain recoverable metadata', () => {
  for (const fault of ['sandbox', 'commit']) {
    const f = fixture();
    try {
      assert.equal(f.call(['fork', 'broken'], { H14_FAULT: fault }).status, 1);
      assert.ok(f.read().projects.h14.closed.broken.failed);
      assert.equal(Object.keys(f.sdk().mounts).length, 0);
      assert.doesNotMatch(f.g('worktree', 'list', '--porcelain'), /lfs\/broken/);
      f.ok(['reopen', 'broken']); f.ok(['drop', 'broken']);
    } finally { f.cleanup(); }
  }
});

test('unmount failure retains evidence and blocks unsafe reopen/drop', () => {
  const f = fixture();
  try {
    // Herdr open and unmount both fail via independent fixture faults.
    const r = f.call(['fork', 'broken'], { H14_FAULT: 'herdr', H14_UNMOUNT_FAIL: '1' });
    assert.equal(r.status, 1);
    const e = f.read().projects.h14.closed.broken;
    assert.match(e.cleanupFailed, /unmount/); assert.ok(Object.keys(f.sdk().mounts).length);
    assert.equal(f.call(['reopen', 'broken']).status, 1);
    assert.equal(f.call(['drop', 'broken']).status, 1);
    assert.ok(f.read().projects.h14.closed.broken);
  } finally { f.cleanup(); }
});

test('uncertain mount response is inspected and not replayed', () => {
  const f = fixture();
  try {
    assert.equal(f.call(['fork', 'broken'], { H14_FAULT: 'mount-response' }).status, 1);
    const e = f.read().projects.h14.closed.broken;
    assert.match(e.cleanupFailed, /mount result unknown/);
    assert.equal(Object.keys(f.sdk().mounts).length, 1);
    assert.equal(f.call(['reopen', 'broken']).status, 1);
    assert.equal(Object.keys(f.sdk().mounts).length, 1);
    assert.equal(f.call(['drop', 'broken']).status, 1);
  } finally { f.cleanup(); }
});

test('empty mount list cannot prove no effect, including a filtered pending view', () => {
  for (const fault of ['mount', 'mount-pending']) {
    const f = fixture();
    try {
      assert.equal(f.call(['fork', 'broken'], { H14_FAULT: fault }).status, 1);
      const before = f.sdk();
      assert.equal(Object.values(before.mounts).filter(w => w.mounted && w.directory).length, 0);
      assert.equal(Object.keys(before.mounts).length, fault === 'mount-pending' ? 1 : 0);
      assert.match(f.read().projects.h14.closed.broken.cleanupFailed, /mount result unknown/);
      assert.equal(f.call(['reopen', 'broken']).status, 1);
      assert.equal(f.call(['drop', 'broken']).status, 1);
      assert.deepEqual(f.sdk(), before);
    } finally { f.cleanup(); }
  }
});

test('Git link index-reset failure cleans only its admin and preserves both Git branches', () => {
  const f = fixture();
  try {
    f.ok(['fork', 'other']);
    const other = Object.values(f.read().workspaces)[0];
    const otherAdmin = readFileSync(join(other.path, '.git'), 'utf8').trim().replace(/^gitdir: /, '');
    const otherHead = readFileSync(join(otherAdmin, 'HEAD'), 'utf8');
    const otherBacklink = readFileSync(join(otherAdmin, 'gitdir'), 'utf8');
    const bin = join(f.dir, 'bin'); mkdirSync(bin);
    const actualGit = run('which', ['git']); assert.equal(actualGit.status, 0);
    const shim = join(bin, 'git');
    writeFileSync(shim, `#!/bin/sh
if [ "$3" = reset ] && [ "$4" = -q ]; then
  echo "injected git link index-reset failure" >&2
  exit 1
fi
exec '${actualGit.stdout.trim()}' "$@"
`); chmodSync(shim, 0o755);
    const r = f.call(['fork', 'broken'], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 1);
    const closed = f.read().projects.h14.closed.broken;
    assert.match(closed.failed, /Git git reset -q:.*injected/);
    assert.ok(!closed.cleanupFailed);
    assert.equal(readFileSync(join(otherAdmin, 'HEAD'), 'utf8'), otherHead);
    assert.equal(readFileSync(join(otherAdmin, 'gitdir'), 'utf8'), otherBacklink);
    const registrations = f.g('worktree', 'list', '--porcelain');
    assert.match(registrations, /refs\/heads\/lfs\/other/);
    assert.doesNotMatch(registrations, /refs\/heads\/lfs\/broken/);
    f.g('show-ref', '--verify', 'refs/heads/lfs/broken');
    f.g('show-ref', '--verify', 'refs/heads/lfs/other');
    assert.ok(f.sdk().mounts[other.path]);
    assert.equal(Object.keys(f.sdk().mounts).length, 1);
    f.ok(['reopen', 'broken']); f.ok(['drop', 'broken']); f.ok(['drop', 'other']);
  } finally { f.cleanup(); }
});

test('unrecorded existing branch restores Git metadata and duplicate fork is friendly', () => {
  const f = fixture();
  try {
    f.ok(['fork', 'orphan']); f.ok(['drop', 'orphan']);
    const r = f.call(['fork', 'orphan']); assert.equal(r.status, 1); assert.match(r.stderr + r.stdout, /reopen orphan/);
    f.ok(['reopen', 'orphan']);
    const entry = Object.values(f.read().workspaces)[0]; assert.equal(entry.gitBranch, 'lfs/orphan');
    assert.match(f.g('worktree', 'list', '--porcelain'), /lfs\/orphan/);
    const repeat = f.call(['reopen', 'orphan']); assert.equal(repeat.status, 1);
    f.ok(['drop', 'orphan']);
  } finally { f.cleanup(); }
});

test('non-Git caller uses cwd immediately; saved invalid routing falls back once; repo caller unchanged', () => {
  const f = fixture();
  try {
    f.ok(['fork', 'normal']);
    const id = Object.keys(f.read().workspaces)[0];
    const duplicate = f.call(['fork', 'normal']);
    assert.equal(duplicate.status, 1);
    assert.ok((duplicate.stderr + duplicate.stdout).includes(`already open as workspace ${id}`));
    assert.doesNotMatch(duplicate.stderr + duplicate.stdout, /use reopen/);
    assert.ok(f.herdr().calls.some(c => c.includes('--workspace') && c.includes('repo-caller')));
    f.ok(['drop', 'normal']);
    const s = f.read(); s.projects.h14.herdrWs = null; f.set(s);
    f.ok(['fork', 'outside'], { HERDR_WORKSPACE_ID: 'bad-caller' });
    assert.ok(!f.herdr().calls.some(c => c[0] === 'worktree' && c[1] === 'open' && c.includes('bad-caller')));
    f.ok(['drop', 'outside']);
    const stale = f.read(); stale.projects.h14.herdrWs = 'bad-caller'; f.set(stale);
    f.ok(['fork', 'fallback'], { HERDR_WORKSPACE_ID: 'bad-caller' });
    assert.equal(f.read().projects.h14.herdrWs, null);
    assert.ok(f.herdr().calls.some(c => c.includes('--cwd') && c.includes(f.repo)));
    f.ok(['drop', 'fallback']);
  } finally { f.cleanup(); }
});

test('normal fork/commit/merge/reopen/startup/drop paths', () => {
  const f = fixture();
  try {
    f.ok(['fork', 'normal']); const id = Object.keys(f.read().workspaces)[0];
    f.ok(['commit'], { HERDR_WORKSPACE_ID: id });
    f.ok(['merge', 'main', '--name', 'merged'], { HERDR_WORKSPACE_ID: id });
    f.ok(['reopen', 'merged']); f.ok(['startup']);
    for (const name of ['normal', 'merged']) f.ok(['drop', name]);
    assert.deepEqual(f.read().workspaces, {});
  } finally { f.cleanup(); }
});
