import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as Net from "node:net";

import type { CloudboxConfig } from "../config.ts";
import { privateKeyPathFromConfig } from "./index.ts";

const SMOKE_REPOSITORY = "/home/dev/smoke-repo";
const T3_PORT = 3773;
const SMOKE_PROMPT = "Reply with exactly: CLOUDBOX_SMOKE_OK and the output of uname -r";
const MACHINE_SMOKE_PROMPT = `Run these commands inside your execution environment:
hostname
cat /etc/hostname
ls /home/dev/ws

Reply with exactly these four lines, replacing values with the command output:
CLOUDBOX_MACHINE_SMOKE_OK
hostname=<hostname output>
etc_hostname=</etc/hostname output>
workspace=<space-separated /home/dev/ws entries>`;
const KERNEL_RELEASE_PATTERN = /\b\d+\.\d+\.\d+(?:[-.][0-9A-Za-z_+]+)+\b/;
const MACHINE_NAME_PREFIX = "thread-";
const MACHINE_NAME_MAX_LENGTH = 63;

export class ThreadSmokeError extends Data.TaggedError("ThreadSmokeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const smokeError = (operation: string, message: string, cause?: unknown) =>
  new ThreadSmokeError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export interface ThreadSmokeProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly authStatus: string;
  readonly message?: string;
  readonly availability?: string;
  readonly unavailableReason?: string;
  readonly models: ReadonlyArray<string>;
}

export interface ThreadSmokeProject {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly machineMode?: "off" | "thread";
}

export interface ThreadSmokeSnapshot {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<ThreadSmokeProject>;
}

export interface ThreadSmokeMachineBinding {
  readonly machineId: string;
  readonly machineName: string;
  readonly state: string;
  readonly hostWorkspaceRoot: string;
  readonly guestWorkspaceRoot: string;
}

export interface ThreadSmokeThreadSnapshot {
  readonly snapshotSequence: number;
  readonly assistantText: string;
  readonly latestTurnState: string | null;
  readonly sessionStatus: string | null;
  readonly lastError: string | null;
  readonly machine: ThreadSmokeMachineBinding | null;
}

export interface ThreadSmokeMachineObservation {
  readonly machineName: string;
  readonly instanceExists: boolean;
  readonly instanceStatus: string;
  readonly dataset: string;
  readonly datasetExists: boolean;
  readonly workspaceOwner: string;
  readonly readmeExists: boolean;
  readonly readmeFirstLine: string;
}

export interface ThreadSmokeMachineCleanupObservation {
  readonly disposition: "destroyed" | "archived" | "incomplete";
  readonly machineName: string;
  readonly instanceExists: boolean;
  readonly instanceStatus: string;
  readonly dataset: string;
  readonly datasetExists: boolean;
}

export interface ThreadSmokeTurnInput {
  readonly threadId: string;
  readonly afterSequence: number;
  readonly command: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly onRunning?: () => Promise<void>;
}

export interface ThreadSmokeSettings {
  readonly pi: Readonly<Record<string, unknown>>;
  readonly providerInstances: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ThreadSmokeTransport {
  readonly readEnvironmentId: () => Promise<string>;
  readonly readSettings: () => Promise<ThreadSmokeSettings>;
  readonly updateSettings: (patch: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly refreshProviders: () => Promise<ReadonlyArray<ThreadSmokeProvider>>;
  readonly readSnapshot: () => Promise<ThreadSmokeSnapshot>;
  readonly readThread: (threadId: string) => Promise<ThreadSmokeThreadSnapshot>;
  readonly dispatch: (command: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly runTurn: (input: ThreadSmokeTurnInput) => Promise<ThreadSmokeThreadSnapshot>;
  readonly inspectMachine: (
    threadId: string,
    machineName: string,
  ) => Promise<ThreadSmokeMachineObservation>;
  readonly inspectMachineCleanup: (
    threadId: string,
    machineName: string,
  ) => Promise<ThreadSmokeMachineCleanupObservation>;
}

export interface ThreadSmokeAssertion {
  readonly name: string;
  readonly pass: boolean;
  readonly evidence: string;
}

export interface ThreadSmokeCaseResult {
  readonly provider: "pi" | "codex";
  readonly model: string;
  readonly pass: boolean;
  readonly threadId: string | null;
  readonly assistantText: string;
  readonly evidence: string;
  readonly cleanup: "not-needed" | "deleted" | "failed";
  readonly assertions: ReadonlyArray<ThreadSmokeAssertion>;
  readonly durationMs: number;
}

export interface ThreadSmokeReport {
  readonly ok: boolean;
  readonly environmentId: string;
  readonly settingsActions: ReadonlyArray<string>;
  readonly projectId: string;
  readonly projectCleanup: "kept" | "deleted" | "failed";
  readonly machineMode: "off" | "thread";
  readonly results: ReadonlyArray<ThreadSmokeCaseResult>;
}

export interface ThreadSmokeOptions {
  readonly timeoutSeconds?: number;
  readonly keepProject?: boolean;
  readonly machineMode?: boolean;
}

interface ProviderCase {
  readonly provider: "pi" | "codex";
  readonly model: string;
}

const PROVIDER_CASES: ReadonlyArray<ProviderCase> = [
  { provider: "pi", model: "openai-codex/gpt-5.6-sol" },
  { provider: "codex", model: "gpt-5.6-sol" },
];

const nowIso = (): string => new Date().toISOString();
const makeId = (prefix: string): string => `${prefix}-${randomUUID()}`;

export const machineNameForSmokeThread = (threadId: string): string => {
  const sanitized = threadId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const plain = `${MACHINE_NAME_PREFIX}${sanitized || "id"}`;
  if (plain.length <= MACHINE_NAME_MAX_LENGTH && sanitized === threadId) return plain;

  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 12);
  const available = MACHINE_NAME_MAX_LENGTH - MACHINE_NAME_PREFIX.length - digest.length - 1;
  const prefix = sanitized.slice(0, available).replace(/-+$/g, "") || "id";
  return `${MACHINE_NAME_PREFIX}${prefix}-${digest}`;
};

const providerUnavailableReason = (
  expected: ProviderCase,
  providers: ReadonlyArray<ThreadSmokeProvider>,
): string | undefined => {
  const provider = providers.find((candidate) => candidate.instanceId === expected.provider);
  if (provider === undefined) {
    return `Provider instance '${expected.provider}' was not returned by server.refreshProviders.`;
  }
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? `Provider instance '${expected.provider}' is unavailable.`;
  }
  if (!provider.enabled || !provider.installed || provider.status === "disabled" || provider.status === "error") {
    return provider.message ??
      `Provider '${expected.provider}' is not selectable (enabled=${String(provider.enabled)}, installed=${String(provider.installed)}, status=${provider.status}).`;
  }
  if (provider.authStatus === "unauthenticated") {
    return provider.message ?? `Provider '${expected.provider}' is unauthenticated.`;
  }
  if (!provider.models.includes(expected.model)) {
    const available = provider.models.length === 0 ? "none" : provider.models.join(", ");
    return `Model '${expected.model}' is not selectable for provider '${expected.provider}'; available models: ${available}.`;
  }
  return undefined;
};

const ensureSmokeProject = async (
  transport: ThreadSmokeTransport,
  machineMode: boolean,
): Promise<string> => {
  const snapshot = await transport.readSnapshot();
  const existing = snapshot.projects.find((project) => project.workspaceRoot === SMOKE_REPOSITORY);
  const desiredMachineMode = machineMode ? "thread" : "off";
  if (existing !== undefined) {
    await transport.dispatch({
      type: "project.meta.update",
      commandId: makeId("cloudbox-smoke-project-upsert"),
      projectId: existing.id,
      title: "Cloudbox smoke repository",
      workspaceRoot: SMOKE_REPOSITORY,
      machineMode: desiredMachineMode,
    });
    return existing.id;
  }

  const projectId = makeId("cloudbox-smoke-project");
  await transport.dispatch({
    type: "project.create",
    commandId: makeId("cloudbox-smoke-project-create"),
    projectId,
    title: "Cloudbox smoke repository",
    workspaceRoot: SMOKE_REPOSITORY,
    createWorkspaceRootIfMissing: false,
    createdAt: nowIso(),
  });
  if (machineMode) {
    await transport.dispatch({
      type: "project.meta.update",
      commandId: makeId("cloudbox-smoke-project-machine-mode"),
      projectId,
      machineMode: "thread",
    });
  }
  return projectId;
};

const validateAssistantText = (assistantText: string): string | undefined => {
  if (!assistantText.includes("CLOUDBOX_SMOKE_OK")) {
    return "Assistant output did not contain CLOUDBOX_SMOKE_OK.";
  }
  if (!KERNEL_RELEASE_PATTERN.test(assistantText)) {
    return "Assistant output did not contain a Linux kernel release string.";
  }
  return undefined;
};

const machineField = (assistantText: string, name: string): string | undefined => {
  const match = new RegExp(`^${name}\\s*=\\s*([^\\n\\r]+)$`, "im").exec(assistantText);
  return match?.[1]?.trim().replace(/^`|`$/g, "");
};

const machineAssertions = (
  threadId: string,
  expectedName: string,
  completed: ThreadSmokeThreadSnapshot,
  observed: ThreadSmokeMachineObservation | undefined,
  observationError: string | undefined,
): ReadonlyArray<ThreadSmokeAssertion> => {
  const binding = completed.machine;
  const hostname = machineField(completed.assistantText, "hostname");
  const etcHostname = machineField(completed.assistantText, "etc_hostname");
  const workspace = machineField(completed.assistantText, "workspace");
  return [
    {
      name: "machine binding",
      pass: binding?.machineName === expectedName &&
        binding.hostWorkspaceRoot === `/tank/threads/${threadId}/ws` &&
        binding.guestWorkspaceRoot === "/home/dev/ws",
      evidence: binding === null
        ? "T3 thread snapshot had no machine binding."
        : `${binding.machineName} state=${binding.state} host=${binding.hostWorkspaceRoot} guest=${binding.guestWorkspaceRoot}`,
    },
    {
      name: "Incus runtime",
      pass: observed?.instanceExists === true && observed.instanceStatus.toUpperCase() === "RUNNING",
      evidence: observed === undefined
        ? observationError ?? "No SSH machine observation was captured while the turn was running."
        : `${observed.machineName} status=${observed.instanceStatus}`,
    },
    {
      name: "ZFS workspace",
      pass: observed?.datasetExists === true && observed.readmeExists,
      evidence: observed === undefined
        ? observationError ?? "No SSH dataset observation was captured while the turn was running."
        : `${observed.dataset} exists=${String(observed.datasetExists)} owner=${observed.workspaceOwner} README=${String(observed.readmeExists)}${observed.readmeFirstLine.length > 0 ? ` (${observed.readmeFirstLine})` : ""}`,
    },
    {
      name: "agent machine proof",
      pass: completed.assistantText.includes("CLOUDBOX_MACHINE_SMOKE_OK") &&
        hostname === expectedName &&
        etcHostname === expectedName &&
        hostname !== "cloudbox-test" &&
        workspace?.split(/\\s+/).includes("README.md") === true,
      evidence: `marker=${String(completed.assistantText.includes("CLOUDBOX_MACHINE_SMOKE_OK"))} hostname=${hostname ?? "missing"} etc_hostname=${etcHostname ?? "missing"} workspace=${workspace ?? "missing"}`,
    },
  ];
};

const runProviderCase = async (
  transport: ThreadSmokeTransport,
  providers: ReadonlyArray<ThreadSmokeProvider>,
  projectId: string,
  expected: ProviderCase,
  timeoutMs: number,
  machineMode: boolean,
): Promise<ThreadSmokeCaseResult> => {
  const startedAt = Date.now();
  let threadId: string | null = null;
  let assistantText = "";
  let pass = false;
  let evidence = "";
  let cleanup: ThreadSmokeCaseResult["cleanup"] = "not-needed";
  const assertions: ThreadSmokeAssertion[] = [];
  let machineObservation: ThreadSmokeMachineObservation | undefined;
  let machineObservationError: string | undefined;

  try {
    const unavailable = providerUnavailableReason(expected, providers);
    if (unavailable !== undefined) {
      evidence = unavailable;
      return {
        provider: expected.provider,
        model: expected.model,
        pass,
        threadId,
        assistantText,
        evidence,
        cleanup,
        assertions,
        durationMs: Date.now() - startedAt,
      };
    }

    threadId = makeId(`cloudbox-smoke-${expected.provider}`);
    const expectedMachineName = machineNameForSmokeThread(threadId);
    const modelSelection = { instanceId: expected.provider, model: expected.model };
    await transport.dispatch({
      type: "thread.create",
      commandId: makeId("cloudbox-smoke-thread-create"),
      threadId,
      projectId,
      title: `Cloudbox smoke: ${expected.provider}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: nowIso(),
    });

    const initial = await transport.readThread(threadId);
    const completed = await transport.runTurn({
      threadId,
      afterSequence: initial.snapshotSequence,
      timeoutMs,
      ...(machineMode
        ? {
            onRunning: async () => {
              try {
                machineObservation = await transport.inspectMachine(threadId!, expectedMachineName);
              } catch (cause) {
                machineObservationError = cause instanceof Error ? cause.message : String(cause);
              }
            },
          }
        : {}),
      command: {
        type: "thread.turn.start",
        commandId: makeId("cloudbox-smoke-turn-start"),
        threadId,
        message: {
          messageId: makeId("cloudbox-smoke-message"),
          role: "user",
          text: machineMode ? MACHINE_SMOKE_PROMPT : SMOKE_PROMPT,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      },
    });
    assistantText = completed.assistantText;

    if (completed.latestTurnState !== "completed") {
      evidence = completed.lastError ??
        `Turn ended in state=${completed.latestTurnState ?? "unknown"}, session=${completed.sessionStatus ?? "unknown"}.`;
    } else if (machineMode) {
      assertions.push(
        ...machineAssertions(
          threadId,
          expectedMachineName,
          completed,
          machineObservation,
          machineObservationError,
        ),
      );
      pass = assertions.every((assertion) => assertion.pass);
      evidence = pass
        ? "Agent turn and all in-machine assertions passed."
        : "Agent turn completed, but one or more in-machine assertions failed.";
    } else {
      const validationError = validateAssistantText(assistantText);
      if (validationError !== undefined) {
        evidence = validationError;
      } else {
        pass = true;
        evidence = "Agent turn completed and returned the smoke marker plus a Linux kernel release.";
      }
    }
  } catch (cause) {
    evidence = cause instanceof Error ? cause.message : String(cause);
    if (machineMode && threadId !== null && assertions.length === 0) {
      const expectedMachineName = machineNameForSmokeThread(threadId);
      try {
        machineObservation ??= await transport.inspectMachine(threadId, expectedMachineName);
      } catch (observationCause) {
        machineObservationError ??= observationCause instanceof Error
          ? observationCause.message
          : String(observationCause);
      }
      try {
        const failedSnapshot = await transport.readThread(threadId);
        assistantText = failedSnapshot.assistantText;
        assertions.push(
          ...machineAssertions(
            threadId,
            expectedMachineName,
            failedSnapshot,
            machineObservation,
            machineObservationError,
          ),
        );
      } catch (snapshotCause) {
        assertions.push({
          name: "machine binding",
          pass: false,
          evidence: snapshotCause instanceof Error ? snapshotCause.message : String(snapshotCause),
        });
      }
    }
  } finally {
    if (threadId !== null) {
      const expectedMachineName = machineNameForSmokeThread(threadId);
      try {
        await transport.dispatch({
          type: "thread.delete",
          commandId: makeId("cloudbox-smoke-thread-delete"),
          threadId,
        });
        cleanup = "deleted";
        if (machineMode) {
          const observed = await transport.inspectMachineCleanup(threadId, expectedMachineName);
          const cleanupPass = observed.disposition === "destroyed" || observed.disposition === "archived";
          const passedBeforeCleanup = pass;
          assertions.push({
            name: "machine cleanup",
            pass: cleanupPass,
            evidence: `${observed.disposition}: ${observed.machineName} exists=${String(observed.instanceExists)} status=${observed.instanceStatus}; ${observed.dataset} exists=${String(observed.datasetExists)}`,
          });
          pass = pass && cleanupPass;
          if (!cleanupPass && passedBeforeCleanup) {
            evidence = "Agent turn passed, but machine cleanup remained incomplete.";
          } else if (pass) {
            evidence = "Agent turn, in-machine assertions, and machine cleanup all passed.";
          }
        }
      } catch (cause) {
        cleanup = "failed";
        pass = false;
        const detail = cause instanceof Error ? cause.message : String(cause);
        evidence = `${evidence} Cleanup failed: ${detail}`.trim();
        if (machineMode) {
          assertions.push({ name: "machine cleanup", pass: false, evidence: detail });
        }
      }
    }
  }

  return {
    provider: expected.provider,
    model: expected.model,
    pass,
    threadId,
    assistantText,
    evidence,
    cleanup,
    assertions,
    durationMs: Date.now() - startedAt,
  };
};

const recordWithout = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const configurePi = async (
  transport: ThreadSmokeTransport,
): Promise<ReadonlyArray<string>> => {
  const settings = await transport.readSettings();
  const explicit = settings.providerInstances.pi;
  const explicitConfig = explicit?.config === null || typeof explicit?.config !== "object" || Array.isArray(explicit?.config)
    ? {}
    : explicit.config as Readonly<Record<string, unknown>>;
  const legacyConfig = recordWithout(settings.pi, "enabled");
  const mergedConfig = {
    ...legacyConfig,
    ...recordWithout(explicitConfig, "enabled"),
  };
  const enabled = explicit === undefined
    ? settings.pi.enabled === true
    : explicit.enabled !== false && explicitConfig.enabled !== false;
  const defaultModel = typeof mergedConfig.defaultModel === "string" ? mergedConfig.defaultModel : "";
  const actions: string[] = [];

  if (enabled && defaultModel === PROVIDER_CASES[0]!.model) {
    return actions;
  }

  await transport.updateSettings({
    providerInstances: {
      ...settings.providerInstances,
      pi: {
        ...explicit,
        driver: "pi",
        enabled: true,
        config: {
          ...mergedConfig,
          defaultModel: PROVIDER_CASES[0]!.model,
        },
      },
    },
  });
  if (!enabled) actions.push("enabled provider pi in environment settings");
  if (defaultModel !== PROVIDER_CASES[0]!.model) {
    actions.push(`set provider pi default model to ${PROVIDER_CASES[0]!.model}`);
  }
  return actions;
};

export const runThreadSmokeSuite = (
  transport: ThreadSmokeTransport,
  options: ThreadSmokeOptions = {},
): Effect.Effect<ThreadSmokeReport, ThreadSmokeError> =>
  Effect.tryPromise({
    try: async () => {
      const environmentId = await transport.readEnvironmentId();
      const settingsActions = [...await configurePi(transport)];
      let providers: ReadonlyArray<ThreadSmokeProvider> = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        providers = await transport.refreshProviders();
        const piReason = providerUnavailableReason(PROVIDER_CASES[0]!, providers);
        if (piReason === undefined || attempt === 3) break;
        settingsActions.push(`retrying pi provider refresh after: ${piReason}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const machineMode = options.machineMode === true;
      const projectId = await ensureSmokeProject(transport, machineMode);
      const results: ThreadSmokeCaseResult[] = [];
      const timeoutMs = (options.timeoutSeconds ?? 240) * 1_000;
      for (const expected of PROVIDER_CASES) {
        results.push(
          await runProviderCase(transport, providers, projectId, expected, timeoutMs, machineMode),
        );
      }

      let projectCleanup: ThreadSmokeReport["projectCleanup"] = "kept";
      if (options.keepProject !== true) {
        try {
          await transport.dispatch({
            type: "project.delete",
            commandId: makeId("cloudbox-smoke-project-delete"),
            projectId,
            force: true,
          });
          projectCleanup = "deleted";
        } catch (cause) {
          projectCleanup = "failed";
          settingsActions.push(
            `project cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }

      return {
        ok: results.every((result) => result.pass) && projectCleanup !== "failed",
        environmentId,
        settingsActions,
        projectId,
        projectCleanup,
        machineMode: machineMode ? "thread" : "off",
        results,
      } satisfies ThreadSmokeReport;
    },
    catch: (cause) => smokeError("smoke thread", "Could not run the T3 thread smoke suite", cause),
  });

export const formatThreadSmokeReport = (report: ThreadSmokeReport): string => {
  const header = [
    `environment: ${report.environmentId}`,
    ...report.settingsActions.map((action) => `settings: ${action}`),
    `project: ${report.projectId}`,
    `machine mode: ${report.machineMode}`,
    `project cleanup: ${report.projectCleanup}`,
  ];
  const cases = report.results.map((result) => {
    const lines = [
      `${result.provider} ${result.pass ? "PASS" : "FAIL"}`,
      `model: ${result.model}`,
      `thread: ${result.threadId ?? "not-created"}`,
      `cleanup: ${result.cleanup}`,
      `evidence: ${result.evidence}`,
    ];
    for (const assertion of result.assertions) {
      lines.push(`assert ${assertion.name}: ${assertion.pass ? "PASS" : "FAIL"} — ${assertion.evidence}`);
    }
    if (result.assistantText.length > 0) {
      lines.push("assistant:", result.assistantText);
    }
    return lines.join("\n");
  });
  return [header.join("\n"), ...cases].join("\n\n");
};

interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCaptured = (
  command: string,
  args: ReadonlyArray<string>,
  input = "",
  timeoutMs = 30_000,
): Promise<ProcessOutput> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: 124, stdout, stderr: `${stderr}\ncommand timed out` });
    }, timeoutMs);
    const finish = (output: ProcessOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });

const sshArgs = (
  config: CloudboxConfig,
  host: string,
  extra: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [
  "-i",
  privateKeyPathFromConfig(config.sshPublicKeyPath),
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  ...extra,
  `${config.boxUser}@${host}`,
];

const prepareRemote = async (config: CloudboxConfig, host: string): Promise<string> => {
  const script = `set -euo pipefail
repo=${SMOKE_REPOSITORY}
if [ -e "$repo" ] && [ ! -d "$repo/.git" ]; then
  echo "$repo exists but is not a Git repository" >&2
  exit 1
fi
if [ ! -d "$repo/.git" ]; then
  mkdir -p "$repo"
  git -C "$repo" init -b main
  printf '# Cloudbox smoke repository\\n\\nCreated for autonomous T3 agent-turn acceptance testing.\\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" -c user.name='Cloudbox Smoke' -c user.email='cloudbox-smoke@localhost' commit -m 'chore: initialize smoke repository'
fi
cat /home/dev/.t3/idle-detector.token
`;
  const output = await runCaptured(
    "ssh",
    [...sshArgs(config, host), "bash", "-s"],
    script,
    30_000,
  );
  if (output.exitCode !== 0) {
    throw smokeError("prepare remote smoke repository", output.stderr.trim() || `ssh exited ${String(output.exitCode)}`);
  }
  const token = output.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (token.length === 0) {
    throw smokeError("read T3 bearer", "The remote bearer token file was empty.");
  }
  return token;
};

const reserveLocalPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local TCP port"));
        return;
      }
      const { port } = address;
      server.close((cause) => cause === undefined ? resolve(port) : reject(cause));
    });
  });

const waitForTunnel = async (
  origin: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`SSH tunnel exited with status ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out opening the SSH tunnel to T3 port 3773");
};

const asRecord = (value: unknown, operation: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw smokeError(operation, "T3 returned an invalid object payload.");
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

class LiveThreadSmokeTransport implements ThreadSmokeTransport {
  readonly #config: CloudboxConfig;
  readonly #host: string;
  readonly #origin: string;
  readonly #token: string;
  readonly #tunnel: ChildProcessWithoutNullStreams;

  constructor(
    config: CloudboxConfig,
    host: string,
    origin: string,
    token: string,
    tunnel: ChildProcessWithoutNullStreams,
  ) {
    this.#config = config;
    this.#host = host;
    this.#origin = origin;
    this.#token = token;
    this.#tunnel = tunnel;
  }

  async close(): Promise<void> {
    if (this.#tunnel.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#tunnel.kill("SIGKILL");
      }, 2_000);
      this.#tunnel.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#tunnel.kill("SIGTERM");
    });
  }

  async #remoteJson(
    operation: string,
    script: string,
    args: ReadonlyArray<string>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const output = await runCaptured(
      "ssh",
      [...sshArgs(this.#config, this.#host), "bash", "-s", "--", ...args],
      script,
      timeoutMs,
    );
    if (output.exitCode !== 0) {
      throw smokeError(operation, output.stderr.trim() || `ssh exited ${String(output.exitCode)}`);
    }
    try {
      return asRecord(JSON.parse(output.stdout.trim()) as unknown, operation);
    } catch (cause) {
      throw smokeError(operation, `Host returned invalid JSON: ${output.stdout.trim()}`, cause);
    }
  }

  async #jsonRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const operation = `${init.method ?? "GET"} ${path}`;
    const deadline = Date.now() + 90_000;
    let lastCause: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.#origin}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...init.headers,
          },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        if (!response.ok) {
          throw smokeError(
            operation,
            `T3 returned HTTP ${String(response.status)}${text.length > 0 ? `: ${text}` : ""}`,
          );
        }
        try {
          return text.length === 0 ? {} : JSON.parse(text) as unknown;
        } catch (cause) {
          throw smokeError(operation, "T3 returned invalid JSON.", cause);
        }
      } catch (cause) {
        if (cause instanceof ThreadSmokeError) throw cause;
        lastCause = cause;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw smokeError(operation, "T3 remained unreachable through the SSH tunnel for 90s.", lastCause);
  }

  async #webSocketTicket(): Promise<string> {
    const payload = asRecord(
      await this.#jsonRequest("/api/auth/websocket-ticket", { method: "POST" }),
      "websocket ticket",
    );
    const ticket = asString(payload.ticket);
    if (ticket === undefined || ticket.length === 0) {
      throw smokeError("websocket ticket", "T3 did not return a WebSocket ticket.");
    }
    return ticket;
  }

  async #rpcUnary(tag: string, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    const ticket = await this.#webSocketTicket();
    const wsUrl = this.#origin.replace(/^http/, "ws") +
      `/ws?wsTicket=${encodeURIComponent(ticket)}&clientSurface=cli&connectionMethod=direct`;
    const socket = new WebSocket(wsUrl);

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(reject, new Error(`${tag} timed out`)), 120_000);
      const finish = (complete: (value: never) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        complete(value as never);
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          _tag: "Request",
          id: 1,
          tag,
          payload,
          headers: [],
        }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = asRecord(JSON.parse(String(event.data)) as unknown, tag);
          if (message._tag === "Chunk" && message.requestId === 1) {
            socket.send(JSON.stringify({ _tag: "Ack", requestId: 1 }));
          }
          if (message._tag !== "Exit" || message.requestId !== 1) return;
          const exit = asRecord(message.exit, tag);
          if (exit._tag === "Success") {
            finish(resolve, exit.value);
          } else {
            finish(reject, new Error(`${tag} failed: ${JSON.stringify(exit)}`));
          }
        } catch (cause) {
          finish(reject, cause);
        }
      });
      socket.addEventListener("error", () => finish(reject, new Error(`${tag} WebSocket error`)));
      socket.addEventListener("close", () => {
        if (!settled) finish(reject, new Error(`${tag} WebSocket closed before completion`));
      });
    });
  }

  async readEnvironmentId(): Promise<string> {
    const descriptor = asRecord(
      await this.#jsonRequest("/.well-known/t3/environment"),
      "environment descriptor",
    );
    const environmentId = asString(descriptor.environmentId);
    if (environmentId === undefined || environmentId.length === 0) {
      throw smokeError("environment descriptor", "T3 did not return an environment id.");
    }
    return environmentId;
  }

  async readSettings(): Promise<ThreadSmokeSettings> {
    const settings = asRecord(await this.#rpcUnary("server.getSettings", {}), "server settings");
    const providers = asRecord(settings.providers, "server provider settings");
    const pi = asRecord(providers.pi, "pi provider settings");
    const providerInstancesValue = asRecord(
      settings.providerInstances,
      "provider instance settings",
    );
    const providerInstances = Object.fromEntries(
      Object.entries(providerInstancesValue).map(([instanceId, value]) => [
        instanceId,
        asRecord(value, `provider instance ${instanceId}`),
      ]),
    );
    return { pi, providerInstances };
  }

  async updateSettings(patch: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#rpcUnary("server.updateSettings", { patch });
  }

  async inspectMachine(
    threadId: string,
    machineName: string,
  ): Promise<ThreadSmokeMachineObservation> {
    const value = await this.#remoteJson(
      "inspect thread machine",
      `set -u
thread_id=$1
machine_name=$2
dataset="tank/threads/$thread_id/ws"
workspace="/tank/threads/$thread_id/ws"
rows=$(incus list "$machine_name" --format json 2>/dev/null || printf '[]')
instance_exists=$(printf '%s' "$rows" | jq 'length > 0')
instance_status=$(printf '%s' "$rows" | jq -r '.[0].status // "MISSING"')
if sudo -n zfs list -H -o name "$dataset" >/dev/null 2>&1; then dataset_exists=true; else dataset_exists=false; fi
if [ -e "$workspace" ]; then workspace_owner=$(stat -c '%u:%g' "$workspace"); else workspace_owner=MISSING; fi
if [ -f "$workspace/README.md" ]; then
  readme_exists=true
  readme_first_line=$(head -n 1 "$workspace/README.md")
else
  readme_exists=false
  readme_first_line=''
fi
jq -nc \
  --arg machineName "$machine_name" \
  --argjson instanceExists "$instance_exists" \
  --arg instanceStatus "$instance_status" \
  --arg dataset "$dataset" \
  --argjson datasetExists "$dataset_exists" \
  --arg workspaceOwner "$workspace_owner" \
  --argjson readmeExists "$readme_exists" \
  --arg readmeFirstLine "$readme_first_line" \
  '{machineName:$machineName,instanceExists:$instanceExists,instanceStatus:$instanceStatus,dataset:$dataset,datasetExists:$datasetExists,workspaceOwner:$workspaceOwner,readmeExists:$readmeExists,readmeFirstLine:$readmeFirstLine}'
`,
      [threadId, machineName],
    );
    return {
      machineName: asString(value.machineName) ?? machineName,
      instanceExists: value.instanceExists === true,
      instanceStatus: asString(value.instanceStatus) ?? "UNKNOWN",
      dataset: asString(value.dataset) ?? `tank/threads/${threadId}/ws`,
      datasetExists: value.datasetExists === true,
      workspaceOwner: asString(value.workspaceOwner) ?? "UNKNOWN",
      readmeExists: value.readmeExists === true,
      readmeFirstLine: asString(value.readmeFirstLine) ?? "",
    };
  }

  async inspectMachineCleanup(
    threadId: string,
    machineName: string,
  ): Promise<ThreadSmokeMachineCleanupObservation> {
    const value = await this.#remoteJson(
      "inspect thread machine cleanup",
      `set -u
thread_id=$1
machine_name=$2
dataset="tank/threads/$thread_id/ws"
instance_exists=true
instance_status=UNKNOWN
dataset_exists=true
for _ in $(seq 1 60); do
  rows=$(incus list "$machine_name" --format json 2>/dev/null || printf '[]')
  if [ "$(printf '%s' "$rows" | jq 'length')" -eq 0 ]; then
    instance_exists=false
    instance_status=MISSING
  else
    instance_exists=true
    instance_status=$(printf '%s' "$rows" | jq -r '.[0].status // "UNKNOWN"')
  fi
  if sudo -n zfs list -H -o name "$dataset" >/dev/null 2>&1; then dataset_exists=true; else dataset_exists=false; fi
  if [ "$instance_exists" = false ] && [ "$dataset_exists" = false ]; then break; fi
  sleep 0.5
done
if [ "$instance_exists" = false ] && [ "$dataset_exists" = false ]; then
  disposition=destroyed
elif [ "$instance_exists" = true ] && [ "\${instance_status^^}" != RUNNING ] && [ "$dataset_exists" = true ]; then
  disposition=archived
else
  disposition=incomplete
fi
jq -nc \
  --arg disposition "$disposition" \
  --arg machineName "$machine_name" \
  --argjson instanceExists "$instance_exists" \
  --arg instanceStatus "$instance_status" \
  --arg dataset "$dataset" \
  --argjson datasetExists "$dataset_exists" \
  '{disposition:$disposition,machineName:$machineName,instanceExists:$instanceExists,instanceStatus:$instanceStatus,dataset:$dataset,datasetExists:$datasetExists}'
`,
      [threadId, machineName],
      45_000,
    );
    const disposition = asString(value.disposition);
    return {
      disposition: disposition === "destroyed" || disposition === "archived"
        ? disposition
        : "incomplete",
      machineName: asString(value.machineName) ?? machineName,
      instanceExists: value.instanceExists === true,
      instanceStatus: asString(value.instanceStatus) ?? "UNKNOWN",
      dataset: asString(value.dataset) ?? `tank/threads/${threadId}/ws`,
      datasetExists: value.datasetExists === true,
    };
  }

  async refreshProviders(): Promise<ReadonlyArray<ThreadSmokeProvider>> {
    const result = asRecord(await this.#rpcUnary("server.refreshProviders", {}), "refresh providers");
    if (!Array.isArray(result.providers)) {
      throw smokeError("refresh providers", "T3 did not return a provider list.");
    }
    return result.providers.map((value) => {
      const provider = asRecord(value, "provider snapshot");
      const auth = asRecord(provider.auth, "provider auth");
      const models = Array.isArray(provider.models)
        ? provider.models.flatMap((modelValue) => {
            const model = asRecord(modelValue, "provider model");
            const slug = asString(model.slug);
            return slug === undefined ? [] : [slug];
          })
        : [];
      return {
        instanceId: asString(provider.instanceId) ?? "",
        driver: asString(provider.driver) ?? "",
        enabled: provider.enabled === true,
        installed: provider.installed === true,
        status: asString(provider.status) ?? "unknown",
        authStatus: asString(auth.status) ?? "unknown",
        ...(asString(provider.message) === undefined ? {} : { message: asString(provider.message)! }),
        ...(asString(provider.availability) === undefined
          ? {}
          : { availability: asString(provider.availability)! }),
        ...(asString(provider.unavailableReason) === undefined
          ? {}
          : { unavailableReason: asString(provider.unavailableReason)! }),
        models,
      } satisfies ThreadSmokeProvider;
    });
  }

  async readSnapshot(): Promise<ThreadSmokeSnapshot> {
    const value = asRecord(
      await this.#jsonRequest("/api/orchestration/snapshot"),
      "orchestration snapshot",
    );
    if (!Array.isArray(value.projects) || typeof value.snapshotSequence !== "number") {
      throw smokeError("orchestration snapshot", "T3 returned an invalid orchestration snapshot.");
    }
    return {
      snapshotSequence: value.snapshotSequence,
      projects: value.projects.map((projectValue) => {
        const project = asRecord(projectValue, "orchestration project");
        const machineMode = asString(project.machineMode);
        return {
          id: asString(project.id) ?? "",
          workspaceRoot: asString(project.workspaceRoot) ?? "",
          ...(machineMode === "off" || machineMode === "thread" ? { machineMode } : {}),
        };
      }),
    };
  }

  async readThread(threadId: string): Promise<ThreadSmokeThreadSnapshot> {
    const value = asRecord(
      await this.#jsonRequest(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
      "thread snapshot",
    );
    const thread = asRecord(value.thread, "thread snapshot");
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    const assistantText = messages.flatMap((messageValue) => {
      const message = asRecord(messageValue, "thread message");
      return message.role === "assistant" && typeof message.text === "string" ? [message.text] : [];
    }).join("\n").trim();
    const latestTurn = thread.latestTurn === null || thread.latestTurn === undefined
      ? undefined
      : asRecord(thread.latestTurn, "latest turn");
    const session = thread.session === null || thread.session === undefined
      ? undefined
      : asRecord(thread.session, "thread session");
    const machineValue = thread.machine === null || thread.machine === undefined
      ? undefined
      : asRecord(thread.machine, "thread machine binding");
    const machine = machineValue === undefined
      ? null
      : {
          machineId: asString(machineValue.machineId) ?? "",
          machineName: asString(machineValue.machineName) ?? "",
          state: asString(machineValue.state) ?? "unknown",
          hostWorkspaceRoot: asString(machineValue.hostWorkspaceRoot) ?? "",
          guestWorkspaceRoot: asString(machineValue.guestWorkspaceRoot) ?? "",
        } satisfies ThreadSmokeMachineBinding;
    if (typeof value.snapshotSequence !== "number") {
      throw smokeError("thread snapshot", "T3 returned no snapshot sequence.");
    }
    return {
      snapshotSequence: value.snapshotSequence,
      assistantText,
      latestTurnState: asString(latestTurn?.state) ?? null,
      sessionStatus: asString(session?.status) ?? null,
      lastError: asString(session?.lastError) ?? null,
      machine,
    };
  }

  async dispatch(command: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#jsonRequest("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }

  async #pollTurnAfterDisconnect(
    threadId: string,
    timeoutMs: number,
  ): Promise<ThreadSmokeThreadSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let lastCause: unknown;
    while (Date.now() < deadline) {
      try {
        const snapshot = await this.readThread(threadId);
        if (
          snapshot.latestTurnState === "completed" ||
          snapshot.latestTurnState === "error" ||
          snapshot.latestTurnState === "interrupted" ||
          snapshot.sessionStatus === "error" ||
          snapshot.sessionStatus === "stopped" ||
          snapshot.sessionStatus === "interrupted"
        ) {
          return snapshot;
        }
      } catch (cause) {
        lastCause = cause;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw smokeError(
      "wait for disconnected turn",
      `Turn did not reach a terminal state within ${String(timeoutMs / 1_000)}s after the event stream disconnected.`,
      lastCause,
    );
  }

  async runTurn(input: ThreadSmokeTurnInput): Promise<ThreadSmokeThreadSnapshot> {
    const ticket = await this.#webSocketTicket();
    const wsUrl = this.#origin.replace(/^http/, "ws") +
      `/ws?wsTicket=${encodeURIComponent(ticket)}&clientSurface=cli&connectionMethod=direct`;
    const socket = new WebSocket(wsUrl);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      let sawRunning = false;
      let ranRunningObserver = false;
      let recovering = false;
      let processing = Promise.resolve();
      const timer = setTimeout(
        () => finish(reject, new Error(`Turn timed out after ${String(input.timeoutMs / 1_000)}s`)),
        input.timeoutMs,
      );
      const finish = (complete: (value: never) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        complete(value as never);
      };
      const recoverAfterDisconnect = (cause: unknown) => {
        if (!started) {
          finish(reject, cause);
          return;
        }
        if (recovering || settled) return;
        recovering = true;
        void this.#pollTurnAfterDisconnect(input.threadId, input.timeoutMs)
          .then((snapshot) => finish(resolve, snapshot))
          .catch((pollCause: unknown) => finish(reject, pollCause));
      };
      const handleStreamItem = async (itemValue: unknown): Promise<void> => {
        const item = asRecord(itemValue, "thread subscription");
        if (item.kind === "synchronized" && !started) {
          started = true;
          await this.dispatch(input.command);
          return;
        }
        if (!started || item.kind !== "event") return;
        const event = asRecord(item.event, "thread event");
        if (event.type !== "thread.session-set") return;
        const eventPayload = asRecord(event.payload, "thread session event");
        const session = asRecord(eventPayload.session, "thread session event");
        const status = asString(session.status) ?? "unknown";
        if (status === "running") {
          sawRunning = true;
          if (!ranRunningObserver && input.onRunning !== undefined) {
            ranRunningObserver = true;
            await input.onRunning();
          }
          return;
        }
        if (!sawRunning || !["ready", "error", "interrupted", "stopped"].includes(status)) return;
        const snapshot = await this.readThread(input.threadId);
        finish(resolve, snapshot);
      };

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          _tag: "Request",
          id: 1,
          tag: "orchestration.subscribeThread",
          payload: {
            threadId: input.threadId,
            afterSequence: input.afterSequence,
            requestCompletionMarker: true,
          },
          headers: [],
        }));
      });
      socket.addEventListener("message", (messageEvent) => {
        processing = processing.then(async () => {
          const message = asRecord(
            JSON.parse(String(messageEvent.data)) as unknown,
            "thread subscription",
          );
          if (message._tag === "Chunk" && message.requestId === 1) {
            socket.send(JSON.stringify({ _tag: "Ack", requestId: 1 }));
            if (!Array.isArray(message.values)) {
              throw new Error("Thread subscription returned an invalid chunk");
            }
            for (const item of message.values) await handleStreamItem(item);
            return;
          }
          if (message._tag === "Exit" && message.requestId === 1 && !settled) {
            throw new Error(`Thread subscription ended early: ${JSON.stringify(message.exit)}`);
          }
        }).catch(recoverAfterDisconnect);
      });
      socket.addEventListener("error", () =>
        recoverAfterDisconnect(new Error("Thread subscription WebSocket error")),
      );
      socket.addEventListener("close", () => {
        if (!settled) {
          recoverAfterDisconnect(new Error("Thread subscription closed before turn completion"));
        }
      });
    });
  }
}

const acquireLiveTransport = async (
  config: CloudboxConfig,
  host: string,
): Promise<LiveThreadSmokeTransport> => {
  const token = await prepareRemote(config, host);
  const port = await reserveLocalPort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const tunnel = spawn(
    "ssh",
    [
      ...sshArgs(config, host, [
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-T",
        "-L",
        `127.0.0.1:${String(port)}:127.0.0.1:${String(T3_PORT)}`,
      ]),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    await waitForTunnel(origin, tunnel);
    return new LiveThreadSmokeTransport(config, host, origin, token, tunnel);
  } catch (cause) {
    tunnel.kill("SIGTERM");
    throw smokeError("open T3 SSH tunnel", "Could not reach the T3 server through SSH.", cause);
  }
};

export const makeSshThreadSmokeTransport = (
  config: CloudboxConfig,
  host: string,
): Effect.Effect<ThreadSmokeTransport, ThreadSmokeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireLiveTransport(config, host),
      catch: (cause) =>
        cause instanceof ThreadSmokeError
          ? cause
          : smokeError("connect to T3", "Could not create the T3 smoke transport.", cause),
    }),
    (transport) => Effect.promise(() => transport.close()),
  );
