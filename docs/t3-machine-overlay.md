# T3 Code thread-to-machine overlay design

**Target tree:** `~/t3code-machines`, branch `local/machines`, HEAD `7a3a3207`.

**Overlay constraint:** machines are Linux-host-only and opt-in per project. With machines off, every code path must remain byte-for-byte equivalent in behavior to the current host-local path. The existing Windows/WSL overlay and native pi provider are part of the baseline; `PATCH.md` records `f5f0c955` as the pi driver commit and lists the Windows/WSL patches that must continue to rebase cleanly (`PATCH.md:36-70`, `PATCH.md:72-103`).

## Recommended shape

```text
T3 server on host
  ├─ orchestration/event store/SQLite
  ├─ host filesystem + host git over /tank/threads/<threadId>/ws
  ├─ MachineService ── Incus/ZFS lifecycle
  ├─ ProcessLauncher ─ host process OR MachineService.exec(...)
  └─ preview gateway ─ machine port -> authenticated T3 URL

/tank/threads/<threadId>/ws      (host canonical path)
             ⇅ idmapped bind mount
/home/dev/ws                   (machine canonical path)
```

The key design choice is **shared storage, split execution**:

* Keep workspace reads, writes, Git, diffing, checkpointing, assets, and search on the host.
* Put only provider agent processes—and explicitly requested machine terminals—inside Incus.
* Persist both host and guest paths. Do **not** overload `worktreePath`: current code treats a non-null value as a real Git linked worktree and may recreate or remove it.
* Make machine identity durable; treat running/stopped as reconciled operational state.

## Machine identity manifest

Machine mode requires a completed, non-dry-run `cloudbox sync`. Bootstrap configures the T3 server to read:

```text
T3_MACHINE_IDENTITY_MANIFEST=/home/<boxUser>/.config/cloudbox/machine-identity.json
```

Bootstrap does **not** create this user-owned file; identity arrives from the user's local machine through sync. The writable identity directories and host workspace are attached with `shift=true`, which preserves their host numeric ownership inside the machine. Therefore the golden image's `dev` UID and GID must exactly match the host box user's IDs; matching the account name alone is not sufficient. Bootstrap reads the host IDs dynamically rather than assuming fixed values.

The manifest schema is:

```json
{
  "version": 1,
  "mounts": [
    {
      "hostPath": "/home/dev/.codex",
      "guestPath": "/home/dev/.codex",
      "readOnly": false
    }
  ]
}
```

Cloudbox derives one mount root from every `identity.paths` include. It takes the first component below `~` (`~/.codex/auth.json` becomes `~/.codex`), except `~/.config/<app>/...`, where it keeps both `.config` and the app component (`~/.config/opencode/auth.json` becomes `~/.config/opencode`). It expands `~` to `/home/<boxUser>` on both sides, deduplicates, sorts, and sets `readOnly` to `false`. Derivation is textual: local symlinks are not resolved, so a configured path such as `~/.agents/skills` remains represented through its host-side `.agents` path.

After all rsync transfers succeed, `cloudbox sync` writes a temporary file in `~/.config/cloudbox`, sets mode `0600`, and atomically renames it to `machine-identity.json`. It then checks every `hostPath` with `-d`. Missing directories are listed and make sync fail as an incomplete identity push. A dry run never writes or verifies the manifest.

Sync also ensures `~/.config/systemd/user/t3code-fork.service` contains the environment line and runs `systemctl --user daemon-reload` only when it changes the unit. It never restarts T3. When sync reports that the line was added or corrected, restart it explicitly on the host:

```bash
systemctl --user restart t3code-fork.service
```

A minimal contract is:

```ts
interface ThreadMachineBinding {
  machineId: string
  machineName: string
  state: "running" | "stopped" | "archived"
  hostWorkspaceRoot: string       // /tank/threads/<id>/ws
  guestWorkspaceRoot: string      // /home/dev/ws
}
```

`MachineService.createFromGolden(threadId)` should be idempotent and return this binding. The Linux implementation owns the golden-image name, ZFS clone, Incus disk mount, UID mapping, and deterministic machine name. The null implementation returns no binding and preserves host-local execution.

---

## 1. Thread lifecycle hooks

### 1.1 Creation and persistence

There are two creation paths.

1. The normal first-send path embeds `createThread` and optional `prepareWorktree` in `thread.turn.start`. The web client decides whether a worktree is required, validates the base branch, and builds the bootstrap payload (`apps/web/src/components/ChatView.tsx:5616-5633`, `apps/web/src/components/ChatView.tsx:5846-5874`).
2. Some flows dispatch `thread.create` directly, then start a turn—for example plan implementation (`apps/web/src/components/ChatView.tsx:6412-6456`). Therefore, machine creation cannot live only in the worktree bootstrap branch.

Client-runtime creates lifecycle commands and sends `thread.create`, `thread.delete`, `thread.archive`, and `thread.unarchive` (`packages/client-runtime/src/operations/commands.ts:122-160`). The wire command schemas carry project, model, branch, and `worktreePath` today (`packages/contracts/src/orchestration.ts:735-770`); the client and internal command unions are intentionally separate (`packages/contracts/src/orchestration.ts:981-1034`, `packages/contracts/src/orchestration.ts:1109-1125`). Machine bind/state commands should be **internal only**, so clients cannot claim another machine.

On the server, bootstrap currently does this synchronously:

1. dispatch `thread.create`;
2. optionally fetch/create the worktree;
3. update thread metadata with branch/path;
4. run the setup script;
5. dispatch the final turn start;
6. delete the newly created thread if bootstrap fails.

That sequence is in `apps/server/src/ws.ts:884-1027` and `apps/server/src/ws.ts:1028-1111`. It is the best synchronous hook for machine preparation on first send, but it must call an idempotent `ensureMachine(threadId)` because direct `thread.create` bypasses this branch.

The decider turns lifecycle commands into events without performing side effects: `thread.create` -> `thread.created`, delete -> `thread.deleted`, archive/unarchive -> their matching events (`apps/server/src/orchestration/decider.ts:349-448`). The engine appends each event and updates projections in one SQL transaction (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:155-218`). The thread projection persists `worktree_path`, archive state, and soft deletion (`apps/server/src/persistence/Layers/ProjectionThreads.ts:27-110`, `apps/server/src/persistence/Layers/ProjectionThreads.ts:124-200`); projection handlers for create/archive/delete are at `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:638-710` and `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:884-901`.

**Machine hook:** add an internal `thread.machine.bind` command/event and projection columns. A `MachineReactor` listens for `thread.created` and idempotently calls `createFromGolden`. The provider-start path also calls `ensureMachine` before spawning, closing the reactor race and repairing crash gaps.

### 1.2 Resume

There is no `thread.resume` lifecycle command. Resume means one of two things:

* **UI lifecycle:** `thread.unarchive` clears `archivedAt`; today it has no backend resource side effect (`apps/server/src/orchestration/decider.ts:424-448`, `apps/server/src/orchestration/projector.ts:330-350`).
* **Provider continuation:** the provider reactor resolves the effective CWD, asks `ProviderService` to start/restart a session, and passes any durable resume cursor (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:640-680`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:699-774`). `ProviderService` recovers persisted CWD/model/resume state (`apps/server/src/provider/Layers/ProviderService.ts:430-485`) and also falls back to a persisted binding when a fresh start omits them (`apps/server/src/provider/Layers/ProviderService.ts:610-675`).

**Machine hook:** `ensureMachineRunning(threadId)` must run before every provider session start/recovery. Unarchive may remain lazy: change state to `stopped`, then start on the next turn or terminal open. This avoids booting archived machines merely because the archive list was opened.

### 1.3 Archive and delete

Archive currently only changes the event-sourced read model. The web action rejects an actively running turn, dispatches archive, refreshes archived threads, and navigates away (`apps/web/src/hooks/useThreadActions.ts:206-274`). There is no server archive reactor.

Delete has both client and server cleanup:

* The web action stops the session, closes terminals, soft-deletes the thread, and optionally asks to remove an orphaned Git worktree (`apps/web/src/hooks/useThreadActions.ts:302-445`).
* `ThreadDeletionReactor` independently stops the provider session and closes terminal history on every `thread.deleted` event (`apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:35-92`).

**Machine policy:**

* `thread.archive`: stop the machine, but keep the ZFS dataset/Incus instance.
* `thread.unarchive`: leave stopped until the next execution request.
* `thread.delete`: after provider and terminal shutdown, call `MachineService.archive(name)`. Do not immediately destroy; archive is the recoverable/destructive boundary requested for this platform.
* `destroy(name)`: later explicit retention/GC action, not ordinary thread delete.

Add machine cleanup to `ThreadDeletionReactor`, after `stopSession` and terminal close. This is the narrowest reliable delete hook and already handles delete events from every client surface.

### 1.4 Existing worktree behavior

#### Creation/removal implementation

`GitVcsDriverCore.createWorktree` chooses `<worktreesDir>/<repo>/<sanitized branch>`, runs `git worktree add`, initializes submodules best-effort, and records a merge base (`apps/server/src/vcs/GitVcsDriverCore.ts:2819-2884`). The exact add argv is:

```text
git worktree add -b <newRef> <worktreePath> <baseRef>
# or
git worktree add <worktreePath> <ref>
```

Removal runs `git worktree remove [--force] <path>`, tolerates an already-gone directory, and prunes stale registrations (`apps/server/src/vcs/GitVcsDriverCore.ts:3066-3116`). `GitWorkflowService` is the routing facade for create/remove/prune (`apps/server/src/git/GitWorkflowService.ts:302-331`).

#### Callers

* Bootstrap creation: `apps/server/src/ws.ts:1044-1084`.
* Generic VCS RPC create/remove: `apps/server/src/ws.ts:2183-2197`.
* Missing-worktree recreation before provider use: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:430-482`.
* Pull-request preparation also creates worktrees through Git manager (`apps/server/src/git/GitManager.ts:2125-2140`).
* Client delete offers orphaned-worktree removal (`apps/web/src/hooks/useThreadActions.ts:330-445`).

A machine workspace must not enter those branches. Persist a separate machine binding and update workspace resolution rather than putting `/tank/threads/<id>/ws` into `worktreePath`.

#### Settings and UI

The existing mode is only `"local" | "worktree"` (`packages/contracts/src/environment.ts:21-29`). Defaults can come from project metadata, checked-in `t3.json`, or global settings:

* global schema: `packages/contracts/src/settings.ts:719-725`;
* checked-in project schema: `packages/contracts/src/t3ProjectFile.ts:68-83`;
* precedence resolver in new-thread creation: `apps/web/src/hooks/useHandleNewThread.ts:163-180`;
* project Settings selector: `apps/web/src/components/settings/ProjectSettingsPanel.tsx:876-929`;
* global Settings selector: `apps/web/src/components/settings/SettingsPanels.tsx:2218-2292`.

**Recommendation:** add a separate project field `machineMode: "off" | "thread"`; do not add `"machine"` to `ThreadEnvMode` in the first overlay. When `machineMode === "thread"`, every new thread gets a machine, the UI relabels/hides the local/worktree selector, and worktree preparation is skipped. This contains version-skew and avoids changing every existing `local/worktree` switch.

### 1.5 CWD/projectRoot decision

The canonical current rule is `worktreePath ?? project.workspaceRoot` in `resolveThreadWorkspaceCwd` (`apps/server/src/checkpointing/Utils.ts:12-28`). `ProviderCommandReactor` uses it immediately before `ProviderService.startSession` (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:648-670`). `ProviderSessionStartInput` carries optional `cwd` (`packages/contracts/src/provider.ts:53-66`), and `ProviderService` persists/reuses it (`apps/server/src/provider/Layers/ProviderService.ts:610-675`).

Change the resolver to:

```text
machine.hostWorkspaceRoot
  ?? worktreePath
  ?? project.workspaceRoot
```

For provider execution only, `ProcessLauncher` maps the resolved host CWD to `machine.guestWorkspaceRoot`. Host Git/checkpoint/file services continue receiving the host CWD.

---

## 2. Provider spawn sites and launcher seam

All configured binary defaults are contract-defined: Codex/Claude (`packages/contracts/src/settings.ts:318-404`), Cursor/Grok/OpenCode/pi (`packages/contracts/src/settings.ts:439-574`). Absolute host binary paths and host home paths are invalid inside a machine; machine mode should resolve guest binaries from the golden image and mount/copy only intentional credentials.

### 2.1 Exact session spawn matrix

| Provider | Exact thread-session spawn in this tree | CWD / env | Transport |
|---|---|---|---|
| **Codex app-server** | `resolveSpawnCommand(options.binaryPath, codexSessionAppServerArgs(...))`, then `ChildProcess.make(...); spawner.spawn(...)` (`apps/server/src/provider/Layers/CodexSessionRuntime.ts:1173-1208`). Argv is `app-server`, configured launch args, then MCP `-c` arguments (`apps/server/src/provider/Layers/codexLaunchArgs.ts:10-16`, `apps/server/src/provider/Layers/codexLaunchArgs.ts:42-48`; MCP construction at `apps/server/src/provider/Layers/CodexAdapter.ts:1682-1726`). | `cwd: options.cwd`; explicit provider env; optional expanded `CODEX_HOME`; `extendEnv` only when no explicit environment; scoped forced kill. | stdin/stdout JSON-RPC via `CodexClient.layerChildProcess`; stderr is separately decoded into provider notifications (`apps/server/src/provider/Layers/CodexSessionRuntime.ts:1210-1220`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2170-2205`). No PTY. |
| **Claude Agent SDK** | T3 does **not** call `spawn` directly. It passes `pathToClaudeCodeExecutable`, `cwd`, env, settings, extra args, MCP servers, and callbacks into SDK `query(...)` (`apps/server/src/provider/Layers/ClaudeAdapter.ts:4262-4348`, `apps/server/src/provider/Layers/ClaudeAdapter.ts:4380-4399`). The SDK owns the final Claude argv and child stdio; an “exact argv” is not represented in this repository. | `cwd: input.cwd`; `claudeEnvironment`; `additionalDirectories` includes cwd and host attachments directory. | SDK async query stream, not T3 PTY (`apps/server/src/provider/Layers/ClaudeAdapter.ts:3618-3646`). |
| **pi RPC** | resolved binary or `pi`, argv `--mode rpc --no-session ...launchArgs`, then `ChildProcess.make` and `spawner.spawn` (`apps/server/src/provider/Layers/PiAdapter.ts:936-980`). | `cwd: input.cwd ?? serverConfig.cwd`; explicit provider env or inherited env. | LF JSONL over stdin/stdout; stderr drained; direct kill/exit watcher (`apps/server/src/provider/Layers/PiAdapter.ts:313-324`, `apps/server/src/provider/Layers/PiAdapter.ts:819-873`). No PTY. |
| **OpenCode** | local mode spawns resolved binary with `serve --hostname=<host> --port=<port>` (`apps/server/src/provider/opencodeRuntime.ts:517-565`). The adapter then creates an HTTP SDK client with `directory` (`apps/server/src/provider/Layers/OpenCodeAdapter.ts:1224-1249`). | The server child currently has **no cwd option**. Env includes provider env plus `OPENCODE_CONFIG_CONTENT`; inherited env is extended only when provider env is absent. The workspace is the SDK `directory`, not process cwd. | HTTP SDK. stdout is parsed for “opencode server listening”; stderr is buffered for startup diagnostics (`apps/server/src/provider/opencodeRuntime.ts:590-679`). No PTY. |
| **Cursor** | `buildCursorAcpSpawnInput` produces binary or `cursor-agent`, optional `-e <apiEndpoint>`, then `acp` (`apps/server/src/provider/acp/CursorAcpSupport.ts:31-52`). Shared ACP runtime resolves and spawns it (`apps/server/src/provider/acp/AcpSessionRuntime.ts:328-373`). | adapter requires and resolves cwd (`apps/server/src/provider/Layers/CursorAdapter.ts:479-501`); optional provider env is explicit and extended. | ACP JSON-RPC over child stdin/stdout via `layerChildProcess`; no PTY (`apps/server/src/provider/acp/AcpSessionRuntime.ts:359-379`). |
| **Grok** | binary or `grok`; argv depends on runtime mode, ending in `agent stdio` or `agent --always-approve stdio` (`apps/server/src/provider/acp/GrokAcpSupport.ts:34-72`). Shared ACP runtime performs the spawn (`apps/server/src/provider/acp/AcpSessionRuntime.ts:328-373`). | adapter requires/resolves cwd (`apps/server/src/provider/Layers/GrokAdapter.ts:938-960`); env adds `GROK_OAUTH2_REFERRER=t3code`. | ACP JSON-RPC over child stdin/stdout; no PTY. |

### 2.2 Smallest safe seam

There is already an Effect-injected `ChildProcessSpawner`, and drivers capture it when constructing adapters (`apps/server/src/provider/builtInDrivers.ts:15-53`, `apps/server/src/provider/ProviderDriver.ts:12-22`). A **global** spawner Layer swap is nevertheless too broad: the same service launches host Git, provider probes, updater commands, preview `lsof`, cloud helpers, and other host processes.

Add a provider-specific service:

```ts
interface ProcessLauncher {
  launch(input: {
    threadId?: ThreadId
    cwd?: string                 // host canonical path
    command: string
    args: readonly string[]
    env?: NodeJS.ProcessEnv
    shell?: boolean
    forceKillAfter?: Duration.Input
  }): Effect<ProcessHandle, LaunchError, Scope>
}
```

`HostProcessLauncher` delegates to the current `ChildProcessSpawner` unchanged. `MachineProcessLauncher` resolves the thread/cwd binding, maps the path, ensures the machine is running, and calls:

```text
incus exec <machine> --user dev --cwd /home/dev/ws -- <binary> <args...>
```

The actual implementation should call `MachineService.exec`, not shell-quote a string. Preserve argv boundaries, streaming stdin/stdout/stderr, exit status, kill semantics, and scope finalization.

Integrate at these narrow points:

* Codex: `makeCodexSessionRuntime` spawn.
* pi: `PiAdapter.startSession` spawn.
* ACP: the one shared spawn in `AcpSessionRuntime`; pass thread identity in `AcpSessionRuntimeOptions`.
* OpenCode: `startOpenCodeServerProcess`; add machine-aware endpoint return.
* Claude: exception. Because the SDK owns spawning, either inject an SDK process transport if its installed API supports one, or set `pathToClaudeCodeExecutable` to a tiny host launcher executable that accepts the SDK-generated Claude argv and forwards it to `MachineService.exec`. Do not attempt to set the executable to `incus`; T3 cannot prepend the required machine/user/cwd arguments to the SDK-generated argv.

Wrap **after** `resolveSpawnCommand`, so the existing Windows `.cmd`/shell behavior remains untouched when machines are off. In machine mode reject `shell: true` launch specs unless translated to a guest shell explicitly.

### 2.3 Secondary provider processes

The seam must account for one-shot text generation, not just chat sessions:

* Codex uses `codex exec ...`, cwd, stdin prompt, output/schema temp files (`apps/server/src/textGeneration/CodexTextGeneration.ts:155-238`). Host temp paths and image paths must be translated or mounted.
* Claude uses `claude -p --output-format json ...`, cwd, stdin prompt (`apps/server/src/textGeneration/ClaudeTextGeneration.ts:135-205`).
* Cursor and Grok reuse the ACP runtime with the requested cwd (`apps/server/src/textGeneration/CursorTextGeneration.ts:43-78`, `apps/server/src/textGeneration/GrokTextGeneration.ts:44-82`).
* OpenCode text generation uses the same OpenCode runtime/server model.
* pi one-shot uses `pi --mode text --no-session -p <prompt> [--model ...]` but currently sets no cwd (`apps/server/src/textGeneration/PiTextGeneration.ts:102-148`); its methods ignore the input cwd (`apps/server/src/textGeneration/PiTextGeneration.ts:220-293`).

Provider health/catalog/update probes are host-global and should remain host-local in the first overlay. The golden image must therefore match the configured provider versions, or a later machine probe capability is needed.

### 2.4 Host-local assumptions

1. **MCP URL.** The endpoint is derived from the T3 HTTP listener; wildcard binds are rewritten to `127.0.0.1` (`apps/server/src/mcp/McpSessionRegistry.ts:79-106`). Codex passes it through CLI `-c` values (`apps/server/src/provider/Layers/CodexAdapter.ts:1698-1718`), Claude puts it in SDK `mcpServers` (`apps/server/src/provider/Layers/ClaudeAdapter.ts:4333-4348`), and Cursor/Grok/OpenCode also consume it (`apps/server/src/provider/Layers/CursorAdapter.ts:538-559`, `apps/server/src/provider/Layers/GrokAdapter.ts:983-1004`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1234-1248`). Inside a machine, loopback points at the machine, not the host.
2. **MCP fix.** Keep credential issuance unchanged, but translate only the advertised endpoint host to the Incus bridge address, e.g. `http://10.x.y.1:3773/mcp`. T3 must listen on that interface, and firewall it to the Incus bridge. Add `MachineService.hostReachableUrl(url)` or a configured bridge gateway; do not globally replace loopback URLs used by host sessions.
3. **Attachments.** `ProviderService` inserts the host attachment path into every prompt (`apps/server/src/provider/Layers/ProviderService.ts:724-754`). Claude also grants the host attachments directory (`apps/server/src/provider/Layers/ClaudeAdapter.ts:4299-4310`), and OpenCode emits host `file://` URLs (`apps/server/src/provider/opencodeRuntime.ts:374-399`). Bind-mount the attachments directory read-only at the **same absolute path** inside each machine, or translate every prompt/SDK file reference. Same-path read-only mount is smaller and avoids provider-specific rewriting.
4. **Provider homes and binaries.** `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, absolute binary paths, pi extensions, Grok home, and OpenCode config currently describe the host. Machine mode needs guest-safe settings and an explicit credential policy; never silently mount the entire host home.
5. **OpenCode network.** It currently allocates a host free port and binds `127.0.0.1` (`apps/server/src/provider/opencodeRuntime.ts:48-55`, `apps/server/src/provider/opencodeRuntime.ts:523-540`). In machine mode allocate/probe inside the machine, bind `0.0.0.0` or the machine interface, and return a host-reachable machine URL to the host SDK client.

---

## 3. Server-side workspace/file access

The bind-mounted dataset is what makes this design small. The following modules assume the server can directly access the workspace path and should remain host-side.

| Area | Direct access today | Machine rule |
|---|---|---|
| Workspace browse/search | `WorkspaceEntries` uses host `readdir` and host path normalization (`apps/server/src/workspace/WorkspaceEntries.ts:116-220`). `WorkspaceSearchIndex` creates a native `FileFinder` rooted at host cwd (`apps/server/src/workspace/WorkspaceSearchIndex.ts:300-380`). | Point them at `binding.hostWorkspaceRoot`; no machine RPC. |
| File read/write | `WorkspaceFileSystem` realpaths, opens, stats, reads, makes directories, writes, and refreshes indexes on the host (`apps/server/src/workspace/WorkspaceFileSystem.ts:135-299`). | Unchanged against the host dataset. |
| Assets/file previews | `AssetAccess` canonicalizes and stats workspace files before issuing URLs (`apps/server/src/assets/AssetAccess.ts:145-184`, `apps/server/src/assets/AssetAccess.ts:214-260`). WebSocket asset context currently chooses `worktreePath ?? project.workspaceRoot` (`apps/server/src/ws.ts:2070-2115`). | Update context resolution to prefer machine host workspace. Serve bytes from host. |
| Attachments | Uploads are written under server state, not the project (`apps/server/src/assets/AttachmentUpload.ts:187-242`; derived path at `apps/server/src/config.ts:109-136`). | Keep host-owned; read-only same-path bind into the machine. |
| Git status/actions | `GitVcsDriverCore` directly spawns host `git` with cwd and host env (`apps/server/src/vcs/GitVcsDriverCore.ts:721-786`). `GitWorkflowService`, `GitManager`, and `VcsStatusBroadcaster` build on it. | Keep host Git. The dataset must contain a standalone, host-valid `.git`, not a linked-worktree `.git` file pointing into a guest rootfs. |
| VCS/SCM CLIs | `VcsProcess` routes `git`, `gh`, `glab`, and related commands through host `ProcessRunner` with cwd (`apps/server/src/vcs/VcsProcess.ts:99-146`). Pull request operations repeatedly use each project workspace root (`apps/server/src/pullRequest/PullRequestService.ts:520-721`). | Keep host-local initially. Host auth remains authoritative. |
| Review/diff | `ReviewService` realpaths the requested cwd and only permits `config.cwd` or `worktreesDir` (`apps/server/src/review/ReviewService.ts:35-91`). Git diff content may directly read a workspace file (`apps/server/src/vcs/GitVcsDriverCore.ts:2414-2462`). | Add `/tank/threads` as an allowed root only when machine mode is enabled, preferably via a `WorkspaceRootPolicy` service rather than a hard-coded third root. |
| Checkpointing | `CheckpointStore` resolves VCS operations by cwd (`apps/server/src/checkpointing/CheckpointStore.ts:102-165`). `CheckpointReactor` captures Git refs and refreshes the host file index (`apps/server/src/orchestration/Layers/CheckpointReactor.ts:182-289`). Diff queries choose worktree/project cwd (`apps/server/src/checkpointing/CheckpointDiffQuery.ts:132-175`, `apps/server/src/checkpointing/CheckpointDiffQuery.ts:240-275`). | Resolve machine host workspace first; otherwise unchanged. |
| Project config/favicon | `T3ProjectFileLoader` and favicon resolver read project files directly (`apps/server/src/project/T3ProjectFileLoader.ts:60-85`, `apps/server/src/project/ProjectFaviconResolver.ts:150-178`). | For per-thread data use host machine workspace; project-level defaults continue using the base project root. |
| Setup scripts/terminal | Setup scripts open a host terminal at worktree cwd and write the command to it (`apps/server/src/project/ProjectSetupScriptRunner.ts:132-180`). Terminal manager spawns a host PTY at session cwd (`apps/server/src/terminal/Manager.ts:1782-1838`); Node and Bun adapters are host implementations (`apps/server/src/terminal/NodePtyAdapter.ts:139-172`, `apps/server/src/terminal/BunPtyAdapter.ts:120-155`). | Machine projects must route setup and “open terminal” through `MachineService.exec(..., tty:true)`. Keep host PTY unchanged for non-machine threads. |
| Preview discovery | Host listener/PID scan; detailed in section 4. | Replace with a machine-scoped scanner/gateway for machine threads. |

### Path mapping invariant

```text
hostRoot  = /tank/threads/<threadId>/ws
guestRoot = /home/dev/ws

host -> guest:
  guestRoot + relative(hostRoot, hostPath)

guest -> host:
  hostRoot + relative(guestRoot, guestPath)
```

Reject paths outside the mapped root. Do not perform prefix-only checks; normalize/realpath and then verify the relative path does not begin with `..` and is not absolute, matching the existing workspace escape checks (`apps/server/src/workspace/WorkspaceFileSystem.ts:144-176`).

### Dataset requirements

* Clone a ZFS dataset per thread and mount it into the Incus instance.
* Use an idmapped Incus disk mount so host T3 and guest user `dev` can both read/write without `chmod 777` or recursive chown.
* Keep `.git` wholly inside the shared dataset. Do not use `git worktree` metadata that points back to the base project’s `.git/worktrees/...` unless that base path is also mounted identically.
* Make machine creation idempotent across server crashes: deterministic dataset, instance, and mount names derived from thread ID.
* Do not expose arbitrary host paths through machine exec. Every machine launch cwd must map through its stored binding.

---

## 4. Preview and ports

### 4.1 Current behavior

Port discovery is environment-global, not thread-scoped. The subscription payload contains configured URLs but no thread ID (`packages/contracts/src/rpc.ts:894-905`). On Linux/macOS the scanner runs:

```text
lsof -iTCP -sTCP:LISTEN -P -n -F pcn
```

It parses local listeners and builds `http://localhost:<port>` (`apps/server/src/preview/PortScanner.ts:183-224`, `apps/server/src/preview/PortScanner.ts:480-529`). On Windows or missing `lsof`, it checks a fixed common-port list through the host loopback network (`apps/server/src/preview/PortScanner.ts:69-72`, `apps/server/src/preview/PortScanner.ts:305-327`). It then probes HTTP/HTTPS and only returns successful HTML/redirect targets (`apps/server/src/preview/PortScanner.ts:329-469`). Polling runs every three seconds while retained (`apps/server/src/preview/PortScanner.ts:543-608`).

Terminal subprocess PIDs are registered so discovered ports can be attributed to `(threadId, terminalId)` (`apps/server/src/terminal/Manager.ts:2011-2055`, `apps/server/src/preview/PortScanner.ts:618-652`). The discovery result contract carries host, port, URL, process, PID, and optional terminal owner (`packages/contracts/src/preview.ts:295-315`).

`PreviewManager` itself stores normalized URLs and browser tab state; it does not discover or proxy network services (`apps/server/src/preview/Manager.ts:44-61`, `apps/server/src/preview/Manager.ts:215-257`).

The web resolver already acknowledges the remote limitation: for a public environment it throws until an authenticated preview gateway exists (`apps/web/src/browser/browserTargetResolver.ts:167-203`). The `environment-port` target currently means a port relative to the whole T3 environment (`packages/contracts/src/previewAutomation.ts:118-146`).

### 4.2 Machine behavior

A dev server inside a machine is invisible to host `lsof`, has an unrelated PID namespace, and usually binds machine loopback. `http://localhost:5173` on the host or remote client is the wrong endpoint.

Implement in two stages:

1. **Machine-scoped discovery.** Add `threadId` to the discovery subscription. For a machine thread, run `ss -H -ltnp` (or equivalent) through `MachineService.exec`; probe from the host using the machine IP. Keep the existing host scanner for non-machine threads. Return `machineId`/thread ownership in the discovered-server contract; do not merge equal port numbers from different machines.
2. **Authenticated gateway.** Expose a T3-origin URL such as `/api/machines/<opaque-binding-id>/ports/<port>/...` that reverse-proxies HTTP and WebSocket upgrades to the machine IP. Authorize it with the existing environment session and verify the requested binding belongs to the thread/environment. This is required for web/mobile/remote clients; a private Incus IP is only an acceptable local debugging fallback.

For OpenCode’s internal SDK server, use a host-reachable machine IP directly because it is server-to-machine control traffic, not a user preview. For user preview URLs, always prefer the authenticated T3 gateway.

Configured script URLs (`ProjectScript.previewUrl`) are currently loopback strings (`packages/contracts/src/orchestration.ts:259-276`). In machine mode resolve their host/port relative to the thread machine before opening the preview.

---

## 5. Machine state in contracts and web UI

### 5.1 Contracts and persistence

Add optional machine metadata to both detailed and shell thread schemas. Those are the canonical client payloads (`packages/contracts/src/orchestration.ts:437-489`, `packages/contracts/src/orchestration.ts:513-572`). Keep the field optional for old-server/new-client and new-server/old-client compatibility.

```ts
machine: Schema.optional(Schema.NullOr(ThreadMachineBinding))
```

Add internal commands/events:

```text
thread.machine.bind       -> thread.machine-bound
thread.machine.state.set  -> thread.machine-state-set
```

Add projection columns in a new migration after the current migration 43 (`apps/server/src/persistence/Migrations.ts:70-116`), update `ProjectionThread` (`apps/server/src/persistence/Services/ProjectionThreads.ts:23-55`), SQL upsert/select (`apps/server/src/persistence/Layers/ProjectionThreads.ts:32-109`, `apps/server/src/persistence/Layers/ProjectionThreads.ts:124-200`), projection handlers, and shell/detail mapping (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2195-2238`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2482-2520`).

Persist `machineId`, name, and both workspace roots. Persist last known state, but reconcile it from Incus on server boot and before launch: a process crash or manual `incus stop` can make projected state stale.

Also add a general resolved workspace field/helper rather than teaching clients that a machine path is a worktree. `EnvironmentThreadShell` automatically inherits new contract fields because it extends `OrchestrationThreadShell` (`packages/client-runtime/src/state/models.ts:1-28`), and shell atoms preserve the whole object (`packages/client-runtime/src/state/threadShell.ts:38-114`). The detailed event reducer must initialize and update the field (`packages/client-runtime/src/state/threadReducer.ts:150-198`).

### 5.2 Minimal UI

1. **Sidebar badge:** add `ThreadMachineIndicator` beside the existing worktree/status indicators. `ThreadWorktreeIndicator` is the nearest pattern (`apps/web/src/components/ThreadStatusIndicators.tsx:430-465`), and sidebar rows already derive terminal, Git, provider, and status metadata (`apps/web/src/components/Sidebar.tsx:770-940`). Badge copy: `machineName · running|stopped|archived`.
2. **Chat header/action menu:** show the same compact badge and actions: Start, Stop, Open terminal. Do not add VNC implementation yet; reserve a disabled/hidden capability-driven action.
3. **Open terminal in machine:** no new user-supplied machine ID is needed. `TerminalOpenInput` already carries trusted thread ID plus cwd (`packages/contracts/src/terminal.ts:35-58`). The server resolves the thread binding and selects a machine-backed PTY adapter. Add machine identity to terminal snapshots only if the UI must distinguish host and machine terminals.
4. **Later VNC:** add a server capability and a machine session endpoint, not a raw machine IP/port. The UI action should appear only when the capability and machine state allow it.

Machine state is not the same as agent session state. Keep both visible: “machine stopped” is infrastructure; “working/approval/done” is thread activity.

---

## 6. Ordered overlay commit plan

LOC estimates include focused tests but exclude generated lockfile churn.

### Commit 1 — `feat(server): add host-local machine service boundary` — ~180 LOC — low risk

**Files**

* new `apps/server/src/machine/MachineService.ts`
* new `apps/server/src/machine/HostMachineService.ts`
* `apps/server/src/server.ts`
* focused service tests

**Change**

Define `createFromGolden`, start/stop, streaming `exec`, archive, destroy, path mapping, and host-reachable URL methods. The host/null Layer returns no machine binding and executes locally. Wire the Layer once beside other runtime services (`apps/server/src/server.ts:245-408`). No contracts or behavior change.

**Risk**

Accidentally importing Linux/Incus code on Windows. Keep the Incus implementation behind a dynamic Linux/config selection; the default Layer must not probe `incus`.

### Commit 2 — `refactor(server): route provider children through ProcessLauncher` — ~420 LOC — medium risk

**Files**

* new `apps/server/src/process/ProcessLauncher.ts`
* Codex session runtime, pi adapter, ACP runtime, OpenCode runtime
* provider drivers/runtime layer
* tests proving exact host launch specs

**Change**

Introduce a host-only launcher first. Route Codex/pi/Cursor/Grok/OpenCode session children through it without changing their command, args, cwd, env, streams, or scope behavior. Carry optional `threadId` through ACP/OpenCode options.

**Risk**

Child kill/finalizer regressions and Windows shell resolution. Compare exact `ChildProcess.make` inputs in tests. Do not globally replace `ChildProcessSpawner`.

### Commit 3 — `refactor(server): add Claude SDK machine launch transport` — ~180 LOC — high risk

**Files**

* `apps/server/src/provider/Layers/ClaudeAdapter.ts`
* new small launcher executable/module if the SDK lacks a spawn hook
* tests

**Change**

Keep host behavior unchanged. Add a transport/wrapper that can forward the SDK-generated Claude argv/stdin/stdout to `ProcessLauncher` for machine threads.

**Risk**

The SDK owns spawning, so argv, signals, control messages, and upgrades must be verified against the installed SDK. This is the only provider that cannot be completed by replacing an explicit T3 spawn call.

### Commit 4 — `feat(contracts): persist project machine mode and thread bindings` — ~360 LOC — medium risk

**Files**

* `packages/contracts/src/orchestration.ts`
* optional project setting schema
* new migration 44
* projection service/layer/pipeline/snapshot query
* client-runtime thread reducer
* contract/projection tests

**Change**

Add `project.machineMode`, optional thread machine binding, internal bind/state commands/events, projection columns, and shell/detail serialization. Add the general host workspace resolution helper. Keep all fields optional/default-off.

**Risk**

Event replay and older cached snapshots. Do not make new fields required on decode. Do not add `machine` to the existing `ThreadEnvMode` literals.

### Commit 5 — `feat(server): bind new threads to golden machines` — ~430 LOC — high risk

**Files**

* new `apps/server/src/machine/IncusMachineService.ts`
* new machine reactor/service tests
* `apps/server/src/ws.ts`
* `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
* checkpoint/workspace resolution call sites
* project Settings command plumbing

**Change**

When project machine mode is on, skip Git worktree creation, call idempotent `createFromGolden(threadId)`, bind the host dataset, persist the binding, and run setup inside the machine. Before provider start/recovery, ensure the machine exists/runs. Cover both bootstrap and direct `thread.create` paths.

**Risk**

Crash consistency, duplicate creation, UID mapping, base-repo freshness, and a direct-create race. Deterministic names plus provider-start reconciliation are mandatory.

### Commit 6 — `feat(server): launch provider sessions inside thread machines` — ~390 LOC — high risk

**Files**

* `ProcessLauncher` machine implementation
* six provider integrations
* MCP session endpoint translation
* attachment mount/path tests
* one-shot text-generation launch sites

**Change**

Map host cwd to `/home/dev/ws`, use guest binaries/env, rewrite MCP endpoint to the host bridge, and route streams through `MachineService.exec`. Mount host attachments read-only at the same absolute path. Fix OpenCode server address/port handling.

**Risk**

Credentials, absolute binary/home paths, OpenCode reachability, Claude SDK behavior, and text-generation temp files. Roll out provider by provider behind one project flag plus a server kill switch.

### Commit 7 — `feat(server): stop and archive machines with thread lifecycle` — ~220 LOC — medium risk

**Files**

* `ThreadDeletionReactor.ts`
* new archive lifecycle reactor or machine reactor extension
* machine state commands/events
* tests

**Change**

Stop on thread archive, lazy-start after unarchive, archive after delete cleanup, and leave destroy for explicit GC. Record state transitions and surface failures as activities/logs without rolling back the already accepted thread lifecycle event.

**Risk**

Partial cleanup and retries. Operations must be idempotent; deletion must not block forever on an unavailable Incus daemon.

### Commit 8 — `feat(terminal): open thread terminals inside machines` — ~300 LOC — medium risk

**Files**

* terminal manager / new machine PTY adapter
* setup script runner
* terminal tests
* minimal web action wiring

**Change**

Resolve machine by thread ID, map cwd, and back the existing terminal stream with `MachineService.exec(..., tty:true)`. Reuse current terminal contracts where possible.

**Risk**

PTY resize, signal delivery, reconnect, PID semantics, and port attribution. Machine PIDs must not be treated as host PIDs.

### Commit 9 — `feat(web): show thread machine state` — ~220 LOC — low risk

**Files**

* `ThreadStatusIndicators.tsx`
* Sidebar and chat header/action menu components
* focused component/logic tests

**Change**

Show machine name/state; add Start, Stop, Open terminal. Hide worktree cleanup/indicator behavior for machine-bound threads. Keep VNC capability-driven and deferred.

**Risk**

Stale state and crowded rows. Use a static icon/badge—no continuously repainting animation.

### Commit 10 — `feat(preview): discover and proxy machine dev servers` — ~500 LOC — high risk

**Files**

* preview contracts/RPC
* `PortScanner.ts` or a new machine discovery service
* authenticated HTTP/WebSocket gateway
* browser target resolver and preview UI
* tests

**Change**

Scope discovery by thread/machine, scan inside Incus, probe from the host, and return T3-origin gateway URLs. Preserve current host scanning for non-machine threads.

**Risk**

SSRF, auth, WebSocket/HMR proxying, port collisions across machines, and remote clients. Never expose an arbitrary host/IP proxy; authorize a stored machine binding and validated port.

---

## Windows/WSL and no-op requirements

The fork’s Windows path is especially sensitive to process launch and cwd behavior. The overlay must satisfy all of these:

1. `machineMode` defaults to off and is unavailable on non-Linux hosts.
2. Host `ProcessLauncher` must preserve the resolved command, argv, `shell`, cwd, env inheritance, streams, force-kill behavior, and Scope finalizers exactly.
3. Incus code must not load, probe, or alter PATH during normal Windows/WSL desktop startup.
4. Existing `worktreePath`, worktree settings, worktree cleanup, and review allowlists remain unchanged for non-machine threads.
5. Do not set global provider env or replace loopback MCP URLs globally; translation is per machine session.

The likely Windows breakpoints are `resolveSpawnCommand` wrapping, `.cmd`/PowerShell shell behavior, node-pty/ConPTY, configured Windows absolute binary paths, and WSL path conversion. Machines-off tests should assert the same launch specs before and after the seam. The existing runtime already chooses Node/Bun platform services dynamically (`apps/server/src/server.ts:230-243`) and separately selects Node/Bun PTY implementations (`apps/server/src/server.ts:327-338`); follow that Layer-selection pattern.

## 12-line summary

1. Keep T3 orchestration, SQLite, Git, diffs, files, checkpoints, and assets on the host.
2. Bind-mount `/tank/threads/<id>/ws` into each machine at `/home/dev/ws`.
3. Persist a machine binding with distinct host and guest workspace roots.
4. Do not reuse `worktreePath` for machine workspaces; current cleanup code treats it as Git state.
5. Create machines idempotently on `thread.created` and reconcile again before provider spawn.
6. Stop machines on thread archive; lazy-start on the next turn or terminal request.
7. Archive—not destroy—the machine after the existing thread-delete cleanup finishes.
8. Add a provider-only `ProcessLauncher`; do not swap the global child-process Layer.
9. Codex, pi, ACP, and OpenCode have explicit spawn seams; Claude needs an SDK transport or wrapper.
10. Translate MCP loopback to the Incus host bridge and make attachments readable in the guest.
11. Machine previews need thread-scoped discovery plus an authenticated HTTP/WebSocket gateway.
12. Keep every new field optional and every machine Layer host-local when machines are off.
