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
    save({ branches: { main: seed }, mounts: {}, n: 0 });
    return new LayerFS();
  }
  static async open() { return new LayerFS(); }
  project = {
    list_branches: async () => ({ items: Object.keys(load().branches).map(name => ({ name })), hasMore: false }),
    list_sandboxes: async () => { fault('sandbox'); return { items: [{ sandbox: '1', name: 'test', workspaces: 0 }] }; },
  };
  sandbox = { list_workspaces: async () => ({ items: Object.values(load().mounts) }) };
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
      s.mounts[path] = { sandbox, branch, path }; save(s);
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
