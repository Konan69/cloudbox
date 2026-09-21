import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import {
  BootstrapCloneError,
  runBootstrapClone,
  type BootstrapCloneRunner,
} from "./bootstrap/clone.ts";
import {
  BoatApiError,
  BoatConfigError,
  makeBoatClientFromEnvironment,
  type BoatClientError,
  type BoatClientShape,
  type BoatSandbox,
} from "./boat/client.ts";
import {
  BOAT_WINDOWS_IDENTITY,
  BoatSshConfigError,
  BoatSshProxyError,
  renderBoatWindowsSshBlock,
  runBoatSshProxy,
  updateBoatManagedSshConfig,
} from "./boat/ssh.ts";
import type {
  AwsCloudboxConfig,
  BoatCloudboxConfig,
  CloudboxConfig,
  GcpCloudboxConfig,
  RepoConfig,
} from "./config.ts";
import { loadConfig } from "./config.ts";
import {
  deriveMachineIdentityManifest,
  machineIdentityManifestPath,
  renderMachineIdentityManifest,
  type MachineIdentityManifest,
} from "./identity/manifest.ts";
import {
  isRunningState,
  makeProviderLifecycle,
  type ProviderInstance,
  type ProviderLifecycle,
} from "./provider/lifecycle.ts";
import {
  assertSshPrerequisites,
  requireSshTransport,
  SshTransportError,
  type SshTransport,
} from "./ssh/transport.ts";
import {
  buildRepoCloneScript,
  buildRepoFetchScript,
  buildRepoInspectScript,
  parseRepoInspection,
  RepoParityError,
  runRepoParity,
  type RepoSyncOperator,
} from "./sync/repos.ts";
import {
  buildT3ParityPublishScript,
  filterPortableT3Settings,
} from "./t3/settingsParity.ts";

export class CloudboxCliError extends Data.TaggedError("CloudboxCliError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type BoxInstance = ProviderInstance;
type InfrastructureCloudboxConfig = AwsCloudboxConfig | GcpCloudboxConfig;

const cliError = (operation: string, message: string, cause?: unknown) =>
  new CloudboxCliError({ ...(cause === undefined ? {} : { cause }), operation, message });

const requireString = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(value).pipe(
    Effect.mapError((cause) => cliError(operation, `${operation} returned no value`, cause)),
  );

const requireInfrastructureConfig = (config: CloudboxConfig) =>
  config.provider === "boat"
    ? Effect.fail(
        cliError(
          "provider command",
          "This command supports AWS and GCP. Use the `cloudbox boat` command group for a Boat config.",
        ),
      )
    : Effect.succeed(config);

const withBox = <A, E, R>(
  effect: (
    config: InfrastructureCloudboxConfig,
    lifecycle: ProviderLifecycle,
    instance: BoxInstance,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const loadedConfig = yield* loadConfig("cloudbox.json");
    const config = yield* requireInfrastructureConfig(loadedConfig);
    const lifecycle = makeProviderLifecycle(config);
    const instance = yield* lifecycle.status;
    return yield* effect(config, lifecycle, instance);
  });

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

const waitForSsh = (transport: SshTransport) =>
  runProcess("ssh", [
    ...transport.args({ batchMode: true, connectTimeoutSeconds: 5 }),
    "true",
  ]).pipe(
    Effect.retry({
      schedule: Schedule.recurs(150).pipe(Schedule.addDelay(() => Effect.succeed("2 seconds"))),
    }),
  );

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type RsyncRunner = (
  path: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<ProcessOutput, CloudboxCliError>;

const runCapturedProcess = (
  command: string,
  args: ReadonlyArray<string>,
  input?: string,
  streamOutput = true,
) =>
  Effect.callback<ProcessOutput, CloudboxCliError>((resume) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    if (input !== undefined) {
      if (child.stdin === null) {
        child.kill();
        complete(Effect.fail(cliError(command, `Could not write ${command} input`)));
        return;
      }
      child.stdin.end(input);
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      if (streamOutput) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      if (streamOutput) process.stderr.write(text);
    });
    child.once("error", (cause) =>
      complete(Effect.fail(cliError(command, `Could not start ${command}`, cause))),
    );
    child.once("close", (code, signal) => {
      const stderrDetail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`;
      if (code === 0) {
        complete(Effect.succeed({ stdout, stderr }));
      } else if (code !== null) {
        complete(
          Effect.fail(
            cliError(command, `${command} exited with status ${String(code)}${stderrDetail}`),
          ),
        );
      } else if (signal !== null) {
        complete(
          Effect.fail(cliError(command, `${command} terminated by signal ${signal}${stderrDetail}`)),
        );
      } else {
        complete(
          Effect.fail(cliError(command, `${command} terminated without an exit status${stderrDetail}`)),
        );
      }
    });
  });

const requirePublicIp = (instance: BoxInstance) => requireString("public IP", instance.publicIp);

const sshTransportError = (cause: unknown) =>
  cliError(
    "SSH transport",
    cause instanceof SshTransportError ? cause.message : "Could not configure SSH transport",
    cause,
  );

const checkSshPrerequisites = (config: CloudboxConfig) =>
  Effect.try({
    try: () => assertSshPrerequisites(config),
    catch: sshTransportError,
  });

const makeSshTransport = (config: CloudboxConfig, awsHost?: string) =>
  Effect.try({
    try: () => requireSshTransport(config, awsHost),
    catch: sshTransportError,
  });

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
  Command.withDescription("Show the box state, access path, and wake-service view."),
  Command.withHandler(() =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        yield* Console.log(
          JSON.stringify(
            {
              provider: config.provider,
              instanceName: config.provider === "gcp" ? instance.instanceId : undefined,
              instanceId: instance.instanceId,
              zone: config.provider === "gcp" ? config.gcp.zone : undefined,
              region: config.provider === "aws" ? config.region : undefined,
              state: instance.state,
              access: config.provider === "gcp" ? "ssh via IAP" : "direct SSH",
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
  Command.withDescription("Start or resume the box, wait for SSH, then print its host."),
  Command.withHandler(({ viaService }) =>
    withBox((config, lifecycle, _instance) =>
      Effect.gen(function* () {
        yield* checkSshPrerequisites(config);
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
        const awsHost = config.provider === "aws"
          ? yield* requirePublicIp(running)
          : undefined;
        const transport = yield* makeSshTransport(config, awsHost);
        yield* waitForSsh(transport);
        yield* Console.log(transport.host);
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

const bootstrapForceFlag = Flag.boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Transfer even when a leg exceeds bootstrap.maxTransferMb."),
);

const withTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path : `${path}/`;

export interface RsyncArgsInput {
  readonly path: string;
  readonly localHome: string;
  readonly transport: SshTransport;
  readonly excludes: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

export const buildRsyncArgs = ({
  path,
  localHome,
  transport,
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
    // Replace a non-empty directory on the box when the local side became a symlink/file.
    "--force",
    "--mkpath",
    "--info=stats2,name1",
    "-e",
    transport.rsyncRemoteShell({ batchMode: true }),
    ...(dryRun ? ["--dry-run"] : []),
    ...excludes.map((exclude) => `--exclude=${exclude}`),
    "--",
    source,
    `${transport.target}:${remotePath}`,
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
  readonly transport: SshTransport;
  readonly dryRun: boolean;
  readonly force: boolean;
}

export interface IdentityManifestPublishInput {
  readonly manifest: MachineIdentityManifest;
  readonly boxUser: string;
  readonly transport: SshTransport;
}

export type IdentityManifestPublisher = (
  input: IdentityManifestPublishInput,
) => Effect.Effect<void, CloudboxCliError>;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildIdentityManifestPublishScript = (
  manifest: MachineIdentityManifest,
  boxUser: string,
): string => {
  const manifestPath = machineIdentityManifestPath(boxUser);
  const manifestDirectory = NodePath.posix.dirname(manifestPath);
  const unitPath = `/home/${boxUser}/.config/systemd/user/t3code-fork.service`;
  const environmentLine = `Environment=T3_MACHINE_IDENTITY_MANIFEST=${manifestPath}`;
  const encodedManifest = Buffer.from(
    renderMachineIdentityManifest(manifest),
    "utf8",
  ).toString("base64");

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
readonly MANIFEST_PATH=${shellQuote(manifestPath)}
readonly MANIFEST_DIRECTORY=${shellQuote(manifestDirectory)}
readonly UNIT_PATH=${shellQuote(unitPath)}
readonly ENVIRONMENT_LINE=${shellQuote(environmentLine)}

install -d -m 700 "$MANIFEST_DIRECTORY"
temporary="$(mktemp "$MANIFEST_DIRECTORY/.machine-identity.XXXXXX")"
cleanup() {
  if [[ -n "$temporary" ]]; then rm -f "$temporary"; fi
}
trap cleanup EXIT
printf '%s' '${encodedManifest}' | base64 --decode > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$MANIFEST_PATH"
temporary=''

missing=()
while IFS= read -r host_path; do
  if [[ ! -d "$host_path" ]]; then missing+=("$host_path"); fi
done < <(jq -r '.mounts[] | .hostPath' "$MANIFEST_PATH")
if (( ${"$"}{#missing[@]} > 0 )); then
  printf 'Machine identity mount directories are missing after sync:\n' >&2
  printf '  %s\n' "${"$"}{missing[@]}" >&2
  printf 'Identity sync is incomplete.\n' >&2
  exit 1
fi

test -f "$UNIT_PATH" || {
  printf 'Cannot update missing T3 user unit: %s\n' "$UNIT_PATH" >&2
  exit 1
}
grep -Fqx '[Service]' "$UNIT_PATH" || {
  printf 'T3 user unit has no [Service] section: %s\n' "$UNIT_PATH" >&2
  exit 1
}
manifest_line_count="$(grep -c '^Environment=T3_MACHINE_IDENTITY_MANIFEST=' "$UNIT_PATH" || true)"
if [[ "$manifest_line_count" != 1 ]] || ! grep -Fqx "$ENVIRONMENT_LINE" "$UNIT_PATH"; then
  sed -i '/^Environment=T3_MACHINE_IDENTITY_MANIFEST=/d' "$UNIT_PATH"
  sed -i "/^\\[Service\\]$/a $ENVIRONMENT_LINE" "$UNIT_PATH"
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload
  printf 'Updated t3code-fork.service with T3_MACHINE_IDENTITY_MANIFEST. Restart required: systemctl --user restart t3code-fork.service\n'
fi
`;
};

export const runIdentitySync = (
  input: IdentitySyncInput,
  runner: RsyncRunner,
  publishManifest: IdentityManifestPublisher,
) => {
  const runPass = (dryRun: boolean, prefix: string) =>
    Effect.forEach(input.paths, (path) =>
      runner(
        path,
        buildRsyncArgs({
          path,
          localHome: input.localHome,
          transport: input.transport,
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
    yield* publishManifest({
      manifest: deriveMachineIdentityManifest(input.paths, input.boxUser),
      boxUser: input.boxUser,
      transport: input.transport,
    });
  });
};

const liveRsyncRunner: RsyncRunner = (_path, args) => runCapturedProcess("rsync", args);

const liveBootstrapCloneRunner: BootstrapCloneRunner = (leg, path, args) =>
  runCapturedProcess("rsync", args).pipe(
    Effect.mapError(
      (cause) =>
        new BootstrapCloneError({
          operation: `bootstrap ${leg}`,
          message: `rsync failed for ${path}: ${cause.message}`,
          cause,
        }),
    ),
  );

const liveIdentityManifestPublisher: IdentityManifestPublisher = ({
  manifest,
  boxUser,
  transport,
}) =>
  runCapturedProcess(
    "ssh",
    [...transport.args({ batchMode: true }), "bash", "-s"],
    buildIdentityManifestPublishScript(manifest, boxUser),
  ).pipe(
    Effect.mapError((cause) =>
      cliError(
        "machine identity manifest",
        `Failed to publish machine identity manifest: ${cause.message}`,
        cause,
      ),
    ),
    Effect.map(() => undefined),
  );

const remoteRepoError = (
  repo: RepoConfig,
  operation: string,
  cause: CloudboxCliError,
) =>
  new RepoParityError({
    path: repo.path,
    message: `${operation} failed for ${repo.path}: ${cause.message}`,
    cause,
  });

const makeLiveRepoSyncOperator = (transport: SshTransport): RepoSyncOperator => {
  const remoteArgs = [...transport.args({ batchMode: true }), "bash", "-s"];
  return {
    inspect: (repo) =>
      runCapturedProcess("ssh", remoteArgs, buildRepoInspectScript(repo), false).pipe(
        Effect.mapError((cause) => remoteRepoError(repo, "Repository inspection", cause)),
        Effect.flatMap((output) =>
          Effect.try({
            try: () => parseRepoInspection(output.stdout),
            catch: (cause) =>
              new RepoParityError({
                path: repo.path,
                message: `Could not parse repository inspection for ${repo.path}`,
                cause,
              }),
          }),
        ),
      ),
    clone: (repo) =>
      runCapturedProcess("ssh", remoteArgs, buildRepoCloneScript(repo)).pipe(
        Effect.mapError((cause) => remoteRepoError(repo, "git clone", cause)),
        Effect.map(() => undefined),
      ),
    fetch: (repo) =>
      runCapturedProcess("ssh", remoteArgs, buildRepoFetchScript(repo)).pipe(
        Effect.mapError((cause) => remoteRepoError(repo, "git fetch --prune origin", cause)),
        Effect.map(() => undefined),
      ),
  };
};

const readOptionalParityFile = (path: string, label: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError((cause) =>
        cliError("T3 settings parity", `Could not check local ${label} at ${path}`, cause),
      ),
    );
    if (!exists) {
      yield* Console.log(`T3 ${label} parity skipped: local file missing: ${path}`);
      return undefined;
    }
    return yield* fs.readFileString(path).pipe(
      Effect.mapError((cause) =>
        cliError("T3 settings parity", `Could not read local ${label} at ${path}`, cause),
      ),
    );
  });

const runT3SettingsParity = (
  localHome: string,
  keybindingsEnabled: boolean,
  transport: SshTransport,
) =>
  Effect.gen(function* () {
    const settingsPath = NodePath.join(localHome, ".t3", "userdata", "settings.json");
    const settingsContents = yield* readOptionalParityFile(settingsPath, "settings");
    let settingsJson: string | undefined;
    if (settingsContents !== undefined) {
      const parsed = yield* Effect.try({
        try: (): unknown => {
          const value: unknown = JSON.parse(settingsContents);
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("settings root must be a JSON object");
          }
          return value;
        },
        catch: (cause) =>
          cliError("T3 settings parity", `Invalid local T3 settings JSON at ${settingsPath}`, cause),
      });
      settingsJson = `${JSON.stringify(filterPortableT3Settings(parsed), null, 2)}\n`;
    }

    let keybindings: string | undefined;
    if (keybindingsEnabled) {
      const keybindingsPath = NodePath.join(
        localHome,
        ".t3",
        "userdata",
        "keybindings.json",
      );
      keybindings = yield* readOptionalParityFile(keybindingsPath, "keybindings");
    }

    if (settingsJson === undefined && keybindings === undefined) return;
    const payload = {
      ...(settingsJson === undefined ? {} : { settingsJson }),
      ...(keybindings === undefined ? {} : { keybindings }),
    };
    yield* runCapturedProcess(
      "ssh",
      [...transport.args({ batchMode: true }), "bash", "-s"],
      buildT3ParityPublishScript(payload),
    ).pipe(
      Effect.mapError((cause) =>
        cliError(
          "T3 settings parity",
          `Failed to publish filtered T3 settings: ${cause.message}`,
          cause,
        ),
      ),
    );
  });

const runSyncOverTransport = (
  config: CloudboxConfig,
  transport: SshTransport,
  dryRun: boolean,
  force: boolean,
  publishMachineIdentity = true,
) =>
  Effect.gen(function* () {
    const localHome = NodeOs.homedir();
    yield* runIdentitySync(
      {
        paths: config.identity.paths,
        excludes: config.identity.excludes,
        maxTransferMb: config.identity.maxTransferMb,
        localHome,
        boxUser: config.boxUser,
        transport,
        dryRun,
        force,
      },
      liveRsyncRunner,
      publishMachineIdentity ? liveIdentityManifestPublisher : () => Effect.void,
    );
    if (dryRun) return;
    yield* runRepoParity(config.repos, makeLiveRepoSyncOperator(transport)).pipe(
      Effect.mapError((cause) =>
        cliError("repository parity", cause.message, cause),
      ),
    );
    if (config.t3.settingsParity.enabled) {
      yield* runT3SettingsParity(
        localHome,
        config.t3.settingsParity.keybindings,
        transport,
      );
    }
  });

const syncCommand = Command.make("sync", { dryRun: dryRunFlag, force: forceFlag }).pipe(
  Command.withDescription("Push identity, repositories, and filtered T3 settings to the running box."),
  Command.withHandler(({ dryRun, force }) =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        const awsHost = config.provider === "aws"
          ? yield* requirePublicIp(instance)
          : undefined;
        const transport = yield* makeSshTransport(config, awsHost);
        yield* runSyncOverTransport(config, transport, dryRun, force);
      }),
    ),
  ),
);

const fromConfigFlag = Flag.string("from-config").pipe(
  Flag.withDescription("Source Cloudbox config. The current cloudbox.json is the destination."),
);

const cacheDirFlag = Flag.string("cache-dir").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "Persistent local cache for resumable deltas (default: ~/.cache/cloudbox/bootstrap/<source>-to-<destination>).",
  ),
);

const bootstrapCacheSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "") || "box";

const bootstrapCacheIdentity = (config: CloudboxConfig): string =>
  bootstrapCacheSegment(
    config.provider === "aws"
      ? `aws-${config.region}-${config.name}`
      : config.provider === "gcp"
        ? `gcp-${config.gcp.project}-${config.gcp.zone}-${config.name}`
        : `boat-${config.name}`,
  );

const resolveLocalPath = (path: string): string =>
  path === "~" || path.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), path.slice(2))
    : NodePath.resolve(path);

const bootstrapConfig = (config: CloudboxConfig, configPath: string) => {
  if (config.bootstrap !== undefined && config.bootstrap.paths.length > 0) {
    return Effect.succeed(config.bootstrap);
  }
  return Effect.fail(
    cliError(
      "bootstrap clone",
      `${configPath} must declare at least one bootstrap.paths entry before it can ${configPath === "cloudbox.json" ? "receive" : "send"} a bootstrap clone.`,
    ),
  );
};

const runningTransport = (loadedConfig: CloudboxConfig) =>
  Effect.gen(function* () {
    const config = yield* requireInfrastructureConfig(loadedConfig);
    yield* checkSshPrerequisites(config);
    const instance = yield* makeProviderLifecycle(config).wake;
    const host = config.provider === "aws" ? yield* requirePublicIp(instance) : undefined;
    const transport = yield* makeSshTransport(config, host);
    yield* waitForSsh(transport);
    return transport;
  });

const bootstrapCloneCommand = Command.make("bootstrap-clone", {
  fromConfig: fromConfigFlag,
  cacheDir: cacheDirFlag,
  dryRun: dryRunFlag,
  force: bootstrapForceFlag,
}).pipe(
  Command.withDescription(
    "Clone allowlisted bootstrap paths from an existing box through a resumable local rsync cache.",
  ),
  Command.withHandler(({ cacheDir, dryRun, force, fromConfig }) =>
    Effect.gen(function* () {
      const sourceConfig = yield* loadConfig(fromConfig);
      const destinationConfig = yield* loadConfig("cloudbox.json");
      const sourceBootstrap = yield* bootstrapConfig(sourceConfig, fromConfig);
      const destinationBootstrap = yield* bootstrapConfig(destinationConfig, "cloudbox.json");
      const missingPaths = destinationBootstrap.paths.filter(
        (path) => !sourceBootstrap.paths.includes(path),
      );
      if (missingPaths.length > 0) {
        return yield* Effect.fail(
          cliError(
            "bootstrap clone",
            `Destination bootstrap paths are not allowlisted by ${fromConfig}:\n${missingPaths.map((path) => `  ${path}`).join("\n")}`,
          ),
        );
      }
      const sameBox =
        sourceConfig.provider === destinationConfig.provider &&
        sourceConfig.name === destinationConfig.name &&
        (sourceConfig.provider === "aws"
          ? destinationConfig.provider === "aws" && sourceConfig.region === destinationConfig.region
          : sourceConfig.provider === "gcp"
            ? destinationConfig.provider === "gcp" &&
              sourceConfig.gcp.project === destinationConfig.gcp.project &&
              sourceConfig.gcp.zone === destinationConfig.gcp.zone
            : destinationConfig.provider === "boat");
      if (sameBox) {
        return yield* Effect.fail(
          cliError("bootstrap clone", "Source and destination resolve to the same Cloudbox."),
        );
      }

      const defaultCacheRoot = NodePath.join(
        NodeOs.homedir(),
        ".cache",
        "cloudbox",
        "bootstrap",
        `${bootstrapCacheIdentity(sourceConfig)}-to-${bootstrapCacheIdentity(destinationConfig)}`,
      );
      const cacheRoot = cacheDir.length === 0 ? defaultCacheRoot : resolveLocalPath(cacheDir);
      const source = yield* runningTransport(sourceConfig);
      if (!dryRun) {
        const fs = yield* FileSystem.FileSystem;
        const cacheExists = yield* fs.exists(cacheRoot).pipe(
          Effect.mapError((cause) =>
            cliError("bootstrap clone", `Could not inspect bootstrap cache ${cacheRoot}`, cause),
          ),
        );
        if (cacheExists) {
          const cacheInfo = yield* fs.stat(cacheRoot).pipe(
            Effect.mapError((cause) =>
              cliError("bootstrap clone", `Could not inspect bootstrap cache ${cacheRoot}`, cause),
            ),
          );
          if (cacheInfo.type !== "Directory" || (cacheInfo.mode & 0o077) !== 0) {
            return yield* Effect.fail(
              cliError(
                "bootstrap clone",
                `Bootstrap cache must be a private directory (mode 0700): ${cacheRoot}`,
              ),
            );
          }
        } else {
          yield* fs.makeDirectory(cacheRoot, { recursive: true, mode: 0o700 }).pipe(
            Effect.mapError((cause) =>
              cliError("bootstrap clone", `Could not create bootstrap cache ${cacheRoot}`, cause),
            ),
          );
        }
      }
      const destination = dryRun ? source : yield* runningTransport(destinationConfig);
      yield* Console.log(
        dryRun
          ? `Previewing source deltas into ${cacheRoot}; the destination is not contacted.`
          : `Cloning through resumable cache ${cacheRoot}. Existing destination-only files are kept.`,
      );
      yield* runBootstrapClone(
        {
          paths: destinationBootstrap.paths,
          excludes: [...new Set([...sourceBootstrap.excludes, ...destinationBootstrap.excludes])],
          maxTransferMb: Math.min(
            sourceBootstrap.maxTransferMb,
            destinationBootstrap.maxTransferMb,
          ),
          cacheRoot,
          source,
          destination,
          dryRun,
          force,
        },
        liveBootstrapCloneRunner,
      ).pipe(
        Effect.mapError((cause) => cliError("bootstrap clone", cause.message, cause)),
      );
      yield* Console.log(
        dryRun
          ? "Source preview complete. Run without --dry-run to refresh the cache and preview the destination delta."
          : "Bootstrap clone complete. The cache is retained for fast resumable reruns.",
      );
    }),
  ),
);

const sshCommand = Command.make("ssh").pipe(
  Command.withDescription("Open an interactive SSH session to the running box."),
  Command.withHandler(() =>
    withBox((config, _lifecycle, instance) =>
      Effect.gen(function* () {
        const awsHost = config.provider === "aws"
          ? yield* requirePublicIp(instance)
          : undefined;
        const transport = yield* makeSshTransport(config, awsHost);
        yield* runProcess("ssh", transport.args());
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
  host: Flag.string("host").pipe(
    Flag.withDefault(""),
    Flag.withDescription("AWS-only public IP or hostname. GCP uses the configured instance name."),
  ),
  expectVm: Flag.boolean("expect-vm").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Also launch and test an Incus VM through /dev/kvm."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run the end-to-end host acceptance suite over SSH."),
  Command.withHandler(({ expectVm, host, json }) =>
    Effect.gen(function* () {
      const loadedConfig = yield* loadConfig("cloudbox.json");
      const config = yield* requireInfrastructureConfig(loadedConfig);
      const report = yield* runAcceptanceSuite(
        config,
        host.length === 0 ? undefined : host,
        expectVm,
      );
      yield* printVerificationReport(report, json);
    }),
  ),
);

const smokeThreadCommand = Command.make("smoke-thread", {
  host: Flag.string("host").pipe(
    Flag.withDefault(""),
    Flag.withDescription("AWS-only public IP or hostname. GCP uses the configured instance name."),
  ),
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
      const loadedConfig = yield* loadConfig("cloudbox.json");
      const config = yield* requireInfrastructureConfig(loadedConfig);
      const transport = yield* makeSshThreadSmokeTransport(
        config,
        host.length === 0 ? undefined : host,
      );
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
      const loadedConfig = yield* loadConfig("cloudbox.json");
      const config = yield* requireInfrastructureConfig(loadedConfig);
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
      const loadedConfig = yield* loadConfig("cloudbox.json");
      const config = yield* requireInfrastructureConfig(loadedConfig);
      const report = yield* verifyIdleSleep(
        config,
        makeProviderLifecycle(config),
        timeout,
      );
      yield* printVerificationReport(report, json);
    }),
  ),
);

const boatCliError = (operation: string, cause: BoatClientError | BoatConfigError) =>
  cliError(
    operation,
    cause instanceof BoatApiError
      ? `${cause.message} (${cause.code}, request ${cause.requestId})`
      : cause.message,
    cause,
  );

const loadBoatConfig = () =>
  Effect.gen(function* () {
    const config = yield* loadConfig("cloudbox.json");
    if (config.provider !== "boat") {
      return yield* Effect.fail(
        cliError("Boat config", "cloudbox.json must set provider to \"boat\""),
      );
    }
    return config;
  });

const makeConfiguredBoatClient = (): Effect.Effect<BoatClientShape, CloudboxCliError> =>
  makeBoatClientFromEnvironment().pipe(
    Effect.mapError((cause) => boatCliError("Boat client", cause)),
  );

const managedBoatName = (config: BoatCloudboxConfig): string => {
  const full = `cloudbox-${config.name}`;
  if (full.length <= 120) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 10);
  return `${full.slice(0, 109)}-${suffix}`;
};

const boatMachineInput = (config: BoatCloudboxConfig) => ({
  type: config.boat.type,
  ttlSeconds: config.boat.ttlSeconds,
  ...(config.boat.environment === undefined ? {} : { environment: config.boat.environment }),
});

const boatUpIdempotencyKey = (config: BoatCloudboxConfig): string => {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(boatMachineInput(config)))
    .digest("hex")
    .slice(0, 20);
  return `cloudbox:up:${config.name}:${bodyHash}`;
};

const findManagedBoat = (client: BoatClientShape, config: BoatCloudboxConfig) =>
  Effect.gen(function* () {
    const name = managedBoatName(config);
    const matches: BoatSandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = yield* client.list(cursor).pipe(
        Effect.mapError((cause) => boatCliError("Boat list", cause)),
      );
      matches.push(...response.sandboxes.filter((sandbox) => sandbox.name === name));
      if (!response.pageInfo.hasMore) break;
      if (response.pageInfo.nextCursor === null) {
        return yield* Effect.fail(
          cliError("Boat list", "Boat reported more sandboxes without a next cursor"),
        );
      }
      cursor = response.pageInfo.nextCursor;
      if (page === 99) {
        return yield* Effect.fail(
          cliError("Boat list", "Boat sandbox pagination exceeded 100 pages"),
        );
      }
    }
    if (matches.length > 1) {
      return yield* Effect.fail(
        cliError("Boat list", `Found multiple sandboxes named ${name}; refusing to guess`),
      );
    }
    return matches[0];
  });

const waitForBoat = (
  client: BoatClientShape,
  sandboxId: string,
  desired: "ready" | "archived",
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const sandbox = yield* client.get(sandboxId).pipe(
        Effect.catchIf(
          (cause) => cause instanceof BoatApiError && cause.code === "boat_restoring",
          () => Effect.succeed(undefined),
        ),
        Effect.mapError((cause) => boatCliError(`wait for Boat ${desired}`, cause)),
      );
      if (sandbox === undefined) {
        yield* Effect.sleep("2 seconds");
        continue;
      }
      if (
        desired === "ready"
          ? sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running"
          : sandbox.state === "archived"
      ) {
        return sandbox;
      }
      if (sandbox.state === "error") {
        return yield* Effect.fail(
          cliError(`wait for Boat ${desired}`, `Sandbox ${sandboxId} entered error state`),
        );
      }
      yield* Effect.sleep("2 seconds");
    }
    return yield* Effect.fail(
      cliError(`wait for Boat ${desired}`, `Sandbox ${sandboxId} did not become ${desired} in 10 minutes`),
    );
  });

const readBoatPublicKey = (config: BoatCloudboxConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = resolveLocalPath(config.sshPublicKeyPath);
    const key = yield* fs.readFileString(path).pipe(
      Effect.mapError((cause) =>
        cliError("Boat SSH key", `Cannot read sshPublicKeyPath ${config.sshPublicKeyPath}`, cause),
      ),
    );
    return yield* requireString("Boat SSH public key", key.trim());
  });

const configureBoatTransport = (
  client: BoatClientShape,
  config: BoatCloudboxConfig,
  sandboxId: string,
) =>
  Effect.gen(function* () {
    const publicKey = yield* readBoatPublicKey(config);
    const configured = yield* client.configureSshKey(sandboxId, publicKey).pipe(
      Effect.mapError((cause) => boatCliError("Boat SSH key", cause)),
    );
    if (!configured.success || configured.machineIp === null) {
      return yield* Effect.fail(
        cliError("Boat SSH key", "Boat did not return a machine IP after configuring SSH"),
      );
    }
    const transport = yield* makeSshTransport(config, configured.machineIp);
    yield* waitForSsh(transport);
    return transport;
  });

const requireManagedBoat = (client: BoatClientShape, config: BoatCloudboxConfig) =>
  Effect.gen(function* () {
    const sandbox = yield* findManagedBoat(client, config);
    if (sandbox === undefined) {
      return yield* Effect.fail(
        cliError("Boat sandbox", `No sandbox named ${managedBoatName(config)}; run cloudbox boat up`),
      );
    }
    return sandbox;
  });

const ensureRunningBoat = (client: BoatClientShape, config: BoatCloudboxConfig) =>
  Effect.gen(function* () {
    let sandbox = yield* requireManagedBoat(client, config);
    if (sandbox.state === "archiving") {
      sandbox = yield* waitForBoat(client, sandbox.id, "archived");
    }
    if (sandbox.state === "archived") {
      yield* client.resume(sandbox.id, boatMachineInput(config)).pipe(
        Effect.mapError((cause) => boatCliError("Boat resume", cause)),
      );
    }
    return yield* waitForBoat(client, sandbox.id, "ready");
  });

interface BoatWindowsSshConfigResult {
  readonly alias: string;
  readonly configPath: string;
}

const writeBoatWindowsSshConfig = (
  config: BoatCloudboxConfig,
): Effect.Effect<BoatWindowsSshConfigResult, CloudboxCliError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const windowsUser = process.env.CLOUDBOX_WINDOWS_USER?.trim() || NodeOs.userInfo().username;
    const windowsHome = NodePath.join("/mnt/c/Users", windowsUser);
    const sshDirectory = NodePath.join(windowsHome, ".ssh");
    const privateKeyPath = NodePath.join(sshDirectory, "ascii_box_ed25519");
    const publicKeyPath = `${privateKeyPath}.pub`;
    const expectedWslPublicKey = NodePath.join(NodeOs.homedir(), ".ssh", "ascii_box_ed25519.pub");
    const configuredPublicKeyPath = resolveLocalPath(config.sshPublicKeyPath);
    if (configuredPublicKeyPath !== expectedWslPublicKey) {
      return yield* Effect.fail(
        cliError(
          "Boat Windows SSH config",
          `sshPublicKeyPath must be ~/.ssh/ascii_box_ed25519.pub, the Boat CLI key documented for WSL`,
        ),
      );
    }
    for (const path of [privateKeyPath, publicKeyPath]) {
      const exists = yield* fs.exists(path).pipe(
        Effect.mapError((cause) =>
          cliError("Boat Windows SSH config", `Could not inspect SSH key ${path}`, cause),
        ),
      );
      if (!exists) {
        return yield* Effect.fail(
          cliError(
            "Boat Windows SSH config",
            `Missing Windows OpenSSH key ${path}; create ${BOAT_WINDOWS_IDENTITY} in C:\\Users\\${windowsUser}\\.ssh before running boat up`,
          ),
        );
      }
    }

    const distribution = process.env.WSL_DISTRO_NAME?.trim();
    if (distribution === undefined || distribution.length === 0) {
      return yield* Effect.fail(
        cliError("Boat Windows SSH config", "WSL_DISTRO_NAME is required to write the Windows ProxyCommand"),
      );
    }
    const cliPath = process.argv[1] === undefined ? "" : NodePath.resolve(process.argv[1]);
    if (NodePath.basename(cliPath) !== "cli.mjs") {
      return yield* Effect.fail(
        cliError(
          "Boat Windows SSH config",
          "boat up must run the built CLI; run pnpm build:cli, then pnpm cloudbox boat up",
        ),
      );
    }
    const workingDirectory = process.cwd();
    const block = renderBoatWindowsSshBlock({
      name: config.name,
      distribution,
      workingDirectory,
      nodePath: process.execPath,
      cliPath,
    });
    const configPath = NodePath.join(sshDirectory, "config");
    yield* fs.makeDirectory(sshDirectory, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        cliError("Boat Windows SSH config", `Could not create ${sshDirectory}`, cause),
      ),
    );
    const exists = yield* fs.exists(configPath).pipe(
      Effect.mapError((cause) =>
        cliError("Boat Windows SSH config", `Could not inspect ${configPath}`, cause),
      ),
    );
    const existing = exists
      ? yield* fs.readFileString(configPath).pipe(
          Effect.mapError((cause) =>
            cliError("Boat Windows SSH config", `Could not read ${configPath}`, cause),
          ),
        )
      : "";
    const updated = yield* Effect.try({
      try: () => updateBoatManagedSshConfig(existing, config.name, block),
      catch: (cause) =>
        cliError(
          "Boat Windows SSH config",
          cause instanceof BoatSshConfigError ? cause.message : `Could not update ${configPath}`,
          cause,
        ),
    });
    const temporary = NodePath.join(sshDirectory, `.config.cloudbox-${randomUUID()}.tmp`);
    yield* fs.writeFileString(temporary, updated).pipe(
      Effect.flatMap(() => fs.rename(temporary, configPath)),
      Effect.mapError((cause) =>
        cliError("Boat Windows SSH config", `Could not atomically write ${configPath}`, cause),
      ),
    );
    return { alias: `cloudbox-${config.name}`, configPath };
  });

const boatUpCommand = Command.make("up", { force: forceFlag }).pipe(
  Command.withDescription("Create or resume the Boat sandbox, sync its loadout, and write the Windows SSH environment."),
  Command.withHandler(({ force }) =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      let sandbox = yield* findManagedBoat(client, config);
      if (sandbox === undefined) {
        const limits = yield* client.limits.pipe(
          Effect.mapError((cause) => boatCliError("Boat limits", cause)),
        );
        if (!limits.canStart) {
          return yield* Effect.fail(
            cliError(
              "Boat up",
              `Boat cannot start a sandbox: ${limits.startBlockedReason ?? limits.billingStatus}`,
            ),
          );
        }
        const created = yield* client.create({
          ...boatMachineInput(config),
          idempotencyKey: boatUpIdempotencyKey(config),
        }).pipe(Effect.mapError((cause) => boatCliError("Boat create", cause)));
        sandbox = yield* client.updateName(created.sandbox.id, managedBoatName(config)).pipe(
          Effect.mapError((cause) => boatCliError("Boat name", cause)),
        );
      } else {
        if (sandbox.state === "archiving") {
          sandbox = yield* waitForBoat(client, sandbox.id, "archived");
        }
        if (sandbox.state === "archived") {
          yield* client.resume(sandbox.id, boatMachineInput(config)).pipe(
            Effect.mapError((cause) => boatCliError("Boat resume", cause)),
          );
        }
      }

      sandbox = yield* waitForBoat(client, sandbox.id, "ready");
      yield* client.updateTtl(sandbox.id, config.boat.ttlSeconds).pipe(
        Effect.mapError((cause) => boatCliError("Boat TTL", cause)),
      );
      const transport = yield* configureBoatTransport(client, config, sandbox.id);
      yield* runSyncOverTransport(config, transport, false, force, false);
      const sshConfig = yield* writeBoatWindowsSshConfig(config);
      yield* Console.log(
        `Boat sandbox ready. Windows SSH config updated: ${sshConfig.configPath}\nT3 SSH environment: ${sshConfig.alias}`,
      );
    }),
  ),
);

const boatStatusCommand = Command.make("status").pipe(
  Command.withDescription("Show Boat account limits and the managed sandbox state."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const limits = yield* client.limits.pipe(
        Effect.mapError((cause) => boatCliError("Boat limits", cause)),
      );
      const sandbox = yield* findManagedBoat(client, config);
      yield* Console.log(JSON.stringify({ limits, sandbox: sandbox ?? null }, null, 2));
    }),
  ),
);

const boatStopCommand = Command.make("stop").pipe(
  Command.withDescription("Snapshot and archive the managed Boat sandbox."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const sandbox = yield* requireManagedBoat(client, config);
      if (sandbox.state !== "archived") {
        yield* client.stop(sandbox.id).pipe(
          Effect.mapError((cause) => boatCliError("Boat stop", cause)),
        );
      }
      const archived = yield* waitForBoat(client, sandbox.id, "archived");
      yield* Console.log(JSON.stringify(archived, null, 2));
    }),
  ),
);

const boatResumeCommand = Command.make("resume").pipe(
  Command.withDescription("Resume the managed Boat sandbox using the configured machine type and TTL."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const ready = yield* ensureRunningBoat(client, config);
      const transport = yield* configureBoatTransport(client, config, ready.id);
      yield* Console.log(JSON.stringify({ sandbox: ready, sshHost: transport.host }, null, 2));
    }),
  ),
);

const boatForkCommand = Command.make("fork").pipe(
  Command.withDescription("Fork the managed sandbox with the configured machine type and TTL."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const source = yield* requireManagedBoat(client, config);
      const forked = yield* client.fork(source.id, {
        ...boatMachineInput(config),
        idempotencyKey: `cloudbox:fork:${randomUUID()}`,
      }).pipe(Effect.mapError((cause) => boatCliError("Boat fork", cause)));
      const ready = yield* waitForBoat(client, forked.id, "ready");
      const transport = yield* configureBoatTransport(client, config, ready.id);
      yield* Console.log(JSON.stringify({ sandbox: ready, sshHost: transport.host }, null, 2));
    }),
  ),
);

const boatSshCommand = Command.make("ssh").pipe(
  Command.withDescription("Resume if needed, then open an interactive SSH session to the managed Boat sandbox."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const sandbox = yield* ensureRunningBoat(client, config);
      const transport = yield* configureBoatTransport(client, config, sandbox.id);
      yield* runProcess("ssh", transport.args());
    }),
  ),
);

const boatExecCommand = Command.make("exec", {
  command: Argument.string("command"),
  timeout: Flag.integer("timeout").pipe(
    Flag.withDefault(600),
    Flag.withDescription("Synchronous timeout in seconds (1-600)."),
  ),
  detached: Flag.boolean("detached").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Run detached and poll until the command exits."),
  ),
}).pipe(
  Command.withDescription("Execute a command in the managed Boat sandbox."),
  Command.withHandler(({ command, detached, timeout }) =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      const client = yield* makeConfiguredBoatClient();
      const sandbox = yield* ensureRunningBoat(client, config);
      const result = detached
        ? yield* client.execDetachedAndWait(sandbox.id, { command }).pipe(
            Effect.mapError((cause) => boatCliError("Boat detached exec", cause)),
          )
        : yield* client.exec(sandbox.id, { command, timeoutSeconds: timeout }).pipe(
            Effect.mapError((cause) => boatCliError("Boat exec", cause)),
          );
      yield* Effect.sync(() => {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      });
      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          cliError("Boat exec", `Command exited with status ${String(result.exitCode)}`),
        );
      }
    }),
  ),
);

const boatProxyCommand = Command.make("proxy", {
  name: Argument.string("name"),
  port: Argument.integer("port"),
}).pipe(
  Command.withDescription("Resume the managed sandbox and proxy stdin/stdout to its current SSH address."),
  Command.withHandler(({ name, port }) =>
    Effect.gen(function* () {
      const config = yield* loadBoatConfig();
      if (name !== config.name) {
        return yield* Effect.fail(
          cliError("Boat SSH proxy", `SSH requested ${name}, but cloudbox.json manages ${config.name}`),
        );
      }
      if (port < 1 || port > 65_535) {
        return yield* Effect.fail(
          cliError("Boat SSH proxy", `Invalid SSH port ${String(port)}`),
        );
      }
      const client = yield* makeConfiguredBoatClient();
      const ready = yield* ensureRunningBoat(client, config);
      const current = yield* client.get(ready.id).pipe(
        Effect.mapError((cause) => boatCliError("Boat SSH address", cause)),
      );
      if (current.ip === undefined || current.ip === null || current.ip.trim().length === 0) {
        return yield* Effect.fail(
          cliError("Boat SSH address", `Boat returned no current address for sandbox ${current.id}`),
        );
      }
      yield* Effect.tryPromise({
        try: () => runBoatSshProxy({ host: current.ip!, port }),
        catch: (cause) =>
          cliError(
            "Boat SSH proxy",
            cause instanceof BoatSshProxyError ? cause.message : "Boat SSH proxy failed",
            cause,
          ),
      });
    }),
  ),
);

const boatCommand = Command.make("boat").pipe(
  Command.withDescription("Provision and operate the Boat provider lane."),
  Command.withSubcommands([
    boatUpCommand,
    boatStatusCommand,
    boatStopCommand,
    boatResumeCommand,
    boatForkCommand,
    boatSshCommand,
    boatExecCommand,
    boatProxyCommand,
  ]),
);

export const cloudbox = Command.make("cloudbox").pipe(
  Command.withDescription("Control and verify one personal Cloudbox machine on AWS, GCP, or Boat."),
  Command.withSubcommands([
    boatCommand,
    statusCommand,
    wakeCommand,
    sleepCommand,
    syncCommand,
    bootstrapCloneCommand,
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
