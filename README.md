# cloudbox

One dev box in your own cloud account, asleep whenever you are not using it.

A big machine for coding agents costs money every hour it runs, and most hours nobody is using it. `cloudbox` keeps one box per config file on AWS, Google Cloud or Boat. On AWS and GCP a timer on the box checks every 5 minutes for agent processes, T3 sessions or a keep-awake marker, and hibernates it through the provider API when there are none. `cloudbox wake` brings it back with memory intact and waits for SSH. The same config syncs your identity files and repos and runs an acceptance suite, so a rebuilt box comes up the same as the old one.

![Explainer: an agent exits, cloudbox-idle.timer logs 0 to 30 idle minutes, the box calls StopInstances Hibernate=true and its RAM goes to the root volume, then cloudbox wake restores it and an agent starts again](docs/media/hero.gif)

## Install

Node.js 24.10+, pnpm 11.10, `ssh` and `rsync`. Plus AWS credentials, the `gcloud` CLI, or a Boat API key, depending on the provider.

```bash
git clone <this-repo-url> cloudbox && cd cloudbox
pnpm install --frozen-lockfile
pnpm build                                     # CLI plus the on-box idle and wake bundles
cp cloudbox.example.json cloudbox.json         # or cloudbox.gcp / .test / .boat.example.json; then edit
```

## Use

```bash
pnpm deploy                 # AWS or GCP: create the box (billable)
pnpm cloudbox wake          # start or resume, print the host once SSH answers
pnpm cloudbox sync          # push identity paths and repos; --dry-run first, stops over maxTransferMb
pnpm cloudbox ssh
pnpm cloudbox verify        # acceptance checks over SSH; verify-sleep proves memory survives a sleep
pnpm cloudbox sleep
pnpm cloudbox status

pnpm cloudbox boat up       # Boat: create or resume, sync, write the SSH entry
pnpm cloudbox boat stop
```

On the box, `sudo touch /run/cloudbox/keepawake` holds it awake.

The config is validated before any provider call, and unsafe values are refused:

```console
$ pnpm -s cloudbox status          # with "sshCidr": "0.0.0.0/0"
ERROR (#1): ConfigError: Invalid cloudbox.json: Expected <filter>
  at ["aws"]["sshCidr"]
```

Every `cloudbox.json` field and environment variable: [docs/configuration.md](docs/configuration.md). How deploy, idle sleep, wake, verify and sync work: [docs/internals.md](docs/internals.md). Boat specifics: [docs/boat-provider.md](docs/boat-provider.md).

## Limits

- One box per `cloudbox.json`. Use a separate directory for each box.
- AWS hibernation must be enabled when the instance is first launched, and AWS supports it only on some instance types.
- GCP suspend keeps memory, but the external IP can change after resume. SSH uses the instance name through IAP for that reason.
- Boat restores onto a new machine, so its IP and SSH host keys change. The managed SSH entry does not keep host keys.
- The box runs a T3 Code checkout from `t3.repoUrl`. The bootstrap and acceptance commands expect APIs from a patched T3 build. Compatibility with upstream T3 is not confirmed.
- `boat up` writes the Windows SSH config under `/mnt/c/Users/`, so the Boat desktop flow needs WSL.
- `pnpm deploy` and the live AWS, GCP and Boat paths were not run while this README was written. The commands in Use up to the config errors were.

## License

MIT
