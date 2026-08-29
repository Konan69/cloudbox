import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { spawn } from "node:child_process";
import * as Net from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatVerificationReport,
  runAcceptanceSuite,
  verificationReportJson,
  verifyIdleSleep,
  verifySleepRoundtrip,
  type VerificationReport,
} from "./acceptance/index.ts";
import {
  formatThreadSmokeReport,
  makeSshThreadSmokeTransport,
  runThreadSmokeSuite,
} from "./acceptance/threadSmoke.ts";
import type { CloudboxConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import {
  isRunningState,
  makeProviderLifecycle,
  type ProviderInstance,
  type ProviderLifecycle,
} from "./provider/lifecycle.ts";

export class CloudboxCliError extends Data.TaggedError("CloudboxCliError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type BoxInstance = ProviderInstance;

const cliError = (operation: string, message: string, cause?: unknown) =>
  new CloudboxCliError({ ...(cause === undefined ? {} : { cause }), operation, message });

const requireString = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(value).pipe(
    Effect.mapError((cause) => cliError(operation, `${operation} returned no value`, cause)),
  );

const withBox = <A, E>(
  effect: (
    config: CloudboxConfig,
    lifecycle: ProviderLifecycle,
    instance: BoxInstance,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* loadConfig("cloudbox.json");
    const lifecycle = makeProviderLifecycle(config);
    const instance = yield* lifecycle.status;
    return yield* effect(config, lifecycle, instance);
  });

const connectToPort = (host: string, port: number) =>
  Effect.callback<void, CloudboxCliError>((resume) => {
    const socket = Net.createConnection({ host, port });
    const finish = (result: Effect.Effect<void, CloudboxCliError>) => {
      socket.destroy();
      resume(result);
    };
    socket.setTimeout(5_000);
    socket.once("connect", () => finish(Effect.void));
    socket.once("timeout", () =>
      finish(Effect.fail(cliError("poll SSH", `Timed out connecting to ${host}:${String(port)}`))),
    );
    socket.once("error", (cause) =>
      finish(Effect.fail(cliError("poll SSH", `Cannot connect to ${host}:${String(port)}`, cause))),
    );
  });

const waitForSsh = (host: string) =>
  connectToPort(host, 22).pipe(
    Effect.retry({
      schedule: Schedule.recurs(150).pipe(Schedule.addDelay(() => Effect.succeed("2 seconds"))),
    }),
  );

const runProcess = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<void, CloudboxCliError>((resume) => {
    const child = spawn(command, [...args], { stdio: "inherit" });
    child.once("error", (cause) =>
      resume(Effect.fail(cliError(command, `Could not start ${command}`, cause))),
    );
    child.once("close", (code, signal) => {
      if (code === 0) {
        resume(Effect.void);
      } else if (code !== null) {
        resume(Effect.fail(cliError(command, `${command} exited with status ${String(code)}`)));
      } else if (signal !== null) {
        resume(Effect.fail(cliError(command, `${command} terminated by signal ${signal}`)));
      } else {
        resume(Effect.fail(cliError(command, `${command} terminated without an exit status`)));
      }
    });
  });

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type RsyncRunner = (
  path: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<ProcessOutput, CloudboxCliError>;

const runCapturedProcess = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<ProcessOutput, CloudboxCliError>((resume) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const complete = (effect: Effect.Effect<ProcessOutput, CloudboxCliError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      complete(Effect.fail(cliError(command, `Could not capture ${command} output`)));
      return;
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.once("error", (cause) =>
      complete(Effect.fail(cliError(command, `Could not start ${command}`, cause))),
    );
    child.once("close", (code, signal) => {
      if (code === 0) {
        complete(Effect.succeed({ stdout, stderr }));
      } else if (code !== null) {
        complete(Effect.fail(cliError(command, `${command} exited with status ${String(code)}`)));
      } else if (signal !== null) {
        complete(Effect.fail(cliError(command, `${command} terminated by signal ${signal}`)));
      } else {
        complete(Effect.fail(cliError(command, `${command} terminated without an exit status`)));
      }
    });
  });

const requirePublicIp = (instance: BoxInstance) => requireString("public IP", instance.publicIp);

const WakeServiceResponse = Schema.Struct({
  state: Schema.Literals(["running", "resuming"]),
});

const WakeStatusResponse = Schema.Struct({
  state: Schema.Literals(["suspended", "running", "resuming", "stopped", "other"]),
  gceStatus: Schema.String,
  name: Schema.NonEmptyString,
});

export const requestWakeViaService = (
  name: string,
  url: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
) =>
  Effect.gen(function* () {
    let endpoint: URL;
    try {
      endpoint = new URL(`${url.replace(/\/$/u, "")}/wake/${encodeURIComponent(name)}`);
    } catch (cause) {
      return yield* Effect.fail(
        cliError("wake service", "CLOUDBOX_WAKE_URL is not a valid URL", cause),
      );
    }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
      return yield* Effect.fail(
        cliError("wake service", "CLOUDBOX_WAKE_URL must use HTTPS"),
      );
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        }),
      catch: (cause) => cliError("wake service", "Wake service request failed", cause),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => cliError("wake service", "Could not read wake service response", cause),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        cliError(
          "wake service",
          `Wake service returned HTTP ${String(response.status)}${text.length === 0 ? "" : `: ${text}`}`,
        ),
      );
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WakeServiceResponse))(text).pipe(
      Effect.mapError((cause) =>
        cliError("wake service", "Wake service returned an invalid response", cause),
      ),
    );
  });

export const requestWakeStatusViaService = (
  name: string,
  url: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
) =>
  Effect.gen(function* () {
    let endpoint: URL;
    try {
      endpoint = new URL(`${url.replace(/\/$/u, "")}/status/${encodeURIComponent(name)}`);
    } catch (cause) {
      return yield* Effect.fail(
        cliError("wake service", "CLOUDBOX_WAKE_URL is not a valid URL", cause),
      );
    }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
      return yield* Effect.fail(
        cliError("wake service", "CLOUDBOX_WAKE_URL must use HTTPS"),
      );
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(endpoint, {
          method: "GET",
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        }),
      catch: (cause) => cliError("wake service", "Wake status request failed", cause),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => cliError("wake service", "Could not read wake status response", cause),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        cliError(
          "wake service",
          `Wake status returned HTTP ${String(response.status)}${text.length === 0 ? "" : `: ${text}`}`,
        ),
      );
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WakeStatusResponse))(text).pipe(
      Effect.mapError((cause) =>
        cliError("wake service", "Wake status returned an invalid response", cause),
      ),
    );
  });

const waitForProviderRunning = (lifecycle: ProviderLifecycle) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const instance = yield* lifecycle.status;
      if (isRunningState(lifecycle.provider, instance.state)) return instance;
      yield* Effect.sleep("5 seconds");
    }
    return yield* Effect.fail(
      cliError("wake service", "Instance did not reach RUNNING in 10 minutes"),
    );
  });

const statusCommand = Command.make("status").pipe(
  Command.withDescription("Show the provider and wake-service box state."),
  Command.withHandler(() =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        yield* Console.log(
          JSON.stringify(
            {
              provider: config.provider,
              instanceId: instance.instanceId,
              state: instance.state,
              publicIp: instance.publicIp,
            },
            null,
            2,
          ),
        );

        const wakeUrl = process.env.CLOUDBOX_WAKE_URL?.trim();
        const wakeSecret = process.env.CLOUDBOX_WAKE_SECRET?.trim();
        const missing = [
          ...(wakeUrl === undefined || wakeUrl.length === 0 ? ["CLOUDBOX_WAKE_URL"] : []),
          ...(wakeSecret === undefined || wakeSecret.length === 0
            ? ["CLOUDBOX_WAKE_SECRET"]
            : []),
        ];
        if (missing.length > 0) {
          yield* Console.log(`Wake service: skipped (${missing.join(" and ")} not set).`);
          return;
        }

        const serviceStatus = yield* requestWakeStatusViaService(
          config.name,
          wakeUrl!,
          wakeSecret!,
        );
        yield* Console.log(`Wake service: ${JSON.stringify(serviceStatus)}`);
      }),
    ),
  ),
);

const viaServiceFlag = Flag.boolean("via-service").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Wake through the deployed Cloud Run service instead of direct GCP credentials."),
);

const wakeCommand = Command.make("wake", { viaService: viaServiceFlag }).pipe(
  Command.withDescription("Start or resume the box, wait for SSH, then print its IP."),
  Command.withHandler(({ viaService }) =>
    withBox((config, lifecycle, _instance) =>
      Effect.gen(function* () {
        let running: BoxInstance;
        if (viaService) {
          if (config.provider !== "gcp") {
            return yield* Effect.fail(
              cliError("wake service", "--via-service is available only for GCP cloudboxes"),
            );
          }
          const wakeUrl = process.env.CLOUDBOX_WAKE_URL?.trim();
          const wakeSecret = process.env.CLOUDBOX_WAKE_SECRET?.trim();
          if (wakeUrl === undefined || wakeUrl.length === 0) {
            return yield* Effect.fail(
              cliError("wake service", "CLOUDBOX_WAKE_URL is required with --via-service"),
            );
          }
          if (wakeSecret === undefined || wakeSecret.length === 0) {
            return yield* Effect.fail(
              cliError("wake service", "CLOUDBOX_WAKE_SECRET is required with --via-service"),
            );
          }
          yield* requestWakeViaService(config.name, wakeUrl, wakeSecret);
          running = yield* waitForProviderRunning(lifecycle);
        } else {
          running = yield* lifecycle.wake;
        }
        const publicIp = yield* requirePublicIp(running);
        yield* waitForSsh(publicIp);
        yield* Console.log(publicIp);
      }),
    ),
  ),
);

const sleepCommand = Command.make("sleep").pipe(
  Command.withDescription("Hibernate or suspend the box through its provider."),
  Command.withHandler(() =>
    withBox((_config, lifecycle, _instance) => lifecycle.sleep),
  ),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print rsync changes without modifying the box."),
);

const forceFlag = Flag.boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Transfer even when the dry-run total exceeds identity.maxTransferMb."),
);

const withTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path : `${path}/`;

export interface RsyncArgsInput {
  readonly path: string;
  readonly localHome: string;
  readonly boxUser: string;
  readonly publicIp: string;
  readonly excludes: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

export const buildRsyncArgs = ({
  path,
  localHome,
  boxUser,
  publicIp,
  excludes,
  dryRun,
}: RsyncArgsInput): ReadonlyArray<string> => {
  const directory = path.endsWith("/");
  const relativePath = path.slice(2);
  const expanded = NodePath.join(localHome, relativePath);
  const source = directory ? withTrailingSlash(expanded) : expanded;
  const remotePath = directory ? withTrailingSlash(path) : path;
  return [
    "-az",
    "--mkpath",
    "--info=stats2,name1",
    ...(dryRun ? ["--dry-run"] : []),
    ...excludes.map((exclude) => `--exclude=${exclude}`),
    "--",
    source,
    `${boxUser}@${publicIp}:${remotePath}`,
  ];
};

export interface RsyncStats {
  readonly path: string;
  readonly files: number;
  readonly bytesToTransfer: number;
}

const parseRsyncMetric = (path: string, output: string, label: string) =>
  Effect.try({
    try: () => {
      const match = new RegExp(`^${label}: ([0-9,]+)`, "m").exec(output);
      if (match === null || match[1] === undefined) {
        throw new Error(`missing ${label}`);
      }
      const value = Number(match[1].replaceAll(",", ""));
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid ${label}`);
      }
      return value;
    },
    catch: (cause) =>
      cliError("parse rsync stats", `Invalid rsync statistics for ${path}: ${label}`, cause),
  });

export const parseRsyncStats = (path: string, output: string) =>
  Effect.gen(function* () {
    const files = yield* parseRsyncMetric(path, output, "Number of regular files transferred");
    const bytesToTransfer = yield* parseRsyncMetric(
      path,
      output,
      "Total transferred file size",
    );
    return { path, files, bytesToTransfer } satisfies RsyncStats;
  });

const formatSyncSummary = (prefix: string, stats: RsyncStats): string =>
  `${prefix} ${stats.path}: ${String(stats.files)} files, ${String(stats.bytesToTransfer)} bytes to transfer`;

export const enforceTransferLimit = (
  stats: ReadonlyArray<RsyncStats>,
  maxTransferMb: number,
  force: boolean,
) => {
  const totalBytes = stats.reduce((total, item) => total + item.bytesToTransfer, 0);
  const maxBytes = maxTransferMb * 1_000_000;
  if (force || totalBytes <= maxBytes) return Effect.void;
  const perPath = stats
    .map((item) => `  ${item.path}: ${String(item.bytesToTransfer)} bytes`)
    .join("\n");
  return Effect.fail(
    cliError(
      "identity sync size guard",
      `Identity sync would transfer ${String(totalBytes)} bytes, exceeding identity.maxTransferMb=${String(maxTransferMb)}.\n${perPath}\nAdd identity.excludes entries or rerun with --force.`,
    ),
  );
};

export interface IdentitySyncInput {
  readonly paths: ReadonlyArray<string>;
  readonly excludes: ReadonlyArray<string>;
  readonly maxTransferMb: number;
  readonly localHome: string;
  readonly boxUser: string;
  readonly publicIp: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

export const runIdentitySync = (input: IdentitySyncInput, runner: RsyncRunner) => {
  const runPass = (dryRun: boolean, prefix: string) =>
    Effect.forEach(input.paths, (path) =>
      runner(
        path,
        buildRsyncArgs({
          path,
          localHome: input.localHome,
          boxUser: input.boxUser,
          publicIp: input.publicIp,
          excludes: input.excludes,
          dryRun,
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cliError("identity sync", `rsync failed for ${path}: ${cause.message}`, cause),
        ),
        Effect.flatMap((output) => parseRsyncStats(path, output.stdout)),
        Effect.tap((stats) => Console.log(formatSyncSummary(prefix, stats))),
      ),
    );

  return Effect.gen(function* () {
    if (input.dryRun) {
      yield* runPass(true, "Dry run");
      return;
    }
    const preflight = yield* runPass(true, "Preflight");
    yield* enforceTransferLimit(preflight, input.maxTransferMb, input.force);
    yield* runPass(false, "Transferred");
  });
};

const liveRsyncRunner: RsyncRunner = (_path, args) => runCapturedProcess("rsync", args);

const syncCommand = Command.make("sync", { dryRun: dryRunFlag, force: forceFlag }).pipe(
  Command.withDescription("Rsync configured identity paths to the running box."),
  Command.withHandler(({ dryRun, force }) =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        const publicIp = yield* requirePublicIp(instance);
        yield* runIdentitySync(
          {
            paths: config.identity.paths,
            excludes: config.identity.excludes,
            maxTransferMb: config.identity.maxTransferMb,
            localHome: NodeOs.homedir(),
            boxUser: config.boxUser,
            publicIp,
            dryRun,
            force,
          },
          liveRsyncRunner,
        );
      }),
    ),
  ),
);

const sshCommand = Command.make("ssh").pipe(
  Command.withDescription("Open an interactive SSH session to the running box."),
  Command.withHandler(() =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        const publicIp = yield* requirePublicIp(instance);
        yield* runProcess("ssh", [`${config.boxUser}@${publicIp}`]);
      }),
    ),
  ),
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON instead of a table."),
);

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDefault(7_200),
  Flag.withDescription("Maximum time in seconds."),
);

const printVerificationReport = (report: VerificationReport, json: boolean) =>
  Effect.gen(function* () {
    yield* Console.log(json ? verificationReportJson(report) : formatVerificationReport(report));
    if (!report.ok) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  });

const verifyCommand = Command.make("verify", {
  host: Flag.string("host").pipe(Flag.withDescription("Public IP or hostname to verify.")),
  expectVm: Flag.boolean("expect-vm").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Also launch and test an Incus VM through /dev/kvm."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run the end-to-end host acceptance suite over SSH."),
  Command.withHandler(({ expectVm, host, json }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig("cloudbox.json");
      const report = yield* runAcceptanceSuite(config, host, expectVm);
      yield* printVerificationReport(report, json);
    }),
  ),
);

const smokeThreadCommand = Command.make("smoke-thread", {
  host: Flag.string("host").pipe(Flag.withDescription("Public IP or hostname running T3.")),
  timeout: Flag.integer("timeout").pipe(
    Flag.withDefault(240),
    Flag.withDescription("Maximum seconds for each provider turn."),
  ),
  keepProject: Flag.boolean("keep-project").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Leave the smoke project in the T3 environment after the run."),
  ),
  machineMode: Flag.boolean("machine-mode").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Run smoke threads in project-scoped Incus machines."),
  ),
}).pipe(
  Command.withDescription("Run autonomous pi and Codex agent turns through the remote T3 server."),
  Command.withHandler(({ host, keepProject, machineMode, timeout }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig("cloudbox.json");
      const transport = yield* makeSshThreadSmokeTransport(config, host);
      const report = yield* runThreadSmokeSuite(transport, {
        keepProject,
        machineMode,
        timeoutSeconds: timeout,
      });
      yield* Console.log(formatThreadSmokeReport(report));
      if (!report.ok) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }),
  ),
);

const verifySleepCommand = Command.make("verify-sleep", {
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Hibernate or suspend, wake, and prove memory survived."),
  Command.withHandler(({ json, timeout }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig("cloudbox.json");
      const report = yield* verifySleepRoundtrip(
        config,
        makeProviderLifecycle(config),
        timeout,
      );
      yield* printVerificationReport(report, json);
    }),
  ),
);

const verifyIdleCommand = Command.make("verify-idle", {
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Leave the host untouched and verify automatic idle sleep."),
  Command.withHandler(({ json, timeout }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig("cloudbox.json");
      const report = yield* verifyIdleSleep(
        config,
        makeProviderLifecycle(config),
        timeout,
      );
      yield* printVerificationReport(report, json);
    }),
  ),
);

export const cloudbox = Command.make("cloudbox").pipe(
  Command.withDescription("Control and verify one personal Cloudbox machine on AWS or GCP."),
  Command.withSubcommands([
    statusCommand,
    wakeCommand,
    sleepCommand,
    syncCommand,
    sshCommand,
    verifyCommand,
    smokeThreadCommand,
    verifySleepCommand,
    verifyIdleCommand,
  ]),
);

const program = Command.run(cloudbox, { version: "0.1.0" }).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(program);
}
