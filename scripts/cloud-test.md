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
   INSTANCE="$(pnpm --silent cloudbox status | jq -r .instanceName)"
   test -n "$INSTANCE" && test "$INSTANCE" != null
   ```

2. Run host and suspend acceptance.

   ```bash
   pnpm cloudbox verify --expect-vm --json | tee /tmp/cloudbox-verify.json
   pnpm cloudbox verify-sleep --timeout 1800 --json | tee /tmp/cloudbox-verify-sleep.json
   ```

3. Run the long idle test. Do not SSH, sync, or open T3 during this command.

   ```bash
   pnpm cloudbox verify-idle --timeout 1800 --json | tee /tmp/cloudbox-verify-idle.json
   ```

4. Wake once, collect evidence, then destroy even if collection fails.

   ```bash
   pnpm cloudbox wake
   INSTANCE="$(pnpm --silent cloudbox status | jq -r .instanceName)"
   PROJECT="$(jq -r .gcp.project cloudbox.json)"
   ZONE="$(jq -r .gcp.zone cloudbox.json)"
   KEY="$(jq -r .sshPublicKeyPath cloudbox.json)"
   KEY="${KEY/#\~/$HOME}"
   KEY="${KEY%.pub}"
   SSH=(ssh -i "$KEY"
     -o "ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project $PROJECT --zone $ZONE --verbosity=warning"
     -o "UserKnownHostsFile=$HOME/.ssh/cloudbox_known_hosts"
     -o StrictHostKeyChecking=accept-new)
   mkdir -p /tmp/cloudbox-evidence
   "${SSH[@]}" "dev@$INSTANCE" \
     'sudo cat /var/log/cloudbox-bootstrap.log' \
     > /tmp/cloudbox-evidence/cloudbox-bootstrap.log
   "${SSH[@]}" "dev@$INSTANCE" \
     'sudo journalctl -u cloudbox-idle.service -u cloudbox-idle.timer --no-pager' \
     > /tmp/cloudbox-evidence/cloudbox-idle.journal.log
   "${SSH[@]}" "dev@$INSTANCE" \
     'journalctl --user -u t3code-fork.service --no-pager' \
     > /tmp/cloudbox-evidence/t3code-fork.journal.log
   pnpm destroy
   ```

If any earlier step fails, collect whatever evidence is available and still run `pnpm destroy`.

## Provider test sizes

`cloudbox.test.example.json` contains the GCP shape with `machineType: "n2-standard-8"` and a 100 GB data disk; set its project and zone. N2 is required for nested KVM.

For AWS, replace `gcp` with `aws: { "sshCidr": "<your-cidr>" }`, `region: "us-east-1"`, `instanceType: "m6i.2xlarge"`, and `diskGb: 100`, then set `provider: "aws"`. Both shapes use `idleMinutes: 10`.
