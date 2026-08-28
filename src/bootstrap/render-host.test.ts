import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";

import { HOST_AGENT_PACKAGES, renderHostBootstrap } from "./render-host.ts";

const config = {
  boxUser: "dev",
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
    expect(script).toContain("images:ubuntu/24.04 testvm --vm");
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
    const idleConfig = Buffer.from(encodedConfig ?? "", "base64").toString("utf8");
    expect(idleConfig).toContain('"idleMinutes": 45');
    expect(idleConfig).toContain('"checkIncus": true');
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
});
