import { gzipSync } from "node:zlib";

import type { CloudboxConfig } from "../config.ts";

export interface BootstrapInput {
  readonly config: CloudboxConfig;
  readonly sshPublicKey: string;
  readonly githubToken: string;
  readonly idleBundle: string;
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const AGENT_PACKAGES = [
  "@anthropic-ai/claude-code@2.1.246",
  "@openai/codex@0.149.0",
  "@earendil-works/pi-coding-agent@0.84.2",
  "opencode-ai@1.18.21",
] as const;

export const renderBootstrap = ({
  config,
  sshPublicKey,
  githubToken,
  idleBundle,
}: BootstrapInput): string => {
  const boxConfig = JSON.stringify(
    {
      name: config.name,
      region: config.region,
      idleMinutes: config.idleMinutes,
      t3Port: 3773,
    },
    null,
    2,
  );

  return `#!/usr/bin/env bash
set -euo pipefail
umask 027
mkdir -p /var/log
exec > >(tee -a /var/log/cloudbox-bootstrap.log) 2>&1
trap 'status=$?; echo "cloudbox bootstrap failed at line $LINENO (exit $status)"; exit $status' ERR

readonly MARKER=/var/lib/cloudbox/bootstrapped
if [[ -f "$MARKER" ]]; then
  echo "cloudbox already bootstrapped"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gh rsync build-essential python3 sudo util-linux jq sqlite3 iproute2

if ! id -u ${config.boxUser} >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash ${config.boxUser}
fi
install -d -m 700 -o ${config.boxUser} -g ${config.boxUser} /home/${config.boxUser}/.ssh
printf '%s' '${b64(sshPublicKey.trim())}' | base64 --decode > /home/${config.boxUser}/.ssh/authorized_keys
chown ${config.boxUser}:${config.boxUser} /home/${config.boxUser}/.ssh/authorized_keys
chmod 600 /home/${config.boxUser}/.ssh/authorized_keys
printf '%s ALL=(ALL) NOPASSWD:ALL\n' '${config.boxUser}' > /etc/sudoers.d/cloudbox-${config.boxUser}
chmod 440 /etc/sudoers.d/cloudbox-${config.boxUser}

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker ${config.boxUser}
systemctl enable --now docker

if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v24.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 13 || (minor === 13 && patch < 1)) { throw new Error("T3 source build requires Node >=24.13.1 <25") }'
corepack enable
corepack prepare pnpm@11.10.0 --activate
npm install --global ${AGENT_PACKAGES.join(" ")}

if [[ ! -x /home/${config.boxUser}/.vite-plus/bin/vp ]]; then
  sudo -iu ${config.boxUser} bash -lc 'curl -fsSL https://vite.plus | bash'
fi
sudo -iu ${config.boxUser} bash -lc 'command -v vp && vp --version'

install -d -m 700 -o ${config.boxUser} -g ${config.boxUser} /home/${config.boxUser}/.config/cloudbox
readonly ASKPASS=/home/${config.boxUser}/.config/cloudbox/github-askpass.sh
cat > "$ASKPASS" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$CLOUDBOX_CLONE_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chown ${config.boxUser}:${config.boxUser} "$ASKPASS"
chmod 700 "$ASKPASS"
export CLOUDBOX_CLONE_TOKEN="$(printf '%s' '${b64(githubToken)}' | base64 --decode)"
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0

if [[ ! -d /home/${config.boxUser}/t3code/.git ]]; then
  sudo --preserve-env=CLOUDBOX_CLONE_TOKEN,GIT_ASKPASS,GIT_TERMINAL_PROMPT -u ${config.boxUser} \\
    git clone --branch ${shellQuote(config.t3.branch)} --single-branch ${shellQuote(config.t3.repoUrl)} /home/${config.boxUser}/t3code
else
  sudo --preserve-env=CLOUDBOX_CLONE_TOKEN,GIT_ASKPASS,GIT_TERMINAL_PROMPT -u ${config.boxUser} \\
    git -C /home/${config.boxUser}/t3code fetch origin ${shellQuote(config.t3.branch)}
  sudo -u ${config.boxUser} git -C /home/${config.boxUser}/t3code checkout ${shellQuote(config.t3.branch)}
  sudo -u ${config.boxUser} git -C /home/${config.boxUser}/t3code reset --hard FETCH_HEAD
fi
unset CLOUDBOX_CLONE_TOKEN GIT_ASKPASS GIT_TERMINAL_PROMPT
rm -f "$ASKPASS"

### T3 HEADLESS — refine from docs/t3-headless.md
sudo -iu ${config.boxUser} bash -lc '
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
'

install -d -m 700 -o ${config.boxUser} -g ${config.boxUser} /home/${config.boxUser}/.config/systemd/user
cat > /home/${config.boxUser}/.config/systemd/user/t3code-fork.service <<'UNIT'
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
Environment=PATH=/home/${config.boxUser}/.vite-plus/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/${config.boxUser}/t3code/.env.example
ExecStart=/usr/bin/node /home/${config.boxUser}/t3code/apps/server/dist/bin.mjs serve --base-dir /home/${config.boxUser}/.t3 --host 127.0.0.1 --port 3773 /home/${config.boxUser}
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
chown ${config.boxUser}:${config.boxUser} /home/${config.boxUser}/.config/systemd/user/t3code-fork.service
loginctl enable-linger ${config.boxUser}
readonly BOX_UID="$(id -u ${config.boxUser})"
systemctl start "user@\${BOX_UID}.service"
runuser -u ${config.boxUser} -- env XDG_RUNTIME_DIR="/run/user/\${BOX_UID}" systemctl --user daemon-reload
runuser -u ${config.boxUser} -- env XDG_RUNTIME_DIR="/run/user/\${BOX_UID}" systemctl --user enable --now t3code-fork.service

install -d -m 755 /opt/cloudbox /etc/cloudbox /var/lib/cloudbox
npm install --prefix /opt/cloudbox --omit=dev \\
  effect@4.0.0-rc.112 \\
  @effect/platform-node@4.0.0-rc.112 \\
  @aws-sdk/client-ec2@3.1120.0
printf '%s' '${b64(idleBundle)}' | base64 --decode > /opt/cloudbox/idle.mjs
chmod 755 /opt/cloudbox/idle.mjs
printf '%s' '${b64(boxConfig)}' | base64 --decode > /etc/cloudbox/config.json
chmod 600 /etc/cloudbox/config.json

cat > /etc/systemd/system/cloudbox-idle.service <<'UNIT'
[Unit]
Description=Hibernate Cloudbox after sustained inactivity
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/cloudbox/idle.mjs
NoNewPrivileges=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=/var/lib/cloudbox /run/cloudbox
UNIT

cat > /etc/systemd/system/cloudbox-idle.timer <<'UNIT'
[Unit]
Description=Check Cloudbox activity every five minutes

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
touch "$MARKER"
echo "cloudbox bootstrap completed"
`;
};

/**
 * EC2 limits raw user data to 16 KiB. Cloud-init executes this small wrapper,
 * which expands the deterministic rendered script in memory.
 */
export const renderUserData = (input: BootstrapInput): string => {
  const compressed = gzipSync(Buffer.from(renderBootstrap(input), "utf8"), { level: 9 });
  return `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' '${compressed.toString("base64")}' | base64 --decode | gzip --decompress | bash\n`;
};
