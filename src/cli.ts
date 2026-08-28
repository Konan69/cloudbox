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
import type { CloudboxConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import {
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

const requirePublicIp = (instance: BoxInstance) => requireString("public IP", instance.publicIp);

const statusCommand = Command.make("status").pipe(
  Command.withDescription("Show the box state and public IP."),
  Command.withHandler(() =>
    withBox((config, _lifecycle, instance) =>
      Console.log(
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
      ),
    ),
  ),
);

const wakeCommand = Command.make("wake").pipe(
  Command.withDescription("Start or resume the box, wait for SSH, then print its IP."),
  Command.withHandler(() =>
    withBox((_config, lifecycle, _instance) =>
      Effect.gen(function* () {
        const running = yield* lifecycle.wake;
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
  Flag.withDescription("Print rsync changes without modifying the box."),
);

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), path.slice(2))
    : NodePath.resolve(path);

const syncCommand = Command.make("sync", { dryRun: dryRunFlag }).pipe(
  Command.withDescription("Rsync configured identity paths to the running box."),
  Command.withHandler(({ dryRun }) =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        const publicIp = yield* requirePublicIp(instance);
        for (const path of config.identity.paths) {
          const args = ["-az", "--mkpath"];
          if (dryRun) args.push("--dry-run");
          for (const exclude of config.identity.excludes) args.push(`--exclude=${exclude}`);
          args.push(expandHome(path), `${config.boxUser}@${publicIp}:${path}`);
          yield* runProcess("rsync", args);
        }
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
