# LayerFS for Herdr

Parallel agent workspaces without copying your repo. Each [Herdr](https://herdr.dev) workspace this plugin opens is a
[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) branch: a copy-on-write view of the project, so a new one costs
no disk until files change. In native mode every branch is also a linked git worktree of your repo, so Herdr shows it
indented under the repo in the sidebar, exactly like `herdr worktree`, and `git commit` / `git push` work as usual.

[中文说明](#中文说明)

## Changes in 0.3.0

- `merge [with] [--name <new-branch>] [--open]` saves the current workspace and merges into a new branch.
- Import adds default `.lww` rules to the imported copy; `LFS_NO_DEFAULT_LWW=1` disables generation.
- `drop` retains the workspace record and Git registration when unmount fails. It reports the cause and exits
  nonzero. After releasing the directory, run it again from another pane with the original `HERDR_WORKSPACE_ID`.
  Once unmounted, completed cleanup steps are saved so Git/Herdr cleanup failures can be resumed. Git branches
  and LayerFS history are kept. Pending cleanup is not automatically remounted on startup.

## What it does

| Action | |
|---|---|
| **LayerFS: import this repo** | Snapshots the focused repo into a LayerFS project. Native mode imports the tracked files at `HEAD` (`git archive`); `.git` stays where it is. |
| **LayerFS: new branch workspace** | Forks the project (or the focused LayerFS branch, after saving it) and opens it as a workspace named `lfs:agent-N`, on git branch `lfs/agent-N`. |
| **LayerFS: new named branch** (pane) | Same, asks for the name. |
| **LayerFS: commit this workspace** | Saves the workspace on its LayerFS branch. |
| **LayerFS: merge with parent** | Saves this workspace, then merges with its recorded parent (or `main`) into a new branch. Both inputs are kept. |
| **LayerFS: discard this workspace** | Unmounts without saving, removes its Git worktree registration, then closes it. The git branch is kept. Failures retain the record for cleanup. |
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

Actions: `layerfs.init`, `layerfs.fork`, `layerfs.commit`, `layerfs.merge`, `layerfs.reopen`, `layerfs.drop`.

`node lfs.mjs merge [with] [--name <new-branch>] [--open]` creates a new LayerFS branch.
It first saves the current workspace, then merges its branch with `with` (default: the parent recorded at fork;
older entries fall back to `main`). The default name is `<current>-x-<with>`, normalized to a valid name;
occupied names, including an explicit `--name`, receive `-2`, `-3`, … suffixes. A concurrent name collision is
reported without retrying. Without `--open`, use `reopen <name>` later; `--open` mounts the result and opens a
Herdr workspace, with git branch `lfs/<name>` in native mode. The parent is retained across close/reopen.

A conflict prints each reported path and type and exits nonzero; the merge creates no branch and both inputs
keep their saved data. Edit one side and merge again, or add generated paths to the current branch's `/.lww`.
The pre-merge workspace save can itself conflict if its branch moved; that is a Workspace commit conflict,
so inspect and resolve the Workspace before continuing. No `--strategy` or user-supplied merge-unit options are exposed.
`--publish` is also unsupported: SDK publish replaces `main`'s view and may skip other publishers' changes
made after the merge; it has no expected-main argument to guard the merge-to-publish gap atomically.

Native Git-backed projects treat only root `/.git` (file or directory) as worktree metadata: an internal
root-anchored merge unit prevents conflicts there, then the result branch removes the inherited metadata.
Opening or reopening the result generates and saves its own `lfs/<name>` worktree link. Input links are kept;
`sub/.git` and other nested paths still merge normally. This can add a cleanup Commit on the result branch.
If cleanup fails after merge, the new branch remains recorded for inspection; do not replay the merge blindly.
The plugin has no diff command; SDK diffs still describe complete trees, including Git metadata.

**LayerFS merge does not merge git history.** Native `lfs/<name>` branches still use ordinary `git merge` for
Git commits. Saving the current Workspace and linking the new one may change LayerFS commits, but never advance
Git refs or create Git merge commits on the input branches.

### Default merge rules

On import, if there is no root `.lww`, the plugin adds one **only to the imported copy**. It includes
`%include .gitignore` (a missing file is skipped), common lockfiles, `*.log`, dependency/build output and test
caches. These files remain stored in LayerFS; on conflicting edits the newer version is kept whole, dropping
the other edit (ties keep the current branch). Rules are read from the first input, the current branch.
Existing `.lww` files are preserved, including an untracked root `.lww` in a native Git source; that rules file
is the exception to the HEAD-only import. Other uncommitted files are not imported in native Git mode.
A source that is not a Git checkout (docker mode) is copied once to a temporary folder for the import, so it
needs free space about the size of that source; native Git sources keep using the smaller `git archive`.
Set `LFS_NO_DEFAULT_LWW=1` in `config.env` or the command environment **before init** to disable generation.
It does not remove existing rules or alter an already imported project. Review your rules before merging;
add source-file exceptions such as `!src/generated-manually.js` if your `.gitignore` is broader than desired.

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
workspace (`HERDR_WORKSPACE_ID`) and current directory. Outside Herdr (SSH/scripts), native mode falls back to
the real current directory, including subdirectories and symlinks, to find the mounted branch in the same plugin
state. Run inside that branch, set `LFS_CWD` to its path, or explicitly set its `HERDR_WORKSPACE_ID` from
`lfs.mjs list`; share the same `LFS_STATE_DIR`. An existing Herdr ID always takes precedence.

```sh
LFS=$(herdr plugin list --plugin layerfs --json | jq -r '.result.plugins[0].plugin_root')

node "$LFS"/lfs.mjs init            # once per repo, from the repo's workspace: import HEAD
node "$LFS"/lfs.mjs fork fix-login  # new branch workspace lfs:fix-login on git branch lfs/fix-login (name optional)
node "$LFS"/lfs.mjs commit          # from inside a branch workspace: save it
node "$LFS"/lfs.mjs merge           # merge with recorded parent into a new branch (no mount)
node "$LFS"/lfs.mjs merge main --name release-check --open  # mount and open the result
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

0.3.0 新增 merge 命令和导入副本的默认 `.lww`，并修复 drop 失败后记录丢失的问题。
drop 先卸载、再清理 Git worktree 注册和 Herdr 工作区，全部成功后才删记录，保留 git 分支与 LayerFS 历史。
遇到 Busy 时先关闭占用挂载目录的进程、让 pane 离开该目录，然后在其他 pane 设置原 `HERDR_WORKSPACE_ID` 再执行 drop。
后续清理失败会保留已完成步骤，下一次 drop 继续清理；startup 不会重新挂载清理中的记录。

native 模式需要 LayerFS 的 macOS 原生支持（PR #427，尚未发布）；docker 模式对应上游 main（Linux），已在 Debian 13 上验证。

命令：没有 `herdr layerfs` 这个子命令。人用快捷键或 `herdr plugin action invoke layerfs.fork`；
**agent 请直接跑脚本**（`herdr plugin action invoke` 作用于 UI 当前聚焦的工作区，不是 agent 自己所在的那个）：

```sh
LFS=$(herdr plugin list --plugin layerfs --json | jq -r '.result.plugins[0].plugin_root')
node "$LFS"/lfs.mjs init            # 每个仓库一次，在仓库工作区里跑
node "$LFS"/lfs.mjs fork 名字        # 开新分支工作区（名字可省，只能 a-z0-9-）
node "$LFS"/lfs.mjs commit | drop   # 在分支工作区里：保存 / 丢弃
node "$LFS"/lfs.mjs merge           # 先保存，再与 fork 的父分支合并，生成新分支
node "$LFS"/lfs.mjs merge main --name release-check --open  # 指定另一边、结果名并打开
node "$LFS"/lfs.mjs reopen [名字] | list
```

`merge [with] [--name 新名] [--open]` 默认与 fork 时记录的父分支合并，老状态没有记录就用 `main`。
默认新名为 `<当前>-x-<with>`，重名自动加 `-2`、`-3`；合并创建新分支，两个输入分支保持不变。
不加 `--open` 可稍后 `reopen 新名`；加上会打开新工作区，native 模式配套 git 分支 `lfs/<新名>`。
冲突会列路径和类型、非零退出、不创建结果分支；修改其中一边再合并，或把生成文件加入当前分支的 `.lww`。
合并前会先保存当前工作区；若保存本身发生冲突，需要在原工作区解决。
native Git 项目合并时只将根 `/.git` 当作工作区元数据：内部合并单元避免它冲突，随后移除结果中继承的内容；
打开/重开结果时生成并保存专属的新链接，不复用输入分支的 Git 索引。子目录中的 `.git` 照常合并。
插件没有 diff 命令；SDK diff 仍返回完整树，包含 Git 元数据。清理失败会保留新分支供检查，不自动重试合并。
**LayerFS merge 不合并 git 历史，git 那边照常用 `git merge`。** 不提供 `ours/theirs`、units 或 `--publish`；
SDK 的 publish 会替换 main 视图，可能跳过合并后别人的发布，无法在一个原子操作中校验 main 没变。

`init` 默认只在导入副本里生成 `.lww`，不修改源仓库；规则含 `%include .gitignore`、常见 lockfile、日志和构建/测试缓存。
已有规则保留（native Git 源仓库中未跟踪的根 `.lww` 也保留，这是 HEAD 导入的例外）。合并读取第一个输入，即当前分支的规则，
匹配的文件双方都改时整份保留较新的版本，会舍弃另一份修改。导入前设 `LFS_NO_DEFAULT_LWW=1` 可关闭默认生成，
不影响已有规则和已经导入的项目。

装好后先在 Herdr 里随便跑一次 LayerFS 动作（记录状态目录），之后 agent 直接跑的脚本才能共用状态。

## License

MIT
