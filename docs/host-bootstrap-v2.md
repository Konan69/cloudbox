# Host bootstrap v2

`src/bootstrap/render-host.ts` renders the GCP N2 host bootstrap. The caller must provide every deployment value, both built Cloudbox bundles, and the stable GCP disk path:

```text
/dev/disk/by-id/google-<diskName>
```

The renderer does not contact GCP. The generated script is intended for an Ubuntu 24.04 x86_64 VM with nested virtualization enabled and `/dev/kvm` present.

## Phases

The script logs to `/var/log/cloudbox-bootstrap.log`. Each completed phase has a marker at `/var/lib/cloudbox/host-v2-<phase>.done`. Re-running skips completed phases. Remove one phase marker to apply a changed phase. Pass `--rebuild` to replace the `golden` image while retaining other completed phases.

The phases install host tools, create `tank`, initialize Incus from preseed, test both container and KVM VM launches, publish the golden image, build T3, issue its idle-detector bearer, and install the machine CLI plus idle timer.

T3 runs from the checked-out fork with:

```text
node apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 3773
```

It uses the custom `t3code-fork.service` user unit with lingering enabled. The bootstrap never runs `t3 service install`.

## Lane installation

Lane publishes Linux x86_64 release binaries through its official installer at `https://lane.lukeed.com`. The golden phase installs that release into `/usr/local/bin`. If the release channel is unavailable, it explicitly installs Cargo and builds `https://github.com/lukeed/lane` with `cargo install --git ... --locked`. Lane requires Rust 1.85 or newer when built from source.

## Machine CLI

Build the host artifacts with `pnpm build`. The bootstrap installs `dist/machines.mjs` as `cloudbox-machines`.

```text
cloudbox-machines list
cloudbox-machines create <thread-id> [--vm]
cloudbox-machines start|stop|destroy <name>
cloudbox-machines exec <name> --user 1000 --cwd /home/dev [--tty] -- <argv...>
cloudbox-machines snapshot <name> <snapshot-name>
cloudbox-machines archive <name>
cloudbox-machines restore <name>
```

Create names instances `thread-<thread-id>` and rejects values that cannot form a valid Incus name. Archives are written to `/tank/archive/<name>.tar.zst`. Archive destroys the instance only after a successful export.
