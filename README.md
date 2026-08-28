# cloudbox

One personal AWS EC2 development machine for dev. It runs the patched T3 Code fork headlessly, hibernates after sustained inactivity, and is controlled from a laptop with an Effect CLI.

## What it creates

- One VPC with a public subnet and internet routing.
- One imported EC2 SSH key and one security group: TCP 22 only from `sshCidr`; unrestricted egress.
- One EC2 role/profile. The inline policy grants `ec2:StopInstances` and `ec2:DescribeInstances` only with the `aws:ResourceTag/cloudbox=<name>` condition.
- One Ubuntu 24.04 x86_64 EC2 instance with an encrypted gp3 root disk, IMDSv2-only metadata, and hibernation enabled at launch.
- A local Alchemy state tree under `.alchemy/state/`.

Alchemy beta.74's typed `AWS.EC2.Instance` props do not expose `HibernationOptions`, root `BlockDeviceMappings`, or `MetadataOptions`. Cloudbox therefore uses Alchemy's documented `AWS.CloudFormation.Stack` escape hatch for the `AWS::EC2::Instance`; networking, key pair, security group, role, and profile use native Alchemy resources.

The AMI is never hardcoded. CloudFormation resolves Canonical's public SSM parameter:

```text
/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
```

## Prerequisites

- Node.js `>=24.10`, pnpm `11.10.0`, and AWS permissions to create EC2, VPC, IAM, and CloudFormation resources.
- An existing public SSH key.
- A GitHub fine-grained token with read-only access to `dev-mualim/t3code`.
- `rsync` and `ssh` on the laptop.
- An AWS region and instance type that support hibernation.

### AWS credentials

Alchemy beta.74 supports its own AWS auth profile. Run `pnpm alchemy login --configure` and choose either AWS SSO (a profile from `~/.aws/config`) or environment credentials. Environment auth reads:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN       # when applicable
AWS_REGION              # must equal cloudbox.json region
AWS_ACCOUNT_ID          # optional; otherwise resolved with STS
```

The laptop CLI uses the AWS SDK default credential chain. It supports the standard `AWS_*` variables, `AWS_PROFILE`, shared AWS config/credentials files, SSO, and other normal SDK sources.

## Configure

```bash
pnpm install
cp cloudbox.example.json cloudbox.json
$EDITOR cloudbox.json
```

Every configuration field is required. There are no config defaults. `instanceType` must be explicit, and `sshCidr` rejects `0.0.0.0/0`.

Set the token named by `t3.githubToken`:

```bash
export CLOUDBOX_GITHUB_TOKEN='github_pat_...'
```

`cloudbox.json`, `.env*`, generated user data, `.alchemy/`, and `.pi/` are ignored by git.

### GitHub token exposure

The private-clone token is passed through EC2 user data. The rendered payload avoids putting it in the clone URL or command arguments, but root on the instance and principals allowed to read EC2 user data can recover it. Cloud-init may retain a root-only copy under `/var/lib/cloud/instances/`.

Use a fine-grained, repository-scoped, read-only token. Rotate or revoke it after bootstrap if future rebuilds do not need it.

## Build and verify locally

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm cloudbox --help
```

`dist/idle.mjs` is intentionally unbundled and small enough for user data. Bootstrap installs its pinned runtime dependencies under `/opt/cloudbox`. The laptop CLI is bundled to `dist/cli.mjs`.

## First run

1. Build and deploy:

   ```bash
   pnpm build
   pnpm alchemy login --configure
   pnpm deploy
   ```

2. Wake the instance and wait for SSH:

   ```bash
   pnpm cloudbox wake
   ```

3. Preview and then perform identity sync:

   ```bash
   pnpm cloudbox sync --dry-run
   pnpm cloudbox sync
   ```

4. Connect and authenticate tools once as `dev`:

   ```bash
   pnpm cloudbox ssh
   claude auth login
   codex login
   pi
   opencode auth login
   gh auth login
   ```

5. Pair T3 Connect against the running fork:

   ```bash
   cd ~/t3code
   node apps/server/dist/bin.mjs connect link --headless --base-dir ~/.t3
   systemctl --user restart t3code-fork.service
   ```

   The service binds T3 to `127.0.0.1:3773`. T3 Connect's managed `cloudflared` tunnel provides remote access. Do not run `t3 service install`: this fork reports `0.0.35`, so that command installs the unpatched npm release instead of the checked-out fork.

## Laptop CLI

All commands read `cloudbox.json` from the current directory and locate exactly one non-terminated instance tagged `cloudbox=<name>`.

```bash
pnpm cloudbox status
pnpm cloudbox wake
pnpm cloudbox sleep
pnpm cloudbox sync --dry-run
pnpm cloudbox sync
pnpm cloudbox ssh
```

| Command | Behavior |
|---|---|
| `status` | Prints instance ID, EC2 state, and current public IP. |
| `wake` | Starts the instance, waits for `running`, polls TCP 22, then prints the IP. |
| `sleep` | Calls `StopInstances` with `Hibernate=true`. |
| `sync` | Runs `rsync -az --mkpath` for each configured identity path and applies every exclude. |
| `ssh` | Opens `ssh dev@<current-public-ip>`. |

The public IP may change after hibernation because v1 does not allocate an Elastic IP. Every command discovers the current address.

## Box services

### T3 Code

Bootstrap clones branch `main`, runs `vp install --frozen-lockfile`, builds only the `t3` package and its dependencies, and installs `t3code-fork.service` as a lingering systemd user service.

The service runs:

```text
/usr/bin/node ~/t3code/apps/server/dist/bin.mjs serve \
  --base-dir ~/.t3 --host 127.0.0.1 --port 3773 /home/dev
```

### Idle hibernation

`cloudbox-idle.timer` runs every five minutes. A check is busy when:

- `/run/cloudbox/keepawake` exists;
- a Claude, Codex, pi, or OpenCode process is running;
- the T3 server has a non-infrastructure child process; or
- TCP port 3773 has an established connection.

The persistent T3-managed `cloudflared` helper is excluded from the child-process test; otherwise merely pairing the relay would prevent hibernation forever. Active relay traffic still appears as an established connection to port 3773.

The idle streak is stored in `/var/lib/cloudbox/idle.json`. At `idleMinutes`, the service gets its instance ID with an IMDSv2 token and calls `StopInstances(Hibernate=true)` using the instance role.

Force the box awake during unattended work:

```bash
sudo touch /run/cloudbox/keepawake
# later
sudo rm /run/cloudbox/keepawake
```

## Hibernation limits

AWS hibernation must be enabled at initial launch; it cannot be enabled later. The root volume must be encrypted and large enough to store RAM state. Supported instances must have less than 150 GiB RAM, and an instance cannot remain hibernated for more than 60 days. AWS support also varies by instance family, size, AMI, region, and purchase option.

The example uses `m7i.4xlarge` (64 GiB RAM) and a 300 GB encrypted gp3 root volume. Validate current AWS hibernation support before deployment.

## Bootstrap diagnostics

Bootstrap is idempotent and writes:

```text
/var/log/cloudbox-bootstrap.log
/var/lib/cloudbox/bootstrapped
/etc/cloudbox/config.json
/opt/cloudbox/idle.mjs
```

If the marker is absent, inspect the log:

```bash
sudo tail -n 200 /var/log/cloudbox-bootstrap.log
systemctl --user status t3code-fork.service --no-pager
sudo systemctl status cloudbox-idle.timer --no-pager
```

## Phase 2 / 3

**Phase 2:** add GCP through a custom Alchemy `Resource`. Alchemy `2.0.0-beta.74` has no GCP provider. This version intentionally contains no GCP code.

**Phase 3:** add relay wake-on-connect so a connection request can start the sleeping instance. This version makes no relay changes.
