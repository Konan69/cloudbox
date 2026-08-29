import { encodeIdleConfig } from "../box/idleConfig.ts";

export interface HostBootstrapConfig {
  readonly boxUser: "dev";
  readonly name: string;
  readonly project: string;
  readonly zone: string;
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
}

export interface HostBootstrapAsset {
  readonly objectName: string;
  readonly sha256: string;
  readonly destination: string;
  readonly mode: "700" | "755";
}

export interface HostFetchWrapperConfig {
  readonly bucketName: string;
  readonly bootstrap: HostBootstrapAsset;
  readonly idle: HostBootstrapAsset;
  readonly machines: HostBootstrapAsset;
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
  const idleConfig = encodeIdleConfig({
    provider: {
      kind: "gcp",
      name: config.name,
      project: config.project,
      zone: config.zone,
    },
    idleMinutes: config.idleMinutes,
    t3Port: config.t3Port,
    t3Activity: {
      kind: "authenticated",
      baseDir: `/home/${config.boxUser}/.t3`,
      tokenPath: `/home/${config.boxUser}/.t3/idle-detector.token`,
    },
    checkIncus: true,
  });

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
resolve_vp() {
  # vite-plus installs to ~/.local/share/vite-plus/bin (older builds used ~/.vite-plus) and only
  # adds itself to the user's interactive rc, so a login shell may not see it: try PATH first,
  # then the known locations.
  local user="$1" home found
  home="$(getent passwd "$user" | cut -d: -f6)"
  found="$(sudo -iu "$user" bash -lc 'command -v vp' 2>/dev/null || true)"
  for candidate in "$found" "$home/.local/share/vite-plus/bin/vp" "$home/.vite-plus/bin/vp"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  echo "vp was not found for $user after install" >&2
  return 1
}
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

  # Docker sets the iptables FORWARD policy to DROP, which silently kills the
  # incus bridge NAT (machines get no egress). DOCKER-USER is the sanctioned
  # place for our allow rules; the oneshot unit re-applies them after every boot.
  cat > /usr/local/sbin/cloudbox-incus-nat <<'NAT'
#!/usr/bin/env bash
set -euo pipefail
for direction in -i -o; do
  iptables -C DOCKER-USER "$direction" incusbr0 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER "$direction" incusbr0 -j ACCEPT
done
NAT
  chmod 755 /usr/local/sbin/cloudbox-incus-nat
  cat > /etc/systemd/system/cloudbox-incus-nat.service <<'UNIT'
[Unit]
Description=Allow incus bridge traffic through Docker's FORWARD chain
After=docker.service incus.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cloudbox-incus-nat
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now cloudbox-incus-nat

  if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v24.* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  fi
  node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); if (M!==24 || m<13 || (m===13 && p<1)) throw new Error("Node >=24.13.1 <25 is required")'
  corepack enable
  corepack prepare pnpm@11.10.0 --activate

  # The host-side T3 server spawns the agent CLIs directly until the
  # machine-per-thread overlay lands; they must exist on the host, not only
  # in the golden image.
  npm install -g ${HOST_AGENT_PACKAGES.join(" ")}
  for tool in claude codex pi opencode; do command -v "$tool" >/dev/null; done

  # vite-plus installs to ~/.local/share/vite-plus/bin (older builds used ~/.vite-plus);
  # resolve it through the user's login PATH instead of assuming a location.
  if ! sudo -iu "$BOX_USER" bash -lc 'command -v vp' >/dev/null 2>&1; then
    sudo -iu "$BOX_USER" bash -lc 'curl -fsSL https://vite.plus | bash'
  fi
  vp_bin="$(resolve_vp "$BOX_USER")"
  ln -sfn "$vp_bin" /usr/local/bin/vp
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
  # Per-thread machine workspaces (T3 machine mode): the server runs as the box
  # user and creates tank/threads/<id>/ws via sudo; the parent must exist and be
  # traversable/owned by that user.
  if ! zfs list tank/threads >/dev/null 2>&1; then
    zfs create -o mountpoint=/tank/threads tank/threads
  fi
  chmod 755 /tank
  chown "$BOX_USER:$BOX_USER" /tank/threads
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
  incus launch images:ubuntu/24.04/cloud test </dev/null
  incus exec test -- cloud-init status --wait </dev/null
  incus exec test -- true </dev/null
  incus delete test --force

  incus launch images:ubuntu/24.04/cloud testvm --vm </dev/null
  # A VM's incus-agent comes up seconds after launch; exec before that fails
  # with "VM agent isn't currently running". Bounded wait, then fail loudly.
  for attempt in $(seq 1 90); do
    if incus exec testvm -- true </dev/null >/dev/null 2>&1; then break; fi
    if [[ "$attempt" = 90 ]]; then echo "testvm agent never became ready" >&2; exit 1; fi
    sleep 2
  done
  incus exec testvm -- cloud-init status --wait </dev/null
  incus exec testvm -- true </dev/null
  incus delete testvm --force
}

phase_golden() {
  local box_uid box_gid golden_uid golden_gid
  box_uid="$(id -u "$BOX_USER")"
  box_gid="$(id -g "$BOX_USER")"

  # Only these exact migration/build names are removed. Existing thread-* machines
  # and tank/threads are independent of the golden image and remain untouched.
  if incus info golden >/dev/null 2>&1; then incus delete golden --force; fi
  if incus info golden-build >/dev/null 2>&1; then incus delete golden-build --force; fi

  # incus launch/exec parse stdin as instance YAML when it is not a TTY; the GCE
  # metadata runner hands this script in on stdin, so every call gets /dev/null.
  incus launch images:ubuntu/24.04/cloud golden-build \
    -c security.nesting=true \
    -c security.syscalls.intercept.mknod=true \
    -c security.syscalls.intercept.setxattr=true </dev/null
  incus exec golden-build -- cloud-init status --wait </dev/null
  incus exec golden-build -- bash -s -- "$BOX_USER" "$box_uid" "$box_gid" <<'GOLDEN'
set -euo pipefail
USER_NAME="$1"
HOST_UID="$2"
HOST_GID="$3"
export DEBIAN_FRONTEND=noninteractive
# incusbr0 has no IPv6 egress (GCE gives none); apt otherwise picks AAAA records
# for archive.ubuntu.com and fails with "Network is unreachable".
printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99cloudbox-force-ipv4
apt-get update
apt-get install -y ca-certificates curl git gh rsync jq zstd build-essential python3 procps sudo

# The source cloud image's default account must not claim the host box user's
# numeric identity. Derivative machines use dev as cloud-init's default user.
if id -u ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi
if getent group ubuntu >/dev/null 2>&1; then groupdel ubuntu; fi

uid_owner="$(getent passwd "$HOST_UID" | cut -d: -f1 || true)"
if [[ -n "$uid_owner" && "$uid_owner" != "$USER_NAME" ]]; then
  echo "uid $HOST_UID is already owned by $uid_owner" >&2
  exit 1
fi
gid_owner="$(getent group "$HOST_GID" | cut -d: -f1 || true)"
if [[ -n "$gid_owner" && "$gid_owner" != "$USER_NAME" ]]; then
  echo "gid $HOST_GID is already owned by $gid_owner" >&2
  exit 1
fi

if getent group "$USER_NAME" >/dev/null 2>&1; then
  groupmod -g "$HOST_GID" "$USER_NAME"
else
  groupadd -g "$HOST_GID" "$USER_NAME"
fi
if id -u "$USER_NAME" >/dev/null 2>&1; then
  usermod -u "$HOST_UID" -g "$HOST_GID" -d "/home/$USER_NAME" -s /bin/bash "$USER_NAME"
else
  useradd -m -u "$HOST_UID" -g "$HOST_GID" -d "/home/$USER_NAME" -s /bin/bash "$USER_NAME"
fi
install -d -m 755 -o "$HOST_UID" -g "$HOST_GID" "/home/$USER_NAME"
chown -R "$HOST_UID:$HOST_GID" "/home/$USER_NAME"
for supplemental_group in sudo lxd; do
  if getent group "$supplemental_group" >/dev/null 2>&1; then
    usermod -aG "$supplemental_group" "$USER_NAME"
  fi
done
cat > /etc/cloud/cloud.cfg.d/99-cloudbox-default-user.cfg <<EOF
system_info:
  default_user:
    name: $USER_NAME
EOF
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USER_NAME" > "/etc/sudoers.d/cloudbox-$USER_NAME"
chmod 440 "/etc/sudoers.d/cloudbox-$USER_NAME"

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); if (M!==24 || m<13 || (m===13 && p<1)) throw new Error("Node >=24.13.1 <25 is required")'
corepack enable
corepack prepare pnpm@11.10.0 --activate
npm install --global ${HOST_AGENT_PACKAGES.join(" ")}

sudo -iu "$USER_NAME" bash -lc 'curl -fsSL https://vite.plus | bash'
resolve_vp() {
  # vite-plus installs to ~/.local/share/vite-plus/bin (older builds used ~/.vite-plus) and only
  # adds itself to the user's interactive rc, so a login shell may not see it: try PATH first,
  # then the known locations.
  local user="$1" home found
  home="$(getent passwd "$user" | cut -d: -f6)"
  found="$(sudo -iu "$user" bash -lc 'command -v vp' 2>/dev/null || true)"
  for candidate in "$found" "$home/.local/share/vite-plus/bin/vp" "$home/.vite-plus/bin/vp"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  echo "vp was not found for $user after install" >&2
  return 1
}
vp_bin="$(resolve_vp "$USER_NAME")"
ln -sfn "$vp_bin" /usr/local/bin/vp

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
# User-scoped installers (vite-plus today, and any future pnpm/npm tools) must
# remain writable after a UID/GID migration.
chown -R "$HOST_UID:$HOST_GID" "/home/$USER_NAME"
command -v node pnpm vp git gh rsync docker lane claude codex pi opencode
npm ls -g --depth=0
GOLDEN

  golden_uid="$(incus exec golden-build -- id -u "$BOX_USER" </dev/null)"
  golden_gid="$(incus exec golden-build -- id -g "$BOX_USER" </dev/null)"
  if [[ "$golden_uid" != "$box_uid" ]]; then
    echo "golden $BOX_USER uid mismatch: expected $box_uid, got $golden_uid" >&2
    exit 1
  fi
  if [[ "$golden_gid" != "$box_gid" ]]; then
    echo "golden $BOX_USER gid mismatch: expected $box_gid, got $golden_gid" >&2
    exit 1
  fi
  if incus exec golden-build -- getent passwd ubuntu </dev/null >/dev/null 2>&1; then
    echo "golden build still contains the ubuntu user" >&2
    exit 1
  fi

  incus stop golden-build --force
  if incus image info golden >/dev/null 2>&1; then incus image delete golden; fi
  incus publish golden-build --alias golden
  incus image info golden
  incus delete golden-build
}

write_t3_unit() {
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
Environment=T3_MACHINE_IDENTITY_MANIFEST=/home/${config.boxUser}/.config/cloudbox/machine-identity.json
Environment=T3CODE_RELAY_URL=${config.t3.relayUrl}
Environment=T3CODE_CLERK_PUBLISHABLE_KEY=${config.t3.clerkPublishableKey}
Environment=T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=${config.t3.clerkCliOauthClientId}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /home/${config.boxUser}/t3code/apps/server/dist/bin.mjs serve --base-dir /home/${config.boxUser}/.t3 --host 127.0.0.1 --port ${String(config.t3Port)} /home/${config.boxUser}
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  chown "$BOX_USER:$BOX_USER" "/home/$BOX_USER/.config/systemd/user/t3code-fork.service"
}

phase_t3() {
  if [[ ! -d "/home/$BOX_USER/t3code/.git" ]]; then
    sudo -u "$BOX_USER" git clone --branch ${shellQuote(config.t3.branch)} --single-branch ${shellQuote(config.t3.repoUrl)} "/home/$BOX_USER/t3code"
  else
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" fetch origin ${shellQuote(config.t3.branch)}
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" checkout ${shellQuote(config.t3.branch)}
    sudo -u "$BOX_USER" git -C "/home/$BOX_USER/t3code" reset --hard FETCH_HEAD
  fi

  # The build runs in a login shell; propagate its failure explicitly so a
  # broken build can never leave this phase marked complete.
  if ! sudo -iu "$BOX_USER" bash -lc '
    set -euo pipefail
    export PATH="/usr/local/bin:/usr/bin:/bin"
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
  '; then
    echo "T3 fork build failed" >&2
    exit 1
  fi

  write_t3_unit
  loginctl enable-linger "$BOX_USER"
  local box_uid
  box_uid="$(id -u "$BOX_USER")"
  systemctl start "user@$box_uid.service"
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$box_uid" systemctl --user daemon-reload
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$box_uid" systemctl --user enable --now t3code-fork.service
}

phase_t3_machine_identity_unit() {
  local unit_path="/home/$BOX_USER/.config/systemd/user/t3code-fork.service"
  local environment_line="Environment=T3_MACHINE_IDENTITY_MANIFEST=/home/$BOX_USER/.config/cloudbox/machine-identity.json"
  local already_configured=0
  if [[ -f "$unit_path" ]] && grep -Fqx "$environment_line" "$unit_path"; then
    already_configured=1
  fi

  write_t3_unit
  local box_uid
  box_uid="$(id -u "$BOX_USER")"
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$box_uid" systemctl --user daemon-reload
  if [[ "$already_configured" != 1 ]]; then
    echo "t3code-fork.service now references the machine identity manifest; restart required: systemctl --user restart t3code-fork.service"
  fi
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
  test -s /opt/cloudbox/idle.mjs
  test -s /opt/cloudbox/machines.mjs
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
run_phase 05-golden-v2 "$REBUILD_GOLDEN" phase_golden
run_phase 06-t3 0 phase_t3
run_phase 06a-t3-machine-identity-unit 0 phase_t3_machine_identity_unit
run_phase 07-t3-idle-token 0 phase_t3_idle_token
run_phase 08-cloudbox-tools 0 phase_cloudbox_tools

echo "cloudbox host bootstrap v2 completed"
`;
};

const assetUrl = (bucketName: string, objectName: string): string =>
  `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?alt=media`;

/**
 * Render the small Compute Engine metadata script. Large bootstrap assets live
 * in GCS, are authenticated with the attached service account, and are verified
 * before installation. The inner script still runs from a file with stdin
 * detached so incus and curl installers cannot consume metadata-runner input.
 */
export const renderFetchWrapper = (config: HostFetchWrapperConfig): string => {
  const assets = [config.bootstrap, config.idle, config.machines]
    .map((asset) =>
      `fetch_asset ${shellQuote(assetUrl(config.bucketName, asset.objectName))} ${shellQuote(asset.sha256)} ${shellQuote(asset.destination)} ${shellQuote(asset.mode)}`,
    )
    .join("\n");
  return `#!/usr/bin/env bash
set -euo pipefail
umask 027
install -d -m 700 /var/lib/cloudbox
install -d -m 755 /opt/cloudbox
readonly METADATA=http://metadata.google.internal/computeMetadata/v1
readonly TOKEN_RESPONSE="$(curl -fsS -H 'Metadata-Flavor: Google' "$METADATA/instance/service-accounts/default/token")"
readonly ACCESS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
test -n "$ACCESS_TOKEN"
fetch_asset() {
  local url="$1" expected="$2" destination="$3" mode="$4" temporary
  temporary="$(mktemp /var/lib/cloudbox/asset.XXXXXX)"
  trap 'rm -f "$temporary"' EXIT
  curl -fsS --retry 36 --retry-delay 5 --retry-max-time 180 --retry-all-errors -H "Authorization: Bearer $ACCESS_TOKEN" "$url" -o "$temporary"
  printf '%s  %s\\n' "$expected" "$temporary" | sha256sum --check --status
  install -m "$mode" "$temporary" "$destination"
  rm -f "$temporary"
  trap - EXIT
}
${assets}
exec bash ${shellQuote(config.bootstrap.destination)} </dev/null
`;
};
