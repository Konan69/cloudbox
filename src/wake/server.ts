import { createServer } from "node:http";

import { makeCloudRunGcpClient, makeGcsRateLimiter } from "./gcpRuntime.ts";
import { makeWakeHandler } from "./handler.ts";

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

const project = requiredEnv("GCP_PROJECT");
const zone = requiredEnv("GCP_ZONE");
const instance = requiredEnv("GCE_INSTANCE");
const cloudboxName = requiredEnv("CLOUDBOX_NAME");
const wakeSecret = requiredEnv("WAKE_SECRET");
const rateLimitBucket = requiredEnv("RATE_LIMIT_BUCKET");
const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("Invalid PORT");

const handler = makeWakeHandler({
  expectedName: cloudboxName,
  bearerSecret: wakeSecret,
  gcp: makeCloudRunGcpClient({ project, zone, instance }),
  rateLimiter: makeGcsRateLimiter(rateLimitBucket),
  log: (entry) => console.info("cloudbox wake", entry),
});

createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${incoming.headers.host ?? "localhost"}`;
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method: incoming.method ?? "GET",
      headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(",") : value] as const]),
    });
    const response = await handler(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (cause) {
    console.error("cloudbox wake request crashed", { error: String(cause) });
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
}).listen(port, "0.0.0.0", () => {
  console.info("cloudbox wake service listening", { port });
});
