// herdr × LayerFS. One short process per action / hook; state lives in state.json.
//   native mode (LAYERFS_SANDBOX=native, macOS/Linux): the Workspace is a host directory (loopback NFS on macOS).
//     A repo is imported from `git archive HEAD`, and every Branch is registered as a linked git worktree of the
//     source repo, so Herdr groups it under the repo's workspace (sidebar tree) and git runs on the host as usual.
//   docker mode (default, upstream main on Linux): the Workspace lives inside the Sandbox container; the new
//     Herdr workspace's root pane enters it with `docker exec`.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync, mkdtempSync, readdirSync, cpSync, copyFileSync } from "node:fs";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const [cmd, arg] = process.argv.slice(2);
const DEFAULT_LWW = `# Generated files keep the newer version whole during LayerFS merges.
%include .gitignore
package-lock.json
npm-shrinkwrap.json
pnpm-lock.yaml
yarn.lock
Cargo.lock
bun.lock
bun.lockb
uv.lock
poetry.lock
Pipfile.lock
Gemfile.lock
composer.lock
*.log
node_modules/
dist/
build/
target/
coverage/
.cache/
.pytest_cache/
__pycache__/
.next/
.turbo/
`;
const quietHook = cmd === "on-close" || cmd === "startup";

// Run from a shell (an agent's pane) instead of by Herdr: `node <plugin_root>/lfs.mjs fork [name]`. Herdr's own CLI
// invoke acts on the workspace focused in the UI, not the caller's, so a direct run uses the pane's HERDR_WORKSPACE_ID
// and cwd, and finds the config dir and state dir that Herdr-launched runs use.
const direct = !process.env.HERDR_PLUGIN_ID;
if (direct && !process.env.HERDR_PLUGIN_CONFIG_DIR) {
  const r = spawnSync(herdr, ["plugin", "config-dir", "layerfs"], { encoding: "utf8" });
  if (!r.status && r.stdout.trim()) process.env.HERDR_PLUGIN_CONFIG_DIR = r.stdout.trim();
}
const cfgDir = process.env.HERDR_PLUGIN_CONFIG_DIR || ".";
const stPtr = join(cfgDir, ".state-dir");
if (direct && !process.env.HERDR_PLUGIN_STATE_DIR && existsSync(stPtr)) process.env.HERDR_PLUGIN_STATE_DIR = readFileSync(stPtr, "utf8").trim();
if (!direct && process.env.HERDR_PLUGIN_STATE_DIR && process.env.HERDR_PLUGIN_CONFIG_DIR) {
  try { if (!existsSync(stPtr) || readFileSync(stPtr, "utf8").trim() !== process.env.HERDR_PLUGIN_STATE_DIR) writeFileSync(stPtr, process.env.HERDR_PLUGIN_STATE_DIR + "\n"); } catch {}
}
const cfgFile = join(cfgDir, "config.env");
if (existsSync(cfgFile)) for (const l of readFileSync(cfgFile, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^~(?=\/)/, process.env.HOME);
}
const missing = ["LAYERFS_API"].filter((k) => !process.env[k]);
if (missing.length) { if (quietHook) process.exit(0); fail(`set ${missing.join(", ")} in ${cfgFile} (see config.env.example)`); }
const native = process.env.LAYERFS_SANDBOX === "native";
if (!native && process.platform !== "linux") { if (quietHook) process.exit(0); fail("docker mode needs a Linux host (upstream main). On macOS set LAYERFS_SANDBOX=native (LayerFS PR #427)"); }
if (native) {
  for (const k of ["LAYERFS_DAEMON", "LAYERFS_LOCAL_DIR", "LAYERFS_HOME", "LAYERFS_STORE_PATH"]) if (!process.env[k]) fail(`native mode needs ${k} in ${cfgFile}`);
  mkdirSync(process.env.LAYERFS_LOCAL_DIR, { recursive: true }); chmodSync(process.env.LAYERFS_LOCAL_DIR, 0o755);
}
if (process.env.LAYERFS_STORE_PATH) mkdirSync(dirname(dirname(process.env.LAYERFS_STORE_PATH)), { recursive: true }); // Init makes the Store folder itself (0700)

// state can be pinned with LFS_STATE_DIR so actions, hooks and every Herdr session share it
const stDir = process.env.LFS_STATE_DIR || process.env.HERDR_PLUGIN_STATE_DIR || ".";
if (direct && !process.env.LFS_STATE_DIR && !process.env.HERDR_PLUGIN_STATE_DIR) fail("run any LayerFS action from Herdr once first (it records where the plugin keeps its state), or set LFS_STATE_DIR in config.env");
const stFile = join(stDir, "state.json");
const st = existsSync(stFile) ? JSON.parse(readFileSync(stFile, "utf8")) : { projects: {}, workspaces: {} };
const save = () => { mkdirSync(stDir, { recursive: true }); writeFileSync(stFile, JSON.stringify(st, null, 2)); };

function notify(msg) { spawnSync(herdr, ["notification", "show", "LayerFS", "--body", msg, "--sound", "none"], { stdio: "ignore" }); console.log(msg); }
function fail(msg) { console.error(`layerfs: ${msg}`); notify(`error: ${msg}`); process.exit(1); }
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: "utf8", ...opts });
const git = (dir, ...a) => { const r = run("git", ["-C", dir, ...a]); if (r.error || r.status !== 0) throw Object.assign(new Error(`git ${a.join(" ")}: ${r.error?.message || r.stderr.trim()}`), { code: "Git" }); return r.stdout.trim(); };
const H = (...a) => { const r = run(herdr, a); if (r.error || r.status !== 0) throw Object.assign(new Error(`herdr ${a.join(" ")}: ${r.error?.message || (r.stderr || r.stdout).trim()}`), { code: "Herdr" }); try { return JSON.parse(r.stdout); } catch { return r.stdout; } };
const herdrWorkspaces = () => { try { return H("workspace", "list").result.workspaces.map((w) => w.workspace_id); } catch { return []; } };

// focused directory / workspace from Herdr's context
const ctx = (() => { try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch { return {}; } })();
const findKey = (o, k) => { if (!o || typeof o !== "object") return; if (typeof o[k] === "string") return o[k]; for (const v of Object.values(o)) { const r = findKey(v, k); if (r) return r; } };
const wsId = process.env.HERDR_WORKSPACE_ID || findKey(ctx, "workspace_id");
const cwd = resolve(process.env.LFS_CWD || findKey(ctx, "cwd") || process.cwd());

const { LayerFS } = await import(join(process.env.LAYERFS_API, "agent/sdk/src/index.js"));
const projName = (dir) => basename(dir).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 63) || "repo";
const gitTop = (dir) => { const r = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]); return r.status ? null : r.stdout.trim(); };
const isMounted = (path) => existsSync(path) && run("mount", []).stdout.includes(` on ${path} `);

async function sandboxFor(lf, project) {
  const p = st.projects[project];
  const live = (await lf.project.list_sandboxes(50, 0)).items ?? [];
  const hit = live.find((s) => s.sandbox === p.sandbox) || live.find((s) => s.workspaces < 16);
  if (hit) { p.sandbox = hit.sandbox; p.container = hit.name; save(); return hit.sandbox; }
  p.sandbox = (await lf.sandbox.create()).sandbox;
  p.container = ((await lf.project.list_sandboxes(50, 0)).items ?? []).find((s) => s.sandbox === p.sandbox)?.name;
  save(); return p.sandbox;
}

// --- git worktree registration (native mode) ---------------------------------------------------
// The mount gets a `.git` file pointing at <repo>/.git/worktrees/<id>; `git worktree repair` writes the back link.
function adminOf(p, gitBranch) {                                // <repo>/.git/worktrees/<id> whose HEAD is the branch
  const root = join(git(p.source, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktrees");
  if (!existsSync(root)) return null;
  for (const id of readdirSync(root)) {
    try { if (readFileSync(join(root, id, "HEAD"), "utf8").trim() === `ref: refs/heads/${gitBranch}`) return join(root, id); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  return null;
}
function linkWorktree(e, p) {
  const dotgit = join(e.path, ".git");
  const linked = (() => { try { return readFileSync(dotgit, "utf8").match(/^gitdir: (.*)$/m)?.[1]; } catch { return null; } })();
  if (linked) {
    let head = null; try { head = readFileSync(join(linked, "HEAD"), "utf8").trim(); } catch {}
    if (head === `ref: refs/heads/${e.gitBranch}`) { git(p.source, "worktree", "repair", e.path); return; } // remount: path may have moved
    rmSync(dotgit, { force: true });                             // inherited from the Branch this one was forked from
  }
  const admin = adminOf(p, e.gitBranch);
  if (admin) {                                                   // registered before, but this Branch never saved its .git file
    writeFileSync(join(e.path, ".git"), `gitdir: ${admin}\n`);
    git(p.source, "worktree", "repair", e.path);
    git(e.path, "reset", "-q");
    return;
  }
  const tmp = mkdtempSync(join(stDir, "wt-")); rmSync(tmp, { recursive: true });
  const exists = run("git", ["-C", p.source, "rev-parse", "--verify", "-q", `refs/heads/${e.gitBranch}`]).status === 0;
  git(p.source, "worktree", "add", "--no-checkout", ...(exists ? [tmp, e.gitBranch] : ["-b", e.gitBranch, tmp, e.base]));
  writeFileSync(join(e.path, ".git"), readFileSync(join(tmp, ".git")));
  rmSync(tmp, { recursive: true, force: true });
  git(p.source, "worktree", "repair", e.path);
  git(e.path, "reset", "-q");                                    // index from HEAD; the files are already there
}
function unlinkWorktree(e, p) {
  // The mount is already gone: locate only this branch's registration in the source repo.
  // Do not use git worktree remove: it can delete the mount directory or another live view.
  const admin = adminOf(p, e.gitBranch);
  if (admin) {
    if (resolve(readFileSync(join(admin, "gitdir"), "utf8").trim()) !== join(e.path, ".git"))
      throw new Error(`Git worktree ${e.gitBranch} points elsewhere; inspect ${admin} before cleanup`);
    rmSync(admin, { recursive: true, force: true });
  }
}

// --- open the Herdr workspace for a mounted Workspace -------------------------------------------
function openHerdr(e, p) {
  if (native && e.gitBranch) {
    const parent = herdrWorkspaces().includes(p.herdrWs) ? ["--workspace", p.herdrWs] : ["--cwd", p.source];
    const r = H("worktree", "open", ...parent, "--path", e.path, "--label", `lfs:${e.branch}`, "--no-focus");
    return r?.result?.workspace?.workspace_id ?? findKey(r, "workspace_id");
  }
  const r = H("workspace", "create", "--cwd", native ? e.path : p.source, "--label", `lfs:${e.branch}`, "--no-focus");
  const id = r.result.workspace.workspace_id;
  if (!native) H("pane", "run", r.result.root_pane.pane_id, `docker exec -it -w '${e.path}' ${p.container} sh -c 'command -v bash >/dev/null && exec bash -l || exec sh -l'`);
  return id;
}

// a fresh mount -> git link (saved at once, so a reboot keeps it) -> Herdr workspace; unmounted again on failure
async function opened(lf, e, p, fresh) {
  try {
    if (e.gitBranch) { linkWorktree(e, p); if (fresh) await lf.workspace.commit({ sandbox: e.sandbox, path: e.path }, `herdr: link git worktree ${e.gitBranch}`); }
    const id = openHerdr(e, p);
    st.workspaces[id] = e; save();
    return id;
  } catch (err) {
    try { await lf.workspace.unmount({ sandbox: e.sandbox, path: e.path }, fresh); } catch {}
    throw err;
  }
}

async function dockerMounted(lf, e) {                           // the Sandbox still runs and still holds this Workspace
  try { return ((await lf.sandbox.list_workspaces(e.sandbox)).items ?? []).some((w) => w.path === e.path); } catch { return false; }
}

// docker mode: closing a pane ends the `docker exec` client but not the shell it started in the container,
// which would keep the Workspace busy; hang up every process whose cwd is inside it
function leaveShells(e, p) {
  if (!p.container) return;
  const script = `for d in /proc/[0-9]*; do c=$(readlink "$d/cwd" 2>/dev/null) || continue; case "$c" in "$1"|"$1"/*) kill -HUP "\${d#/proc/}" 2>/dev/null;; esac; done; sleep 0.3`;
  const r = run("docker", ["exec", p.container, "sh", "-c", script, "sh", e.path]);
  if (r.error || r.status !== 0) throw new Error(`cannot stop workspace shells: ${r.error?.message || r.stderr.trim()}`);
}

const entryHere = () => st.workspaces[wsId];
const projectHere = () => entryHere()?.project
  || Object.entries(st.projects).find(([, p]) => p.source === cwd || p.source === gitTop(cwd))?.[0];

let lf;
try {
  if (cmd === "init") {
    const top = gitTop(cwd); const source = top || cwd;
    const name = arg || projName(source);
    if (st.projects[name]) fail(`project ${name} already imported from ${st.projects[name].source}`);
    let from = source, tmp = null, base = null;
    if (native && top) {                                          // tracked files at HEAD; .git stays on the host
      base = git(top, "rev-parse", "HEAD");
      tmp = mkdtempSync(join(stDir, "seed-"));
      const r = spawnSync("/bin/sh", ["-c", `git -C "${top}" archive --format=tar HEAD | tar -x -C "${tmp}"`]);
      if (r.status) fail(`git archive failed: ${r.stderr}`);
      from = tmp;
      const dirty = git(top, "status", "--porcelain", "--untracked-files=no");
      if (dirty) notify(`note: uncommitted changes in ${top} are not imported (HEAD ${base.slice(0, 9)} is)`);
    }
    notify(`importing ${source} as ${name}…`);
    try {
      // Never add rules to the source. Native git imports already own a disposable archive.
      if (tmp && !existsSync(join(from, ".lww")) && existsSync(join(source, ".lww")))
        copyFileSync(join(source, ".lww"), join(from, ".lww"));
      if (process.env.LFS_NO_DEFAULT_LWW !== "1" && !existsSync(join(from, ".lww"))) {
        if (!tmp) {
          tmp = mkdtempSync(join(stDir, "seed-"));
          cpSync(source, tmp, { recursive: true });
          from = tmp;
        }
        writeFileSync(join(from, ".lww"), DEFAULT_LWW);
      }
      lf = await LayerFS.init(name, from, 1_800_000);
    } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
    st.projects[name] = { source, git: !!(native && top), base, sandbox: null, container: null, herdrWs: wsId ?? null, n: 0 }; save();
    notify(`imported ${name}${base ? ` at ${base.slice(0, 9)}` : ""}`);
  } else if (cmd === "fork") {
    const here = entryHere();
    const project = projectHere() || fail(`no LayerFS project for ${cwd}; run "LayerFS: import this repo" first`);
    const p = st.projects[project]; if (!here && wsId) p.herdrWs = wsId;
    lf = await LayerFS.open(project);
    const branch = arg || `agent-${++p.n}`; save();
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(branch)) fail(`bad branch name ${branch}`);
    if (here) await lf.workspace.commit({ sandbox: here.sandbox, path: here.path }, `herdr: before fork ${branch}`); // fork sees saved state only
    await lf.branch.fork(branch, here?.branch);                  // from the focused LayerFS branch, else main
    const sb = await sandboxFor(lf, project);
    const w = await lf.workspace.mount(sb, branch);
    const e = { project, branch, parent: here?.branch || "main", sandbox: sb, path: w.path, gitBranch: p.git ? `lfs/${branch}` : null,
      base: p.git ? (here ? git(here.path, "rev-parse", "HEAD") : p.base) : null };
    const id = await opened(lf, e, p, true);
    notify(`${branch} ready (${id})`);
  } else if (cmd === "merge") {
    const e = entryHere() || fail("this workspace is not a LayerFS branch");
    let withBranch, requestedName, open = false;
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--open" && !open) open = true;
      else if (a === "--name" && requestedName === undefined && args[i + 1] && !args[i + 1].startsWith("-")) requestedName = args[++i];
      else if (!a.startsWith("-") && withBranch === undefined) withBranch = a;
      else fail(`invalid merge argument ${a}; use merge [with] [--name <new-branch>] [--open] (--publish and --strategy are not supported)`);
    }
    withBranch ??= e.parent || "main";
    if (withBranch === e.branch) fail(`cannot merge ${e.branch} with itself; pass the other branch`);
    const validName = (s) => /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/.test(s) && s !== "main";
    if (requestedName !== undefined && !validName(requestedName)) fail(`bad new branch name ${requestedName}`);
    lf = await LayerFS.open(e.project);
    // Choose a free name before attempting the merge; never replay a failed merge.
    const names = new Set();
    for (let pos = 0; ; ) {
      const page = await lf.project.list_branches(50, pos);
      for (const b of page.items) names.add(b.name);
      if (!page.hasMore) break;
      pos += page.items.length;
    }
    const stem = requestedName ?? (`${e.branch}-x-${withBranch}`.toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 63).replace(/[^a-z0-9]+$/g, "") || "merge");
    let name = stem;
    for (let n = 2; names.has(name); n++) {
      const suffix = `-${n}`;
      name = stem.slice(0, 63 - suffix.length).replace(/[^a-z0-9]+$/g, "") + suffix;
    }
    await lf.workspace.commit({ sandbox: e.sandbox, path: e.path }, `herdr: before merge ${e.branch} with ${withBranch}`);
    const merged = await lf.branch.merge(e.branch, withBranch, name, `herdr: merge ${e.branch} with ${withBranch}`);
    const p = st.projects[e.project];
    const meta = { parent: withBranch, gitBranch: p.git ? `lfs/${name}` : null,
      base: p.git ? git(e.path, "rev-parse", "HEAD") : null };
    p.closed ||= {}; p.closed[name] = meta; save();
    notify(`merged ${e.branch} with ${withBranch} into new branch ${name} (${merged.fastForward ? "fast-forward" : "merge"}); inputs unchanged${merged.lww?.length ? `; lww: ${merged.lww.map((d) => `${d.path} (${d.kept})`).join(", ")}` : ""}`);
    if (open) {
      const sb = await sandboxFor(lf, e.project);
      const w = await lf.workspace.mount(sb, name);
      const id = await opened(lf, { project: e.project, branch: name, sandbox: sb, path: w.path, ...meta }, p, true);
      delete p.closed[name]; save();
      notify(`${name} ready (${id})`);
    }
  } else if (cmd === "commit") {
    const e = entryHere() || fail("this workspace is not a LayerFS branch");
    lf = await LayerFS.open(e.project);
    await lf.workspace.commit({ sandbox: e.sandbox, path: e.path }, arg || `herdr: ${e.branch}`);
    notify(`committed ${e.branch}`);
  } else if (cmd === "drop" || cmd === "on-close") {
    let id = wsId;
    if (cmd === "on-close") id = findKey(JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}"), "workspace_id");
    const e = st.workspaces[id];
    if (!e) { if (cmd === "on-close") process.exit(0); fail("this workspace is not a LayerFS branch"); }
    if (cmd === "on-close" && e.cleanup) process.exit(0); // drop's close hook must not commit or unmount again
    const p = st.projects[e.project];
    const ws = { sandbox: e.sandbox, path: e.path };
    try {
      if (!e.cleanup?.unmounted) {
        lf = await LayerFS.open(e.project);
        if (cmd === "on-close") await lf.workspace.commit(ws, `herdr: ${e.branch} (closed)`);
        if (!native) leaveShells(e, p);
        await lf.workspace.unmount(ws, cmd === "drop"); // one attempt; Busy/uncertain failure retains the record
        e.cleanup = { unmounted: true }; save();
      }
      if (cmd === "drop") {
        if (!e.cleanup.unlinked) {
          if (e.gitBranch) unlinkWorktree(e, p); // Git branches and LayerFS history are always kept
          e.cleanup.unlinked = true; save();
        }
        if (!e.cleanup.closed) {
          H("workspace", "close", id); // do not hide UI cleanup failures
          e.cleanup.closed = true; save();
        }
      } else {
        p.closed ||= {}; p.closed[e.branch] = { parent: e.parent || "main", gitBranch: e.gitBranch, base: e.base };
      }
      delete st.workspaces[id];
      try { save(); } catch (err) { st.workspaces[id] = e; throw err; }
    } catch (err) {
      console.error(`Workspace record retained for ${id}. Close panes/processes using ${e.path}, leave that directory, then run drop again from another pane with HERDR_WORKSPACE_ID=${id}. If cleanup already unmounted it, drop resumes the remaining Git/Herdr cleanup. Inspect uncertain errors before continuing.`);
      throw err;
    }
    notify(cmd === "drop" ? `discarded ${e.branch}${e.gitBranch ? ` (git branch ${e.gitBranch} kept)` : ""}` : `saved ${e.branch}; reopen it with "LayerFS: reopen branch"`);
  } else if (cmd === "reopen") {                                 // mount a saved branch again (arg = branch, default newest closed)
    const project = projectHere() || fail(`no LayerFS project for ${cwd}`);
    const p = st.projects[project]; const names = Object.keys(p.closed || {});
    const branch = arg || names.at(-1) || fail("no closed LayerFS branch to reopen");
    lf = await LayerFS.open(project);
    const sb = await sandboxFor(lf, project);
    const w = await lf.workspace.mount(sb, branch);
    const e = { project, branch, sandbox: sb, path: w.path, ...(p.closed?.[branch] ?? { gitBranch: null, base: null }) };
    const id = await opened(lf, e, p, false);
    delete p.closed?.[branch]; save();
    notify(`${branch} reopened (${id})`);
  } else if (cmd === "startup") {                                // after a reboot / server restart: remount and reopen
    const live = herdrWorkspaces(); let n = 0;
    for (const [id, e] of Object.entries(st.workspaces)) {
      if (e.cleanup) { console.error(`cleanup pending for ${id} (${e.branch}); run drop with HERDR_WORKSPACE_ID=${id} to finish`); continue; }
      const p = st.projects[e.project];
      try {
        lf = await LayerFS.open(e.project);
        const mounted = native ? isMounted(e.path) : await dockerMounted(lf, e);
        if (native && mounted && live.includes(id)) { await lf.close?.(); lf = null; continue; } // nothing lost
        // docker mode: the pane's `docker exec` ended with the server, so the workspace is reopened either way
        if (!mounted) {
          const sb = await sandboxFor(lf, e.project);
          const w = await lf.workspace.mount(sb, e.branch);
          Object.assign(e, { sandbox: sb, path: w.path });
          if (e.gitBranch) linkWorktree(e, p);
        }
        delete st.workspaces[id]; save();                         // before the close, so on-close leaves the mount alone
        if (live.includes(id)) { try { H("workspace", "close", id); } catch {} } // restored with a dead cwd
        if (!native && mounted) leaveShells(e, p);
        st.workspaces[openHerdr(e, p)] = e; save(); n++;
        await lf.close?.(); lf = null;
      } catch (err) { console.error(`restore ${e.branch}: ${err.code ?? ""} ${err.message}`); }
    }
    if (n) notify(`restored ${n} LayerFS workspace${n > 1 ? "s" : ""}`);
  } else if (cmd === "list") {
    for (const [name, p] of Object.entries(st.projects)) {
      console.log(`${name}  ← ${p.source}${p.base ? ` @${p.base.slice(0, 9)}` : ""}  sandbox=${p.sandbox ?? "-"}`);
      for (const [id, e] of Object.entries(st.workspaces).filter(([, e]) => e.project === name))
        console.log(`  open    ${id.padEnd(6)} ${e.branch.padEnd(20)} ${e.gitBranch ?? ""}  ${e.path}`);
      for (const b of Object.keys(p.closed || {})) console.log(`  closed         ${b}`);
    }
  } else fail(`unknown command ${cmd}`);
} catch (e) {
  if (e.code === "Conflict") {
    for (const c of e.detail?.conflicts ?? []) console.error(`${c.path}: ${c.kind}`);
    if (e.detail?.conflictsTruncated) console.error("conflict list truncated by SDK; inspect both branches with branch.diff_branches");
    console.error("Edit one side and merge again, or add generated paths to /.lww (rules come from the current branch). 改其中一边再 merge，或把生成文件路径加进 .lww。");
  }
  const msg = `${cmd}: ${e.code ?? ""} ${String(e.message).slice(0, 400)}`;
  console.error(`layerfs: ${msg}`); notify(`error: ${msg}`); process.exitCode = 1;
}
finally { try { await lf?.close?.(); } catch {} }
