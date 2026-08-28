# GCP wake service

The GCP stack deploys an authenticated Cloudflare Worker at:

```text
POST <wakeUrl>/wake/<cloudbox name>
Authorization: Bearer <wakeSecret>
```

A running VM returns `200 {"state":"running"}`. A suspended or terminated VM receives `instances.resume` or `instances.start` and returns `202 {"state":"resuming"}`. KV coalesces subsequent state-change requests for that name for 60 seconds. Every accepted, rejected, coalesced, and failed wake is written to Worker logs without logging the bearer or Google key.

## Deploy authentication

The relay reference stack uses Alchemy's Cloudflare provider login. Cloudbox uses the same provider. Alchemy stores its own OAuth credentials and does not reuse Wrangler's OAuth token. An interactive deploy can use:

```bash
pnpm alchemy login --configure
pnpm deploy
```

For CI, set:

```text
CLOUDFLARE_ACCOUNT_ID=<dev's Cloudflare account ID>
CLOUDFLARE_API_TOKEN=<account token>
```

The token must grant exactly **Workers Scripts: Edit**, **Workers KV Storage: Edit**, and **Account Settings: Read** on dev's account. Google deployment authentication remains the configured ADC or `gcp.credentials.serviceAccountJsonPath`. There are no additional deploy-time wake environment variables.

## Stack outputs and client configuration

A successful GCP deploy prints and persists these outputs:

| Output | Client use |
|---|---|
| `wakeUrl` | Set as `CLOUDBOX_WAKE_URL`. The fork calls `<wakeUrl>/wake/<name>`. |
| `wakeSecret` | Set as `CLOUDBOX_WAKE_SECRET`. This value is sensitive. |
| `wakeClientUrlEnv` | Literal output documenting `CLOUDBOX_WAKE_URL`. |
| `wakeClientSecretEnv` | Literal output documenting `CLOUDBOX_WAKE_SECRET`. |
| `wakeServiceAccount` | Operational identity; clients do not need it. |
| `wakeServiceAccountKey` | Google key resource name; clients do not need it. |

Test the same endpoint used by the fork:

```bash
export CLOUDBOX_WAKE_URL='<wakeUrl output>'
export CLOUDBOX_WAKE_SECRET='<wakeSecret output>'
pnpm cloudbox wake --via-service
```

The bearer is generated once with `Alchemy.makeRandom`, stored as a Worker `secret_text` binding, and mapped to plaintext only as a deferred stack output because the client must receive it. Protect `.alchemy/state/` and terminal/deploy logs as credentials.

## IAM scope and GCE label limitation

The stack creates:

- service account `cloudbox-wake@<project>.iam.gserviceaccount.com`;
- project custom role `cloudboxWake` with `compute.instances.get`, `compute.instances.resume`, and `compute.instances.start`;
- an instance-level IAM binding for that role on `cloudbox-<name>`.

GCE **labels cannot be read by IAM Conditions**. IAM Conditions support resource name/type/service and Resource Manager tags, while Compute Engine's `resource.labels` field belongs to organization-policy custom constraints. Cloudbox therefore does not claim a label condition that Google IAM cannot enforce. Its provider first fetches the VM and refuses reconciliation unless `labels.cloudbox == <name>`, then writes the role binding to that exact VM's IAM policy. The role exists at project scope because custom roles do, but its permissions are granted only on the one instance.

`compute.instances.start` is included because the endpoint must start a `TERMINATED` VM. A role containing only `get` and `resume` cannot implement that required behavior.

References:

- [Managing access to Compute Engine resources](https://cloud.google.com/compute/docs/access/managing-access-to-resources)
- [IAM Conditions attribute reference](https://cloud.google.com/iam/docs/conditions-attribute-reference)
- [`instances.resume` required permission](https://cloud.google.com/compute/docs/reference/rest/v1/instances/resume)

## Why the Worker has a Google key

Cloud Run can use an attached service account without a downloadable key. Cloudflare Workers cannot use that metadata-server flow, and this Worker has no trusted OIDC issuer configured for Google Workload Identity Federation. The stack therefore creates one user-managed service-account key and stores the credentials JSON only in local Alchemy state and a Worker secret binding.

Google user-managed service-account keys do not have a configurable short lifetime. Rotate instead of treating this key as short-lived:

1. Increment `gcp.wakeKeyRotation` in `cloudbox.json`.
2. Run `pnpm deploy`.

Alchemy replaces the key, updates the Worker secret, and then deletes the prior key. This is the exact rotation command:

```bash
pnpm deploy
```

Do not create or copy this key into the fork, desktop app, or mobile app. They receive only `wakeUrl` and `wakeSecret`.

## Assumptions

- One Cloudbox is deployed per GCP project because the requested service-account ID is fixed as `cloudbox-wake`.
- The Cloudflare account has a `workers.dev` subdomain enabled; no custom wake domain is configured.
- The endpoint is intentionally a private single-owner bearer service. A later multi-user product should replace the bearer with owner-bound Clerk/DPoP authorization.
- Workers KV is eventually consistent. It suppresses ordinary repeat calls; concurrent cross-region requests can still race, while Compute Engine state transitions remain idempotent in practice.
