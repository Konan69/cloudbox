import { gzipSync } from "node:zlib";

export interface HostBootstrapConfig {
  readonly boxUser: "dev";
  readonly zfsDataDevice: string;
  readonly idleMinutes: number;
  readonly t3Port: number;
  readonly t3: {
    readonly repoUrl: string;
    readonly branch: string;
    readonly relayUrl: string;
    readonly clerkPublishableKey: string;
    readonly clerkCliOauthClientId: string;
  };
  readonly idleBundle: string;
  readonly machinesBundle: string;
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const HOST_AGENT_PACKAGES = [
  "@anthropic-ai/claude-code@2.1.246",
  "@openai/codex@0.149.0",
  "@earendil-works/pi-coding-agent@0.84.2",
  "opencode-ai@1.18.21",
] as const;

export const renderHostBootstrap = (config: HostBootstrapConfig): string => {
  const idleConfig = JSON.stringify(
    {
      provider: { kind: "gcp" },
      idleMinutes: config.idleMinutes,
      t3Port: config.t3Port,
      t3Activity: {
        kind: "authenticated",
        baseDir: `/home/${config.boxUser}/.t3`,
        tokenPath: `/home/${config.boxUser}/.t3/idle-detector.token`,
      },
      checkIncus: true,
    },
    null,
    2,
  );

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
umask 027
mkdir -p /var/log /var/lib/cloudbox
exec > >(tee -a /var/log/cloudbox-bootstrap.log) 2>&1
trap 'status=$?; echo "cloudbox host bootstrap failed at line $LINENO (exit $status)"; exit $status' ERR

readonly STATE_DIR=/var/lib/cloudbox
readonly BOX_USER=${shellQuote(config.boxUser)}
readonly ZFS_DATA_DEVICE=${shellQuote(config.zfsDataDevice)}
readonly T3_PORT=${String(config.t3Port)}
REBUILD_GOLDEN=0

for argument in "$@"; do
  case "$argument" in
    --rebuild) REBUILD_GOLDEN=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 2 ;;
  esac
done

run_phase() {
  local name="$1"
  local force="$2"
  local marker="$STATE_DIR/host-v2-$name.done"
  shift 2
  if [[ -f "$marker" && "$force" != 1 ]]; then
    echo "phase $name already complete"
    return
  fi
  echo "starting phase $name"
  "$@"
  touch "$marker"
  echo "completed phase $name"
}

phase_host_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg git gh rsync jq sqlite3 zstd \
    build-essential python3 sudo util-linux iproute2 zfsutils-linux

  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
  # apt fetches run as the unprivileged _apt user; a 0640 keyring yields
  # "Unknown error executing apt-key" and "repository is not signed".
  chmod 0644 /etc/apt/keyrings/zabbly.asc
  . /etc/os-release
  cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $VERSION_CODENAME
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
  apt-get update
  apt-get install -y incus

  if ! id -u "$BOX_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$BOX_USER"
  fi
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$BOX_USER" > "/etc/sudoers.d/cloudbox-$BOX_USER"
  chmod 440 "/etc/sudoers.d/cloudbox-$BOX_USER"

  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi
  usermod -aG docker,incus-admin "$BOX_USER"
  systemctl enable --now docker incus

  if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v24.* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  fi
  node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); if (M!==24 || m<13 || (m===13 && p<1)) throw new Error("Node >=24.13.1 <25 is required")'
  corepack enable
  corepack prepare pnpm@11.10.0 --activate

  if [[ ! -x "/home/$BOX_USER/.vite-plus/bin/vp" ]]; then
    sudo -iu "$BOX_USER" bash -lc 'curl -fsSL https://vite.plus | bash'
  fi
  ln -sfn "/home/$BOX_USER/.vite-plus/bin/vp" /usr/local/bin/vp
  sudo -iu "$BOX_USER" bash -lc 'vp --version'
  test -c /dev/kvm
}

phase_zfs() {
  udevadm settle
  test -b "$ZFS_DATA_DEVICE"
  if ! zpool list -H tank >/dev/null 2>&1; then
    if zpool import -d "$(dirname "$ZFS_DATA_DEVICE")" 2>/dev/null | grep -q 'pool: tank'; then
      zpool import -N -d "$(dirname "$ZFS_DATA_DEVICE")" tank
    else
      zpool create -f -o ashift=12 -O compression=zstd -O atime=off -O mountpoint=none tank "$ZFS_DATA_DEVICE"
    fi
  fi
  zpool status tank
  if ! zfs list tank/incus >/dev/null 2>&1; then
    zfs create -o mountpoint=none tank/incus
  fi
  if ! zfs list tank/archive >/dev/null 2>&1; then
    zfs create -o mountpoint=/tank/archive tank/archive
  fi
  zfs set compression=zstd tank tank/incus tank/archive
  zfs set mountpoint=none tank/incus
  zfs set mountpoint=/tank/archive tank/archive
  install -d -m 755 /tank/archive
}

phase_incus() {
  systemctl enable --now incus
  for attempt in $(seq 1 60); do
    if incus admin waitready --timeout=2 >/dev/null 2>&1; then break; fi
    if [[ "$attempt" = 60 ]]; then echo "incus did not become ready" >&2; exit 1; fi
    sleep 2
  done

  if ! incus storage show tank >/dev/null 2>&1; then
    incus admin init --preseed <<'PRESEED'
config: {}
networks:
- name: incusbr0
  type: bridge
  config:
    ipv4.address: auto
    ipv4.nat: "true"
    ipv6.address: none
storage_pools:
- name: tank
  driver: zfs
  config:
    source: tank/incus
profiles:
- name: default
  config: {}
  devices:
    eth0:
      name: eth0
      network: incusbr0
      type: nic
    root:
      path: /
      pool: tank
      type: disk
projects:
- name: default
  description: Default Incus project
  config:
    features.images: "true"
    features.networks: "true"
    features.profiles: "true"
    features.storage.volumes: "true"
cluster: null
PRESEED
  fi
  incus storage show tank
  incus network show incusbr0
  incus profile show default
}

phase_verify_incus() {
  test -c /dev/kvm
  for name in test testvm; do
    if incus info "$name" >/dev/null 2>&1; then incus delete "$name" --force; fi
  done
  incus launch images:ubuntu/24.04 test </dev/null
  incus exec test -- cloud-init status --wait </dev/null
  incus exec test -- true </dev/null
  incus delete test --force

  incus launch images:ubuntu/24.04 testvm --vm </dev/null
  incus exec testvm -- cloud-init status --wait </dev/null
  incus exec testvm -- true </dev/null
  incus delete testvm --force
}

phase_golden() {
  if incus image info golden >/dev/null 2>&1; then
    if [[ "$REBUILD_GOLDEN" != 1 ]]; then
      echo "golden alias already exists; use --rebuild to replace it"
      return
    fi
    incus image delete golden
  fi
  if incus info golden-build >/dev/null 2>&1; then incus delete golden-build --force; fi

  # incus launch/exec parse stdin as instance YAML when it is not a TTY; the GCE
  # metadata runner hands this script in on stdin, so every call gets /dev/null.
  incus launch images:ubuntu/24.04 golden-build \
    -c security.nesting=true \
    -c security.syscalls.intercept.mknod=true \
    -c security.syscalls.intercept.setxattr=true </dev/null
  incus exec golden-build -- cloud-init status --wait </dev/null
  incus exec golden-build -- bash -s -- "$BOX_USER" <<'GOLDEN'
set -euo pipefail
USER_NAME="$1"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gh rsync jq zstd build-essential python3 procps sudo

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  uid1000_user="$(getent passwd 1000 | cut -d: -f1)"
  if [[ -n "$uid1000_user" ]]; then
    uid1000_group="$(id -gn "$uid1000_user")"
    usermod --login "$USER_NAME" --home "/home/$USER_NAME" --move-home "$uid1000_user"
    if [[ "$uid1000_group" = "$uid1000_user" ]]; then groupmod --new-name "$USER_NAME" "$uid1000_group"; fi
    usermod --gid "$USER_NAME" "$USER_NAME"
  else
    useradd --create-home --uid 1000 --shell /bin/bash "$USER_NAME"
  fi
fi
test "$(id -u "$USER_NAME")" = 1000
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USER_NAME" > "/etc/sudoers.d/cloudbox-$USER_NAME"
chmod 440 "/etc/sudoers.d/cloudbox-$USER_NAME"

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); if (M!==24 || m<13 || (m===13 && p<1)) throw new Error("Node >=24.13.1 <25 is required")'
corepack enable
corepack prepare pnpm@11.10.0 --activate
npm install --global ${HOST_AGENT_PACKAGES.join(" ")}

sudo -iu "$USER_NAME" bash -lc 'curl -fsSL https://vite.plus | bash'
ln -sfn "/home/$USER_NAME/.vite-plus/bin/vp" /usr/local/bin/vp

# lane publishes Linux x86_64 releases through its official installer.
# If that release channel is unavailable, build the public Git repository with Cargo.
if ! curl -fsSL https://lane.lukeed.com | LANE_INSTALL=/usr/local/bin sh; then
  apt-get install -y cargo
  cargo install --git https://github.com/lukeed/lane --locked
  install -m 755 /root/.cargo/bin/lane /usr/local/bin/lane
fi

if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
usermod -aG docker "$USER_NAME"
systemctl enable docker
command -v node pnpm vp git gh rsync docker lane claude codex pi opencode
npm ls -g --depth=0
GOLDEN

  incus stop golden-build --force
  incus publish golden-build --alias golden
  incus image info golden
  incus delete golden-build
}

phase_t3() {
  if [[ ! -d "/home/$BOX_USER/t3code/.git" ]]; then
    sudo -u "$BOX_USER" git clone --branch ${shellQuote(config.t3.branch)} --single-branch ${shellQuote(config.t3.repoUrl)} "/home/$BOX_USER/t3code"
  else
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" fetch origin ${shellQuote(config.t3.branch)}
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" checkout ${shellQuote(config.t3.branch)}
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" reset --hard FETCH_HEAD
  fi

  sudo -iu "$BOX_USER" bash -lc '
    set -euo pipefail
    export PATH="$HOME/.vite-plus/bin:/usr/local/bin:/usr/bin:/bin"
    cd "$HOME/t3code"
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
  '

  install -d -m 700 -o "$BOX_USER" -g "$BOX_USER" "/home/$BOX_USER/.config/systemd/user"
  cat > "/home/$BOX_USER/.config/systemd/user/t3code-fork.service" <<'UNIT'
[Unit]
Description=T3 Code patched fork
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/${config.boxUser}
Environment=T3CODE_HOME=/home/${config.boxUser}/.t3
Environment=T3CODE_RELAY_URL=${config.t3.relayUrl}
Environment=T3CODE_CLERK_PUBLISHABLE_KEY=${config.t3.clerkPublishableKey}
Environment=T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=${config.t3.clerkCliOauthClientId}
Environment=PATH=/home/${config.boxUser}/.vite-plus/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /home/${config.boxUser}/t3code/apps/server/dist/bin.mjs serve --base-dir /home/${config.boxUser}/.t3 --host 127.0.0.1 --port ${String(config.t3Port)} /home/${config.boxUser}
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  chown "$BOX_USER:$BOX_USER" "/home/$BOX_USER/.config/systemd/user/t3code-fork.service"
  loginctl enable-linger "$BOX_USER"
  local box_uid
  box_uid="$(id -u "$BOX_USER")"
  systemctl start "user@$box_uid.service"
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$box_uid" systemctl --user daemon-reload
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$box_uid" systemctl --user enable --now t3code-fork.service
}

phase_t3_idle_token() {
  for attempt in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$T3_PORT/.well-known/t3/environment" >/dev/null; then break; fi
    if [[ "$attempt" = 90 ]]; then echo "T3 did not become ready" >&2; exit 1; fi
    sleep 2
  done
  local token_path="/home/$BOX_USER/.t3/idle-detector.token"
  if [[ ! -s "$token_path" ]]; then
    local token
    token="$(runuser -u "$BOX_USER" -- /usr/bin/node "/home/$BOX_USER/t3code/apps/server/dist/bin.mjs" auth session issue --base-dir "/home/$BOX_USER/.t3" --ttl 365d --label idle-detector --token-only)"
    printf '%s' "$token" > "$token_path"
    chown "$BOX_USER:$BOX_USER" "$token_path"
    chmod 600 "$token_path"
  fi
}

phase_cloudbox_tools() {
  install -d -m 755 /opt/cloudbox /etc/cloudbox /var/lib/cloudbox
  npm install --prefix /opt/cloudbox --omit=dev \
    effect@4.0.0-rc.112 \
    @effect/platform-node@4.0.0-rc.112 \
    @aws-sdk/client-ec2@3.1120.0
  printf '%s' '${b64(config.idleBundle)}' | base64 --decode > /opt/cloudbox/idle.mjs
  printf '%s' '${b64(config.machinesBundle)}' | base64 --decode > /opt/cloudbox/machines.mjs
  printf '%s' '${b64(idleConfig)}' | base64 --decode > /etc/cloudbox/config.json
  chmod 755 /opt/cloudbox/idle.mjs /opt/cloudbox/machines.mjs
  chmod 600 /etc/cloudbox/config.json

  cat > /usr/local/bin/cloudbox-machines <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/node /opt/cloudbox/machines.mjs "$@"
WRAPPER
  chmod 755 /usr/local/bin/cloudbox-machines

  cat > /etc/systemd/system/cloudbox-idle.service <<'UNIT'
[Unit]
Description=Power off Cloudbox host after sustained inactivity
After=network-online.target incus.service

[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/cloudbox/idle.mjs
NoNewPrivileges=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=/var/lib/cloudbox
UNIT

  cat > /etc/systemd/system/cloudbox-idle.timer <<'UNIT'
[Unit]
Description=Check Cloudbox host activity every five minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now cloudbox-idle.timer
}

run_phase 01-host-packages 0 phase_host_packages
run_phase 02-zfs 0 phase_zfs
run_phase 03-incus 0 phase_incus
run_phase 04-incus-verification 0 phase_verify_incus
run_phase 05-golden "$REBUILD_GOLDEN" phase_golden
run_phase 06-t3 0 phase_t3
run_phase 07-t3-idle-token 0 phase_t3_idle_token
run_phase 08-cloudbox-tools 0 phase_cloudbox_tools

echo "cloudbox host bootstrap v2 completed"
`;
};

/**
 * Compute Engine limits an inline startup-script metadata value to 256 KiB.
 * The wrapper keeps the host bootstrap and its embedded bundles below that limit.
 */
export const renderHostStartupScript = (config: HostBootstrapConfig): string => {
  const compressed = gzipSync(Buffer.from(renderHostBootstrap(config), "utf8"), { level: 9 });
  // Write the script to a file and run it with stdin detached. Piping it into
  // `bash` makes every child process share the script text as its stdin
  // (incus parses that as instance YAML; curl|bash installers misbehave).
  return `#!/usr/bin/env bash\nset -euo pipefail\ninstall -d -m 700 /var/lib/cloudbox\nprintf '%s' '${compressed.toString("base64")}' | base64 --decode | gzip --decompress > /var/lib/cloudbox/host-bootstrap.sh\nchmod 700 /var/lib/cloudbox/host-bootstrap.sh\nexec bash /var/lib/cloudbox/host-bootstrap.sh </dev/null\n`;
};
