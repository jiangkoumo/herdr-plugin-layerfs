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
  Verified on Linux (Debian 13, Docker 29, Herdr 0.9.5): import, fork, server restart and reboot-style restore, close/save, reopen, discard.

## Install

Docker mode (Linux, LayerFS `main`; tested at the commit in [`layerfs.json`](layerfs.json)). You need Node 22+, Rust
1.85.1, Docker and Herdr 0.9+.

1. Clone LayerFS at that commit and build it:
   `cargo +1.85.1 build --manifest-path core/Cargo.toml --release --locked -p layerfs-daemon`, then
   `npm --prefix api install && npm --prefix api run build:native`.
2. A runtime image with git and a shell, and a volume:
   `printf 'FROM node:22-trixie\nRUN apt-get update && apt-get install -y --no-install-recommends git procps\n' | docker build -t layerfs-rt:herdr -`,
   then `docker volume create layerfs-herdr`.
3. `herdr plugin install jiangkoumo/herdr-plugin-layerfs`
4. `cp config.env.example "$(herdr plugin config-dir layerfs)/config.env"`, then set the paths and
   `LAYERFS_IMAGE=$(docker image inspect -f '{{.Id}}' layerfs-rt:herdr)`.
5. In a repo's workspace, run **LayerFS: import this repo**, then **LayerFS: new branch workspace**.

Native mode (macOS): build LayerFS from [PR #427](https://github.com/Ephemeral-AI-Lab/layerfs/pull/427) instead, and use
the native block of `config.env.example`.

See [Commands](#commands) for the CLI, key bindings and use from agents.

## Commands

There is no `herdr layerfs` subcommand. Herdr plugins are run in three ways:

| From | How |
|---|---|
| Keyboard | bind an action in Herdr's config (below) |
| Herdr CLI | `herdr plugin action invoke layerfs.<action>`, or `herdr plugin pane open --plugin layerfs --entrypoint fork-named` / `status` |
| A shell or an agent | `node "$LFS"/lfs.mjs <command> [name]` (see below) |

Actions: `layerfs.init`, `layerfs.fork`, `layerfs.commit`, `layerfs.reopen`, `layerfs.drop`.

```toml
# Herdr config
[[keys.command]]
key = "prefix+L"
type = "plugin_action"
command = "layerfs.fork"
description = "LayerFS: new branch workspace"
```

### For agents (and scripts)

`herdr plugin action invoke` acts on the workspace **focused in the Herdr UI**, not on the pane that runs the command
(checked on Herdr 0.9.5). An agent should run the plugin script directly instead: it then uses its own pane's
workspace (`HERDR_WORKSPACE_ID`) and current directory.

```sh
LFS=$(herdr plugin list --plugin layerfs --json | jq -r '.result.plugins[0].plugin_root')

node "$LFS"/lfs.mjs init            # once per repo, from the repo's workspace: import HEAD
node "$LFS"/lfs.mjs fork fix-login  # new branch workspace lfs:fix-login on git branch lfs/fix-login (name optional)
node "$LFS"/lfs.mjs commit          # from inside a branch workspace: save it
node "$LFS"/lfs.mjs reopen [name]   # mount a saved branch again (default: newest closed)
node "$LFS"/lfs.mjs drop            # from inside a branch workspace: discard it (git branch kept)
node "$LFS"/lfs.mjs list            # projects and branches
```

- Run `fork` from the source repo's workspace for a fresh branch, or from a branch workspace to fork that branch
  (it is saved first).
- The new workspace opens in Herdr; in native mode its path is a normal folder (the repo's linked git worktree), so
  the agent can `cd` there or start another agent in it with `herdr`.
- Run any LayerFS action from Herdr once after installing: it records where the plugin keeps its state, so direct
  runs share it. Or set `LFS_STATE_DIR` in `config.env`.
- Docker mode: run these on the host, not inside a branch's container shell (it has no `node`/`herdr`).
- Names: `a-z`, `0-9`, `-`.

## Limits

- Docker mode reads the Store inside the Docker volume (`LAYERFS_STORE_PATH`), so Herdr must run as a user that can
  read `/var/lib/docker/volumes` (root on a default install). Tested that way.

- Edits a branch has not saved (commit action, or closing the workspace) are lost if the machine reboots. Git commits
  are never lost: they live in your repo's `.git`.
- The first `git status` in a fresh branch takes ~2 s while git refreshes its index.
- Uncommitted changes in the source repo are not imported (`HEAD` is), and the plugin says so.
- LayerFS's own `diff_branches` lists git internals in docker mode; use `git diff`.

## 中文说明

把 LayerFS 分支变成 Herdr 工作区：开一个新分支约 2 秒、几乎不占磁盘。native 模式下每个分支同时是源仓库的
git worktree，所以会像 `herdr worktree` 一样缩进挂在仓库工作区下面（树状），里面照常 `git commit`、`git push`。
关闭工作区自动保存并卸载；herdr 重启或电脑重启后，`startup` 钩子会重新挂载并恢复工作区。

native 模式需要 LayerFS 的 macOS 原生支持（PR #427，尚未发布）；docker 模式对应上游 main（Linux），已在 Debian 13 上验证。

命令：没有 `herdr layerfs` 这个子命令。人用快捷键或 `herdr plugin action invoke layerfs.fork`；
**agent 请直接跑脚本**（`herdr plugin action invoke` 作用于 UI 当前聚焦的工作区，不是 agent 自己所在的那个）：

```sh
LFS=$(herdr plugin list --plugin layerfs --json | jq -r '.result.plugins[0].plugin_root')
node "$LFS"/lfs.mjs init            # 每个仓库一次，在仓库工作区里跑
node "$LFS"/lfs.mjs fork 名字        # 开新分支工作区（名字可省，只能 a-z0-9-）
node "$LFS"/lfs.mjs commit | drop   # 在分支工作区里：保存 / 丢弃
node "$LFS"/lfs.mjs reopen [名字] | list
```

装好后先在 Herdr 里随便跑一次 LayerFS 动作（记录状态目录），之后 agent 直接跑的脚本才能共用状态。

## License

MIT
