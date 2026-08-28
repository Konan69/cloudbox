import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";
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

import type { AwsCloudboxConfig, CloudboxConfig, GcpCloudboxConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { GcpApi, Operation } from "./gcp/client.ts";

export class CloudboxCliError extends Data.TaggedError("CloudboxCliError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const Ec2StateName = Schema.Literals([
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
]);

type Ec2StateName = typeof Ec2StateName.Type;

const DescribeInstancesResult = Schema.Struct({
  Reservations: Schema.Array(
    Schema.Struct({
      Instances: Schema.Array(
        Schema.Struct({
          InstanceId: Schema.NonEmptyString,
          State: Schema.Struct({ Name: Ec2StateName }),
          PublicIpAddress: Schema.optional(Schema.NonEmptyString),
        }),
      ),
    }),
  ),
});

type BoxInstance = {
  readonly instanceId: string;
  readonly state: string;
  readonly publicIp: string | undefined;
};

const cliError = (operation: string, message: string, cause?: unknown) =>
  new CloudboxCliError({ ...(cause === undefined ? {} : { cause }), operation, message });

const aws = <A>(operation: string, request: () => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => cliError(operation, `${operation} failed`, cause),
  });

const gcp = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => cliError(operation, `${operation} failed`, cause)),
  );

const GcpCliInstance = Schema.Struct({
  name: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  labels: Schema.optional(
    Schema.Struct({ cloudbox: Schema.optional(Schema.String) }),
  ),
  networkInterfaces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        accessConfigs: Schema.optional(
          Schema.Array(Schema.Struct({ natIP: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

const makeAwsClient = (config: AwsCloudboxConfig) => new EC2Client({ region: config.region });
const makeGcpClient = (config: GcpCloudboxConfig) =>
  new GcpApi({ project: config.gcp.project, credentials: config.gcp.credentials });
const gcpInstanceName = (config: GcpCloudboxConfig) => `cloudbox-${config.name}`;

const requireString = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(value).pipe(
    Effect.mapError((cause) => cliError(operation, `${operation} returned no value`, cause)),
  );

const findAwsInstance = (config: AwsCloudboxConfig, client: EC2Client) =>
  Effect.gen(function* () {
    const response = yield* aws("DescribeInstances", () =>
      client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:cloudbox", Values: [config.name] },
            { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
          ],
        }),
      ),
    );
    const decoded = yield* Schema.decodeUnknownEffect(DescribeInstancesResult)(response).pipe(
      Effect.mapError((cause) =>
        cliError("DescribeInstances", "DescribeInstances returned an invalid response", cause),
      ),
    );
    const instances = decoded.Reservations.flatMap((reservation) => reservation.Instances);
    if (instances.length !== 1) {
      return yield* Effect.fail(
        cliError(
          "find instance",
          `Expected exactly one live AWS instance tagged cloudbox=${config.name}; found ${String(instances.length)}`,
        ),
      );
    }
    const instance = instances[0];
    if (instance === undefined) {
      return yield* Effect.fail(cliError("find instance", "AWS returned an empty instance list"));
    }
    return {
      instanceId: instance.InstanceId,
      state: instance.State.Name,
      publicIp: instance.PublicIpAddress,
    } satisfies BoxInstance;
  });

const findGcpInstance = (config: GcpCloudboxConfig, client: GcpApi) =>
  Effect.gen(function* () {
    const name = gcpInstanceName(config);
    const instance = yield* gcp(
      "get GCP instance",
      client.requestOptional(
        `get instance ${name}`,
        client.projectPath(
          `/zones/${encodeURIComponent(config.gcp.zone)}/instances/${encodeURIComponent(name)}`,
        ),
        GcpCliInstance,
      ),
    );
    if (instance === undefined || instance.labels?.cloudbox !== config.name) {
      return yield* Effect.fail(
        cliError("find instance", `No owned GCP instance named ${name} in ${config.gcp.zone}`),
      );
    }
    return {
      instanceId: instance.name,
      state: instance.status,
      publicIp: instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
    } satisfies BoxInstance;
  });

const findInstance = (config: CloudboxConfig) =>
  config.provider === "aws"
    ? findAwsInstance(config, makeAwsClient(config))
    : findGcpInstance(config, makeGcpClient(config));

const withBox = <A>(
  effect: (config: CloudboxConfig, instance: BoxInstance) => Effect.Effect<A, CloudboxCliError>,
) =>
  Effect.gen(function* () {
    const config = yield* loadConfig("cloudbox.json");
    const instance = yield* findInstance(config);
    return yield* effect(config, instance);
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

const waitForGcpRunning = (config: GcpCloudboxConfig, client: GcpApi) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const instance = yield* findGcpInstance(config, client);
      if (instance.state === "RUNNING") return instance;
      yield* Effect.sleep("5 seconds");
    }
    return yield* Effect.fail(cliError("wait for GCP instance", "Instance did not reach RUNNING in 10 minutes"));
  });

const runGcpAction = (
  config: GcpCloudboxConfig,
  client: GcpApi,
  action: "start" | "resume" | "suspend",
) =>
  gcp(
    `${action} GCP instance`,
    Effect.gen(function* () {
      const operation = yield* client.request(
        `${action} instance`,
        client.projectPath(
          `/zones/${encodeURIComponent(config.gcp.zone)}/instances/${encodeURIComponent(gcpInstanceName(config))}/${action}`,
        ),
        Operation,
        { method: "POST" },
      );
      yield* client.waitForOperation(operation, { zone: config.gcp.zone });
    }),
  );

const statusCommand = Command.make("status").pipe(
  Command.withDescription("Show the box state and public IP."),
  Command.withHandler(() =>
    withBox((config, instance) =>
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
    withBox((config, instance) =>
      Effect.gen(function* () {
        let running: BoxInstance;
        if (config.provider === "aws") {
          const client = makeAwsClient(config);
          if (instance.state !== "running" && instance.state !== "pending") {
            yield* aws("StartInstances", () =>
              client.send(new StartInstancesCommand({ InstanceIds: [instance.instanceId] })),
            );
          }
          yield* aws("wait for instance running", () =>
            waitUntilInstanceRunning(
              { client, maxWaitTime: 600, minDelay: 5, maxDelay: 15 },
              { InstanceIds: [instance.instanceId] },
            ),
          );
          running = yield* findAwsInstance(config, client);
        } else {
          const client = makeGcpClient(config);
          if (instance.state === "SUSPENDED") yield* runGcpAction(config, client, "resume");
          else if (instance.state === "TERMINATED") yield* runGcpAction(config, client, "start");
          running = yield* waitForGcpRunning(config, client);
        }
        const publicIp = yield* requirePublicIp(running);
        yield* waitForSsh(publicIp);
        yield* Console.log(publicIp);
      }),
    ),
  ),
);

const sleepCommand = Command.make("sleep").pipe(
  Command.withDescription("Suspend the box while preserving memory (GCP limit: 60 days)."),
  Command.withHandler(() =>
    withBox((config, instance) =>
      config.provider === "aws"
        ? aws("StopInstances", () =>
            makeAwsClient(config).send(
              new StopInstancesCommand({ InstanceIds: [instance.instanceId], Hibernate: true }),
            ),
          ).pipe(Effect.asVoid)
        : instance.state === "SUSPENDED"
          ? Effect.void
          : instance.state === "RUNNING"
            ? runGcpAction(config, makeGcpClient(config), "suspend")
            : Effect.fail(
                cliError(
                  "suspend GCP instance",
                  `Instance must be RUNNING or SUSPENDED; current state is ${instance.state}`,
                ),
              ),
    ),
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
    withBox((config, instance) =>
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
    withBox((config, instance) =>
      Effect.gen(function* () {
        const publicIp = yield* requirePublicIp(instance);
        yield* runProcess("ssh", [`${config.boxUser}@${publicIp}`]);
      }),
    ),
  ),
);

export const cloudbox = Command.make("cloudbox").pipe(
  Command.withDescription("Control one personal Cloudbox machine on AWS or GCP."),
  Command.withSubcommands([statusCommand, wakeCommand, sleepCommand, syncCommand, sshCommand]),
);

const program = Command.run(cloudbox, { version: "0.1.0" }).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(program);
}
