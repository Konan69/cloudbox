# Verification and bootstrap testing

## Local bootstrap check

```bash
pnpm check:bootstrap
```

This renders `cloudbox.example.json` with inert SSH and idle-bundle inputs, then runs `bash -n` and `/usr/bin/shellcheck --severity=warning`. Missing ShellCheck is an error; install it with `sudo apt-get install shellcheck`.

The local verification aggregate is:

```bash
pnpm verify
```

It runs typechecking, tests, and the static bootstrap check. It does not run Docker, install host packages, or contact a cloud provider.

## Remote acceptance

```bash
node dist/cli.mjs verify
node dist/cli.mjs verify --expect-vm
node dist/cli.mjs verify --json
node dist/cli.mjs smoke-thread [--keep-project] [--machine-mode]
node dist/cli.mjs verify-sleep --timeout 1800
node dist/cli.mjs verify-idle --timeout 1800
```

`--json` is optional; the default output is a table. `--timeout` is seconds. `verify-idle` requires a timeout greater than `(idleMinutes + 5) * 60`. Every verification command exits non-zero when a check fails. SSH uses `boxUser` and derives the private key by removing `.pub` from `sshPublicKeyPath`; the configured path must end in `.pub`. On AWS, pass `--host <public-ip>` to `verify` and `smoke-thread`. `--host` is rejected for GCP.

## Access: IAP TCP forwarding

GCP verification and smoke commands address `cloudbox-<name>` through IAP, not the external IP. Install and authenticate the `gcloud` CLI first. The deployer receives `roles/iap.tunnelResourceAccessor`, and the SSH firewall accepts TCP 22 only from Google's IAP range, `35.235.240.0/20`.

`cloudbox ssh`, sync, verification, and acceptance all use `gcloud compute start-iap-tunnel` as SSH's `ProxyCommand`. The VM keeps an ephemeral external IP for egress, but that IP is not stable across suspend/resume and must never be pinned.

## Autonomous T3 thread smoke

```bash
pnpm build:cli
node dist/cli.mjs smoke-thread --timeout 240 [--keep-project] [--machine-mode]
```

The command prepares `/home/dev/smoke-repo` over SSH, opens an SSH tunnel to the loopback-only T3 server, and reads the existing automation bearer. It prints the environment ID and reads environment-owned settings with `server.getSettings`. When pi is disabled, it uses `server.updateSettings` to add an enabled `pi` provider instance with default model `openai-codex/gpt-5.6-sol`, and logs `enabled provider pi in environment settings`. It then refreshes the provider catalog and runs separate `pi` (`openai-codex/gpt-5.6-sol`) and `codex` (`gpt-5.6-sol`) cases. Each case prints its own PASS/FAIL, thread ID, and assistant text.

Every created smoke thread is deleted, including failed cases. The smoke project is deleted by default; `--keep-project` preserves the earlier behavior of leaving it in the environment.

`--machine-mode` updates the smoke project with `machineMode: "thread"` before creating threads. For each provider, it waits for the streamed session state to become `running`, then checks over SSH that the deterministic `thread-…` Incus instance is `RUNNING`, `tank/threads/<thread-id>/ws` exists, and its mounted workspace contains `README.md`. The agent must report `hostname`, `/etc/hostname`, and `/home/dev/ws`; the smoke requires both hostnames to equal the Incus machine name, rejects `cloudbox-test`, and requires the workspace listing to contain `README.md`. After `thread.delete`, it reports whether the instance and dataset were destroyed or retained in the overlay's archived state. Each assertion prints its own PASS/FAIL and evidence.

The implementation follows these contracts from dev's fork:

- `packages/contracts/src/environmentHttp.ts:434-438,500-530` defines bearer-authenticated WebSocket-ticket issuance plus orchestration snapshot, thread snapshot, and dispatch HTTP routes.
- `packages/contracts/src/orchestration.ts:287-310,454-465,731-760` defines project `machineMode`, persisted thread machine bindings, and the `project.meta.update` command used to enable machine mode, alongside the existing project/thread lifecycle commands.
- `apps/server/src/machine/MachineService.ts:20-43` defines the deterministic machine name and `/tank/threads/<thread-id>/ws` host workspace. `apps/server/src/machine/IncusMachineService.ts:184-323` provisions the ZFS dataset and golden Incus machine and mounts it at `/home/dev/ws`.
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:40-57,90-103` removes the machine worktree and calls `MachineService.destroy`; the current implementation removes both the instance and ZFS dataset. The smoke also accepts the documented stopped-instance/dataset-retained archived policy and reports which disposition occurred.
- `packages/contracts/src/orchestration.ts:720-760,910-948` defines `project.create`, `project.meta.update`, `project.delete`, `thread.create`, `thread.delete`, and `thread.turn.start` payloads.
- `packages/contracts/src/rpc.ts:281-282,396-405` defines `server.getSettings` and `server.updateSettings`; `apps/server/src/ws.ts:1691-1709` reads, updates, and returns redacted environment settings.
- `packages/contracts/src/settings.ts:553-615,753-768,913-960` defines pi settings (`enabled`, `defaultModel`, provider filtering, launch configuration) and the whole-map `providerInstances` update boundary. The smoke preserves the returned map and adds/updates only the `pi` instance envelope.
- `packages/contracts/src/orchestration.ts:53-70` makes `modelSelection.instanceId` the provider-instance routing key; the model is the provider-specific slug. The smoke therefore uses instance IDs `pi` and `codex` and never falls back from pi.
- `packages/contracts/src/orchestration.ts:1575-1588,1774-1777` defines the `orchestration.subscribeThread` stream items (`snapshot`, `synchronized`, and `event`).
- `apps/server/src/ws.ts:1474-1602` attaches live thread delivery before replay/snapshot loading and emits the synchronization marker before the live tail. The smoke waits for that marker before dispatching the turn, avoiding a completion race.
- `apps/server/src/ws.ts:2488-2524` authenticates `/ws` with the one-use ticket and serves Effect's JSON RPC protocol. The smoke acknowledges each streamed chunk.
- `apps/server/src/orchestration/projector.ts:567-624` identifies a session leaving `running` as the authoritative turn-end signal. The smoke waits for that streamed `thread.session-set` event, then reads the final thread snapshot.
- `apps/server/src/provider/Layers/PiAdapter.ts:899-928,943-966` parses the pi model slug into provider/model IDs and launches `pi --mode rpc --no-session` in the thread working directory.

After the explicit settings update and provider refresh, a provider case fails before thread creation when the catalog still says it is disabled, unavailable, missing, unauthenticated, or does not expose the requested model. The exact server provider message is preserved in the failure output.
