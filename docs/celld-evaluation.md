# celld evaluation (2026-08-29, celld v0.4.0)

**celld** ([github.com/denoland/celld](https://github.com/denoland/celld), [celld.dev](https://celld.dev)) is
Deno's self-hosted, distributed Durable Objects runtime: one daemon per node embeds V8 and runs
Wrangler bundles; a *cell* is a named Worker/Durable Object with its own SQLite database, replicated
to an S3/GCS/Azure bucket that is also the only coordination point (no control plane). Cells
hibernate to the bucket when idle. Releases: v0.1.0 (Aug 5) → v0.3.0 (Aug 20: write-behind log, D1,
cron, Azure) → **v0.4.0 (Aug 28: KV / Queues / Workflows / R2 bindings, `celld dev`, in-place
deployment adoption, EKS pod identity)**.

## What it can and cannot run (from the compatibility docs)

- Runs: module Workers, Durable Objects (partial: RPC single-method across isolates), alarms,
  hibernatable WebSockets, Queues (single writer, one consumer), KV, D1, Workflows, R2 (partial),
  cron, Wasm, static assets, service bindings, `fetch()` to arbitrary hosts.
- Does **not** run: TCP sockets (`connect()` is an inert stub), Hyperdrive, Cache API, Workers AI,
  Vectorize, Browser Rendering, Email, HTMLRewriter; Node compat is limited to a few `node:` modules.
- Never runs: processes, containers, shells, git, Docker — it is an isolate runtime with a 128 MB
  default heap per isolate.
- Operations: does not terminate TLS; peer traffic is plaintext on a private network; one fleet =
  one application; Linux x86-64/ARM64 and Apple Silicon binaries.

## Fit against cloudbox, piece by piece

| Cloudbox piece | Needs | celld verdict |
| --- | --- | --- |
| Thread machines (agents, workspaces) | processes, filesystem, git, Docker, the agent CLIs | **No.** Isolates cannot host Codex/pi/Claude/OpenCode or a checkout. incus containers on ZFS stay. |
| T3 server | Node + SQLite + child processes | **No.** Not a Worker. |
| Wake service | tiny HTTP endpoint that calls the GCE API and rate-limits | **Possible but worse.** Needs an always-on celld node plus TLS/ingress in front (celld has neither); Cloud Run scales to zero and already works. |
| T3 Connect relay (self-hosting `infra/relay`) | Workers + Durable Objects + Queues **+ Hyperdrive → PlanetScale Postgres + Cloudflare Tunnel API + Cloudflare DNS API** + Clerk + APNs | **Not without a rewrite.** The runtime half fits (DOs, Queues), but Hyperdrive and TCP sockets are unsupported, and managed endpoints are Cloudflare *account* services (tunnels, DNS zone) that a runtime swap does not replace. Relay-side wake (design Plan A) therefore does not become cheaper via celld. |
| Per-agent durable state (memory, inbox, schedule) for an agent fleet | exactly what a cell is | **Yes — but that is a different product** (Harnessy/Jarvis territory), not the dev box. |

## Decision

celld is validated as real and well-built, and **not used** in cloudbox. Revisit if any of these
becomes true: celld adds process/container execution (would compete with incus for machines);
celld adds TCP sockets or a Hyperdrive equivalent *and* dev decides to self-host the relay with
his own ingress instead of Cloudflare tunnels; or the agent-fleet product needs per-agent durable
objects (then celld on the always-on side, not on the sleeping host).

Sources: celld README, [docs index](https://celld.dev/docs/), [Cloudflare compatibility](https://celld.dev/docs/cloudflare-compat),
[Limitations](https://celld.dev/docs/limitations), [GitHub releases](https://github.com/denoland/celld/releases).
