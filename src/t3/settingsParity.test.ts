import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  buildT3ParityPublishScript,
  filterPortableT3Settings,
} from "./settingsParity.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const localSettingsFixture = {
  enableLegacyTokenStreaming: true,
  enableProviderUpdateChecks: false,
  enableAgentBrowserAccess: false,
  backgroundActivity: {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: "balanced",
    overrides: {
      automaticGitFetchInterval: 90_000,
      pauseWhenOnBattery: true,
      unexpectedPath: "/home/local/background",
    },
    futureSecret: "background-secret",
  },
  automaticGitFetchInterval: 30_000,
  providerHealthRefreshInterval: 300_000,
  backgroundActivityProfile: "balanced",
  defaultThreadEnvMode: "worktree",
  newWorktreesStartFromOrigin: false,
  addProjectBaseDirectory: "/home/local/src",
  textGenerationModelSelection: {
    instanceId: "codex_work",
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "high" }],
    binaryPath: "/usr/local/bin/model-helper",
  },
  sourceControlWritingStyle: {
    mode: "custom",
    customInstructions: "Use issue IDs.",
    followChangeRequestTemplates: false,
    worktreeRoot: "/home/local/worktrees",
  },
  sourceControlWriterModelSelection: {
    instanceId: "pi",
    model: "openai-codex/gpt-5.6-sol",
  },
  providers: {
    codex: {
      enabled: true,
      binaryPath: "/home/local/bin/codex",
      homePath: "/home/local/.codex",
      shadowHomePath: "/home/local/.codex-work",
      launchArgs: "--config /home/local/codex.toml --token provider-secret",
      customModels: ["gpt-custom"],
    },
    claudeAgent: {
      enabled: true,
      binaryPath: "/opt/claude",
      homePath: "/home/local/.claude",
      autoCompactWindow: "300000",
      customModels: ["claude-custom"],
    },
    cursor: {
      enabled: true,
      binaryPath: "/opt/cursor",
      apiEndpoint: "https://cursor.example.test",
      customModels: ["cursor-custom"],
    },
    grok: { enabled: false, binaryPath: "/opt/grok", customModels: ["grok-custom"] },
    opencode: {
      enabled: true,
      binaryPath: "/opt/opencode",
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "opencode-secret",
      customModels: ["opencode-custom"],
    },
    pi: {
      enabled: true,
      binaryPath: "/home/local/bin/pi",
      defaultModel: "openai-codex/gpt-5.6-sol",
      excludedProviders: "google,openai",
      launchArgs: "--extension /home/local/private.ts",
      customModels: ["pi-custom"],
    },
  },
  providerInstances: {
    codex_work: {
      driver: "codex",
      displayName: "Codex Work",
      accentColor: "blue",
      enabled: true,
      environment: [
        { name: "API_KEY", value: "instance-secret", sensitive: true },
      ],
      config: {
        enabled: true,
        binaryPath: "/home/local/bin/codex",
        homePath: "/home/local/.codex",
        launchArgs: "--token instance-secret",
        customModels: ["work-custom"],
      },
    },
    fork: {
      driver: "futureDriver",
      displayName: "Future",
      enabled: true,
      environment: [{ name: "TOKEN", value: "future-secret", sensitive: true }],
      config: { rootPath: "/home/local/future", apiToken: "future-secret" },
    },
  },
  observability: {
    otlpTracesUrl: "https://otel.example.test/v1/traces",
    otlpMetricsUrl: "https://otel.example.test/v1/metrics",
    headersFile: "/home/local/otel-headers",
  },
  environmentId: "local-environment-id",
  secrets: { token: "top-level-secret" },
  stateSqlite: "/home/local/.t3/userdata/state.sqlite",
};

describe("T3 settings parity filtering", () => {
  it("keeps a home-relative Codex shadow home and drops an absolute one", () => {
    const filtered = filterPortableT3Settings({
      providerInstances: {
        codex_work: { driver: "codex", config: { shadowHomePath: "~/.codex_work" } },
        codex_local: { driver: "codex", config: { shadowHomePath: "/home/local/.codex-work" } },
        codex_escape: { driver: "codex", config: { shadowHomePath: "~/../other/.codex" } },
      },
    });

    expect(filtered.providerInstances).toEqual({
      codex_work: { driver: "codex", config: { shadowHomePath: "~/.codex_work" } },
      codex_local: { driver: "codex", config: {} },
      codex_escape: { driver: "codex", config: {} },
    });
  });

  it("keeps the explicit portable allow-list and removes paths and secrets", () => {
    const filtered = filterPortableT3Settings(localSettingsFixture);

    expect(filtered).toMatchObject({
      enableLegacyTokenStreaming: true,
      enableProviderUpdateChecks: false,
      enableAgentBrowserAccess: false,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: 90_000,
          pauseWhenOnBattery: true,
        },
      },
      defaultThreadEnvMode: "worktree",
      newWorktreesStartFromOrigin: false,
      textGenerationModelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.6",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "Use issue IDs.",
        followChangeRequestTemplates: false,
      },
      providers: {
        codex: { enabled: true, customModels: ["gpt-custom"] },
        claudeAgent: {
          enabled: true,
          autoCompactWindow: "300000",
          customModels: ["claude-custom"],
        },
        opencode: {
          enabled: true,
          serverUrl: "http://127.0.0.1:4096",
          customModels: ["opencode-custom"],
        },
        pi: {
          enabled: true,
          defaultModel: "openai-codex/gpt-5.6-sol",
          excludedProviders: "google,openai",
          customModels: ["pi-custom"],
        },
      },
      providerInstances: {
        codex_work: {
          driver: "codex",
          displayName: "Codex Work",
          accentColor: "blue",
          enabled: true,
          config: { enabled: true, customModels: ["work-custom"] },
        },
        fork: { driver: "futureDriver", displayName: "Future", enabled: true },
      },
      observability: {
        otlpTracesUrl: "https://otel.example.test/v1/traces",
        otlpMetricsUrl: "https://otel.example.test/v1/metrics",
      },
    });

    const encoded = JSON.stringify(filtered);
    for (const forbidden of [
      "/home/local",
      "/usr/local/bin",
      "/opt/",
      "provider-secret",
      "instance-secret",
      "future-secret",
      "opencode-secret",
      "top-level-secret",
      "local-environment-id",
      "state.sqlite",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });
});

describe("T3 settings parity publishing", () => {
  it("deep-merges filtered settings, preserves host paths, and copies keybindings verbatim", () => {
    const home = mkdtempSync(NodePath.join(NodeOs.tmpdir(), "cloudbox-settings-parity-"));
    temporaryDirectories.push(home);
    const userdata = NodePath.join(home, ".t3", "userdata");
    mkdirSync(userdata, { recursive: true });
    const settingsPath = NodePath.join(userdata, "settings.json");
    const keybindingsPath = NodePath.join(userdata, "keybindings.json");
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        defaultThreadEnvMode: "local",
        providers: {
          codex: { enabled: false, binaryPath: "/host/bin/codex", homePath: "/host/.codex" },
        },
      }, null, 2)}\n`,
    );
    writeFileSync(keybindingsPath, "{\"old\":true}\n");
    const filtered = filterPortableT3Settings(localSettingsFixture);
    const keybindings = "{\n  \"command.palette\": \"ctrl+k\"\n}\n";
    const script = buildT3ParityPublishScript({
      settingsJson: `${JSON.stringify(filtered, null, 2)}\n`,
      keybindings,
    });

    const result = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("T3 settings changed fields:");
    expect(result.stdout).toContain("defaultThreadEnvMode");
    expect(result.stdout).toContain("T3 keybindings changed");
    expect(result.stdout).toContain("Cloudbox did not restart it");
    const merged: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(merged).toMatchObject({
      defaultThreadEnvMode: "worktree",
      providers: {
        codex: {
          enabled: true,
          binaryPath: "/host/bin/codex",
          homePath: "/host/.codex",
          customModels: ["gpt-custom"],
        },
      },
    });
    expect(readFileSync(keybindingsPath, "utf8")).toBe(keybindings);
    expect(script).not.toMatch(/^\s*systemctl\s+--user\s+restart/mu);
  }, 30_000);
});
