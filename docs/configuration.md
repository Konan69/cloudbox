# Configuration

## cloudbox.json

No field has a default. Every field is required unless the table says optional. The examples hold working starting values.

| Field | Providers | What it does |
| --- | --- | --- |
| `provider` | all | `"aws"`, `"gcp"` or `"boat"`. |
| `name` | all | Box name. AWS tags and GCP labels use it. GCP and Boat need 1 to 50 lowercase letters, digits or hyphens. |
| `boxUser` | all | Linux account on the box. Boat requires `"user"`. The examples use `"dev"` for AWS and GCP. |
| `sshPublicKeyPath` | all | Public key to authorize. Boat requires `~/.ssh/ascii_box_ed25519.pub`. |
| `idleMinutes` | all | Idle time before the box sleeps. Boat ignores it and uses its TTL. |
| `aws.sshCidr` | aws | IPv4 CIDR allowed to reach port 22. `0.0.0.0/0` is rejected. |
| `region`, `instanceType`, `diskGb` | aws | EC2 region, instance type and root disk size. The instance type must support hibernation. |
| `gcp.project`, `gcp.zone` | gcp | Project and zone. |
| `gcp.machineType` | gcp | An Intel `n1-`, `n2-` or `c2-` type. |
| `gcp.bootDiskGb`, `gcp.dataDiskGb` | gcp | Disk sizes. |
| `gcp.dataDiskType` | gcp | `"pd-ssd"` or `"pd-balanced"`. |
| `gcp.credentials` | gcp | `"adc"` or `{ "serviceAccountJsonPath": "..." }`. |
| `wake.allowedOrigins` | gcp | At least one origin (scheme and host, no path) that may call the wake service. |
| `boat.type` | boat | `"small"`, `"default"`, `"large"` or `"xlarge"`. |
| `boat.ttlSeconds` | boat | Seconds before Boat archives the sandbox, or `null`. |
| `boat.environment` | boat | Optional Boat environment name. The example uses `"base"`. |
| `t3.repoUrl`, `t3.branch` | aws, gcp | T3 Code checkout that the box builds and runs. |
| `t3.relayUrl`, `t3.clerkPublishableKey`, `t3.clerkCliOauthClientId` | aws, gcp | Optional. Relay settings for the T3 service. Empty when unset. |
| `t3.settingsParity.enabled`, `t3.settingsParity.keybindings` | all | Copy portable local T3 settings and keybindings on sync. The examples set both to `false`. |
| `identity.paths` | all | `~/`-relative files and folders to copy to the box. The examples copy nothing. |
| `identity.excludes` | all | rsync exclude patterns. |
| `identity.maxTransferMb` | all | Sync stops above this many MB unless you pass `--force`. |
| `bootstrap.paths`, `bootstrap.excludes`, `bootstrap.maxTransferMb` | all | Optional. Allowlist and limit for `bootstrap-clone`. |
| `repos[].url`, `repos[].path`, `repos[].branch` | all | Repositories to clone on sync. `url` is HTTPS, `ssh://` or `user@host:path`. `path` starts with `~/` and is unique. `branch` is optional. |

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `BOAT_API_KEY` | unset | Boat API key for `cloudbox boat`. If unset, the CLI reads `~/.config/cloudbox/boat-api-key`. |
| `CLOUDBOX_WAKE_URL`, `CLOUDBOX_WAKE_SECRET` | unset | Wake service URL and secret from the GCP deploy. Used by `wake --via-service` and `status`. |
| `CLOUDBOX_WINDOWS_USER` | local user name | Windows user whose `C:\Users\<user>\.ssh\config` `boat up` writes. |
| `CLOUDBOX_BOX_USER` | `dev` | Box account for the on-box machine CLI. The generated T3 service sets it. |

## Boat helper scripts

`scripts/devbox-pick`, `devbox-start`, `devbox-stop`, `boat-is-up` and `boat-keepalive` manage several Boat sandboxes through the Boat API. They read the key only from `~/.config/cloudbox/boat-api-key`.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLOUDBOX_HOSTS` | `cloudbox-dev` | Space-separated hosts that `devbox-pick` chooses from. |
| `CLOUDBOX_PROTECTED_HOSTS` | empty | Hosts that `devbox-start` and `devbox-stop` refuse to touch. |
| `CLOUDBOX_RESUME_HOOK` | unset | Local shell script that `devbox-start` runs on the box after a resume. |
