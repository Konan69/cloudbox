# Verification and bootstrap testing

## Local bootstrap check

```bash
pnpm check:bootstrap
```

This renders `cloudbox.example.json` with inert SSH and idle-bundle inputs, then runs `bash -n` and `/usr/bin/shellcheck --severity=warning`. Missing ShellCheck is an error; install it with `sudo apt-get install shellcheck`.

The local verification aggregate is:

```bash
pnpm verify
```

It runs typechecking, tests, and the static bootstrap check. It does not run Docker, install host packages, or contact a cloud provider.

## Remote acceptance

```bash
node dist/cli.mjs verify --host 203.0.113.42
node dist/cli.mjs verify --host 203.0.113.42 --expect-vm
node dist/cli.mjs verify --host 203.0.113.42 --json
node dist/cli.mjs verify-sleep --timeout 1800
node dist/cli.mjs verify-idle --timeout 1800
```

`--json` is optional; the default output is a table. `--timeout` is seconds. `verify-idle` requires a timeout greater than `(idleMinutes + 5) * 60`. Every verification command exits non-zero when a check fails. SSH uses `boxUser@host` and derives the private key by removing `.pub` from `sshPublicKeyPath`; the configured path must end in `.pub`.
