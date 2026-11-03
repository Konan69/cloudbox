# T3 Code patched fork: headless Ubuntu 24.04 server reconnaissance

## Scope and conclusions

This report is for `main` at commit `7a3a32079da011c14683c4872d9354fadeefe080`. `PATCH.md` identifies the three pi-provider commits as `f5f0c955`, `da4659dd`, and `2f07fc33` and documents the fork's V1 pi limitations. [PATCH.md:73-86] [PATCH.md:112-144]

**Recommended deployment model:** build this checkout on the EC2 host, run `apps/server/dist/bin.mjs serve` from a custom systemd **user** unit, bind it to `127.0.0.1`, and let T3 Connect's managed `cloudflared` tunnel expose it. Do **not** run this fork's `t3 service install`: that command installs `t3@0.0.35` from npm, not this local patched build. [apps/server/package.json:1-20] [apps/server/src/cloud/pinnedRuntime.ts:12-40] [apps/server/src/cloud/pinnedRuntime.ts:149-159]

Three preflight issues can block the desired relay deployment:

1. A fresh source checkout has T3 Connect disabled unless the public relay/Clerk values are supplied at build time or at server runtime. [.env.example:1-22] [docs/internals/t3-connect.md:17-57]
2. Building the monorepo requires Node `^24.13.1`; “Node 24” below `24.13.1` is insufficient even though the server package alone permits `>=24.10`. [package.json:56-59] [apps/server/package.json:50-52]
3. The server package reports version `0.0.35`, while `PATCH.md` says the patched desktop shell reports `0.0.36-nightly.20260828.1210`. Expect a client/server version warning and do not accept a self-update that would replace the fork. [apps/server/package.json:1-4] [PATCH.md:3-17]

---

## 1. BUILD

### Minimal build commands

On fresh Ubuntu, install the native-build and verification tools, then install the repo-documented global `vp` CLI:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential python3 git curl ca-certificates \
  jq sqlite3 rsync zstd

curl -fsSL https://vite.plus | bash
command -v vp
```

The repo's source-build instructions require the global Vite+ CLI and use `vp i` for dependency installation. [README.md:92-112] The compiler toolchain is needed if pnpm must build `node-pty`/other native addons; `jq` and `sqlite3` are used by the external status checks later in this report. [pnpm-workspace.yaml:11-20]

Run from the checkout at `/home/dev/t3code-wsl-fix`:

```bash
set -euo pipefail
cd /home/dev/t3code-wsl-fix

node --version
node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); if (M!==24 || m<13 || (m===13 && p<1)) process.exit(1)'

# Use the tracked public production identifiers during this build.
set -a
. ./.env.example
set +a

vp install --frozen-lockfile
vp run --filter t3 build

test -f apps/server/dist/bin.mjs
test -f apps/server/dist/service-launcher.mjs
test -f apps/server/dist/client/index.html
test -d apps/server/node_modules
test -d node_modules/.pnpm
```

Why this target:

- The root `build` script builds every app/package and is not minimal. [package.json:21-23]
- The `t3` build task runs `apps/server/scripts/cli.ts build` and depends on `@t3tools/web#build`. [apps/server/vite.config.ts:30-33]
- That script runs `build:bundle`, then copies `apps/web/dist` to `apps/server/dist/client`. [apps/server/scripts/cli.ts:155-170]
- `build:bundle` emits both the CLI bundle and `service-launcher.mjs`. [apps/server/package.json:17-20]

There is no `.node-version` in this tree and no `js_runtime`/`jsRuntime` Vite Plus setting in the root or app Vite configs. Treat both as **unknown/not configured**, not as an alternate Node pin. The authoritative checked-in constraints are the two `engines.node` fields above.

### Runtime artifact set

For an in-place EC2 build, keep these together:

```text
/home/dev/t3code-wsl-fix/
├── apps/server/dist/**          # bin.mjs, emitted chunks/maps, client assets, service launcher
├── apps/server/node_modules/**  # pnpm workspace symlinks
└── node_modules/**              # backing .pnpm store and native addons
```

`bin.mjs` is **not** the whole runtime. The packer bundles normal JS dependencies but deliberately leaves native/native-loader dependency closures external. The external list includes `node-pty`, `ffi-rs`, `@yuuang/*`, `@ff-labs/*`, `msgpackr-extract`, `node-gyp-build`, `node-addon-api`, and `detect-libc`. [apps/server/vite.config.ts:38-52] [scripts/lib/cli-external-packages.ts:19-52]

`vp install` is allowed to run the `node-pty` and `msgpackr-extract` builds, and the workspace asks pnpm to include Linux x64/glibc artifacts. [pnpm-workspace.yaml:11-20] [pnpm-workspace.yaml:158-161]

If transferring a build instead of building on EC2, preserve symlinks:

```bash
cd /home/dev/t3code-wsl-fix
tar --zstd -cpf /tmp/t3-server-runtime.tar.zst \
  apps/server/dist \
  apps/server/package.json \
  apps/server/node_modules \
  node_modules
```

Build on the same OS/architecture/libc as the target when possible. A Linux x64 glibc EC2 host needs Linux x64 native addons; a Windows or macOS install tree is not a substitute.

`apps/server/dist/client/**` is needed for the normal `/pair` and browser UI. An API/WebSocket-only process may start without it because `resolveStaticDir()` can return `undefined`, but that is not a complete supported `t3 serve` deployment. [apps/server/src/config.ts:217-235]

`dist/service-launcher.mjs` is needed only by T3's generated background-service mechanism. The native resource monitor is optional telemetry: the server searches for it or accepts `T3CODE_RESOURCE_MONITOR_PATH`; failure to find it does not define the core HTTP/WebSocket runtime. [apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts:139-174]

T3 Connect installs its own pinned `cloudflared` under `<baseDir>/tools/cloudflared/<version>/<platform>-<arch>/`; it is not a build artifact. [packages/shared/src/relayClient.ts:193-240]

### Is the desktop WSL staging copy the full runtime set?

**Yes for the built server runtime itself.** `STAGE_RUNTIME_SCRIPT` checks for `apps/server/dist/bin.mjs` and root `node_modules`, then copies the complete `apps/server` tree plus root `node_modules` while preserving metadata/symlinks. [apps/desktop/src/wsl/DesktopWslEnvironment.ts:262-306]

It also has a dedicated Linux `node-pty` probe/prebuild path. [apps/desktop/src/wsl/DesktopWslEnvironment.ts:356-424]

It is **not** a complete headless-machine image: it does not copy provider binaries or their login/config state, git/ssh credentials, projects, T3 userdata, Tailscale, or relay account credentials.

---

## 2. RUN

### Command names and semantics

There is no `run` subcommand. These three forms run the same server core:

```bash
node apps/server/dist/bin.mjs [flags] [cwd]         # root/default handler
node apps/server/dist/bin.mjs start [flags] [cwd]   # explicit alias
node apps/server/dist/bin.mjs serve [flags] [cwd]   # headless presentation
```

The root command and `start` call `runServerCommand` normally. `serve` forces headless presentation, disables browser opening, and disables automatic project creation from the process cwd. [apps/server/src/bin.ts:48-61] [apps/server/src/cli/server.ts:8-35]

### Complete server flag/argument set

The root command, `start`, and `serve` share this set. [apps/server/src/cli/config.ts:173-190]

| CLI | Environment equivalent | Meaning/default |
|---|---|---|
| `--mode web\|desktop` | `T3CODE_MODE` | Default `web`; `desktop` uses loopback-oriented defaults. |
| `--port N` | `T3CODE_PORT` | HTTP/WebSocket port. Default starts at `3773`; web mode finds an available port, desktop mode fixes `3773`. |
| `--host HOST` | `T3CODE_HOST` | Bind interface. Node server default is `127.0.0.1`; examples: `127.0.0.1`, `0.0.0.0`, Tailnet IP. |
| `--base-dir DIR` | `T3CODE_HOME` | Base data directory. Default `~/.t3`; normal state is under `<base>/userdata`. |
| positional `[cwd]` | none | Provider-session working directory; defaults to the process cwd. It is resolved and created if absent. |
| `--dev-url URL` | `VITE_DEV_SERVER_URL` | Development web origin; not for production/headless deployment. |
| `--no-browser[=BOOL]` | `T3CODE_NO_BROWSER` | Disable browser launch. `serve` forces true. |
| `--bootstrap-fd N` | `T3CODE_BOOTSTRAP_FD` | Read one one-line desktop bootstrap JSON envelope from an inherited FD. |
| `--auto-bootstrap-project-from-cwd[=BOOL]` | `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD` | Create a project for cwd when missing. Web default true; `serve` forces false. |
| `--log-websocket-events[=BOOL]` / `--log-ws-events` | `T3CODE_LOG_WS_EVENTS` | Enable outbound WebSocket request logging. |
| `--tailscale-serve[=BOOL]` | `T3CODE_TAILSCALE_SERVE` | Ask Tailscale Serve to front this backend over Tailnet HTTPS. |
| `--tailscale-serve-port N` | `T3CODE_TAILSCALE_SERVE_PORT` | Tailnet HTTPS port; default `443`. |

Definitions are in [apps/server/src/cli/config.ts:20-75]; precedence/default resolution is in [apps/server/src/cli/config.ts:244-347]. Effect CLI also supplies generated `--help`, `--version`, and a global log-level flag; this tree consumes `GlobalFlag.LogLevel` but does not define those library-level spellings locally. Use `node apps/server/dist/bin.mjs serve --help` on the built artifact as the final authority.

### `--bootstrap-fd`

This is a desktop-process bootstrap channel, not normal headless authentication. The envelope schema requires `mode: "desktop"` and carries port, host, T3 home, the trusted desktop bootstrap token, Tailscale settings, optional OTLP settings, telemetry FDs, and optional resource-monitor path. [packages/contracts/src/desktopBootstrap.ts:5-24]

The packaged desktop passes FD 3 to the native backend; the WSL path uses stdin/FD 0. [apps/desktop/src/backend/DesktopBackendConfiguration.ts:380-430] [apps/desktop/src/backend/DesktopBackendConfiguration.ts:560-629]

A headless service should not set it.

### Recommended relay-first foreground setup

```bash
set -euo pipefail
cd /home/dev/t3code-wsl-fix
T3=(node "$PWD/apps/server/dist/bin.mjs")

export T3CODE_HOME=/home/dev/.t3
export T3CODE_RELAY_URL=https://relay.t3.codes
export T3CODE_CLERK_PUBLISHABLE_KEY=example-publishable-key
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=example-client-id

# Installs/locates cloudflared, performs Clerk OOB OAuth, and records managed-link intent.
"${T3[@]}" connect link --headless --base-dir "$T3CODE_HOME"

# Keep the backend private; cloudflared reaches it on loopback.
"${T3[@]}" serve \
  --base-dir "$T3CODE_HOME" \
  --host 127.0.0.1 \
  --port 3773 \
  /home/dev
```

`connect link --headless` is preferable to bare `connect --headless` for automation because bare `connect` also offers to install T3's background service. Both authorize with out-of-band OAuth; SSH is detected automatically from `SSH_CONNECTION`/`SSH_TTY`. [apps/server/src/cli/connect.ts:65-134] [apps/server/src/cli/connect.ts:469-540] [apps/server/src/cli/connect.ts:676-720]

On startup, the server reconciles persisted link intent against `http://127.0.0.1:<port>`, then launches the managed tunnel. [apps/server/src/server.ts:589-656]

### Direct pairing and bearer access

For direct LAN/Tailnet pairing:

```bash
# Bind to a trusted Tailnet address, not the EC2 public interface.
"${T3[@]}" serve \
  --base-dir "$T3CODE_HOME" \
  --host "$(tailscale ip -4)" \
  --port 3773 \
  /home/dev
```

`serve` prints a connection string, one-time token, `/pair#token=...` URL, and QR code. [apps/server/src/startupAccess.ts:122-147]

To mint another one-time code for the already-running process:

```bash
"${T3[@]}" pair --base-dir "$T3CODE_HOME" --ttl 10m --label desktop
```

`pair` can also add `--tailscale --tailscale-serve-port 443`. Its flags are defined at [apps/server/src/cli/pair.ts:454-492].

For a non-T3 programmatic client, issue a bearer session directly:

```bash
BEARER=$("${T3[@]}" auth session issue \
  --base-dir "$T3CODE_HOME" \
  --ttl 30d \
  --label automation \
  --token-only)

curl -fsS \
  -H "Authorization: Bearer $BEARER" \
  http://127.0.0.1:3773/api/auth/session
```

The desktop's **Remote link** form does not consume that direct bearer as a pairing code. It exchanges a one-time bootstrap credential at `/oauth/token` and persists the returned bearer. [packages/client-runtime/src/authorization/remote.ts:84-133] [packages/client-runtime/src/connection/onboarding.ts:86-119]

### Tailscale Serve

```bash
"${T3[@]}" serve \
  --base-dir "$T3CODE_HOME" \
  --host 127.0.0.1 \
  --port 3773 \
  --tailscale-serve \
  --tailscale-serve-port 443 \
  /home/dev

# In another shell, mint a pairing URL that definitely uses MagicDNS HTTPS:
"${T3[@]}" pair --base-dir "$T3CODE_HOME" --tailscale
```

The server configures Tailscale Serve after activation and disables that mapping on clean shutdown. [apps/server/src/server.ts:536-586]

### Persistence layout

With default/explicit `T3CODE_HOME=/home/dev/.t3`:

```text
~/.t3/
├── userdata/
│   ├── state.sqlite                 # projects, threads, auth pairing grants/sessions
│   ├── settings.json                # server/provider settings
│   ├── environment-id
│   ├── server-runtime.json          # pid, host, port, origin, startedAt while running
│   ├── logs/
│   └── secrets/*.bin                # 0700 dir, 0600 files
├── tools/cloudflared/...            # managed relay client
├── runtime/...                      # only T3 background-service machinery
└── worktrees/
```

The path derivation is explicit in [apps/server/src/config.ts:102-134], and secret permissions/naming are in [apps/server/src/auth/ServerSecretStore.ts:158-203]. Pairing grants and bearer sessions are database rows; the server signing key is `userdata/secrets/server-signing-key.bin`. [apps/server/src/auth/SessionStore.ts:410-476]

T3 Connect persists:

- `cloud-cli-oauth-token.bin` (Clerk OAuth access/refresh credential);
- `cloud-cli-desired-link.bin`;
- linked user, relay URL/issuer, environment credential, mint public key, endpoint runtime config, and publish preference as separate `*.bin` files.

[apps/server/src/cloud/CliTokenManager.ts:42-42] [apps/server/src/cloud/CliTokenManager.ts:335-350] [apps/server/src/cloud/CliState.ts:15-70] [apps/server/src/cloud/config.ts:8-14]

### What `service install` generates

On Linux it writes a **user** unit at `~/.config/systemd/user/t3code.service`, runs `systemctl --user daemon-reload`, enables it, calls `loginctl enable-linger`, and restarts it. [apps/server/src/cloud/bootService.ts:202-263]

The rendered unit is effectively:

```ini
[Unit]
Description=T3 Code server
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h
Environment=T3CODE_HOME=<base-dir>
Environment=T3_BOOT_SERVICE_UNIT=t3code.service
ExecStart=<absolute-node-path> <base-dir>/runtime/service-launcher.mjs
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
StandardOutput=append:<base-dir>/userdata/logs/boot-service.log
StandardError=append:<base-dir>/userdata/logs/boot-service.log

[Install]
WantedBy=default.target
```

That content comes directly from [apps/server/src/cloud/bootService.ts:61-90]. It does not persist arbitrary environment variables. The launcher requires `T3CODE_HOME` and spawns `<base>/runtime/versions/<version>/node_modules/t3/dist/bin.mjs serve`. [apps/server/src/serviceLauncher.ts:399-405] [apps/server/src/serviceLauncher.ts:606-608]

**Fork blocker:** installation first runs:

```text
npm install --prefix <staging> --no-fund --no-audit t3@<apps/server package version>
```

[apps/server/src/cloud/pinnedRuntime.ts:149-159]

Here that version is `0.0.35`. Therefore `service install` installs the npm release, not `apps/server/dist` from this checkout. It can silently remove the pi patch from the running service.

### Safe custom user service for this fork

After `connect link --headless` succeeds:

```bash
set -euo pipefail
REPO=/home/dev/t3code-wsl-fix
NODE_BIN=$(readlink -f "$(command -v node)")
PI_BIN=$(readlink -f "$(command -v pi)")
SERVICE_PATH="$(dirname "$NODE_BIN"):$(dirname "$PI_BIN"):/usr/local/bin:/usr/bin:/bin"

install -d -m 700 /home/dev/.config/systemd/user
cat > /home/dev/.config/systemd/user/t3code-fork.service <<EOF
[Unit]
Description=T3 Code patched fork
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/dev
Environment=T3CODE_HOME=/home/dev/.t3
Environment=T3CODE_RELAY_URL=https://relay.t3.codes
Environment=T3CODE_CLERK_PUBLISHABLE_KEY=example-publishable-key
Environment=T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=example-client-id
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $REPO/apps/server/dist/bin.mjs serve --base-dir /home/dev/.t3 --host 127.0.0.1 --port 3773 /home/dev
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now t3code-fork.service
sudo loginctl enable-linger dev
systemctl --user status t3code-fork.service --no-pager
journalctl --user -u t3code-fork.service -n 100 --no-pager
```

The server also attempts to hydrate PATH from the user's interactive login shell, but an explicit unit PATH plus absolute provider `binaryPath` settings is more deterministic. [apps/server/src/os-jank.ts:13-82] [packages/shared/src/shell.ts:161-224]

### Docs/code comparison

| Item | Result |
|---|---|
| Linux user unit, lingering, boot-after-logout | **Matches.** The docs describe `~/.config/systemd/user/t3code.service`; code creates that unit and enables linger. [docs/user/background-service.md:43-44] [apps/server/src/cloud/bootService.ts:202-241] |
| Service and T3 Connect are separate | **Matches.** [docs/user/background-service.md:67-72] [apps/server/src/cli/connect.ts:658-673] |
| `t3 serve` prints direct pairing details | **Matches.** [docs/user/remote-access.md:83-107] [apps/server/src/startupAccess.ts:122-147] |
| `t3 serve --tailscale-serve` “advertises” MagicDNS HTTPS | **Mismatch.** The docs say it advertises `https://machine.tailnet.ts.net/`, but startup output is built only from configured host + listening port and does not inspect Tailscale. Use `t3 pair --tailscale` after startup for the correct HTTPS URL. [docs/user/remote-access.md:112-119] [apps/server/src/startupAccess.ts:133-146] |
| Server Node requirement in SSH docs | **Runtime statement matches** `>=24.10`, but building this monorepo is stricter at `^24.13.1`. [docs/user/remote-access.md:141-149] [apps/server/package.json:50-52] [package.json:56-59] |
| Background service runs the local fork | **Not promised by docs and false for this checkout.** The implementation installs the exact npm version. Do not use it for an unpublished patch build. [docs/user/background-service.md:35-39] [apps/server/src/cloud/pinnedRuntime.ts:12-16] |

---

## 3. ENV: T3-prefixed variables read or created by the server

### Operator-facing inputs

| Variable | Meaning/default |
|---|---|
| `T3CODE_HOME` | Base directory; default `~/.t3`. State normally lands in `userdata`. |
| `T3CODE_MODE` | `web` or `desktop`; default `web`. |
| `T3CODE_HOST` | HTTP/WS bind host. |
| `T3CODE_PORT` | HTTP/WS port. |
| `T3CODE_NO_BROWSER` | Disable browser opening. |
| `T3CODE_BOOTSTRAP_FD` | Desktop bootstrap FD; do not set headlessly. |
| `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD` | Startup project creation toggle. |
| `T3CODE_DEV_ALLOWED_ORIGINS` | Comma-separated extra dev CORS origins. |
| `T3CODE_LOG_LEVEL` | Effect server log level; default `Info`. |
| `T3CODE_LOG_WS_EVENTS` | Outbound WS request logging toggle. |
| `T3CODE_TAILSCALE_SERVE` | Enable Tailscale Serve. |
| `T3CODE_TAILSCALE_SERVE_PORT` | Tailnet HTTPS port; default `443`. |
| `T3CODE_TRACE_MIN_LEVEL` | Trace minimum level; default `Info`. |
| `T3CODE_TRACE_TIMING_ENABLED` | Timing traces; default true. |
| `T3CODE_TRACE_FILE` | Trace file override. |
| `T3CODE_TRACE_MAX_BYTES` | Rotation size; default 10 MiB. |
| `T3CODE_TRACE_MAX_FILES` | Rotation count; default 10. |
| `T3CODE_TRACE_BATCH_WINDOW_MS` | Trace batch window; default 1000 ms. |
| `T3CODE_OTLP_TRACES_URL` | OTLP traces endpoint. |
| `T3CODE_OTLP_METRICS_URL` | OTLP metrics endpoint. |
| `T3CODE_OTLP_EXPORT_INTERVAL_MS` | OTLP interval; default 10000 ms. |
| `T3CODE_OTLP_SERVICE_NAME` | OTLP service name; default `t3-server`. |

These are loaded together at [apps/server/src/cli/config.ts:78-142].

### T3 Connect inputs

| Variable | Meaning |
|---|---|
| `T3CODE_RELAY_URL` | Secure HTTPS relay origin; runtime value overrides build-time fallback. |
| `T3CODE_HOSTED_APP_URL` | Hosted `/connect` OAuth UI origin; default `https://app.t3.codes`. |
| `T3CODE_CLERK_PUBLISHABLE_KEY` | Public Clerk instance identifier used to derive OAuth endpoint. |
| `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | Public Clerk OAuth application ID for CLI PKCE. |
| `T3CODE_CLOUDFLARED_PATH` | Absolute cloudflared executable override. |
| `T3CODE_RELAY_CLIENT_OTLP_TRACES_URL` | Relay-client trace endpoint. |
| `T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET` | Relay-client trace dataset. |
| `T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN` | Relay-client ingest token. |

[apps/server/src/cloud/publicConfig.ts:85-113] [apps/server/src/cloud/publicConfig.ts:160-214] [packages/shared/src/relayClient.ts:21-25]

`T3CODE_CLERK_JWT_TEMPLATE` is a client-build setting, but the headless server CLI does not read it in the requested server/shared/client-runtime grep scope. The server's `hasCloudPublicConfig` gate requires exactly relay URL, Clerk publishable key, and CLI OAuth client ID. [apps/server/src/cloud/publicConfig.ts:211-214]

### Telemetry, source control, and provider inputs

| Variable | Meaning/default |
|---|---|
| `T3CODE_POSTHOG_KEY` | PostHog project key; checked-in default exists. |
| `T3CODE_POSTHOG_HOST` | PostHog host; default `https://us.i.posthog.com`. |
| `T3CODE_TELEMETRY_ENABLED` | Anonymous telemetry; default true. |
| `T3CODE_TELEMETRY_FLUSH_BATCH_SIZE` | Default 20. |
| `T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS` | Default 1000. |
| `T3CODE_BITBUCKET_API_BASE_URL` | Default `https://api.bitbucket.org/2.0`. |
| `T3CODE_BITBUCKET_ACCESS_TOKEN` | Bitbucket bearer access token. |
| `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN` | Bitbucket basic/API-token alternative. |
| `T3CODE_CODEX_LAUNCH_ARGS` | Overrides configured Codex app-server launch args when non-empty. |
| `T3CODE_RESOURCE_MONITOR_PATH` | Native resource-monitor executable override. |
| `T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD` | Internal guard; enabled unless exactly `0`. |

[apps/server/src/telemetry/AnalyticsService.ts:30-45] [apps/server/src/sourceControl/BitbucketApi.ts:38-48] [apps/server/src/provider/Layers/codexLaunchArgs.ts:3-8] [apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts:139-153] [apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:102-102]

### Internal/generated T3 variables

These are not normal deployment knobs:

| Variable | Producer/consumer |
|---|---|
| `T3_SERVICE_LAUNCHER_CONTEXT` | Launcher-to-child JSON protocol context. |
| `T3_BOOT_SERVICE_UNIT` | Unit/plist identity injected by generated service. |
| `T3_MCP_BEARER_TOKEN` | Ephemeral token injected into a Codex child for T3's MCP server. |
| `T3CODE_PROJECT_ROOT` | Injected into project setup/runtime scripts. |
| `T3CODE_WORKTREE_PATH` | Injected when a worktree exists. |

[apps/server/src/cloud/serviceProtocol.ts:3-8] [apps/server/src/cloud/bootService.ts:36-39] [apps/server/src/provider/Layers/CodexAdapter.ts:1706-1714] [packages/shared/src/projectScripts.ts:18-31]

Names such as `__T3CODE_BUILD_*__`, `T3_CODE_BROWSER_TOOL_INSTRUCTIONS`, and `T3_CHAT_THEME` are compile-time symbols/constants, not environment variables.

---

## 4. PROVIDERS, especially fork-specific pi

### Common binary resolution rule

All four providers have a `binaryPath` setting. Defaults are command names (`pi`, `claude`, `codex`, `opencode`) and are resolved through `resolveSpawnCommand`, which searches the child environment/PATH. Absolute paths are supported and are safer in a user service. [packages/contracts/src/settings.ts:270-279] [packages/contracts/src/settings.ts:328-331] [packages/contracts/src/settings.ts:387-390] [packages/contracts/src/settings.ts:509-512] [packages/contracts/src/settings.ts:561-564]

Per-instance environment values are merged over the server process environment, so API keys and provider-specific variables can also be configured per provider instance. [apps/server/src/provider/ProviderInstanceEnvironment.ts:1-13]

### pi: exact invocation and required host state

Install the same pi distribution that the fork's maintenance metadata names:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
command -v pi
pi --version
```

Then configure T3 **Settings → Providers → pi** and preferably set the absolute `binaryPath` printed by `command -v pi`.

The fork does three kinds of pi execution:

1. Health: `pi --version`. [apps/server/src/provider/Layers/PiProvider.ts:281-294]
2. Model discovery: `pi --mode rpc --no-session --no-skills --no-tools`, then JSONL `get_available_models` and `get_state`. Extensions remain enabled, which is how extension-backed providers such as `claude-bridge` can appear. [apps/server/src/provider/Layers/PiProvider.ts:4-6] [apps/server/src/provider/Layers/PiProvider.ts:50-53] [apps/server/src/provider/Layers/PiProvider.ts:299-312]
3. One child per T3 thread: `pi --mode rpc --no-session ...<configured launchArgs>`, with cwd set to the T3 thread/project cwd. [apps/server/src/provider/Drivers/PiDriver.ts:2-8] [apps/server/src/provider/Layers/PiAdapter.ts:931-984]

One-shot title/branch/commit/PR generation uses `pi --mode text --no-session -p <prompt> [--model ...]`. [apps/server/src/textGeneration/PiTextGeneration.ts:1-4] [apps/server/src/textGeneration/PiTextGeneration.ts:111-116]

**What T3 itself reads under `~/.pi`: nothing.** This tree never opens pi config files; it only spawns the binary with inherited/per-instance environment. Therefore the exact pi config directory and extension-private files are formally **unknown to this tree**.

For the current `@earendil-works/pi-coding-agent` distribution, the operational sync set is under `~/.pi/agent`:

| Path | Copy? | Why |
|---|---:|---|
| `auth.json` | **Yes when credentials are not supplied by env or an extension.** | Provider API/OAuth credentials. Keep mode `0600`. |
| `settings.json` | **Yes.** | Default model/provider, package/resource paths, trust fallback, extension config. |
| `extensions/` | **Yes when pi providers/tools come from local extensions.** | Model discovery deliberately leaves extensions enabled. |
| `npm/`, `git/` | **Copy or reinstall.** | Package-backed extensions/skills referenced by settings must exist. |
| `models.json` | Copy if used. | Custom provider/model definitions. |
| `models-store.json` | Optional. | Catalog cache; pi can refresh it. |
| `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` | Copy if behavior must match. | Global instructions/system prompt. |
| `skills/` and `~/.agents/skills/` | Copy if agents should use them. | Normal T3 thread launches do **not** pass `--no-skills`; only the short model-discovery probe does. |
| `trust.json` | Copy if project-local `.pi` resources must load. | RPC mode cannot prompt; without saved trust or `defaultProjectTrust: "always"`, project resources may be ignored. |
| `sessions/` | **Do not sync.** | Every T3 pi invocation includes `--no-session`; T3 owns thread history. |

A conservative transfer that excludes sessions is:

```bash
ssh dev@EC2_HOST 'install -d -m 700 ~/.pi/agent ~/.agents'

rsync -a --delete \
  --exclude='sessions/' \
  --exclude='pi-debug.log' \
  ~/.pi/agent/ \
  dev@EC2_HOST:/home/dev/.pi/agent/

# Only if these shared skills are part of the intended agent behavior.
rsync -a ~/.agents/skills/ \
  dev@EC2_HOST:/home/dev/.agents/skills/

ssh dev@EC2_HOST 'chmod 700 ~/.pi/agent; test ! -e ~/.pi/agent/auth.json || chmod 600 ~/.pi/agent/auth.json'
```

Do not blindly sync extension-specific OAuth/cache directories unless that extension's documentation says they are portable. For `claude-bridge`, its exact credential/state files are **unknown from this T3 tree**.

Fork limitations: extension UI dialogs are auto-cancelled, and historical replay/rollback are not implemented. [PATCH.md:127-144]

### Codex

- Binary default: `codex`; configurable absolute `binaryPath`. [packages/contracts/src/settings.ts:322-331]
- Default home: `~/.codex`; custom `homePath` becomes `CODEX_HOME`. [apps/server/src/provider/Drivers/CodexHomeLayout.ts:32-58] [apps/server/src/provider/Layers/CodexProvider.ts:322-340]
- This tree explicitly identifies `auth.json` and `models_cache.json` as private entries. With a shadow home, `auth.json` must be a real file in the shadow rather than a shared symlink. [apps/server/src/provider/Drivers/CodexHomeLayout.ts:19-40] [apps/server/src/provider/Drivers/CodexHomeLayout.ts:302-318]
- Authentication check tells the operator to run `codex login`. [apps/server/src/provider/Layers/CodexProvider.ts:478-498]

Practical state: log in as Linux user `dev` on EC2 with `codex login`, or securely copy the intended `~/.codex/auth.json` to the selected Codex home and mode `0600`. Copying Codex transcript `sessions/` is not required for T3 to start new work. The checked-in install guide names `codex login`. [README.md:13-23]

### Claude

- Binary default: `claude`; configurable absolute `binaryPath`. [packages/contracts/src/settings.ts:381-390]
- With no custom home, T3 leaves the environment alone. With `homePath`, it sets `CLAUDE_CONFIG_DIR` while intentionally preserving `HOME` so platform credential lookup still works. [apps/server/src/provider/Drivers/ClaudeHome.ts:9-34]
- T3 invokes the configured binary through `resolveSpawnCommand` and runs Claude's own auth/status logic. [apps/server/src/provider/Layers/ClaudeProvider.ts:723-798]

The exact Linux Claude credential filename is **unknown from this tree**; T3 does not read it directly. Perform `claude auth login` on the EC2 box as `dev`, then verify with `claude auth status`. The login command is checked into the install guide; the status probe is what the provider code invokes. [README.md:13-23] [apps/server/src/provider/Layers/ClaudeProvider.ts:723-798] Do not guess a filename and copy it.

### OpenCode

- Binary default: `opencode`; configurable `serverUrl` and optional `serverPassword`. [packages/contracts/src/settings.ts:501-548]
- Local mode checks `opencode --version`, then runs `opencode models --verbose`, `opencode agent list`, and `opencode debug skill`; for turns it starts `opencode serve --hostname=127.0.0.1 --port=<ephemeral>`. [apps/server/src/provider/Layers/OpenCodeProvider.ts:326-445] [apps/server/src/provider/opencodeRuntime.ts:533-555] [apps/server/src/provider/opencodeRuntime.ts:761-850]
- T3 preserves an inherited/per-instance `OPENCODE_CONFIG_CONTENT` instead of replacing the user's config. [apps/server/src/provider/opencodeRuntime.ts:38-48] [apps/server/src/provider/opencodeRuntime.ts:548-555]

The exact OpenCode login-state filename is **unknown from this tree**; T3 delegates it to the OpenCode CLI. Run `opencode auth login` as `dev` on EC2, or point T3 at an already-authenticated external OpenCode server. The checked-in install guide names that login command. [README.md:13-23]

---

## 5. Detecting attached clients, running agents, and idle state externally

### Server alive

A public descriptor endpoint exists:

```bash
curl -fsS http://127.0.0.1:3773/.well-known/t3/environment | jq .
```

It proves an HTTP server is answering and identifies the environment, but does not report clients or running agents. [packages/contracts/src/environmentHttp.ts:404-408]

While running, `~/.t3/userdata/server-runtime.json` records PID, host, port, origin, and start time and is removed on clean shutdown. [apps/server/src/serverRuntimeState.ts:11-22] [apps/server/src/serverRuntimeState.ts:50-90] The repo's own triage logic treats it as stale unless the PID is alive. [apps/server/src/cli/triage.ts:81-104]

### Accurate “a user is attached” signal

An authenticated endpoint already exists:

```text
GET /api/auth/clients
```

It returns active client sessions including a live `connected` boolean. [packages/contracts/src/environmentHttp.ts:464-468]

The boolean is accurate inside the running process: `/ws` calls `markConnected` for the lifetime of each authenticated WebSocket and `markDisconnected` on release; `SessionStore` keeps an in-memory connection count per session. [apps/server/src/ws.ts:2488-2556] [apps/server/src/auth/SessionStore.ts:476-522] [apps/server/src/auth/SessionStore.ts:577-600]

Create a monitor bearer once:

```bash
cd /home/dev/t3code-wsl-fix
T3=(node "$PWD/apps/server/dist/bin.mjs")
MONITOR_TOKEN=$("${T3[@]}" auth session issue \
  --base-dir /home/dev/.t3 \
  --ttl 365d \
  --label idle-detector \
  --token-only)
printf '%s' "$MONITOR_TOKEN" > /home/dev/.t3/idle-detector.token
chmod 600 /home/dev/.t3/idle-detector.token
```

Then:

```bash
TOKEN=$(cat /home/dev/.t3/idle-detector.token)
CONNECTED_CLIENTS=$(
  curl -fsS \
    -H "Authorization: Bearer $TOKEN" \
    http://127.0.0.1:3773/api/auth/clients \
  | jq '[.[] | select(.connected == true)] | length'
)
printf 'connected_clients=%s\n' "$CONNECTED_CLIENTS"
```

Do **not** use `t3 auth session list --json` from a separate process for live attachment detection. Its separate `SessionStore` has an empty in-memory connection registry; only the HTTP request handled by the running server sees live WebSockets. The CLI formatter exposes `connected`, but connectedness comes from the process-local map. [apps/server/src/cliAuthFormat.ts:146-184] [apps/server/src/auth/SessionStore.ts:853-869]

### Accurate-enough “agents are running” signal

There is no small public health endpoint that returns a running-agent count. The projected SQLite table does persist each thread session's `status` and `active_turn_id`. [apps/server/src/persistence/Migrations/005_Projections.ts:62-70]

Read it safely with SQLite's normal concurrent-reader behavior:

```bash
RUNNING_AGENTS=$(
  sqlite3 -readonly /home/dev/.t3/userdata/state.sqlite \
    "SELECT COUNT(*) FROM projection_thread_sessions WHERE status IN ('starting','running');"
)
printf 'running_agents=%s\n' "$RUNNING_AGENTS"
```

The projector repository upserts those status fields. [apps/server/src/persistence/Layers/ProjectionThreadSessions.ts:23-49]

### Unified classification

```bash
set -euo pipefail
BASE=/home/dev/.t3
ORIGIN=http://127.0.0.1:3773
TOKEN=$(cat "$BASE/idle-detector.token")

curl -fsS "$ORIGIN/.well-known/t3/environment" >/dev/null
clients=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/auth/clients")
attached=$(jq '[.[] | select(.connected == true)] | length' <<<"$clients")
agents=$(sqlite3 -readonly "$BASE/userdata/state.sqlite" \
  "SELECT COUNT(*) FROM projection_thread_sessions WHERE status IN ('starting','running');")

if (( attached > 0 )); then
  state=attached
elif (( agents > 0 )); then
  state=agents-running-unattended
else
  state=idle
fi
printf 'state=%s connected_clients=%s running_agents=%s\n' "$state" "$attached" "$agents"
```

This does not classify detached terminal-only commands or non-agent child processes. A single unified status endpoint does not exist.

### Relay tunnel state

`connect status --json` reports **persisted** desired/authenticated/linked/relay-client state; it does not report whether the managed `cloudflared` child is currently connected. [apps/server/src/cli/connect.ts:544-579]

The live tunnel PID/status is held in memory, and successful registration emits the log line `Relay client tunnel connection registered`. [apps/server/src/cloud/ManagedEndpointRuntime.ts:39-61] [apps/server/src/cloud/ManagedEndpointRuntime.ts:133-170] There is no relay tunnel state file. The persisted endpoint runtime config proves configuration, not liveness.

`POST /api/t3-connect/health` exists, but it requires a one-use relay-signed proof and returns only online/descriptor data, not client or agent counts. [packages/contracts/src/environmentHttp.ts:589-593] [apps/server/src/cloud/http.ts:831-941]

No follow-up server patch is required for basic idle detection because `/api/auth/clients` plus `projection_thread_sessions` is sufficient. A future convenience patch could add a single authenticated summary endpoint, but it is not necessary for this deployment.

---

## 6. DESKTOP remote environments and fork impact

### User path

In the patched desktop renderer:

1. Open **Settings → Connections** (`/settings/connections`). [apps/web/src/routes/settings.connections.tsx:3-6]
2. Under **Remote Environments**, click **Add environment**.
3. Choose **Remote link**.
4. Paste the full pairing URL, or enter backend host plus pairing code.
5. Click **Add environment**.

The dialog and mode cards are implemented at [apps/web/src/components/settings/ConnectionsSettings.tsx:3404-3440]. The handler parses host/code and calls `connectPairing`; the client fetches the public descriptor, exchanges the pairing credential for a bearer, and registers the saved environment. [apps/web/src/components/settings/ConnectionsSettings.tsx:2144-2239] [packages/client-runtime/src/connection/onboarding.ts:86-127]

Desktop additionally offers **SSH**, which provisions an SSH-managed tunnel through desktop IPC. [apps/web/src/components/settings/ConnectionsSettings.tsx:2144-2180] [packages/client-runtime/src/connection/onboarding.ts:213-241]

Relay-linked environments appear through the same connection catalog but are discovered through T3 Connect rather than a manually pasted pairing code.

### Did this fork alter remote/relay code?

No overlay commit changes an `infra/relay`, `cloud`, `connect`, or remote-connection path. `PATCH.md` lists WSL, preview, activity, settings, packaging, and pi-provider work only. [PATCH.md:73-86]

The pi UI commit touches provider settings/picker/icon files, not environment connectivity. [PATCH.md:120-126]

### Does patched `DesktopBackendConfiguration` native/WSL logic affect remote environments?

No. Its public service only resolves the desktop-owned primary local backend, WSL backend instances, and the primary label. [apps/desktop/src/backend/DesktopBackendConfiguration.ts:36-65]

The patched decision chooses Windows-native versus WSL for the **primary** local backend and builds only those local start configs. [apps/desktop/src/backend/DesktopBackendConfiguration.ts:672-757] Manual bearer and relay/SSH environments are handled by `packages/client-runtime` connection onboarding and desktop SSH IPC, outside `DesktopBackendConfiguration`.

---

## 7. RELAY (`infra/relay`) and account requirements

`infra/relay` is T3 Connect's hosted Cloudflare control plane. It owns account/environment links, managed endpoint provisioning, short-lived connection credentials, environment/device lists, and optional mobile notifications/Live Activities. It is intentionally not in the normal traffic hot path: after discovery/auth, API and WebSocket traffic flows directly between client and environment through the provisioned endpoint. [infra/relay/README.md:6-25]

### Default relay

- The tracked public production configuration points to `https://relay.t3.codes`. [.env.example:20-22]
- Official release CI injects the relay/Clerk public values at build time. Source builds read process env, `.env.local`, then `.env`. [scripts/lib/public-config.ts:23-65] [docs/internals/t3-connect.md:39-50]
- A fresh clone does **not** automatically consume `.env.example`; T3 Connect is disabled until values are supplied. [docs/internals/t3-connect.md:17-25]
- The headless server bundle supports runtime overrides through `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, and `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. [apps/server/src/cloud/publicConfig.ts:98-113] [apps/server/src/cloud/publicConfig.ts:160-214]
- Desktop/web/mobile client relay values are build-time configuration. To use the owner's future self-hosted relay, rebuild those clients with matching Clerk/relay public config; changing only the server cannot redirect an already-built desktop/mobile client. [docs/internals/t3-connect.md:39-57]

Whether the already-installed patched desktop binary retained production relay config is **unknown from this source tree**; that depends on the environment used when its replaced web/server bundles were built.

### Does headless `connect` need an account?

**Yes.** `connect --headless`/`connect link --headless` uses a Clerk public OAuth client with PKCE. It prints a hosted `/connect` URL, requires the operator to sign in on another device, and asks for the displayed authorization code. The resulting OAuth access/refresh token is stored in `~/.t3/userdata/secrets/cloud-cli-oauth-token.bin`. [docs/internals/t3-connect.md:74-103] [apps/server/src/cloud/CliTokenManager.ts:288-323] [apps/server/src/cloud/CliTokenManager.ts:335-350]

The relay then validates that Clerk OAuth bearer when linking the environment. The relay is not part of the OAuth handshake itself. [docs/internals/t3-connect.md:95-103]

A direct one-time `/pair#token=...` connection does **not** require a Clerk/T3 Connect account; it talks straight to the environment. Relay discovery/managed tunneling does require the account.

### Self-hosting later

`infra/relay` deploys with Alchemy to Cloudflare and requires deployment-specific domains, Clerk configuration, PlanetScale, Cloudflare credentials, and optional APNs/Axiom settings. There are no checked-in deployment defaults. [docs/internals/t3-connect.md:60-70] [infra/relay/README.md:77-113]

The client-facing relay URL is configurable, but the CLI requires a secure absolute HTTPS origin. [apps/server/src/cloud/publicConfig.ts:23-37] [apps/server/src/cloud/publicConfig.ts:98-103]

---

## Final headless-run checklist

```bash
# 1. Build with Node >=24.13.1 and production public relay config.
cd /home/dev/t3code-wsl-fix
set -a; . ./.env.example; set +a
vp install --frozen-lockfile
vp run --filter t3 build

# 2. Install and verify provider CLIs as user dev.
command -v pi && pi --version
command -v codex || true
command -v claude || true
command -v opencode || true

# 3. Sync only intended pi configuration; exclude ~/.pi/agent/sessions.

# 4. Link the environment to hosted T3 Connect.
T3=(node "$PWD/apps/server/dist/bin.mjs")
export T3CODE_HOME=/home/dev/.t3
export T3CODE_RELAY_URL=https://relay.t3.codes
export T3CODE_CLERK_PUBLISHABLE_KEY=example-publishable-key
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=example-client-id
"${T3[@]}" connect link --headless --base-dir "$T3CODE_HOME"

# 5. Install/start the custom t3code-fork.service above; do not use `service install`.

# 6. Verify HTTP, persisted relay state, and tunnel registration.
curl -fsS http://127.0.0.1:3773/.well-known/t3/environment | jq .
"${T3[@]}" connect status --base-dir "$T3CODE_HOME" --json
journalctl --user -u t3code-fork.service --since -10m --no-pager \
  | grep -F 'Relay client tunnel connection registered'
```
