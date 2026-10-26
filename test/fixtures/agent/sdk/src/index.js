// Process-level test double: persistent branches and mounted views, with explicit fault injection.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.LFS_STATE_DIR, 'sdk.json');
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = s => writeFileSync(file, JSON.stringify(s));
const fault = name => { if (process.env.H14_FAULT === name) throw Object.assign(new Error(`injected ${name}`), { code: 'Failed' }); };
export class LayerFS {
  static async init(name, source) {
    const seed = join(process.env.LFS_STATE_DIR, 'seed');
    cpSync(source, seed, { recursive: true });
    save({ branches: { main: seed }, mounts: {}, n: 0, sandboxes: {}, sandboxN: 0, closeCalls: [] });
    return new LayerFS();
  }
  static async open() { return new LayerFS(); }
  project = {
    list_branches: async () => ({ items: Object.keys(load().branches).map(name => ({ name })), hasMore: false }),
    list_sandboxes: async () => {
      fault('sandbox');
      if (process.env.H16_LIST_FAIL_AFTER_CREATE && Object.keys(load().sandboxes).length)
        throw new Error('injected lookup after create');
      return { items: Object.keys(load().sandboxes).map(sandbox => ({ sandbox, name: 'test', workspaces: Object.values(load().mounts).filter(w => w.sandbox === sandbox).length })) };
    },
  };
  // Match SDK filtering: attaching views are not included in this public list.
  sandbox = {
    list_workspaces: async () => ({ items: Object.values(load().mounts).filter(w => w.mounted && w.directory) }),
    create: async () => {
      const s = load(), sandbox = String(++s.sandboxN);
      s.sandboxes[sandbox] = true; save(s); return { sandbox };
    },
    close: async sandbox => {
      const s = load(); s.closeCalls.push(sandbox); save(s);
      if (process.env.H16_CLOSE_FAIL) throw Object.assign(new Error('injected close failure'), { code: 'Failed' });
      // Model the binding's authoritative check, including a concurrent consumer
      // invisible to plugin state and a pending view filtered out by the SDK list.
      if (process.env.H16_CONCURRENT_MOUNT || Object.values(s.mounts).some(w => w.sandbox === sandbox))
        throw Object.assign(new Error('another Workspace is active'), { code: 'MountsActive' });
      delete s.sandboxes[sandbox]; save(s);
    },
  };
  branch = {
    fork: async (name, parent = 'main') => {
      const s = load();
      if (s.branches[name]) throw Object.assign(new Error('branch exists'), { code: 'NameTaken' });
      const path = join(process.env.LFS_STATE_DIR, `branch-${name}`);
      cpSync(s.branches[parent], path, { recursive: true });
      s.branches[name] = path; save(s);
    },
    merge: async (a, b, name) => { await this.branch.fork(name, a); return { fastForward: false }; },
  };
  workspace = {
    mount: async (sandbox, branch) => {
      fault('mount');
      const s = load(), path = join(process.env.LAYERFS_LOCAL_DIR, 'test', 'workspaces', String(++s.n));
      mkdirSync(path, { recursive: true }); cpSync(s.branches[branch], path, { recursive: true });
      s.mounts[path] = { sandbox, branch, path, directory: path, mounted: process.env.H14_FAULT !== 'mount-pending' }; save(s);
      fault('mount-pending');
      fault('mount-response');
      return { sandbox, path };
    },
    commit: async ({ path }) => {
      fault('commit');
      const s = load(), m = s.mounts[path];
      rmSync(s.branches[m.branch], { recursive: true });
      cpSync(path, s.branches[m.branch], { recursive: true });
    },
    unmount: async ({ path }) => {
      if (process.env.H14_UNMOUNT_FAIL) throw new Error('injected unmount failure');
      fault('unmount');
      const s = load(); delete s.mounts[path]; save(s);
      rmSync(path, { recursive: true });
    },
  };
  fs = {
    stat: async (branch, path) => { if (!existsSync(join(load().branches[branch], path))) throw Object.assign(new Error('missing'), { code: 'NoSuchPath' }); },
    rm: async (branch, path) => rmSync(join(load().branches[branch], path), { recursive: true }),
  };
  async close() {}
}
