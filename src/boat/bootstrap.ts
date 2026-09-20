import type { BoatCloudboxConfig } from "../config.ts";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const BOAT_T3_PORT = 3773;
export const BOAT_HOST_PORT = 3774;

export const renderBoatBootstrap = (config: BoatCloudboxConfig): string => {
  const repoUrl = shellQuote(config.t3.repoUrl);
  const branch = shellQuote(config.t3.branch);

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
umask 027

readonly REPO=/home/user/t3code
readonly REPO_URL=${repoUrl}
readonly BRANCH=${branch}
readonly T3_PORT=${String(BOAT_T3_PORT)}
readonly HOST_PORT=${String(BOAT_HOST_PORT)}

sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential python3 socat
sudo loginctl enable-linger user

if [[ ! -e "$REPO" ]]; then
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$REPO"
else
  test -d "$REPO/.git" || { printf 'Existing path is not a git checkout: %s\n' "$REPO" >&2; exit 1; }
  actual_origin="$(git -C "$REPO" remote get-url origin)"
  [[ "$actual_origin" == "$REPO_URL" ]] || {
    printf 'Refusing to replace mismatched T3 checkout origin: %s\n' "$actual_origin" >&2
    exit 1
  }
  git -C "$REPO" fetch --prune origin "$BRANCH"
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO" switch "$BRANCH"
  else
    git -C "$REPO" switch --create "$BRANCH" --track "origin/$BRANCH"
  fi
  git -C "$REPO" merge --ff-only "origin/$BRANCH"
fi

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a===24 && (b>13 || (b===13 && c>=1)) ? 0 : 1)'; then
  export NVM_DIR=/home/user/.nvm
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install 24.13.1
  nvm alias default 24.13.1
fi

VP_BIN="$(command -v vp || true)"
if [[ -z "$VP_BIN" ]]; then
  curl -fsSL https://vite.plus | bash
  for candidate in /home/user/.local/bin/vp /home/user/.vite-plus/bin/vp /home/user/.vp/bin/vp; do
    if [[ -x "$candidate" ]]; then VP_BIN="$candidate"; break; fi
  done
fi
[[ -n "$VP_BIN" && -x "$VP_BIN" ]] || { printf 'vp install completed but vp was not found\n' >&2; exit 1; }

cd "$REPO"
set -a
# The fork's public relay identifiers are required at build time.
. ./.env.example
set +a
"$VP_BIN" install --frozen-lockfile
"$VP_BIN" run --filter t3 build

test -f "$REPO/apps/server/dist/bin.mjs"
NODE_BIN="$(readlink -f "$(command -v node)")"
SERVICE_PATH="$(dirname "$NODE_BIN"):$(dirname "$VP_BIN"):/usr/local/bin:/usr/bin:/bin"
install -d -m 700 /home/user/.config/systemd/user /home/user/.t3/userdata/logs

cat > /home/user/.config/systemd/user/t3code-fork.service <<UNIT
[Unit]
Description=T3 Code patched fork
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/user
Environment=T3CODE_HOME=/home/user/.t3
Environment=T3CODE_RELAY_URL=https://relay.t3.codes
Environment=T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
Environment=T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $REPO/apps/server/dist/bin.mjs serve --base-dir /home/user/.t3 --host 127.0.0.1 --port $T3_PORT /home/user
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
StandardOutput=append:/home/user/.t3/userdata/logs/boot-service.log
StandardError=append:/home/user/.t3/userdata/logs/boot-service.log

[Install]
WantedBy=default.target
UNIT

# Boat hosting reaches a machine port, not loopback. Keep T3 private on 127.0.0.1
# and expose this TCP proxy port through Boat's HTTPS hosting endpoint.
cat > /home/user/.config/systemd/user/t3code-host-proxy.service <<UNIT
[Unit]
Description=Boat hosting proxy for T3 Code
After=t3code-fork.service
Requires=t3code-fork.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:$HOST_PORT,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:$T3_PORT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT

XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
systemctl --user daemon-reload
systemctl --user enable --now t3code-fork.service t3code-host-proxy.service
systemctl --user is-active --quiet t3code-fork.service
systemctl --user is-active --quiet t3code-host-proxy.service
curl --fail --silent --show-error --retry 30 --retry-delay 1 \
  "http://127.0.0.1:$T3_PORT/.well-known/t3/environment" >/dev/null
`;
};
