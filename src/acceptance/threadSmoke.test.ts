import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  formatThreadSmokeReport,
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

const completedThread = (assistantText: string): ThreadSmokeThreadSnapshot => ({
  snapshotSequence: 12,
  assistantText,
  latestTurnState: "completed",
  sessionStatus: "ready",
  lastError: null,
});

const makeFakeTransport = (input?: {
  readonly providers?: ReadonlyArray<ThreadSmokeProvider>;
  readonly assistantText?: string;
}) => {
  const commands: Array<Readonly<Record<string, unknown>>> = [];
  const projects: ThreadSmokeProject[] = [];
  const providers = input?.providers ?? [
    provider("pi", "openai-codex/gpt-5.6-sol"),
    provider("codex", "gpt-5.6-sol"),
  ];
  const assistantText = input?.assistantText ?? "CLOUDBOX_SMOKE_OK\n6.17.0-1022-gcp";

  const dispatch = async (command: Readonly<Record<string, unknown>>) => {
    commands.push(command);
    if (command.type === "project.create") {
      projects.push({
        id: String(command.projectId),
        workspaceRoot: String(command.workspaceRoot),
      });
    }
  };

  const transport: ThreadSmokeTransport = {
    refreshProviders: async () => providers,
    readSnapshot: async () => ({ snapshotSequence: commands.length, projects }),
    readThread: async () => ({
      snapshotSequence: commands.length,
      assistantText: "",
      latestTurnState: null,
      sessionStatus: null,
      lastError: null,
    }),
    dispatch,
    runTurn: async (turn: ThreadSmokeTurnInput) => {
      await dispatch(turn.command);
      return completedThread(assistantText);
    },
  };

  return { commands, transport };
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
      expect(fake.commands.filter((command) => command.type === "project.create")).toHaveLength(1);
      expect(fake.commands.filter((command) => command.type === "project.meta.update")).toHaveLength(1);
      expect(fake.commands.filter((command) => command.type === "thread.create")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(2);
      expect(fake.commands.filter((command) => command.type === "thread.delete")).toHaveLength(2);

      const output = formatThreadSmokeReport(report);
      expect(output).toContain("pi PASS");
      expect(output).toContain("codex PASS");
      expect(output).toContain("CLOUDBOX_SMOKE_OK");
    });
  });

  it.effect("reports the exact pi availability reason and still runs Codex", () => {
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
    });

    return Effect.gen(function* () {
      const report = yield* runThreadSmokeSuite(fake.transport);

      expect(report.ok).toBe(false);
      expect(report.results[0]).toMatchObject({
        provider: "pi",
        pass: false,
        threadId: null,
        evidence: "pi is disabled in T3 Code settings.",
        cleanup: "not-needed",
      });
      expect(report.results[1]).toMatchObject({ provider: "codex", pass: true });
      expect(fake.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
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
