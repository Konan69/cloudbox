# Boat provider lane

Boat replaces the GCP design for the T3 desktop workflow, but it is only one stock SSH sandbox. Cloudbox creates/resumes the sandbox and syncs files. It does **not** clone, build, install, host, or run T3. The Windows T3 desktop connects over SSH, installs its matching T3 server release, and owns the tunnel.

The account cannot start sandboxes until checkout is complete. Tests use fake HTTP clients or localhost sockets and never call the real Boat API.

## One-time setup

Boat documents its SSH key as `~/.ssh/ascii_box_ed25519`. Create it in WSL if the Boat CLI has not already created it:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ascii_box_ed25519
```

Windows OpenSSH cannot use the WSL path directly. Copy the same private/public pair into `C:\Users\dev\.ssh\` from Windows PowerShell, then keep the private key restricted to the current Windows user:

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
Copy-Item "\\wsl.localhost\Ubuntu-24.04\home\dev\.ssh\ascii_box_ed25519*" "$HOME\.ssh\"
icacls "$HOME\.ssh\ascii_box_ed25519" /inheritance:r /grant:r "${env:USERNAME}:(R)"
```

The Windows-launched `ProxyCommand` also needs `BOAT_API_KEY` inside WSL. Put the key in the Windows user environment and include it in `WSLENV` for the Windows-to-WSL direction, then restart T3 so it receives the new environment:

```powershell
[Environment]::SetEnvironmentVariable("BOAT_API_KEY", "<account service API key>", "User")
$current = [Environment]::GetEnvironmentVariable("WSLENV", "User")
$items = @($current -split ':' | Where-Object { $_ -and $_ -ne 'BOAT_API_KEY/u' })
[Environment]::SetEnvironmentVariable("WSLENV", (($items + 'BOAT_API_KEY/u') -join ':'), "User")
```

Configure and build Cloudbox in WSL:

```bash
cp cloudbox.boat.example.json cloudbox.json
$EDITOR cloudbox.json
export BOAT_API_KEY='<account service API key>'
pnpm build:cli
pnpm cloudbox boat up
```

## `boat up` flow

`cloudbox boat up` does only this:

1. Create the named sandbox, or resume it, using `boat.type` and `boat.ttlSeconds`.
2. Authorize `~/.ssh/ascii_box_ed25519.pub` and wait for SSH.
3. Push the configured identity paths, repositories, and portable T3 settings through the existing sync paths.
4. Atomically add or replace one managed entry in `C:\Users\dev\.ssh\config`.

It prints `cloudbox-<name>`. In the Windows T3 desktop, add that name as an **SSH environment**. T3 then installs the matching server release on the sandbox and creates its own tunnel.

The managed block has exact begin/end markers. Re-running `boat up` replaces only that block and leaves every other SSH entry byte-for-byte unchanged. For this checkout and distro, the block is:

```sshconfig
# BEGIN CLOUDBOX BOAT cloudbox-dev
Host cloudbox-dev
    HostName cloudbox-dev
    User user
    IdentityFile ~/.ssh/ascii_box_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile NUL
    GlobalKnownHostsFile NUL
    LogLevel ERROR
    ProxyCommand C:/Windows/System32/wsl.exe --distribution Ubuntu-24.04 --cd /home/dev/cloudbox --exec /usr/local/lib/nodejs/node-v24.14.1-linux-x64/bin/node /home/dev/cloudbox/dist/cli.mjs boat proxy dev %p
# END CLOUDBOX BOAT cloudbox-dev
```

The Node executable, WSL distro, checkout path, and name are captured from the `boat up` process. Re-run `pnpm build:cli` and `boat up` after moving the checkout, changing distro, or replacing Node.

Boat resumes onto a new machine with a new IP and new SSH host keys. The managed entry therefore does not retain host keys. The API-authenticated proxy resolves the current IP each time; disabling host-key persistence is a deliberate consequence of Boat's documented machine-identity model.

## Independent sandboxes

Each config manages one sandbox named `cloudbox-<name>`. Use a separate working directory and config for each sandbox.

`identity.paths` selects the files copied by rsync. The examples copy no identity files and disable settings parity. Enable these explicitly for your account.

## Resume-on-connect proxy

Windows OpenSSH invokes:

```text
cloudbox boat proxy <name> %p
```

through `wsl.exe`. The proxy:

1. Finds the exact managed sandbox.
2. Waits for an in-progress archive, then resumes an archived sandbox with the configured type and TTL.
3. Polls until Boat reports ready, retrying the API's retryable `boat_restoring` response.
4. Resolves the current IP and opens the requested TCP port.
5. Retries an SSH-side `boat_restoring` preface, then pipes stdin/stdout only after receiving an SSH banner.

There is no stale-IP, direct-host, hosting, or network-tool fallback. Missing config, credentials, sandbox, key, address, malformed managed markers, unexpected SSH data, and retry exhaustion each fail with a specific error.

## Commands

```bash
pnpm cloudbox boat status
pnpm cloudbox boat stop
pnpm cloudbox boat resume
pnpm cloudbox boat fork
pnpm cloudbox boat ssh
pnpm cloudbox boat exec 'uname -a'
pnpm cloudbox boat exec --detached 'long-running-command'
```

`ssh` and `exec` also resume the primary sandbox when needed. `fork` leaves the primary unchanged and prints the fork id and current SSH address; it does not add another Windows SSH alias. `proxy` is an internal stdio command used by Windows OpenSSH.

## Boat persistence and limits

| Boat behavior | Cloudbox impact |
|---|---|
| Resume restores the filesystem onto a new machine; IP, SSH host keys, RAM, processes, and open ports do not survive. | The proxy resolves every connection. T3 desktop reinstalls/reconnects its matching server as needed. |
| TTL starts at create/resume time. Numeric TTL is capped at 2,592,000 seconds (30 days); `null` disables auto-stop. | `idleMinutes` does not drive Boat. Trial accounts require auto-stop and cap TTL at 2 hours. |
| Trial permits 2 concurrent sandboxes and only `small`/`default`. Paid plans set concurrency and rolling start limits. | Checkout is currently required, so lifecycle commands that start a machine remain blocked. |
| Disk is fixed by type: 12 GB small, 50 GB default, 125 GB large, 251 GB xlarge. | Choose a type large enough for T3's server install and repositories. |
| A refused final snapshot leaves the VM running but pauses billing. | Use `stop`, not permanent deletion, to retain resumable files. |
| A sandbox pins one environment version for life until explicitly upgraded. | Changing the named Boat environment does not silently update the existing sandbox. |

The safe read-only account check is:

```bash
~/.ascii/bin/boat limits --json
```

At implementation time it reported `canStart: false`, `checkoutRequired: true`, and `startBlockedReason: subscription_required`.

The trial 2-hour TTL is renewable: `PATCH /sandboxes/:id {"ttlSeconds":7200}` restarts the clock (verified 2026-10-04). `~/bin/boat-keepalive`, run every 20 minutes by the `boat-keepalive.timer` systemd user unit on the PC, renews it for any box with a live `boat proxy` tunnel. Without it the box is archived every 2 hours even mid-work, which kills running agents and their background commands.

## User action still required

- Complete Boat checkout so `GET /limits` reports `canStart: true`.
- Create/copy the matching `ascii_box_ed25519` key pair into both WSL and `C:\Users\dev\.ssh`.
- Persist `BOAT_API_KEY` and `WSLENV` in Windows as shown above, then restart T3.
- Run the first real `pnpm cloudbox boat up`; this implementation intentionally did not start a real sandbox.
