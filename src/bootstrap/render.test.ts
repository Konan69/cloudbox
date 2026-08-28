import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { IdleConfig } from "../box/idleConfig.ts";
import { CloudboxConfig } from "../config.ts";
import { renderBootstrap, renderUserData } from "./render.ts";

const config = Schema.decodeUnknownSync(CloudboxConfig)({
  provider: "aws",
  name: "dev",
  region: "us-east-1",
  instanceType: "m7i.4xlarge",
  diskGb: 300,
  sshCidr: "203.0.113.10/32",
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: {
    repoUrl: "https://github.com/example/t3code.git",
    branch: "main",
  },
  identity: {
    paths: ["~/.pi/agent/settings.json"],
    excludes: ["sessions/"],
    maxTransferMb: 300,
  },
  boxUser: "dev",
});

describe("renderBootstrap", () => {
  it("renders the idempotent headless bootstrap", () => {
    const script = renderBootstrap({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      idleBundle: "console.log('idle')",
    });

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("/var/lib/cloudbox/bootstrapped");
    expect(script).toContain("vp install --frozen-lockfile");
    expect(script).toContain("vp run --filter t3 build");
    expect(script).toContain("apps/server/dist/bin.mjs serve");
    expect(script).toContain("cloudbox-idle.timer");
    expect(script).toContain("@anthropic-ai/claude-code@2.1.246");
    expect(script).toContain("@openai/codex@0.149.0");
    expect(script).toContain("@earendil-works/pi-coding-agent@0.84.2");
    expect(script).toContain("opencode-ai@1.18.21");
  });

  it("renders an AWS config that decodes with the idle schema", () => {
    const script = renderBootstrap({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      idleBundle: "console.log('idle')",
    });
    const encodedConfig =
      /printf '%s' '([^']+)' \| base64 --decode > \/etc\/cloudbox\/config\.json/.exec(
        script,
      )?.[1];

    expect(encodedConfig).toBeDefined();
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(IdleConfig))(
        Buffer.from(encodedConfig ?? "", "base64").toString("utf8"),
      ),
    ).toEqual({
      provider: { kind: "aws", name: "dev", region: "us-east-1" },
      idleMinutes: 30,
      t3Port: 3773,
      t3Activity: { kind: "tcp" },
      checkIncus: false,
    });
  });

  it("fits the compressed wrapper inside EC2's 16 KiB user-data limit", () => {
    const userData = renderUserData({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      idleBundle: "console.log('idle')",
    });

    expect(Buffer.byteLength(userData, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(userData).toContain("gzip --decompress");
  });

  it("clones the public fork without credentials", () => {
    const script = renderBootstrap({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      idleBundle: "idle-bundle",
    });

    expect(script).toContain("https://github.com/example/t3code.git");
    expect(script).not.toContain("GIT_ASKPASS");
    expect(script).not.toContain("CLOUDBOX_CLONE_TOKEN");
    expect(script).not.toContain("ssh-ed25519 AAAATEST laptop");
  });
});
