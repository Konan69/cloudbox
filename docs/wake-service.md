# GCP Cloud Run wake service

The GCP stack deploys an authenticated Cloud Run service in the same project and region as the VM:

```text
POST <wakeUrl>/wake/<cloudbox name>
Authorization: Bearer <wakeSecret>
```

A running VM returns `200 {"state":"running"}`. A suspended or terminated VM receives `instances.resume` or `instances.start` and returns `202 {"state":"resuming"}`. The service logs every accepted, rejected, coalesced, and failed wake without logging the bearer.

## Build and deployment path

Cloud Run Admin API v2 services ultimately run a container image. Cloudbox uses the stable, explicit API path rather than the preview direct-source runtime:

1. `pnpm build:wake` bundles `src/wake/server.ts` into the self-contained `dist/wake-service.mjs`.
2. The stack creates a deterministic `.tar.gz` containing that bundle and a Node 24 Dockerfile.
3. A custom `GcpStorageObject` uploads the archive to the stack-owned source bucket.
4. A custom `GcpCloudBuild` submits `projects.locations.builds.create` and polls its long-running operation. Docker builds and pushes a content-addressed tag to the stack-owned Artifact Registry repository.
5. A custom `GcpCloudRunService` creates or updates the Cloud Run Admin API v2 service with that image.

No `gcloud`, Wrangler, external registry, or second Alchemy provider is used. Google also offers a preview Cloud Run `sourceCode.cloudStorageSource` no-build API, but this stack deliberately uses the stable Cloud Build plus Artifact Registry flow.

## Runtime identity and secrets

The Cloud Run revision runs as:

```text
cloudbox-wake@<project>.iam.gserviceaccount.com
```

The service obtains short-lived OAuth access tokens from the Cloud Run metadata server. The stack never creates, downloads, stores, or exports a service-account key.

`WAKE_SECRET` is generated once by Alchemy, written to Secret Manager as a secret version, and injected into Cloud Run with a secret environment-value reference. The service account receives `roles/secretmanager.secretAccessor` only on that secret. The client bearer is deliberately returned as the `wakeSecret` stack output; protect `.alchemy/state/` and deploy logs.

## Persistent 60-second coalescing

A dedicated GCS bucket stores one object at `wake-rate/<name>`. Each claim uses GCS generation preconditions:

- create uses `ifGenerationMatch=0`;
- update uses the observed object generation;
- HTTP 412 means another request won the race and is returned as a coalesced `202`.

This makes the one-resume-per-60-seconds decision survive cold starts and remain atomic across concurrent Cloud Run instances. The runtime service account receives `roles/storage.objectAdmin` only on this dedicated bucket.

## APIs

The stack enables these APIs with custom `GcpProjectService` resources:

```text
run.googleapis.com
cloudbuild.googleapis.com
artifactregistry.googleapis.com
secretmanager.googleapis.com
storage.googleapis.com
```

`serviceusage.googleapis.com` must already be enabled so the stack can enable the others.

## IAM required to deploy

The ADC principal needs these project roles, or equivalent custom permissions:

```text
roles/compute.instanceAdmin.v1
roles/iam.roleAdmin
roles/iam.serviceAccountAdmin
roles/iam.serviceAccountUser
roles/serviceusage.serviceUsageAdmin
roles/storage.admin
roles/artifactregistry.admin
roles/cloudbuild.builds.editor
roles/secretmanager.admin
roles/run.admin
```

The deployer also needs `iam.serviceAccounts.actAs` on `cloudbox-wake` when Cloud Run attaches that service identity.

Cloud Build's default build identity must be able to read the source object, run builds, write build logs, and push to the same-project repository. Grant the project's selected default Cloud Build service account `roles/cloudbuild.builds.builder` if organization policy no longer grants that role automatically. Google may select either the Compute Engine default service account or the legacy Cloud Build service account; check the project's Cloud Build default-service-account setting before the first deploy.

## Instance IAM scope

The project custom role contains:

```text
compute.instances.get
compute.instances.resume
compute.instances.start
```

GCE labels are not IAM Conditions attributes. The provider first fetches the VM and refuses reconciliation unless `labels.cloudbox == <name>`, then attaches this role to that exact VM's instance-level IAM policy. `compute.instances.start` is required for the endpoint's documented `TERMINATED` behavior.

## Stack outputs

| Output | Client use |
|---|---|
| `wakeUrl` | Set as `CLOUDBOX_WAKE_URL`. |
| `wakeSecret` | Set as `CLOUDBOX_WAKE_SECRET`. Sensitive. |
| `wakeClientUrlEnv` | Literal `CLOUDBOX_WAKE_URL`. |
| `wakeClientSecretEnv` | Literal `CLOUDBOX_WAKE_SECRET`. |
| `wakeServiceAccount` | Operational output; clients do not need it. |

Test the same endpoint used by the fork:

```bash
export CLOUDBOX_WAKE_URL='<wakeUrl output>'
export CLOUDBOX_WAKE_SECRET='<wakeSecret output>'
pnpm cloudbox wake --via-service
```

## Assumptions

- One Cloudbox is deployed per GCP project because the service-account ID and Artifact Registry repository are fixed as `cloudbox-wake`.
- The configured zone's parent region supports Cloud Run, Cloud Build regional builds, and Artifact Registry.
- Project policy permits `allUsers` to receive `roles/run.invoker`; application-level bearer authentication remains mandatory.
