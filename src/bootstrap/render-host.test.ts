import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { IdleConfig } from "../box/idleConfig.ts";
import {
  HOST_AGENT_PACKAGES,
  renderHostBootstrap,
  renderHostStartupScript,
} from "./render-host.ts";

const config = {
  boxUser: "dev",
  name: "test",
  project: "cloudbox-project",
  zone: "us-central1-a",
  zfsDataDevice: "/dev/disk/by-id/google-agent-data",
  idleMinutes: 45,
  t3Port: 3773,
  t3: {
    repoUrl: "https://github.com/example/t3code.git",
    branch: "main",
    relayUrl: "https://relay.t3.codes",
    clerkPublishableKey: "pk_live_Y2xlcmsudDMuY29kZXMk",
    clerkCliOauthClientId: "hzxSgY2cH10sDU2r",
  },
  idleBundle: "console.log('idle bundle')",
  machinesBundle: "console.log('machines bundle')",
} as const;

describe("renderHostBootstrap", () => {
  it("renders the settled host phases and interpolates config", () => {
    const script = renderHostBootstrap(config);

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("/var/log/cloudbox-bootstrap.log");
    expect(script).toContain("host-v2-$name.done");
    expect(script).toContain("/dev/disk/by-id/google-agent-data");
    expect(script).toContain("zpool create");
    expect(script).toContain("source: tank/incus");
    expect(script).toContain("incusbr0");
    expect(script).toContain("images:ubuntu/24.04/cloud testvm --vm </dev/null");
    expect(script).toContain("security.nesting=true");
    expect(script).toContain("incus publish golden-build --alias golden");
    expect(script).toContain("--rebuild");
    expect(script).toContain("https://github.com/example/t3code.git");
    expect(script).toContain("main");
    expect(script).toContain("apps/server/dist/bin.mjs serve");
    expect(script).toContain("--host 127.0.0.1 --port 3773");
    expect(script).toContain("--label idle-detector");
    const encodedConfig = /printf '%s' '([^']+)' \| base64 --decode > \/etc\/cloudbox\/config\.json/.exec(
      script,
    )?.[1];
    expect(encodedConfig).toBeDefined();
    const idleConfig = Schema.decodeUnknownSync(Schema.fromJsonString(IdleConfig))(
      Buffer.from(encodedConfig ?? "", "base64").toString("utf8"),
    );
    expect(idleConfig).toEqual({
      provider: {
        kind: "gcp",
        name: "test",
        project: "cloudbox-project",
        zone: "us-central1-a",
      },
      idleMinutes: 45,
      t3Port: 3773,
      t3Activity: {
        kind: "authenticated",
        baseDir: "/home/dev/.t3",
        tokenPath: "/home/dev/.t3/idle-detector.token",
      },
      checkIncus: true,
    });
    expect(script).not.toContain("service install");
    for (const packageName of HOST_AGENT_PACKAGES) expect(script).toContain(packageName);
  });

  it("renders valid bash", () => {
    const result = spawnSync("bash", ["-n"], {
      input: renderHostBootstrap(config),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("compresses the built bundles below GCE's metadata value limit", () => {
    const startupScript = renderHostStartupScript({
      ...config,
      idleBundle: readFileSync("dist/idle.mjs", "utf8"),
      machinesBundle: readFileSync("dist/machines.mjs", "utf8"),
    });

    expect(Buffer.byteLength(startupScript, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(startupScript).toContain("gzip --decompress");
    const result = spawnSync("bash", ["-n"], { input: startupScript, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
