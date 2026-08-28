# Relay wake-on-connect design reconnaissance

**Repository snapshot:** upstream T3 Code at `2f4dcc07` (read-only review, 2026-08-28).

## Decision

For dev’s single-owner fork, implement **B: client-side, explicit one-shot wake intent backed by a small authenticated GCP wake service**.

Do **not** wake on every ordinary reconnect. T3 starts supervisors for all persisted targets and those supervisors retry forever with delays of 3, 4, 8, then 16 seconds capped (`packages/client-runtime/src/connection/registry.ts:247-262`, `packages/client-runtime/src/connection/registry.ts:351-354`, `packages/client-runtime/src/connection/supervisor.ts:32-33`, `packages/client-runtime/src/connection/supervisor.ts:732-751`). If every retry resumed the VM, dev’s idle suspension would immediately cause a reconnect, which would resume it again. The safe trigger is a **one-shot user intent** armed when the user selects/opens that environment or foregrounds the app while it is selected. Background retries may connect after the wake, but may not initiate another wake.

Design A is the best upstream product architecture, because it keeps wake credentials and rate limits in the authenticated relay. It is not the best first deployment for dev: `relay.t3.codes` would need to ship the feature, or dev would have to operate a full relay stack. Design C avoids T3 changes but either wakes for unauthenticated traffic or becomes a second authenticated proxy in the application data path.

---

## 1. Current system: what the relay knows

### 1.1 Control plane and data plane

The relay is a control plane. It links environments, provisions managed endpoints, issues short-lived credentials, and persists relay state (`infra/relay/README.md:19-25`). It is intentionally not in the normal application traffic path; after setup, traffic uses the managed Cloudflare tunnel hostname (`infra/relay/README.md:10-12`, `docs/internals/remote.md:145-149`).

```text
client
  │  Clerk token → relay DPoP token
  │  POST /v1/environments/:id/connect
  ▼
relay Worker ──POST signed mint request──► managed tunnel hostname
                                               │
                                               ▼
                                       cloudflared → T3 server

then:
client ──HTTP/WSS + environment credential──► managed tunnel hostname
```

The managed endpoint is therefore down when the VM and `cloudflared` are suspended, even though the relay Worker and its database remain available.

### 1.2 Environment linking and managed endpoint registration

The host’s startup reconciliation does the following:

1. It requests a link challenge from `/v1/client/environment-link-challenges`.
2. It signs an environment proof containing its descriptor, environment public key, local loopback origin, endpoint kind, and requested scopes.
3. It POSTs that proof to `/v1/client/environment-links`.
4. It applies the relay-returned `endpointRuntime` locally (`apps/server/src/cloud/http.ts:540-616`).

The relay verifies the proof and capability scope. For a managed link it provisions a managed endpoint, persists the link, and creates the environment credential (`infra/relay/src/environments/EnvironmentLinker.ts:95-103`, `infra/relay/src/environments/EnvironmentLinker.ts:311-339`). Provisioning:

- reserves a `(userId, environmentId)` allocation;
- finds or creates a Cloudflare tunnel;
- records the tunnel ID;
- configures ingress to the loopback T3 origin;
- creates/repairs DNS;
- gets the connector token;
- marks the allocation ready (`infra/relay/src/environments/ManagedEndpointProvider.ts:666-693`, `infra/relay/src/environments/ManagedEndpointProvider.ts:721-827`, `infra/relay/src/environments/ManagedEndpointProvider.ts:849-853`).

The host persists that runtime config and starts `cloudflared tunnel run` with `TUNNEL_TOKEN`. The local runtime supervises the process and restarts it after exit (`apps/server/src/cloud/ManagedEndpointRuntime.ts:105-139`, `apps/server/src/cloud/ManagedEndpointRuntime.ts:229-233`, `apps/server/src/cloud/ManagedEndpointRuntime.ts:278-302`). The binary resolver/installer is separate shared host code; it currently pins cloudflared `2026.5.2` (`packages/shared/src/relayClient.ts:22`, `packages/shared/src/relayClient.ts:126-135`, `packages/shared/src/relayClient.ts:475-476`).

CLI-desired managed links are reconciled at server startup with exponential retry for up to ten minutes (`apps/server/src/server.ts:574-628`).

### 1.3 Tunnel status and heartbeats

The relay does **not** have a live tunnel-presence heartbeat from the host.

It has two durable facts:

- the user/environment link and advertised endpoint;
- the allocation’s hostname, tunnel ID, DNS ID, and `readyAt` provisioning marker (`infra/relay/src/persistence/schema.ts:62-81`, `infra/relay/src/persistence/schema.ts:86-102`).

`readyAt` means that provisioning completed. It does not mean a connector is currently attached. The host only logs locally when cloudflared prints “Registered tunnel connection” (`apps/server/src/cloud/ManagedEndpointRuntime.ts:71-73`, `apps/server/src/cloud/ManagedEndpointRuntime.ts:168-170`). The release path deliberately leaves a stale allocation so an offline environment continues to produce an offline health result rather than an authorization failure (`infra/relay/src/environments/ManagedEndpointProvider.ts:596-599`).

“Online” is determined by an **on-demand active probe**, not a heartbeat. `POST /v1/environments/:environmentId/status` sends a signed health request through the managed endpoint. A timeout or transport failure returns HTTP 200 with `status: "offline"`, `checkedAt`, an error, and a trace ID; a verified signed response returns `status: "online"` and the descriptor (`infra/relay/src/environments/EnvironmentConnector.ts:395-474`, `infra/relay/src/environments/EnvironmentConnector.ts:486-536`, `packages/contracts/src/relay.ts:746-755`). Client discovery invokes that status route during refresh and records `online` or `offline` (`packages/client-runtime/src/relay/discovery.ts:150-189`, `packages/client-runtime/src/relay/discovery.ts:204-282`). There is no periodic environment heartbeat route or `lastSeenAt` field in the relay schema.

### 1.4 Durable per-environment state

There is no Durable Object in `infra/relay`. Durable state is in PlanetScale through Hyperdrive:

- `relay_environment_links`, primary key `(userId, environmentId)`;
- `relay_managed_endpoint_allocations`, primary key `(userId, environmentId)`;
- DPoP replay records, primary key `(thumbprint, jti)` (`infra/relay/src/persistence/schema.ts:62-102`, `infra/relay/src/persistence/schema.ts:178-189`).

The deployed stack creates PlanetScale and Hyperdrive resources (`infra/relay/alchemy.run.ts:27-38`, `infra/relay/src/db.ts:49-85`). A wake hook can therefore live in either:

- optional columns on `relay_environment_links`; or
- preferably a separate `relay_environment_wake_hooks` row keyed by `(userId, environmentId)`.

A separate row keeps encrypted secret material and wake-rate state out of ordinary environment listing. No secret should be returned in `RelayClientEnvironmentRecord`.

### 1.5 What happens when a client connects to a suspended environment

The connection route is:

```text
POST /v1/environments/:environmentId/connect
```

It is a DPoP-authenticated route (`packages/contracts/src/relay.ts:1022-1032`). The Worker obtains the authenticated `userId`, verifies the DPoP proof/key binding, and calls `EnvironmentConnector.connect` (`infra/relay/src/http/Api.ts:758-773`). The connector concurrently loads the requesting user’s link and managed allocation, then sends `t3MintCredential` through the managed endpoint (`infra/relay/src/environments/EnvironmentConnector.ts:541-558`, `infra/relay/src/environments/EnvironmentConnector.ts:625-643`). It does not call `/status` first.

For a suspended VM:

- a fast Cloudflare/tunnel failure becomes typed HTTP **502** `RelayEnvironmentEndpointUnavailableError`;
- the declared endpoint timeout is typed HTTP **504** `RelayEnvironmentEndpointTimedOutError` (`infra/relay/src/http/Api.ts:787-801`, `packages/contracts/src/relay.ts:405-425`);
- however, the Worker’s global request deadline is 9 seconds, while the connector and client request timeouts are each 10 seconds. A truly stalled request can therefore be cut off first by the global untyped 504 body (`infra/relay/src/http/Api.ts:157-189`, `infra/relay/src/environments/EnvironmentConnector.ts:129`, `packages/client-runtime/src/relay/managedRelay.ts:222`, `packages/client-runtime/src/relay/managedRelay.ts:331-347`).

Client-runtime maps typed 502 to transient `endpoint-unavailable`, typed 504 to transient `timeout`, and an untyped managed-relay failure to transient `relay-unavailable` (`packages/client-runtime/src/connection/errors.ts:54-70`, `packages/client-runtime/src/connection/errors.ts:77-95`). The supervisor retries transient errors indefinitely using 3/4/8/16-second backoff; blocked auth/configuration errors wait for an explicit signal (`packages/client-runtime/src/connection/supervisor.ts:703-751`). A complete connection attempt is separately capped at 15 seconds (`packages/client-runtime/src/connection/supervisor.ts:33`, `packages/client-runtime/src/connection/supervisor.ts:516-537`).

### 1.6 Desktop/mobile connection behavior that matters

`RelayConnectionTarget` currently contains only `environmentId` and `label` (`packages/client-runtime/src/connection/model.ts:4-7`, `packages/client-runtime/src/connection/model.ts:26-31`). Persisted targets are stored directly in the connection catalog document (`packages/client-runtime/src/platform/storageDocument.ts:13-25`).

Both web/desktop and mobile construct this minimal target when the user adds a cloud environment (`apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx:66-82`, `apps/mobile/src/features/connection/useConnectionController.ts:75-85`). Desktop wraps the web surface, so the web registration path is the desktop UI touchpoint.

Registration immediately creates a supervisor and calls `supervisor.connect`; app startup acquires supervisors for all persisted targets (`packages/client-runtime/src/connection/registry.ts:247-262`, `packages/client-runtime/src/connection/registry.ts:351-354`, `packages/client-runtime/src/connection/registry.ts:389-405`). This is why “ordinary connect means wake” is unsafe: an app launch, a background retry, or an involuntary socket close is not necessarily fresh user intent.

---

## 2. Candidate designs

| Design | T3 relay change | dev fork change | External service | Main advantage | Main problem |
|---|---:|---:|---:|---|---|
| **A. Relay wake hook** | Yes | Small client intent change | GCP wake webhook | Best centralized auth, secrets, coalescing | Requires upstream deploy or self-hosted relay |
| **B. Client wake** | No | Yes | GCP wake endpoint | Smallest deployable scope for dev | Fork owns metadata/auth and intent semantics |
| **C. Doorbell proxy** | No | None or small auth header change | Always-on Worker proxy + GCP wake | Independent of T3 release cycle | Becomes data-plane proxy; hard to authenticate before host wakes |

### A. Relay-side wake hook

#### Shape

Add an optional logical wake hook to the environment link:

```ts
type RelayEnvironmentWakeHook = {
  url: string;                  // HTTPS only
  encryptedSecret: string;      // never returned to clients
  minIntervalSeconds: number;   // e.g. 300
  graceSeconds: number;         // e.g. 120
  lastRequestedAt: string | null;
  leaseUntil: string | null;
};
```

A client connect carrying a **one-shot `wakeIntent`** would:

1. attempt the existing mint request;
2. on endpoint-unavailable, atomically claim the wake lease;
3. POST a timestamped HMAC request to the hook;
4. coalesce concurrent clients behind the same lease;
5. retry health/mint every 1–2 seconds;
6. return the normal connect response once online, or a typed `waking_timed_out` response after **N = 35 seconds**.

Thirty-five seconds covers the observed ~14-second GCE resume plus cloudflared/T3 reconnection without making a failed request unbounded.

#### Required tree touchpoints

1. **Contracts:** add hook registration fields, `wakeIntent`, and wake-specific typed errors in `packages/contracts/src/relay.ts`. The current connect request/response are at `packages/contracts/src/relay.ts:634-651` and `packages/contracts/src/relay.ts:735-755`.
2. **Persistence:** add `relayEnvironmentWakeHooks` and a migration beside `infra/relay/src/persistence/schema.ts:62-102`.
3. **Link authorization:** include wake capability in the environment-signed link proof and challenge; validate it in `infra/relay/src/environments/EnvironmentLinker.ts:95-103` and persist only after proof verification.
4. **Wake service:** add `infra/relay/src/environments/EnvironmentWakeHooks.ts` with atomic lease/rate-limit operations and a no-redirect HTTPS webhook client.
5. **Connector:** wrap the current direct mint path at `infra/relay/src/environments/EnvironmentConnector.ts:541-669` with wake/coalesce/poll behavior.
6. **Worker deadlines:** the existing 9-second global deadline, 10-second managed-relay timeout, and 15-second supervisor establishment timeout cannot hold a 35-second wake (`infra/relay/src/http/Api.ts:167-189`, `packages/client-runtime/src/relay/managedRelay.ts:331-347`, `packages/client-runtime/src/connection/supervisor.ts:32-33`). Add route-specific deadlines rather than increasing every relay request.
7. **Client intent:** add one-shot wake intent to shared client-runtime. Never infer it from every call to `connectEnvironment` in `packages/client-runtime/src/connection/resolver.ts:141-184`.

#### Ownership and deployment

The route already authenticates a DPoP-bound client and resolves the link by that authenticated `userId` (`infra/relay/src/http/Api.ts:763-773`, `infra/relay/src/environments/EnvironmentLinks.ts:344-363`). The hook should be keyed by the same `(userId, environmentId)` and accepted only when included in an environment-signed link proof. Thus an arbitrary client cannot attach a webhook to someone else’s environment.

This design must be deployed by T3 to `relay.t3.codes`. A fork cannot add a server-side feature to the hosted relay. Until an upstream PR lands, dev must point server, web/desktop, and mobile builds at a self-hosted relay; relay URL selection is already configurable through `T3CODE_RELAY_URL`/build config (`apps/server/src/cloud/publicConfig.ts:48-101`, `apps/mobile/app.config.ts:348`, `apps/web/src/cloud/publicConfig.ts:46-47`).

#### Assessment

- **Security:** strongest.
- **Product fit:** strongest upstream design.
- **Implementation:** about **1,200–1,800 changed LOC including tests/migration**, 5–7 commits.
- **Risk:** medium-high, mostly timeout behavior, SSRF defense, encrypted secret lifecycle, and retry coalescing.
- **dev fit now:** poor unless self-hosting is already desired.

### B. Client-side wake in dev’s fork

#### Shape

Extend the locally persisted relay target with non-secret sleep metadata:

```ts
type WakePolicy = {
  endpoint: string;
  mode: "explicit-intent";
  resumeGraceSeconds: number;
};
```

The wake endpoint is not obtained from `relay.t3.codes`; it is local fork configuration attached to dev’s environment. No GCP credential or static wake secret is stored in the app. The app uses its existing Clerk token plus its existing device DPoP key to authenticate a wake request. `ManagedRelayDpopSigner` already exposes a device key thumbprint and proof creation with an optional access token hash (`packages/client-runtime/src/relay/managedRelay.ts:48-52`, `packages/client-runtime/src/relay/managedRelay.ts:212-220`).

Add a one-shot `WakeIntentStore`:

```text
user selects/opens dev env
  → arm WakeIntentStore[environmentId]
  → retryNow(environmentId)
  → resolver consumes intent exactly once
  → POST authenticated wake request
  → continue normal relay connect
  → ordinary supervisor retries do not wake again
```

The first normal relay connect may still fail while the VM resumes. Existing retries occur around 3, 7, and 15 seconds, so the attempt near 15 seconds should normally reach the resumed tunnel without holding any Worker request open (`packages/client-runtime/src/connection/supervisor.ts:32`, `packages/client-runtime/src/connection/supervisor.ts:732-751`).

#### Required tree touchpoints

1. `packages/client-runtime/src/connection/model.ts`: optional `wakePolicy` on `RelayConnectionTarget`.
2. `packages/client-runtime/src/platform/storageDocument.ts`: catalog schema migration from v1; the current document stores targets directly (`packages/client-runtime/src/platform/storageDocument.ts:13-25`).
3. New `packages/client-runtime/src/connection/wakeIntent.ts`: atomically arm/consume intent.
4. New `packages/client-runtime/src/connection/wakeEndpoint.ts`: Clerk + DPoP authenticated POST, 5-second timeout, no retries inside this client.
5. `packages/client-runtime/src/connection/resolver.ts:141-184`: consume the one-shot intent before the existing relay bootstrap call.
6. `packages/client-runtime/src/connection/registry.ts:625-629`: pair `armWake` with existing `retryNow` so selection interrupts backoff.
7. Desktop/web surface: arm on selecting/opening the active dev environment; registration currently occurs in `apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx:72-97`.
8. Mobile surface: arm on selection/foreground for the selected dev environment; connection commands are centralized at `apps/mobile/src/features/connection/useConnectionController.ts:39-85`.

#### Assessment

- **Security:** good if the GCP endpoint validates Clerk audience, exact owner `sub`, and DPoP proof.
- **Product fit:** private/fork feature, not general relay behavior.
- **Implementation:** about **580–920 changed LOC including tests and GCP service**, four commits.
- **Risk:** medium. The key risk is accidentally arming wake from background auto-connect rather than explicit user intent.
- **dev fit now:** best. No relay fork or self-hosting.

### C. Always-on doorbell proxy

#### Shape

Point the app at an always-on hostname such as `dev-doorbell.example.com`. The Worker:

1. receives the first HTTP request;
2. authenticates a wake entitlement;
3. calls the GCP wake service;
4. waits/polls the underlying tunnel hostname;
5. proxies HTTP and WebSocket traffic after it is reachable.

This should be a direct bearer environment, not a hosted-relay target. Relay connect/status authorize only a relay-managed Cloudflare allocation and reject other provider kinds (`infra/relay/src/environments/EnvironmentConnector.ts:304-390`). The hosted app also does not proxy traffic itself and requires the backend to be directly reachable (`docs/internals/remote.md:104-120`).

#### Concrete external/T3 touchpoints

- Pair the stable doorbell URL as a `BearerConnectionTarget`; direct and relay targets are separate access types (`docs/internals/remote.md:51-59`).
- The Worker needs a second, non-recursive origin hostname for the actual managed tunnel.
- It must preserve method, host/audience semantics, auth headers, WebSocket upgrade, streaming, and close codes.
- If it requires a custom wake header, client-runtime still needs a change, reducing the claimed “nothing in T3” advantage.

#### Assessment

- **Security:** weak with zero client changes. Before the VM wakes, the Worker cannot ask the sleeping T3 server whether a request is authorized. A public request, scanner, or replay can cause a paid resume unless the Worker has its own independent authentication.
- **Architecture:** violates the current “relay is not in the hot path” property (`infra/relay/README.md:10-12`).
- **Implementation:** about **200–450 external LOC**, plus Cloudflare routing and WebSocket tests.
- **Risk:** medium-high: proxy correctness, recursive fetch/routing, long-lived WebSockets, and unauthenticated wake abuse.
- **dev fit:** acceptable only if the doorbell already has an authenticated client protocol; otherwise reject.

---

## 3. Security and operational requirements

### 3.1 Who may wake

The invariant is:

> A wake is accepted only from an authenticated client whose Clerk `sub` is the owner configured for this environment, with a fresh DPoP proof bound to that Clerk token.

For A, existing relay DPoP proof consumption already stores `(thumbprint, jti)` replay records (`infra/relay/src/auth/DpopProofs.ts:53-66`, `infra/relay/src/auth/DpopProofs.ts:84-118`). The relay must additionally require the authenticated user’s active environment link.

For B, the GCP endpoint validates:

- Clerk signature, issuer, audience, expiry, and exact owner `sub`;
- DPoP `typ`, ES256 signature, embedded public JWK, `htm`, normalized `htu`, `iat` within 30 seconds, unique UUID `jti`, and `ath = SHA-256(Clerk token)`;
- POST only and an exact endpoint URL.

No service-account key is shipped to desktop or mobile.

### 3.2 Replay, idempotency, and rate limiting

Use the DPoP `jti` as GCE `instances.resume?requestId=<jti>`. That gives the cloud call a stable idempotency key. Reject proofs older than 30 seconds. During that 30-second replay window, the host’s post-resume grace period prevents it from suspending again, so replay cannot create a second paid run cycle.

For A, add an atomic database lease:

```text
UPDATE relay_environment_wake_hooks
SET lease_until = now + 45s, last_requested_at = now
WHERE user_id = ? AND environment_id = ?
  AND (lease_until IS NULL OR lease_until < now)
  AND (last_requested_at IS NULL OR last_requested_at < now - 5m)
```

Concurrent connect attempts then share one wake. Store only an encrypted webhook secret. Permit HTTPS, reject redirects, block loopback/private/link-local destinations, cap response bytes, and use a 3-second webhook timeout. These controls are required because an owner-configurable URL otherwise turns the Worker into an SSRF primitive.

For B, enforce an endpoint-side per-owner minimum wake interval, preferably at an edge/Firestore rate limiter if the service may scale beyond one instance. For dev’s low-volume deployment, fresh DPoP + `requestId` + the host grace window are the minimum safe baseline.

### 3.3 Accidental-wake cost

The expensive event is not the HTTP function call; it is resuming the GCE VM and resetting its idle period. Therefore:

- never wake from status-list refresh;
- never wake from the supervisor’s automatic retry loop;
- never wake all saved environments at app launch;
- arm only the currently selected environment once;
- expose telemetry: `wake.requested`, `wake.accepted`, `wake.coalesced`, `wake.rejected`, and time-to-online.

### 3.4 Idle timer coordination

dev’s VM-side idle controller must maintain `notBeforeSuspend`.

Set it to at least **resume detected + 120 seconds** and refresh it on the first authenticated T3 HTTP/WebSocket activity. A Linux service can detect resume using a system sleep hook or a wall-clock/boot-time discontinuity. The controller must not suspend while T3/cloudflared is still reconnecting.

This grace is deliberately longer than:

- ~14 seconds to resume;
- the client’s retry around 15 seconds;
- expected cloudflared registration time.

Most importantly, only a fresh one-shot client intent can call wake. Once the grace expires and the VM suspends, background connection retries remain harmless failures until the user opens/selects the environment again.

---

## 4. Self-hosting the relay for design A

A fork cannot alter `relay.t3.codes`. Running A before upstream adoption means deploying `infra/relay` and pointing all dev builds and the host at it.

The unmodified Alchemy stack includes:

- Alchemy `2.0.0-beta.65` and Effect beta (`infra/relay/package.json:19-21`);
- a PlanetScale Postgres `PS_20` deployment with two replicas and a runtime role (`infra/relay/src/db.ts:49-73`);
- Cloudflare Hyperdrive with a 20-origin-connection limit (`infra/relay/src/db.ts:79-85`);
- a Worker, tunnel write binding, DNS write binding, queues, cron, and Axiom tracing (`infra/relay/src/worker.ts:99`, `infra/relay/src/worker.ts:118-156`, `infra/relay/src/worker.ts:241-263`);
- retained/adopted relay API and managed-endpoint DNS zones (`infra/relay/src/zone.ts:48-70`);
- Clerk and APNs credentials (`infra/relay/.env.example:12-26`).

### Estimated ownership cost

| Item | Estimate |
|---|---:|
| Initial deployment with existing Cloudflare, PlanetScale, Clerk, DNS, Apple, and Axiom accounts | **3–5 engineer-days** |
| Production hardening, secret rotation, monitoring, restore drill, release-build wiring | **another 3–5 days** |
| Ongoing upgrades/operations | **2–4 hours/month**, plus incidents |
| Minimum hosted cash baseline | roughly **$55+/month** before domains, storage, Axiom, Clerk overages, and GCE |

The cash baseline uses the current public PlanetScale PS-20 HA price (~$50/month) and Cloudflare Workers Paid minimum ($5/month); verify current regional pricing before committing:

- <https://planetscale.com/docs/postgres/pricing>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/hyperdrive/platform/pricing/>

The repository’s `replicas: 2`, queues, observability, Clerk, and APNs make this more than “deploy one Worker.” Removing notifications/APNs/Axiom can reduce cost but creates a long-lived infrastructure fork.

---

## 5. Recommended implementation plan: B

### Commit 1 — `feat(client-runtime): model sleepable relay targets`

**Scope:** 140–220 LOC including tests. **Risk:** low-medium.

- Add optional `WakePolicy` to `RelayConnectionTarget`.
- Add a catalog document v2 decoder/migration; never place a static wake secret in the target.
- Add serialization tests for old v1 documents and the new optional policy.
- Configure only dev’s environment as sleepable in the fork.

### Commit 2 — `feat(client-runtime): add one-shot wake intent`

**Scope:** 180–280 LOC including tests. **Risk:** medium.

- Add `WakeIntentStore.arm(environmentId)` and atomic `consume(environmentId)`.
- Add `wakeAndRetry(environmentId)` to the environment registry: arm, then invoke existing `retryNow`.
- Test that registration/app startup does not arm; explicit intent arms once; the first resolver attempt consumes it; later 3/4/8/16-second retries do not call wake.
- Test concurrent selection signals coalesce to one intent.

### Commit 3 — `feat(client-runtime): authenticate the GCE wake request`

**Scope:** 180–260 LOC including tests. **Risk:** medium.

- Add `WakeEndpointClient` using `CloudSession.clerkToken` and `ManagedRelayDpopSigner`.
- Use a 5-second wake-call timeout. Treat HTTP 202 (resume accepted) and 204 (already active) as success.
- In the relay resolver, call it only after consuming a wake intent, then continue the existing `connectEnvironment` path (`packages/client-runtime/src/connection/resolver.ts:141-184`).
- Do not wait 14 seconds in this request; let existing connection backoff observe tunnel recovery.

### Commit 4 — `feat(desktop-mobile): wake the selected dev environment`

**Scope:** 80–160 LOC including tests. **Risk:** low-medium.

- Desktop/web: call `wakeAndRetry` when the user opens/selects the dev environment or foregrounds the app with it selected.
- Mobile: do the same through `useConnectionController`.
- Do not arm from cloud environment discovery/status refresh.
- Suppress duplicate intent while the selected environment is already connecting or connected.

### GCP deployment — wake service and host grace

**Scope:** 100–180 LOC/IaC outside this repository. **Risk:** medium.

- Deploy one Cloud Run service/function with fixed project, zone, and instance name.
- Validate Clerk + DPoP as described below.
- Run it as a dedicated service account with only `compute.instances.resume` on the exact labelled instance.
- Add the VM-side 120-second resume grace to the idle controller.
- Log owner, DPoP `jti`, Compute operation ID, result, and latency; never log Clerk tokens or DPoP JWTs.

**Total:** approximately **680–1,100 LOC including tests and GCP code**, four repository commits plus one infrastructure deployment. Expected implementation time: **3–5 engineer-days**. Main residual risk: correctly distinguishing explicit user intent from automatic lifecycle reconnects.

---

## 6. Minimal GCP wake service (plain TypeScript)

This sketch uses a Clerk JWT plus a DPoP proof. It intentionally does not accept a static bearer secret and does not carry a service-account key. Cloud Run obtains an OAuth token from its attached service account.

```ts
import { verifyToken } from "@clerk/backend";
import { createHash, randomUUID } from "node:crypto";
import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";

const project = mustEnv("GCP_PROJECT");
const zone = mustEnv("GCP_ZONE");
const instance = mustEnv("GCE_INSTANCE");
const ownerSub = mustEnv("OWNER_CLERK_USER_ID");
const clerkSecretKey = mustEnv("CLERK_SECRET_KEY");
const clerkAudience = mustEnv("CLERK_JWT_AUDIENCE");
const publicWakeUrl = mustEnv("PUBLIC_WAKE_URL");

function mustEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function base64urlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function bearer(request: Request): string | null {
  const match = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

async function authorize(request: Request): Promise<string> {
  const token = bearer(request);
  const proof = request.headers.get("dpop");
  if (!token || !proof) throw new Response("Unauthorized", { status: 401 });

  const clerk = await verifyToken(token, {
    secretKey: clerkSecretKey,
    audience: clerkAudience,
  });
  if (clerk.sub !== ownerSub) throw new Response("Forbidden", { status: 403 });

  const header = decodeProtectedHeader(proof);
  if (header.typ?.toLowerCase() !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk) {
    throw new Response("Invalid DPoP header", { status: 401 });
  }
  const key = await importJWK(header.jwk as JWK, "ES256");
  const { payload } = await jwtVerify(proof, key, { algorithms: ["ES256"] });
  const now = Math.floor(Date.now() / 1_000);
  if (
    payload.htm !== "POST" ||
    payload.htu !== publicWakeUrl ||
    typeof payload.iat !== "number" ||
    Math.abs(now - payload.iat) > 30 ||
    typeof payload.jti !== "string" ||
    payload.ath !== base64urlSha256(token)
  ) {
    throw new Response("Invalid DPoP proof", { status: 401 });
  }
  // Compute requestId accepts a UUID. Reject rather than substituting one,
  // because substitution would discard end-to-end idempotency.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.jti)) {
    throw new Response("Invalid idempotency key", { status: 400 });
  }
  return payload.jti;
}

async function serviceAccountToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error(`metadata token failed: ${response.status}`);
  return String((await response.json() as { access_token: string }).access_token);
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    try {
      const requestId = await authorize(request);
      const accessToken = await serviceAccountToken();
      const url = new URL(
        `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}` +
        `/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}/resume`,
      );
      url.searchParams.set("requestId", requestId);

      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const operation = await response.json() as { id?: string; name?: string };
        return Response.json(
          { accepted: true, operationId: operation.id ?? operation.name ?? randomUUID() },
          { status: 202 },
        );
      }

      const body = await response.text();
      // Match the documented condition reason in production, not arbitrary 400s.
      if (response.status === 400 && /not.*suspended|conditionNotMet/iu.test(body)) {
        return new Response(null, { status: 204 });
      }
      console.error("instances.resume failed", { status: response.status, body });
      return new Response("Resume failed", { status: 502 });
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("wake handler failed", { error: String(error) });
      return new Response("Internal error", { status: 500 });
    }
  },
};
```

Production additions:

1. Handle CORS preflight for the exact desktop/web origins if the call runs in a renderer; mobile native fetch does not need browser CORS.
2. Put `CLERK_SECRET_KEY` in Secret Manager. Keep project/zone/instance fixed configuration, not request parameters.
3. Apply a request/body size limit and reject redirects at any fronting proxy.
4. Add a short edge rate limit keyed by Clerk `sub`.
5. Replace the broad “already active” regex with the exact Compute API error reason observed in a staging test.

### Least-privilege IAM

Create a custom role containing only:

```text
compute.instances.resume
```

Bind it to the Cloud Run runtime service account **on the exact GCE instance resource**, not project-wide. Keep the operational label, for example `t3-wake=true`, and have deployment verify it before applying the binding. Do not discover by label at runtime: listing/getting instances would require extra permissions and could resume the wrong machine after a naming error.

The runtime service account needs no downloadable key. Cloud Run’s metadata server supplies the OAuth token. Clerk verification uses the Clerk secret, which is application configuration rather than a Google IAM permission.

---

## 10-line summary

1. The relay stores environment links and Cloudflare allocation records, but no live heartbeat or connector-presence state.
2. Online/offline is an active signed health probe through the tunnel, not durable liveness.
3. A suspended VM makes `/connect` fail as endpoint-unavailable/timeout; client-runtime then retries forever at 3/4/8/16 seconds.
4. Persisted targets auto-connect at app startup, so waking on every connect would prevent idle suspension from sticking.
5. Relay-side A is the strongest upstream design, but it needs a relay deploy plus client wake-intent signaling.
6. Using A now means self-hosting the Alchemy/PlanetScale/Hyperdrive/Cloudflare/Clerk stack, roughly 6–10 setup days and $55+/month baseline.
7. Doorbell C avoids T3 changes but cannot securely authorize the first wake without becoming a second client-auth protocol and data-plane proxy.
8. Recommend B for dev: local sleep metadata, a one-shot explicit wake intent, and an authenticated GCP resume endpoint.
9. Validate Clerk owner `sub` plus fresh DPoP, use the DPoP `jti` as Compute `requestId`, and grant only `compute.instances.resume` on the exact VM.
10. Give the VM a 120-second post-resume grace; background retries must never create another wake after that one-shot intent is consumed.
