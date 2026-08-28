import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  formatThreadSmokeReport,
  machineNameForSmokeThread,
  runThreadSmokeSuite,
  type ThreadSmokeProject,
  type ThreadSmokeProvider,
  type ThreadSmokeThreadSnapshot,
  type ThreadSmokeTransport,
  type ThreadSmokeTurnInput,
} from "./threadSmoke.ts";

const provider = (
  instanceId: "pi" | "codex",
  model: string,
  overrides: Partial<ThreadSmokeProvider> = {},
): ThreadSmokeProvider => ({
  instanceId,
  driver: instanceId,
  enabled: true,
  installed: true,
  status: "ready",
  authStatus: instanceId === "pi" ? "unknown" : "authenticated",
  models: [model],
  ...overrides,
});

const completedThread = (
  assistantText: string,
  threadId?: string,
): ThreadSmokeThreadSnapshot => ({
  snapshotSequence: 12,
  assistantText,
  latestTurnState: "completed",
  sessionStatus: "ready",
  lastError: null,
  machine: threadId === undefined
    ? null
    : {
        machineId: machineNameForSmokeThread(threadId),
        machineName: machineNameForSmokeThread(threadId),
        state: "running",
        hostWorkspaceRoot: `/tank/threads/${threadId}/ws`,
        guestWorkspaceRoot: "/home/dev/ws",
      },
});

const makeFakeTransport = (input?: {
  readonly providers?: ReadonlyArray<ThreadSmokeProvider>;
  readonly assistantText?: string;
  readonly piEnabled?: boolean;
  readonly machineMode?: boolean;
}) => {
  const commands: Array<Readonly<Record<string, unknown>>> = [];
  const settingsUpdates: Array<Readonly<Record<string, unknown>>> = [];
  const projects: ThreadSmokeProject[] = [];
  let providers = input?.providers ?? [
    provider("pi", "openai-codex/gpt-5.6-sol"),
    provider("codex", "gpt-5.6-sol"),
  ];
  const piEnabled = input?.piEnabled ?? true;
  const piSettings: Record<string, unknown> = {
    enabled: piEnabled,
    binaryPath: "pi",
    defaultModel: piEnabled ? "openai-codex/gpt-5.6-sol" : "",
    excludedProviders: "google, openai, anthropic, opencode-go",
    launchArgs: "",
    customModels: [],
  };
  let providerInstances: Record<string, Readonly<Record<string, unknown>>> = {};
  const assistantText = input?.assistantText ?? "CLOUDBOX_SMOKE_OK\n6.17.0-1022-gcp";

  const dispatch = async (command: Readonly<Record<string, unknown>>) => {
    commands.push(command);
    if (command.type === "project.create") {
      projects.push({
        id: String(command.projectId),
        workspaceRoot: String(command.workspaceRoot),
        machineMode: "off",
      });
    }
    if (command.type === "project.meta.update" && command.machineMode !== undefined) {
      const project = projects.find((entry) => entry.id === command.projectId);
      if (project !== undefined) {
        Object.assign(project, { machineMode: command.machineMode });
      }
    }
  };

  const transport: ThreadSmokeTransport = {
    readEnvironmentId: async () => "environment-test",
    readSettings: async () => ({ pi: piSettings, providerInstances }),
    updateSettings: async (patch) => {
      settingsUpdates.push(patch);
      const replacement = patch.providerInstances as Record<string, Readonly<Record<string, unknown>>>;
      providerInstances = replacement;
      const piInstance = replacement.pi;
      const config = piInstance?.config as Record<string, unknown> | undefined;
      piSettings.enabled = piInstance?.enabled === true;
      piSettings.defaultModel = config?.defaultModel ?? "";
      providers = providers.map((entry) => entry.instanceId === "pi"
        ? provider("pi", "openai-codex/gpt-5.6-sol")
        : entry);
    },
    refreshProviders: async () => providers,
    readSnapshot: async () => ({ snapshotSequence: commands.length, projects }),
    readThread: async () => ({
      snapshotSequence: commands.length,
      assistantText: "",
      latestTurnState: null,
      sessionStatus: null,
      lastError: null,
      machine: null,
    }),
    dispatch,
    runTurn: async (turn: ThreadSmokeTurnInput) => {
      await dispatch(turn.command);
      await turn.onRunning?.();
      if (input?.machineMode === true) {
        const machineName = machineNameForSmokeThread(turn.threadId);
        return completedThread(
          `CLOUDBOX_MACHINE_SMOKE_OK\nhostname=${machineName}\netc_hostname=${machineName}\nworkspace=README.md`,
          turn.threadId,
        );
      }
      return completedThread(assistantText);
    },
    inspectMachine: async (threadId, machineName) => ({
      machineName,
      instanceExists: true,
      instanceStatus: "RUNNING",
      dataset: `tank/threads/${threadId}/ws`,
      datasetExists: true,
      workspaceOwner: "1001:1002",
      readmeExists: true,
      readmeFirstLine: "# Cloudbox smoke repository",
    }),
    inspectMachineCleanup: async (threadId, machineName) => ({
      disposition: "destroyed",
      machineName,
      instanceExists: false,
      instanceStatus: "MISSING",
      dataset: `tank/threads/${threadId}/ws`,
      datasetExists: false,
    }),
  };

  return { commands, settingsUpdates, transport };
};

describe("T3 thread smoke", () => {
  it.effect("runs pi and Codex turns through a fake transport and deletes both threads", () => {
    const fake = makeFakeTransport();
    return Effect.gen(function* () {
      const report = yield* runThreadSmokeSuite(fake.transport);

      expect(report.ok).toBe(true);
      expect(report.results.map((result) => [result.provider, result.pass, result.cleanup])).toEqual([
        ["pi", true, "deleted"],
        ["codex", true, "deleted"],
      ]);
      expect(report.environmentId).toBe("environment-test");
      expect(report.projectCleanup).toBe("deleted");
      expect(fake.commands.filter((command) => command.type === "project.create")).toHaveLength(1);
      expect(fake.commands.filter((command) => command.type === "project.meta.update")).toHaveLength(0);
      expect(fake.commands.filter((command) => command.type === "thread.create")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "thread.delete")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "project.delete")).toHaveLength(1);

      const output = formatThreadSmokeReport(report);
      expect(output).toContain("pi PASS");
      expect(output).toContain("codex PASS");
      expect(output).toContain("CLOUDBOX_SMOKE_OK");
    });
  });

  it.effect("enables disabled pi settings explicitly, then runs pi and Codex", () => {
    const fake = makeFakeTransport({
      providers: [
        provider("pi", "openai-codex/gpt-5.6-sol", {
          enabled: false,
          installed: false,
          status: "disabled",
          message: "pi is disabled in T3 Code settings.",
          models: [],
        }),
        provider("codex", "gpt-5.6-sol"),
      ],
      piEnabled: false,
    });

    return Effect.gen(function* () {
      const report = yield* runThreadSmokeSuite(fake.transport, { keepProject: true });

      expect(report.ok).toBe(true);
      expect(report.settingsActions).toEqual([
        "enabled provider pi in environment settings",
        "set provider pi default model to openai-codex/gpt-5.6-sol",
      ]);
      expect(report.projectCleanup).toBe("kept");
      expect(report.results[0]).toMatchObject({ provider: "pi", pass: true });
      expect(report.results[1]).toMatchObject({ provider: "codex", pass: true });
      expect(fake.settingsUpdates).toHaveLength(1);
      expect(fake.settingsUpdates[0]).toMatchObject({
        providerInstances: {
          pi: {
            driver: "pi",
            enabled: true,
            config: { defaultModel: "openai-codex/gpt-5.6-sol" },
          },
        },
      });
      expect(fake.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "project.delete")).toHaveLength(0);
      expect(formatThreadSmokeReport(report)).toContain(
        "settings: enabled provider pi in environment settings",
      );
    });
  });

  it.effect("proves machine resources, agent hostname, and deletion cleanup", () => {
    const fake = makeFakeTransport({ machineMode: true });
    return Effect.gen(function* () {
      const report = yield* runThreadSmokeSuite(fake.transport, {
        keepProject: true,
        machineMode: true,
      });

      expect(report.ok).toBe(true);
      expect(fake.commands).toContainEqual(expect.objectContaining({
        type: "project.meta.update",
        machineMode: "thread",
      }));
      expect(report.results).toHaveLength(2);
      for (const result of report.results) {
        expect(result.pass).toBe(true);
        expect(result.assertions.map((assertion) => [assertion.name, assertion.pass])).toEqual([
          ["machine binding", true],
          ["Incus runtime", true],
          ["ZFS workspace", true],
          ["agent machine proof", true],
          ["machine cleanup", true],
        ]);
      }
      const output = formatThreadSmokeReport(report);
      expect(output).toContain("assert Incus runtime: PASS");
      expect(output).toContain("assert machine cleanup: PASS — destroyed");
      expect(output).toContain("CLOUDBOX_MACHINE_SMOKE_OK");
    });
  });

  it.effect("fails output without a kernel release but still cleans up", () => {
    const fake = makeFakeTransport({ assistantText: "CLOUDBOX_SMOKE_OK" });
    return Effect.gen(function* () {
      const report = yield* runThreadSmokeSuite(fake.transport);

      expect(report.ok).toBe(false);
      expect(report.results.every((result) => !result.pass)).toBe(true);
      expect(report.results.every((result) => result.cleanup === "deleted")).toBe(true);
      expect(report.results[0]?.evidence).toBe(
        "Assistant output did not contain a Linux kernel release string.",
      );
    });
  });
});
