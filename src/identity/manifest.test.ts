import { describe, expect, it } from "@effect/vitest";

import {
  deriveMachineIdentityManifest,
  machineIdentityManifestPath,
  renderMachineIdentityManifest,
} from "./manifest.ts";

const identityPaths = [
  "~/.claude/settings.json",
  "~/.claude/.credentials.json",
  "~/.claude/skills/",
  "~/.agents/skills/",
  "~/.codex/auth.json",
  "~/.codex/config.toml",
  "~/.pi/agent/auth.json",
  "~/.pi/agents/",
  "~/.local/share/opencode/auth.json",
  "~/.config/opencode/",
  "~/.config/gh/hosts.yml",
] as const;

describe("machine identity manifest", () => {
  it("derives, deduplicates, and sorts mount roots without resolving symlinks", () => {
    expect(deriveMachineIdentityManifest(identityPaths, "dev")).toEqual({
      version: 1,
      mounts: [
        {
          hostPath: "/home/dev/.agents",
          guestPath: "/home/dev/.agents",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.claude",
          guestPath: "/home/dev/.claude",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.codex",
          guestPath: "/home/dev/.codex",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.config/gh",
          guestPath: "/home/dev/.config/gh",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.config/opencode",
          guestPath: "/home/dev/.config/opencode",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.local/share/opencode",
          guestPath: "/home/dev/.local/share/opencode",
          readOnly: false,
        },
        {
          hostPath: "/home/dev/.pi",
          guestPath: "/home/dev/.pi",
          readOnly: false,
        },
      ],
    });
  });

  it("renders the versioned JSON at the user-owned host path", () => {
    const manifest = deriveMachineIdentityManifest(["~/.codex/auth.json"], "dev");

    expect(machineIdentityManifestPath("dev")).toBe(
      "/home/dev/.config/cloudbox/machine-identity.json",
    );
    expect(JSON.parse(renderMachineIdentityManifest(manifest))).toEqual(manifest);
  });
});
