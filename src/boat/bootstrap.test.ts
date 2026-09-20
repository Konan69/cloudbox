import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import type { BoatCloudboxConfig } from "../config.ts";
import { BOAT_HOST_PORT, BOAT_T3_PORT, renderBoatBootstrap } from "./bootstrap.ts";

const config: BoatCloudboxConfig = {
  provider: "boat",
  name: "dev",
  boat: { type: "default", ttlSeconds: 7200, environment: "base" },
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: {
    repoUrl: "https://github.com/example/t3code.git",
    branch: "main",
    settingsParity: { enabled: true, keybindings: true },
  },
  identity: { paths: ["~/.pi/agent/settings.json"], excludes: ["sessions/"], maxTransferMb: 300 },
  repos: [],
  boxUser: "user",
};

describe("renderBoatBootstrap", () => {
  it("renders an idempotent source build and persistent user services", () => {
    const script = renderBoatBootstrap(config);

    expect(script).toContain(`readonly T3_PORT=${String(BOAT_T3_PORT)}`);
    expect(script).toContain(`readonly HOST_PORT=${String(BOAT_HOST_PORT)}`);
    expect(script).toContain('git clone --branch "$BRANCH" --single-branch');
    expect(script).toContain('"$VP_BIN" install --frozen-lockfile');
    expect(script).toContain('"$VP_BIN" run --filter t3 build');
    expect(script).toContain("t3code-fork.service");
    expect(script).toContain("sudo loginctl enable-linger user");
    expect(script).toContain("--host 127.0.0.1 --port $T3_PORT");
    expect(script).toContain("TCP-LISTEN:$HOST_PORT,bind=0.0.0.0");
    expect(script).not.toContain("t3 service install");

    const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
