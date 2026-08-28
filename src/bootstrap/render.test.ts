import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CloudboxConfig } from "../config.ts";
import { renderBootstrap, renderUserData } from "./render.ts";

const config = Schema.decodeUnknownSync(CloudboxConfig)({
  name: "dev",
  region: "us-east-1",
  instanceType: "m7i.4xlarge",
  diskGb: 300,
  sshCidr: "203.0.113.10/32",
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: {
    repoUrl: "https://github.com/dev-mualim/t3code.git",
    branch: "main",
    githubToken: "CLOUDBOX_GITHUB_TOKEN",
  },
  identity: { paths: ["~/.pi/agent"], excludes: ["sessions/"] },
  boxUser: "dev",
});

describe("renderBootstrap", () => {
  it("renders the idempotent headless bootstrap", () => {
    const script = renderBootstrap({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      githubToken: "github-secret-value",
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

  it("fits the compressed wrapper inside EC2's 16 KiB user-data limit", () => {
    const userData = renderUserData({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      githubToken: "github-secret-value",
      idleBundle: "console.log('idle')",
    });

    expect(Buffer.byteLength(userData, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(userData).toContain("gzip --decompress");
  });

  it("does not place clone credentials or SSH keys in clear text", () => {
    const script = renderBootstrap({
      config,
      sshPublicKey: "ssh-ed25519 AAAATEST laptop",
      githubToken: "github-secret-value",
      idleBundle: "idle-bundle",
    });

    expect(script).not.toContain("github-secret-value");
    expect(script).not.toContain("ssh-ed25519 AAAATEST laptop");
  });
});
