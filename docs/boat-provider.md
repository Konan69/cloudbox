# Boat provider lane

The Boat lane is code-only until the account completes checkout. It uses the Boat REST API at `https://boat.dev/api/v1`; tests inject a fake `fetch` and never contact the real account.

## First run

```bash
cp cloudbox.boat.example.json cloudbox.json
$EDITOR cloudbox.json
export BOAT_API_KEY='<account service API key>'
pnpm build:cli
pnpm cloudbox boat up
```

`boat up` performs the full initial path:

1. Check account limits, then create or resume the sandbox with the configured type, TTL, and optional environment.
2. Authorize `sshPublicKeyPath`, wait for SSH, clone/build the configured T3 fork with `vp`, and enable lingering.
3. Install `t3code-fork.service`, push the existing identity/repository/settings loadout over SSH, and restart the service.
4. Keep T3 on `127.0.0.1:3773`, proxy `0.0.0.0:3774` to it, expose port 3774 through Boat hosting, and print the protected HTTPS URL.

Boat's hosting route cannot reach a service bound only to loopback. The separate `socat` user service is intentional: T3 remains loopback-only while Boat receives a machine-facing port.

Never run `t3 service install` on this fork. That command installs the published npm release instead of the local patched build. The enabled custom user unit runs `apps/server/dist/bin.mjs` directly and returns after stop/resume or fork. A hand-run process would not return because Boat snapshots files, not process or memory state.

## Commands

```bash
pnpm cloudbox boat status
pnpm cloudbox boat stop
pnpm cloudbox boat resume
pnpm cloudbox boat fork
pnpm cloudbox boat ssh
pnpm cloudbox boat exec 'systemctl --user status t3code-fork.service'
pnpm cloudbox boat exec --detached 'vp run build'
pnpm cloudbox boat host
```

The managed primary is found by the exact display name `cloudbox-<config.name>`. `fork` leaves the primary unchanged and prints the new sandbox id, SSH host, and hosted URL.

## Model differences and limits

| Boat behavior | Cloudbox impact |
|---|---|
| Snapshots capture files, installed packages, and enabled services, but not RAM, running processes, open ports, or machine identity. | This is reboot-style persistence, not GCE suspend or EC2 hibernation. In-memory T3/agent state is lost. The enabled user services restore the server and hosting proxy. |
| TTL starts at create/resume time, not last activity. Numeric TTL is capped at 2,592,000 seconds (30 days); `null` disables auto-stop. | `idleMinutes` does not drive Boat. Trial accounts require auto-stop and cap TTL at 2 hours. `/api/auth/clients` is the accurate T3 attached-user signal if a future activity-aware controller is added. |
| Trial permits 2 concurrent sandboxes and only `small`/`default`. Paid plans set concurrency and rolling start limits; create, resume, and fork each consume one start. | Checkout is currently required, so `up`, `resume`, and `fork` will be refused until the account can start machines. |
| Disk is fixed by type: 12 GB small, 50 GB default, 125 GB large, 251 GB xlarge. Shrinking fails when restored data does not fit. The pricing/machines pages document `xlarge`, but the current v1 OpenAPI request enums still list only small/default/large. | Choose a type that can hold the source build and dependencies. The client accepts and sends `xlarge`, but the first real call will prove whether the live v1 endpoint supports it; `xlarge` also needs paid capacity and operator allocation. |
| Snapshots are continuous and final on clean stop. A refused snapshot leaves the VM running but pauses billing. | Use `stop`, not permanent deletion, to keep resumable data. |
| A sandbox pins one environment version for life until explicitly upgraded. | Changing the named Boat environment does not silently update an existing Cloudbox. |
| Boat `idle`/`running` reflects Boat prompt work, not commands or SSH processes. | Do not use the Boat sandbox state as T3 user/agent activity. T3's authenticated `/api/auth/clients` endpoint reports attached clients. |

The safe read-only check for this account is `~/.ascii/bin/boat limits --json`. At implementation time it reported `canStart: false`, `checkoutRequired: true`, and `startBlockedReason: subscription_required`.

## Operator inputs

The first real `boat up` needs:

- checkout/payment completed so `GET /limits` reports `canStart: true`;
- an account service key in `BOAT_API_KEY` with sandbox lifecycle, command, SSH-key, and hosting access;
- a valid `cloudbox.json` copied from `cloudbox.boat.example.json`;
- the private key matching `sshPublicKeyPath`, plus local `ssh` and `rsync`;
- access to the configured T3 Git repository/branch and any selected Boat environment.

The printed hosted URL contains a `_token` query parameter by default. Treat it as a secret. Use `cloudbox boat host --public` only when intentionally removing that gate.
