# T3 Code state, environments, threads, and headless-provider identity

## Scope and bottom line

This is source-only recon of the owner's patched fork on branch `main`. No dependencies were installed and nothing was built or run.

**Bottom line:** WSL and GCE are two independent T3 execution environments. Each server owns its own SQLite event store/read model, projects, threads, provider runtime bindings, files, Git worktrees, provider availability/auth, and server settings. The desktop can present both environments together, but that is client-side aggregation: it is not thread replication. T3 Connect/PlanetScale stores environment-link, tunnel, device, and sparse agent-activity data; it is not a thread store. The safe recommendation is **push only verified identity material and start fresh cloud threads**. Selective historical thread migration is unsupported and touches more than SQLite rows.

Terminology follows this tree: one running server is an `ExecutionEnvironment`; it owns providers/auth, models, projects/threads, terminals, filesystem, Git, and server settings (`docs/internals/remote.md:35-41`).

---

## Parity via cloudbox sync

T3 still does not replicate repositories, settings, projects, or threads. `cloudbox sync` supplies three one-way local → host parity layers:

1. Identity paths are rsynced and published as the machine-identity manifest.
2. Each configured `repos[]` destination is cloned when missing. A matching Git repository receives only `git fetch --prune origin`; its checkout and working tree are never changed. An existing non-repository or origin mismatch stops sync without overwriting anything.
3. With `t3.settingsParity.enabled`, local server settings are explicitly filtered and deep-merged over the host's `~/.t3/userdata/settings.json`. With `keybindings: true`, the local keybindings file is copied verbatim.

Repository parity is not subject to `identity.maxTransferMb`; Git streams its own clone/fetch output. A dry run performs only identity rsync inspection and does not clone, fetch, or publish T3 settings.

The settings top-level allow-list is `enableLegacyTokenStreaming`, `enableProviderUpdateChecks`, `enableAgentBrowserAccess`, `backgroundActivity`, `automaticGitFetchInterval`, `providerHealthRefreshInterval`, `backgroundActivityProfile`, `defaultThreadEnvMode`, `newWorktreesStartFromOrigin`, `textGenerationModelSelection`, `sourceControlWritingStyle`, `sourceControlWriterModelSelection`, `providers`, `providerInstances`, and `observability`. Nested objects have their own explicit allow-lists:

- `backgroundActivity`: `schemaVersion`, `profile`, `baseProfile`, and the documented override fields.
- model selections: `instanceId`, `model`, `options`; source-control style: `mode`, `customInstructions`, `followChangeRequestTemplates`; observability: `otlpTracesUrl`, `otlpMetricsUrl`.
- provider configs: portable enablement/custom models plus `claudeAgent.autoCompactWindow`, `cursor.apiEndpoint`, `opencode.serverUrl`, and pi's `defaultModel`/`excludedProviders`.
- provider-instance envelopes: `driver`, `displayName`, `accentColor`, `enabled`; known built-in `config` uses the same provider allow-list. `environment` and unknown-driver opaque `config` are omitted.

The filter never copies `binaryPath`, provider home/shadow-home paths, `addProjectBaseDirectory`, launch arguments, OpenCode `serverPassword`, provider-instance environment variables, or any non-allow-listed field. The deep merge preserves those host-specific values already on the box. It does not read or write `environment-id`, `secrets/`, or `state.sqlite`. Sync prints changed field paths and reminds the user to restart T3, but does not restart it.

---

## 1. State per environment

### 1.1 Server-owned layout under `T3CODE_HOME`

For an explicit/default production home, the server state directory is `<T3CODE_HOME>/userdata`; implicit development can instead use `<T3CODE_HOME>/dev`. The path derivation is centralized in `deriveServerPaths` (`apps/server/src/config.ts:108-135`). With the usual `T3CODE_HOME=~/.t3`, the important paths are:

| Path | Owner / meaning | Portability |
|---|---|---|
| `~/.t3/userdata/state.sqlite` plus live `-wal`/`-shm` siblings | This environment's event store, projections, provider-session runtime, checkpoints/diffs, and client-auth records. SQLite is explicitly WAL-mode (`apps/server/src/persistence/Layers/Sqlite.ts:35-40`). | Authoritative, but copy only from a quiescent server or a consistent SQLite snapshot. Not a credential file. |
| `~/.t3/userdata/settings.json` | Server-authoritative settings: providers/instances, binary/home paths, custom models, defaults, background policy, source-control writing style, observability (`packages/contracts/src/settings.ts:698-769`; `apps/server/src/serverSettings.ts:374-413`). | Per environment. Copying it changes the target environment's provider configuration. |
| `~/.t3/userdata/keybindings.json` | Server-side keybinding configuration, not a desktop-only file (`apps/server/src/config.ts:120-123`; `apps/server/src/keybindings.ts:289-314`). The primary environment's resolved bindings drive the web UI (`apps/web/src/state/server.ts:78-96`). | Per environment in this branch. |
| `~/.t3/userdata/attachments/` | Uploaded attachment files. Metadata lives in events and `projection_thread_messages.attachments_json`; files live here (`apps/server/src/persistence/Migrations/007_ProjectionThreadMessageAttachments.ts:7-10`; `docs/internals/providers.md:54-58`). | Per environment; required with migrated attachment-bearing threads. |
| `~/.t3/userdata/secrets/*.bin` | Server secret store. Directory mode is `0700`; files are `0600` (`apps/server/src/auth/ServerSecretStore.ts:158-169`, `apps/server/src/auth/ServerSecretStore.ts:187-203`). | Per environment. Never copy wholesale between WSL and GCE. |
| `~/.t3/userdata/environment-id` | Stable identity of this server environment; generated once and persisted (`apps/server/src/environment/ServerEnvironment.ts:80-130`). | **Machine/environment-bound. Never copy WSL's value onto GCE.** |
| `~/.t3/userdata/anonymous-id` | Server telemetry pseudonymous identity (`apps/server/src/telemetry/Identify.ts:216-245`). | Not needed for functionality; do not copy. |
| `~/.t3/userdata/server-runtime.json` | Current process PID, host, port, origin, and start time (`apps/server/src/serverRuntimeState.ts:11-20`, `apps/server/src/serverRuntimeState.ts:50-61`). | Ephemeral/machine-bound; do not copy. |
| `~/.t3/userdata/logs/` | Server trace/log, provider event log, terminal logs (`apps/server/src/config.ts:125-130`). | Diagnostic only; do not copy for identity or migration. |
| `~/.t3/userdata/model-manifest.json` | Refreshable model-classification cache (`apps/server/src/provider/ModelManifest.ts:148-161`). | Cache; do not copy. |
| `~/.t3/userdata/usage-model-rates.json`, `usage-scan-cache.json` | Refreshable/scanned usage caches (`apps/server/src/usage/UsageService.ts:131-134`). | Cache; do not copy. |
| `~/.t3/caches/` | Provider-status cache (`apps/server/src/config.ts:113-123`). | Cache; do not copy. |
| `~/.t3/worktrees/` | Default Git worktree root (`apps/server/src/config.ts:120-124`). | Per environment and path-dependent. Do not treat it as portable identity. |
| `~/.t3/runtime/` | Pinned server versions, service-launcher state, update DB backups. Pinned versions live under `runtime/versions/<version>` (`apps/server/src/cloud/pinnedRuntime.ts:11-16`). | Runtime/machine state; do not copy. |
| `~/.t3/tools/cloudflared/...` | Managed relay-client binary (`packages/shared/src/relayClient.ts:184-196`). | Reinstallable tool; do not copy. |
| `~/.t3/userdata/triage/<timestamp>/` and optional `~/.t3/source/` | `t3 triage` scratch context/prompts and its suggested source clone/cache (`apps/server/src/cli/triage.ts:188-221`, `apps/server/src/cli/triage.ts:250-270`). | Diagnostic/scratch state; do not copy. |

The server creates the main state, log, attachment, worktree, settings, keybinding, and cache directories itself (`apps/server/src/config.ts:143-154`).

### 1.2 What is in `state.sqlite`

There is **no settings table**. Server settings are `settings.json`; sensitive provider-instance environment values are separate secret files. The database is event-sourced: domain events are the source of truth and projections are derived read models (`docs/internals/glossary.md:62-78`).

The material tables introduced by migrations in this branch are:

| Area | Tables / important columns |
|---|---|
| Source event log | `orchestration_events`: global `sequence`, aggregate kind, stream ID/version, event type, actor, `payload_json`, metadata (`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-22`). |
| Idempotency/command results | `orchestration_command_receipts`: command ID, aggregate kind/ID, accepted time, result sequence, status/error (`apps/server/src/persistence/Migrations/002_OrchestrationCommandReceipts.ts:8-17`). |
| Projects | `projection_projects`: project ID, title, absolute `workspace_root`, model selection, scripts, timestamps/deletion; later migrations add repository/default-mode/favicon-related fields (`apps/server/src/persistence/Migrations/005_Projections.ts:8-17`; migration list at `apps/server/src/persistence/Migrations.ts:70-113`). |
| Thread shell | `projection_threads`: thread ID, project ID, model, branch, absolute `worktree_path`, latest turn, lifecycle timestamps and later runtime/interaction/settle/snooze/pin/PR fields (`apps/server/src/persistence/Migrations/005_Projections.ts:21-32`; `apps/server/src/persistence/Migrations.ts:79-113`). |
| Timeline | `projection_thread_messages`, `projection_thread_activities`, and `projection_thread_proposed_plans` (`apps/server/src/persistence/Migrations/005_Projections.ts:36-59`; `apps/server/src/persistence/Migrations/013_ProjectionThreadProposedPlans.ts:8-16`). |
| Provider/session linkage | `projection_thread_sessions` includes provider/session/thread IDs and active turn; `provider_session_runtime` stores provider/adapter/runtime status plus JSON resume cursor/runtime payload (`apps/server/src/persistence/Migrations/005_Projections.ts:62-71`; `apps/server/src/persistence/Migrations/004_ProviderSessionRuntime.ts:8-17`). |
| Turns/checkpoints | `projection_turns` stores turn state, checkpoint count/ref/status/file summary; `checkpoint_diff_blobs` stores computed diffs (`apps/server/src/persistence/Migrations/005_Projections.ts:75-91`; `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts:8-15`). |
| Pending state | `projection_pending_approvals` and `projection_state` (`apps/server/src/persistence/Migrations/005_Projections.ts:95-112`). |
| Environment access | `auth_pairing_links`, `auth_sessions`, and their later auth columns. These authorize clients to this server; they are unrelated to provider login (`apps/server/src/persistence/Migrations/031_AuthAuthorizationScopes.ts:15-57`). |
| Migration bookkeeping | Effect SQL's migration table plus migrations 1–43 (`apps/server/src/persistence/Migrations.ts:70-116`). |

Checkpoint metadata is only half of a checkpoint. The actual workspace snapshots are hidden Git refs under `refs/t3/checkpoints/<encoded-thread>/turn/<n>` (`apps/server/src/checkpointing/Utils.ts:4-9`); `CheckpointStore` explicitly describes them as filesystem/repository-backed hidden refs (`apps/server/src/checkpointing/CheckpointStore.ts:1-6`).

### 1.3 Desktop/client-owned state

Desktop-local state is separate from whichever remote server is selected:

| Local client state | Location / behavior |
|---|---|
| Desktop shell settings | `~/.t3/userdata/desktop-settings.json`: window state, update channel, exposure, Tailscale, and WSL backend choices. Desktop derives this and the other client paths locally (`apps/desktop/src/app/DesktopEnvironment.ts:201-208`). |
| Client preferences | Desktop: `~/.t3/userdata/client-settings.json`; browser: local-storage key `t3code:client-settings:v1` (`apps/desktop/src/app/DesktopEnvironment.ts:203-206`; `apps/web/src/clientPersistenceStorage.ts:5-29`). These include appearance, favorites/model ordering, project grouping, sidebar, confirmations, and fonts (`packages/contracts/src/settings.ts:27-27`, `packages/contracts/src/settings.ts:209-244`). |
| Environment list and connection credentials | Desktop: encrypted `~/.t3/userdata/connection-catalog.json`. Its plaintext schema contains targets, profiles, credentials, and per-environment remote DPoP tokens; the whole catalog is encrypted with Electron safe storage (`packages/client-runtime/src/platform/storageDocument.ts:17-31`; `apps/desktop/src/app/DesktopConnectionCatalogStore.ts:385-426`). Legacy `saved-environments.json` may remain and is migrated into the catalog (`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:289-374`). |
| T3 Connect/Clerk login | `@clerk/electron` stores encrypted Clerk tokens under the desktop state directory, but this tree does not name the individual files (`apps/desktop/src/app/DesktopClerk.ts:75-77`; `docs/internals/t3-connect.md:173-176`). |
| Offline cache | IndexedDB database `t3code:connection-runtime` stores environment-scoped shell snapshots, thread snapshots, server config, and VCS refs (`apps/web/src/connection/storage.ts:36-75`). Keys include `environmentId`, so this is a cache, not merged authority (`apps/web/src/connection/storage.ts:232-237`, `apps/web/src/connection/storage.ts:539-575`). |

**Important correction:** in this branch, keybindings are server/environment-owned, while `desktop-settings.json`, `client-settings.json`, the connection catalog/environment list, Clerk tokens, and cached thread snapshots are desktop/client-owned.

---

## 2. Threads and environments

### 2.1 Binding

A durable thread belongs to exactly one server database/environment:

- The server's `projection_threads` row has no `environment_id`; environment identity is the enclosing server and its `state.sqlite` (`apps/server/src/persistence/Migrations/005_Projections.ts:21-32`).
- The thread points to one `projectId`, and the thread/project contracts carry `projectId`, `workspaceRoot`, and optional `worktreePath` (`packages/contracts/src/orchestration.ts:285-301`, `packages/contracts/src/orchestration.ts:437-488`).
- Clients add `environmentId` when scoping server-returned projects/threads (`packages/client-runtime/src/state/models.ts:11-37`). Thus the real client identity is `(environmentId, threadId)`, not `threadId` alone.

### 2.2 Can desktop show several environments at once?

**Yes.** The shared client runtime iterates every entry in the environment catalog, collects each environment's thread refs, then builds one combined thread-shell list (`packages/client-runtime/src/state/threadShell.ts:149-171`). Projects are combined the same way (`packages/client-runtime/src/state/projectEntities.ts:71-94`). The sidebar and command palette therefore can present WSL and GCE threads together while routing each action back to its owning environment.

This is presentation/aggregation only. Client offline copies remain keyed by environment and thread (`apps/web/src/connection/storage.ts:58-75`, `apps/web/src/connection/storage.ts:232-237`).

### 2.3 Sync, export/import, relay, and PlanetScale

**No thread sync or migration mechanism was found.** The public orchestration surface has dispatch, diff, search, archived-shell read, and subscriptions, but no export/import/move RPC (`packages/contracts/src/orchestration.ts:27-36`, `packages/contracts/src/orchestration.ts:1749-1780`). Server settings similarly expose get/update, not import/export (`packages/contracts/src/rpc.ts:272-283`, `packages/contracts/src/rpc.ts:396-406`).

T3 Connect does not change this:

- Remote access is one client talking to one server; the server still owns all runtime state (`docs/internals/remote.md:17-38`).
- A saved environment entry is local to the client profile and does not give the hosted app a copy of server session state (`docs/internals/remote.md:46-49`).
- The relay handles environment discovery, cloud records, tunnels, and mobile notifications; after connection, traffic goes directly to the environment (`docs/internals/workspace-layout.md:40-45`).
- PlanetScale's relay schema has environment links/credentials, endpoint allocations, devices/live activities, replay proofs, delivery attempts, and sparse `relay_agent_activity_rows` keyed by environment/thread with `state_json`; it has no project, message, turn, checkpoint, or attachment tables (`infra/relay/src/persistence/schema.ts:18-178`).

`apps/server/src/cloud/*` is for T3 Connect credentials/link intent, managed endpoint/tunnel runtime, headless Connect OAuth, boot service, pinned server runtime, and self-update. Its persisted names are link/relay/runtime credentials, not conversation storage (`apps/server/src/cloud/config.ts:8-14`; `apps/server/src/cloud/CliState.ts:15-21`; `apps/server/src/cloud/pinnedRuntime.ts:11-16`).

### 2.4 What moving WSL → GCE would actually require

There are two materially different operations.

#### Whole-environment transplant

Replace the GCE server's complete `state.sqlite` with a consistent WSL snapshot and copy every referenced attachment and repository/checkpoint state. This moves **all** WSL projects/threads and also carries WSL client-auth tables. It would overwrite/conflict with existing GCE state. Preserve GCE's own `environment-id` and GCE relay/server secrets; do not copy the WSL identity or whole secrets directory.

Because SQLite uses WAL (`apps/server/src/persistence/Layers/Sqlite.ts:35-40`), copying only a live `state.sqlite` is unsafe. The tree's own maintenance tooling uses `VACUUM INTO` for a consistent snapshot (`apps/server/scripts/t3-sqlite-state.ts:219-221`). A stopped-server copy must account for `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm`; the updater treats all three as one rollback unit (`docs/internals/server-updates.md:59-63`).

#### Selective project/thread migration

There is no supported importer. A custom offline migrator would need, at minimum:

1. Project and thread source events from `orchestration_events`, with collision-free global sequence/event/command IDs; corresponding `orchestration_command_receipts` if preserving idempotency.
2. Every dependent projection row: project, thread, messages, activities, proposed plans, thread session, turns, pending approvals, checkpoint diff blobs, and provider-session runtime. `projection_state` is global, so blindly copying it is wrong.
3. Attachment files selected from the attachment metadata/events. File IDs include a normalized thread segment (`apps/server/src/attachmentStore.ts:83-88`), and deletion/pruning also keys by that segment (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:368-395`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:420-492`).
4. The target repository checkout, rewritten `workspace_root`/`worktree_path`, branches, and hidden `refs/t3/checkpoints/...` Git refs. A DB checkpoint ref without its Git object/ref is not restorable.
5. Provider-native continuation state. T3 persists a resume cursor and runtime payload (`apps/server/src/persistence/ProviderSessionRuntime.ts:31-52`, `apps/server/src/persistence/ProviderSessionRuntime.ts:153-185`), but that cursor may name a session stored by Codex/Claude/Cursor/Grok/OpenCode outside T3's DB.
6. Reprojection/validation with the target server version. No supported reprojection/import command was found in the public surface.

This list is a dependency map, **not a safe SQL recipe**. Event sequence, IDs, provider-native sessions, path rewrites, Git refs, and attachment ownership make row-splicing risky.

---

## 3. Projects, repositories, CWD, and worktrees

A project stores an absolute `workspaceRoot`; a thread stores a `projectId` and optional absolute `worktreePath` (`packages/contracts/src/orchestration.ts:285-301`, `packages/contracts/src/orchestration.ts:437-447`). Runtime CWD resolves to the thread's worktree when present, otherwise to its project's workspace root (`apps/server/src/checkpointing/Utils.ts:12-27`).

If the same repository is `/home/dev/src/repo` in WSL and `/srv/t3/repo` on GCE:

- They are two physical projects because the physical key includes both `environmentId` and normalized path (`packages/client-runtime/src/state/projectGrouping.ts:67-86`).
- They may appear as one logical project if repository discovery gives both the same `repositoryIdentity.canonicalKey`; that grouping is UI correlation only (`packages/client-runtime/src/state/projectGrouping.ts:100-140`).
- Routing never substitutes one path for the other. The architecture explicitly says local and remote clones remain different environment-local projects, and a thread binds to one of them (`docs/internals/remote.md:125-130`).
- Starting a cloud thread requires selecting/creating the cloud physical project with the cloud path. No automatic WSL→GCE path map exists in the inspected source.

Default worktrees are created at `<T3CODE_HOME>/worktrees/<repo-basename>/<branch-with-slashes-replaced>` unless an explicit path is supplied (`apps/server/src/vcs/GitVcsDriverCore.ts:2826-2832`). Therefore WSL and GCE have separate worktree directories and separate Git administrative state. Copying only a worktree directory is not a thread migration.

---

## 4. Provider auth on a headless environment

### 4.1 The governing rule

Provider authentication occurs on the server machine, not in the laptop browser (`docs/user/source-control.md:140-144`). T3's provider-instance environment starts from the server process environment, overlays configured variables, and passes that result to provider drivers (`apps/server/src/provider/ProviderInstanceEnvironment.ts:3-15`). Sensitive provider-instance values are stored as T3 server secrets named `provider-env-<base64url(instance)>-<base64url(name)>` and redacted from clients (`apps/server/src/serverSettings.ts:129-150`, `apps/server/src/serverSettings.ts:485-573`).

The generic unauthenticated UI says “Sign in via the CLI”; it does not launch a provider login flow (`apps/web/src/components/chat/ProviderStatusBanner.tsx:35-43`). No generic provider-login/device-code RPC appears in this tree. A user could run a provider CLI in a server-side T3 terminal, but that is still an interactive CLI session, not a dedicated desktop login handoff. T3 Connect has a separate headless OAuth flow that prints a hosted URL and accepts a pasted code (`docs/internals/t3-connect.md:131-137`), but that authenticates the environment to **T3 Connect**, not Claude/Codex/pi/OpenCode/Cursor/Grok.

### 4.2 Per-tool findings

| Tool | What this tree verifies | Exact Linux identity path from this tree | Headless/remote login surface in T3 | Minimal laptop→GCE identity recommendation |
|---|---|---|---|---|
| **Codex app-server** | Default `CODEX_HOME` is `~/.codex`; `auth.json` is intentionally private while sessions/sqlite/cache can be shared in shadow-home mode (`docs/user/providers-codex.md:18-28`; `apps/server/src/provider/Drivers/CodexHomeLayout.ts:19-34`). T3 reports `codex login` when unauthenticated. | **Verified:** `~/.codex/auth.json`, or `<configured CODEX_HOME>/auth.json`; for a shadow instance, `<shadowHomePath>/auth.json` (`docs/user/providers-codex.md:87-101`, `docs/user/providers-codex.md:142-151`). | No T3 device-code UI found; docs require CLI login. | For fresh threads, rsync **only `auth.json`** to the matching target home and mode `0600`. Do not copy the whole Codex home. |
| **Claude Agent SDK / Claude Code** | T3 uses normal Claude config when `homePath` is empty; otherwise it sets `CLAUDE_CONFIG_DIR` and deliberately leaves `HOME` unchanged. Source explicitly mentions macOS keychain behavior (`docs/user/providers-claude.md:25-35`; `apps/server/src/provider/Drivers/ClaudeHome.ts:24-33`). Docs say account and local state span multiple files in the config directory (`docs/user/providers-claude.md:110-115`). | **Unknown.** This tree does not name `~/.claude/.credentials.json` or any exact Linux OAuth file. It also does not establish whether a particular Claude version uses a file, OS keyring, or both. | No T3 provider-login UI found; docs require `claude auth login`, optionally with `CLAUDE_CONFIG_DIR` (`docs/user/providers-claude.md:83-100`). | Exact minimal rsync set is **unknown** from this tree. Do not claim one-file portability. Either establish the upstream Claude version's auth format separately or use a sensitive provider env token where appropriate. |
| **pi (`--mode rpc`)** | The fork starts `pi --mode rpc --no-session`, passes the chosen thread CWD, and passes the merged server/provider environment unchanged (`apps/server/src/provider/Layers/PiAdapter.ts:940-965`). The Pi driver gets that environment from the server process plus provider-instance overrides (`apps/server/src/provider/Drivers/PiDriver.ts:99-123`). Thus T3 does not strip `HOME` or auth env vars. | **Unknown.** `~/.pi/agent/auth.json` does not appear in this tree. T3 delegates credential lookup to the installed pi CLI. | No T3 pi-login/device-code surface found. | The fork **passes auth through** if the remote pi CLI can find it via its own `HOME`/env. The exact file allowlist is unknown here; do not present `~/.pi/agent/auth.json` as source-verified. |
| **OpenCode** | T3 passes the merged provider environment and preserves `OPENCODE_CONFIG_CONTENT`; it can also use a configured OpenCode server URL/password (`apps/server/src/provider/Drivers/OpenCodeDriver.ts:119-144`; `apps/server/src/provider/opencodeRuntime.ts:544-557`; `apps/server/src/provider/opencodeRuntime.ts:708-718`). | **Unknown.** `~/.local/share/opencode/auth.json` does not appear in this tree. | No remote login flow found; status is inferred from connected OpenCode providers (`apps/server/src/provider/Layers/OpenCodeProvider.ts:469-477`). | Exact auth-file rsync set is unknown. Prefer explicit sensitive provider env values if the selected OpenCode provider supports them; otherwise verify upstream OpenCode storage separately. |
| **Cursor** | T3 invokes Cursor ACP with auth method `cursor_login`; status errors tell the operator to run `agent login` (`apps/server/src/provider/acp/CursorAcpSupport.ts:57-65`; `apps/server/src/provider/Layers/CursorProvider.ts:834-840`). Provider env is passed through (`apps/server/src/provider/Drivers/CursorDriver.ts:108-132`). | **Unknown.** No credential/config path is named in this tree. | No T3 device-code/login UI found. | Exact minimal rsync set and safe excludes are unknown. |
| **Grok** | T3 chooses API-key auth when `XAI_API_KEY` is present; otherwise it uses the provider's cached-token auth method (`apps/server/src/provider/acp/GrokAcpSupport.ts:14-18`, `apps/server/src/provider/acp/GrokAcpSupport.ts:63-68`). Provider env is passed through (`apps/server/src/provider/Drivers/GrokDriver.ts:90-114`). | Cached-token file path is **unknown**. | No T3 login UI found. | Best source-verified portable identity is `XAI_API_KEY` as a **sensitive provider environment variable**. Subscription/cached-login file set is unknown. |
| **GitHub CLI (`gh`)** | T3 executes `gh` on the server and docs require `gh auth login` there, then a Settings rescan (`docs/user/source-control.md:70-80`, `docs/user/source-control.md:140-145`). | **Unknown.** `~/.config/gh/hosts.yml` and `GH_CONFIG_DIR` do not appear in this tree. | No T3 `gh` device-code relay; only status/guidance. | Do not claim the candidate path as verified from this repo. Verify the installed `gh` version/upstream behavior separately or use an upstream-supported server env token outside this source-only conclusion. |

### 4.3 What must not be copied

Use an **allowlist**, not “rsync the whole home and exclude a few names.” From this tree, the hard excludes are:

- T3 environment identity and runtime: `environment-id`, `anonymous-id`, `server-runtime.json`, `runtime/`, `tools/`, `caches/`, logs, browser artifacts, and live SQLite `-wal`/`-shm` files unless doing a coordinated DB snapshot.
- T3 `secrets/` wholesale. It mixes provider-env secrets with server-signing keys, asset-signing keys, T3 Connect OAuth/link credentials, relay credentials, and environment signing keys (`apps/server/src/auth/SessionStore.ts:410-475`; `apps/server/src/assets/AssetAccess.ts:45-47`; `apps/server/src/cloud/CliTokenManager.ts:42-42`; `apps/server/src/cloud/config.ts:8-14`; `apps/server/src/cloud/environmentKeys.ts:8-10`). Copy only explicitly selected `provider-env-*.bin` files when also copying the matching provider-instance settings.
- Codex non-identity state for **fresh threads**: `sessions/`, `archived_sessions/`, `sqlite/`, `shell_snapshots/`, `logs/`, `cache/`, `plugins/`, `mcp-oauth-locks/`, plus shadow-local `log/`, `memories/`, and `tmp/` (`apps/server/src/provider/Drivers/CodexHomeLayout.ts:19-34`). `models_cache.json` is also not identity.
- Generic sockets, PID files, lock files, logs, caches, temp files, and provider session histories. Exact names for Claude/pi/OpenCode/Cursor/Grok are unknown in this tree, which is another reason not to sync their whole config directories.

### 4.4 Exact source-verified push set

For a **fresh-thread cloud setup**, this tree supports only the following exact allowlist claims:

```text
Codex default account:       ~/.codex/auth.json
Codex configured home:       <CODEX_HOME>/auth.json
Codex shadow account:        <shadowHomePath>/auth.json
T3 provider env settings:    ~/.t3/userdata/settings.json
T3 sensitive provider envs:  ~/.t3/userdata/secrets/provider-env-*.bin
T3 keybindings (optional):   ~/.t3/userdata/keybindings.json
```

Copying `settings.json` is optional and broad: it includes all server provider paths/defaults, which may need path edits for GCE. A safer operational approach is to configure the cloud environment through the desktop's remote Settings UI, then push only upstream CLI identity files that have been independently verified. The exact minimal files proposed in the question for Claude, pi, OpenCode, and `gh` remain **unknown from this tree**.

---

## 5. Settings ownership and transfer

### 5.1 Environment/server settings

`~/.t3/userdata/settings.json` is authoritative for that server. It includes:

- provider enabled state, binary path, provider home/config path, launch args, custom models, OpenCode server URL/password, and driver-agnostic provider instances (`packages/contracts/src/settings.ts:319-608`, `packages/contracts/src/settings.ts:747-769`);
- global default thread environment mode, worktree behavior, text-generation and source-control-writer model selections, and source-control writing style (`packages/contracts/src/settings.ts:719-745`);
- background activity, update checks, agent browser access, and observability (`packages/contracts/src/settings.ts:684-718`, `packages/contracts/src/settings.ts:769-769`).

Sensitive provider-instance environment values are not recoverable from the redacted JSON alone; they require the matching `provider-env-*.bin` secret (`apps/server/src/serverSettings.ts:485-503`, `apps/server/src/serverSettings.ts:550-616`).

The live model catalog is also environment-specific: it combines installed provider probes with bundled/refreshable manifest data. `model-manifest.json` is only a cache, while user custom models live in server settings (`docs/internals/providers.md:40-52`).

### 5.2 Project and thread settings

These are DB state, not standalone files:

- Project title, `workspaceRoot`, repository identity, default model, project scripts, default thread env mode, and favicon path are project events/projections (`packages/contracts/src/orchestration.ts:285-300`; `apps/server/src/persistence/Migrations.ts:107-110`).
- Thread model selection, runtime permission mode, interaction mode, branch, worktree path, lifecycle state, and linked PR are thread events/projections (`packages/contracts/src/orchestration.ts:437-486`).
- Provider-native permission/config state may also live in the provider's own home; exact upstream files are provider-specific and mostly unknown here.

### 5.3 Desktop/client settings

`client-settings.json` is local-device preference state. It includes appearance, model favorites/order/hiding, confirmation behavior, project grouping, sidebar sorting, and similar UI choices (`packages/contracts/src/settings.ts:27-27`, `packages/contracts/src/settings.ts:193-253`). `desktop-settings.json` is Electron shell/backend behavior, not remote server behavior (`apps/desktop/src/settings/DesktopAppSettings.ts:24-54`).

The client normally edits the **primary selected environment's** server settings and uses that environment's keybindings (`apps/web/src/state/server.ts:66-96`). Therefore WSL and GCE can legitimately have different provider settings and keybindings even when shown in one desktop.

### 5.4 Export/import paths

No dedicated settings export/import feature was found. The source-backed transfer points are:

| Intent | Direct path/state |
|---|---|
| Move server provider/default settings | `~/.t3/userdata/settings.json` plus only matching `secrets/provider-env-*.bin`; inspect/edit path-dependent values. |
| Move server keybindings | `~/.t3/userdata/keybindings.json`. |
| Move desktop UI preferences | Local desktop `~/.t3/userdata/client-settings.json`; browser-only clients use local storage key `t3code:client-settings:v1`. |
| Move desktop shell settings | Local `~/.t3/userdata/desktop-settings.json`; generally do not transfer across machines/OSes. |
| Move environment list/relay access | Local encrypted `connection-catalog.json` and Clerk storage. These are safe-storage/device-bound and should be recreated by pairing/sign-in, not rsynced. |
| Move project/thread settings | No file export; they are event/DB state. Use fresh cloud project/thread creation or build a custom offline migrator. |

---

## 6. Recommendation for the owner

### Do now: fresh cloud threads

1. Keep WSL and GCE as separate environment identities. Never copy `environment-id` or the full T3 secrets directory.
2. Create the GCE project using its real GCE repository path. Let repository identity group it with WSL in the UI if both remotes resolve to the same canonical repository.
3. Push **only verified provider identity**. Today that means Codex `auth.json`; for Grok, prefer a sensitive `XAI_API_KEY`. Treat Claude/pi/OpenCode/Cursor/`gh` file paths as unknown until verified against each installed upstream CLI version.
4. Configure GCE provider settings through the remote environment's Settings UI or transfer `settings.json` plus selected `provider-env-*.bin` files after reviewing absolute paths.
5. Start fresh threads on GCE. Keep historical WSL threads visible beside them in desktop; the combined UI already supports that.

### Later: only if historical migration is worth a custom tool

Build an offline, version-pinned importer that reads a consistent WSL SQLite snapshot, emits new collision-free commands/events into GCE, remaps project/worktree paths, copies attachments, imports Git checkpoint refs/objects, and explicitly chooses whether provider sessions resume or restart. Do not splice projection rows by hand. This is substantially more work and risk than credential push plus fresh threads.

---

## 12-line summary

1. WSL and GCE are separate T3 environments, each identified by its own persisted `environment-id`.
2. A thread belongs to exactly one environment because it lives in that server's `state.sqlite`.
3. Desktop can show WSL and GCE threads together by client-side environment-scoped aggregation.
4. That combined view is not synchronization; offline thread snapshots are only client caches.
5. T3 Connect/PlanetScale stores links, tunnels, devices, and sparse activity—not full threads or projects.
6. Projects store environment-local absolute `workspaceRoot`; threads store `projectId` and optional `worktreePath`.
7. The same repository at different WSL/GCE paths is two physical projects that may be grouped visually.
8. `~/.t3/worktrees` and hidden Git checkpoint refs are per environment/repository.
9. Exact source-verified fresh-thread credential-file push is Codex `<CODEX_HOME>/auth.json` only.
10. Claude, pi, OpenCode, Cursor, Grok cached-token, and `gh` credential file paths are unknown in this tree.
11. Never copy `environment-id`, `server-runtime.json`, caches/logs/runtime, or the whole T3 `secrets/` directory.
12. Recommended path: push verified identity, configure the GCE environment, and use fresh cloud threads.
