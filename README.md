# cloudbox

One personal AWS EC2 or Google Compute Engine development machine for dev. It runs the patched T3 Code fork headlessly, suspends after sustained inactivity, and is controlled from a laptop with an Effect CLI.

## What it creates

Select `provider: "aws"` or `provider: "gcp"` in `cloudbox.json`. AWS creates:

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

## GCP host

The GCP stack uses a custom Effect-native Alchemy provider and Google REST APIs through the configured ADC. It creates one SSH firewall rule on the default VPC, one separate `pd-ssd` or `pd-balanced` data disk, one Ubuntu 24.04 x86_64 instance, and the Cloud Run wake service with its GCS, Artifact Registry, Cloud Build, and Secret Manager resources. The instance uses an Intel N1/N2/C2 machine type, nested virtualization, an explicit boot-disk size, an external IP, and the `cloudbox=<name>` label. The default VPC and default Compute Engine service account must already exist. Disks and instances are adopted only when name and label match. Compute firewall rules do not support labels, so firewall ownership uses its generated name plus exact Cloudbox description.

The host v2 Incus path requires an N2 machine type so KVM is available through `/dev/kvm`. The standard GCP example is the full host. `cloudbox.test.example.json` is the cheap test host: `n2-standard-2`, a 30 GB boot disk, and a 50 GB balanced data disk.

Copy one GCP example:

```bash
cp cloudbox.gcp.example.json cloudbox.json       # full host
cp cloudbox.test.example.json cloudbox.json      # cheap test host
```

For Application Default Credentials, configure either interactive ADC:

```bash
gcloud auth application-default login
```

or set `gcp.credentials` to a service-account key file:

```json
"credentials": { "serviceAccountJsonPath": "~/.config/gcloud/cloudbox.json" }
```

The deploying principal needs permissions to manage Compute Engine, project custom roles, service accounts, enabled APIs, Cloud Storage, Artifact Registry, Cloud Build, Secret Manager, and Cloud Run. See [docs/wake-service.md](docs/wake-service.md) for the exact roles and the Cloud Build service-account prerequisite. No downloadable runtime key is created.

Check that the organization policy does not disable nested virtualization:

```bash
gcloud org-policies describe constraints/compute.disableNestedVirtualization \
  --project=YOUR_PROJECT --effective
```

The instance uses the default service account with the Compute OAuth scope. That service account needs `compute.instances.suspend` on this instance (normally through a narrow custom role and IAM condition). Without it, automatic idle suspend fails.

The stack also creates `cloudbox-wake@<project>.iam.gserviceaccount.com`, a project custom role, and an IAM binding on the exact VM. Compute Engine instance labels are **not** IAM Conditions attributes; Resource Manager tags are. Cloudbox therefore verifies `cloudbox=<name>` before reconciliation, then attaches the role to the instance-level IAM policy instead of granting it project-wide. The role contains `compute.instances.get`, `compute.instances.resume`, and `compute.instances.start`; `start` is required for the documented `TERMINATED` behavior. See [docs/wake-service.md](docs/wake-service.md).

GCE suspend preserves memory, but supports only instances with at most 208 GB RAM and no GPU. A suspended instance is automatically terminated after 60 days. In-guest suspend commands are ignored by GCE; Cloudbox calls `instances.suspend` through the Compute API. The external IP may change after resume.

## Configure

```bash
pnpm install
cp cloudbox.example.json cloudbox.json
$EDITOR cloudbox.json
```

Every field for the selected provider is required. There are no config defaults. AWS requires explicit `region`, `instanceType`, and `diskGb`. GCP requires explicit `project`, `zone`, Intel N1/N2/C2 `machineType`, boot/data disk sizes, data-disk type, and credentials. Identity sync requires `maxTransferMb`. `sshCidr` rejects `0.0.0.0/0`.

The public fork is cloned directly from `https://github.com/example/t3code.git`; no GitHub token enters EC2 user data.

`cloudbox.json`, `.env*`, generated user data, `.alchemy/`, and `.pi/` are ignored by git.

### Identity sync safety

Identity paths must start with `~/`, so each path is translated from the laptop user's home to the box user's home. End directory paths with `/` to sync their contents rather than nesting the directory itself. The example configs include only small settings, skills, memory, and agent-definition paths; they exclude session transcripts and extension caches.

Every real sync first runs rsync in dry-run mode and totals `Total transferred file size` across all paths. If that exceeds `identity.maxTransferMb`, the command lists each path's bytes and stops. Tighten `identity.excludes`, or use `cloudbox sync --force` after reviewing the totals.

Credentials are copied only when explicitly listed in `identity.paths`. This includes `~/.codex/auth.json`, `~/.claude/.credentials.json`, and `~/.config/gh/hosts.yml`. The safer alternative is to omit those files and run `codex login`, `claude auth login`, and `gh auth login` once on the box.

## Build and verify locally

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm check:bootstrap
pnpm cloudbox --help
```

`dist/idle.mjs` and `dist/machines.mjs` are minified, self-contained host bundles. Tests copy them to an empty temporary directory and run each bundle's `--help` entry point without `node_modules`. GCP uploads those bundles and the rendered inner bootstrap as content-addressed objects in a private assets bucket; instance metadata contains only a sub-4 KiB authenticated fetch-and-verify wrapper. EC2 uses the smaller `dist/idle-aws.mjs` plus pinned Effect runtime packages to remain below its 16 KiB user-data limit. The laptop CLI is bundled to `dist/cli.mjs`; the Cloud Run source archive contains the self-contained `dist/wake-service.mjs` bundle.

## First run

1. Build and deploy:

   ```bash
   pnpm build
   pnpm alchemy login --configure
   pnpm deploy
   ```

2. Wake the instance and wait for SSH. Direct GCP credentials remain the default; the second form tests the deployed Cloud Run path:

   ```bash
   pnpm cloudbox wake
   export CLOUDBOX_WAKE_URL='<wakeUrl output>'
   export CLOUDBOX_WAKE_SECRET='<wakeSecret output>'
   pnpm cloudbox wake --via-service
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

All commands read `cloudbox.json` from the current directory and dispatch by `provider`. AWS locates one non-terminated tagged instance. GCP locates `cloudbox-<name>` in the configured zone and verifies its `cloudbox=<name>` label.

```bash
pnpm cloudbox status
pnpm cloudbox wake
pnpm cloudbox sleep
pnpm cloudbox sync --dry-run
pnpm cloudbox sync
pnpm cloudbox sync --force
pnpm cloudbox ssh
pnpm cloudbox verify --host <ip> [--expect-vm] [--json]
pnpm cloudbox smoke-thread --host <ip> [--timeout 240] [--keep-project]
pnpm cloudbox verify-sleep [--timeout 1800] [--json]
pnpm cloudbox verify-idle [--timeout 1800] [--json]
```

| Command | Behavior |
|---|---|
| `status` | Prints provider, instance ID/name, cloud state, and current public IP. |
| `wake` | AWS: starts. GCP: resumes `SUSPENDED`, or starts `TERMINATED`. `--via-service` uses `CLOUDBOX_WAKE_URL` and `CLOUDBOX_WAKE_SECRET`. Then waits for TCP 22 and prints the IP. |
| `sleep` | AWS: hibernates. GCP: calls `instances.suspend` to preserve memory. |
| `sync` | Shows rsync names/stats per path. Real transfers run a dry-run size guard first; `--force` overrides `maxTransferMb`. |
| `ssh` | Opens `ssh dev@<current-public-ip>`. |
| `verify` | Runs named bootstrap, tool, ZFS, Incus, T3, timer, and Docker checks over SSH. |
| `smoke-thread` | Enables/configures pi through the environment API, runs autonomous pi and Codex turns, validates output, then deletes smoke threads and (unless `--keep-project`) the project. |
| `verify-sleep` | Sleeps and wakes through the configured provider, then proves uptime and a marker PID survived. |
| `verify-idle` | Leaves the host untouched for `idleMinutes + 5` and verifies provider sleep. |

Verification prints a table by default or JSON with `--json`, and exits non-zero if any check fails. `--timeout` is seconds. See [docs/testing.md](docs/testing.md) and [scripts/cloud-test.md](scripts/cloud-test.md).

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

The idle streak is stored in `/var/lib/cloudbox/idle.json`. At `idleMinutes`, AWS gets its instance ID with an IMDSv2 token and calls `StopInstances(Hibernate=true)`. GCP reads project, zone, instance name, and an access token from `metadata.google.internal`, then calls `instances.suspend` on itself. Busy detection is shared.

Each tick records wall-clock time. A gap larger than three timer intervals is treated as a resume clock jump: the idle streak resets and suspension is blocked for another `idleMinutes`. This gives T3 and cloudflared time to reconnect before the host can suspend again.

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
/var/lib/cloudbox/bootstrapped                 # AWS v1
/var/lib/cloudbox/host-v2-<phase>.done         # GCP host v2
/etc/cloudbox/config.json
/opt/cloudbox/idle.mjs
/opt/cloudbox/machines.mjs                     # GCP host v2
```

If the expected marker is absent, inspect the log:

```bash
sudo tail -n 200 /var/log/cloudbox-bootstrap.log
systemctl --user status t3code-fork.service --no-pager
sudo systemctl status cloudbox-idle.timer --no-pager
```

## Wake-on-connect boundary

This repository now owns the GCP IAM, Cloud Run wake service, host grace, and `cloudbox wake --via-service` path. The dev T3 fork still owns the explicit one-shot client intent that calls the `wakeUrl`; the hosted T3 relay is unchanged.
