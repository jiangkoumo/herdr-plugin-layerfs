# LayerFS for Herdr

Parallel agent workspaces without copying your repo. Each [Herdr](https://herdr.dev) workspace this plugin opens is a
[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) branch: a copy-on-write view of the project, so a new one costs
no disk until files change. In native mode every branch is also a linked git worktree of your repo, so Herdr shows it
indented under the repo in the sidebar, exactly like `herdr worktree`, and `git commit` / `git push` work as usual.

[中文说明](#中文说明)

## What it does

| Action | |
|---|---|
| **LayerFS: import this repo** | Snapshots the focused repo into a LayerFS project. Native mode imports the tracked files at `HEAD` (`git archive`); `.git` stays where it is. |
| **LayerFS: new branch workspace** | Forks the project (or the focused LayerFS branch, after saving it) and opens it as a workspace named `lfs:agent-N`, on git branch `lfs/agent-N`. |
| **LayerFS: new named branch** (pane) | Same, asks for the name. |
| **LayerFS: commit this workspace** | Saves the workspace on its LayerFS branch. |
| **LayerFS: discard this workspace** | Closes it and unmounts without saving. The git branch is kept. |
| **LayerFS: reopen last closed branch** | Mounts a saved branch again. |
| **LayerFS: status** (pane) | Projects, open and closed branches. |

Hooks:

- `workspace.closed`: closing a LayerFS workspace in Herdr saves it, then unmounts it.
- `startup`: after Herdr restarts, workspaces whose mounts are gone (a reboot) are mounted again, their git worktree
  links repaired, and reopened in the sidebar group. If the mounts survived (only the server restarted), nothing changes.

Measured on a MacBook Air M2 (macOS 27.2), a 607 MB repo (483 MB of it `.git`), native mode:

| | |
|---|---|
| import | 2.9–3.1 s, Store 312 MB for the whole run |
| new branch workspace (fork, mount, worktree link, save, open) | 2.1–2.2 s, ~0 extra disk |
| commit / discard / reopen | 0.11–0.13 s |
| `git status` in a branch | 0.10 s |
| reboot-style restore of 3 workspaces | all 3 back, git history and saved files intact |

## Modes

- **native** (`LAYERFS_SANDBOX=native`): the branch is a folder on the host; on macOS it is served over loopback NFSv3.
  Needs a LayerFS build with the native backend: [PR #427](https://github.com/Ephemeral-AI-Lab/layerfs/pull/427)
  (not in a release yet). Tested on macOS.
- **docker** (default, upstream `main`, Linux): the branch lives inside the LayerFS Sandbox container; the new
  workspace's first pane enters it with `docker exec`. No sidebar tree in this mode (the folder is not on the host).
  **Experimental, not yet verified end to end.**

## Install

1. Build LayerFS (see its README): `npm --prefix api install && npm --prefix api run build:native`, plus the daemon
   for native mode. You need Node 22+.
2. `herdr plugin install jiangkoumo/herdr-plugin-layerfs`
3. `cp config.env.example "$(herdr plugin config-dir layerfs)/config.env"` and edit the paths.
4. In a repo's workspace, run **LayerFS: import this repo**, then **LayerFS: new branch workspace**.

Bind actions to keys in Herdr's config if you use them often.

## Limits

- Edits a branch has not saved (commit action, or closing the workspace) are lost if the machine reboots. Git commits
  are never lost: they live in your repo's `.git`.
- The first `git status` in a fresh branch takes ~2 s while git refreshes its index.
- Uncommitted changes in the source repo are not imported (`HEAD` is), and the plugin says so.
- LayerFS's own `diff_branches` lists git internals in docker mode; use `git diff`.

## 中文说明

把 LayerFS 分支变成 Herdr 工作区：开一个新分支约 2 秒、几乎不占磁盘。native 模式下每个分支同时是源仓库的
git worktree，所以会像 `herdr worktree` 一样缩进挂在仓库工作区下面（树状），里面照常 `git commit`、`git push`。
关闭工作区自动保存并卸载；herdr 重启或电脑重启后，`startup` 钩子会重新挂载并恢复工作区。

native 模式需要 LayerFS 的 macOS 原生支持（PR #427，尚未发布）；docker 模式对应上游 main（Linux），目前为实验性。

## License

MIT
