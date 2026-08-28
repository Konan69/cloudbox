# Autonomous cloud acceptance loop

Use a throwaway deployment and keep cleanup in a finalizer. No cloud access is needed for local static checks; this loop is for an authorized cloud test account.

## Run

1. Create the test config and deploy.

   ```bash
   cp cloudbox.test.example.json cloudbox.json
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm build
   pnpm deploy
   pnpm cloudbox wake
   HOST="$(pnpm --silent cloudbox status | jq -r .publicIp)"
   test -n "$HOST" && test "$HOST" != null
   ```

2. Run host and suspend acceptance.

   ```bash
   pnpm cloudbox verify --host "$HOST" --expect-vm --json | tee /tmp/cloudbox-verify.json
   pnpm cloudbox verify-sleep --timeout 1800 --json | tee /tmp/cloudbox-verify-sleep.json
   ```

3. Run the long idle test. Do not SSH, sync, or open T3 during this command.

   ```bash
   pnpm cloudbox verify-idle --timeout 1800 --json | tee /tmp/cloudbox-verify-idle.json
   ```

4. Wake once, collect evidence, then destroy even if collection fails.

   ```bash
   pnpm cloudbox wake
   HOST="$(pnpm --silent cloudbox status | jq -r .publicIp)"
   KEY="$(jq -r .sshPublicKeyPath cloudbox.json)"
   KEY="${KEY/#\~/$HOME}"
   KEY="${KEY%.pub}"
   mkdir -p /tmp/cloudbox-evidence
   ssh -i "$KEY" "dev@$HOST" \
     'sudo cat /var/log/cloudbox-bootstrap.log' \
     > /tmp/cloudbox-evidence/cloudbox-bootstrap.log
   ssh -i "$KEY" "dev@$HOST" \
     'sudo journalctl -u cloudbox-idle.service -u cloudbox-idle.timer --no-pager' \
     > /tmp/cloudbox-evidence/cloudbox-idle.journal.log
   ssh -i "$KEY" "dev@$HOST" \
     'journalctl --user -u t3code-fork.service --no-pager' \
     > /tmp/cloudbox-evidence/t3code-fork.journal.log
   pnpm destroy
   ```

If any earlier step fails, collect whatever evidence is available and still run `pnpm destroy`.

## Provider test sizes

`cloudbox.test.example.json` contains the GCP shape with `machineType: "n2-standard-8"` and a 100 GB data disk; set its project and zone. N2 is required for nested KVM.

For AWS, replace `gcp` with `region: "us-east-1"`, `instanceType: "m6i.2xlarge"`, and `diskGb: 100`, then set `provider: "aws"`. Both shapes use `idleMinutes: 10`.
