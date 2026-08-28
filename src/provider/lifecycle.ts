import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AwsCloudboxConfig, CloudboxConfig, GcpCloudboxConfig } from "../config.ts";
import { GcpApi, Operation } from "../gcp/client.ts";

const Ec2StateName = Schema.Literals([
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
]);

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

const GcpInstance = Schema.Struct({
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

export interface ProviderInstance {
  readonly instanceId: string;
  readonly state: string;
  readonly publicIp: string | undefined;
}

export class ProviderLifecycleError extends Data.TaggedError("ProviderLifecycleError")<{
  readonly provider: "aws" | "gcp";
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProviderLifecycle {
  readonly provider: "aws" | "gcp";
  readonly status: Effect.Effect<ProviderInstance, ProviderLifecycleError>;
  readonly sleep: Effect.Effect<void, ProviderLifecycleError>;
  readonly wake: Effect.Effect<ProviderInstance, ProviderLifecycleError>;
}

const lifecycleError = (
  provider: "aws" | "gcp",
  operation: string,
  message: string,
  cause?: unknown,
) =>
  new ProviderLifecycleError({
    ...(cause === undefined ? {} : { cause }),
    provider,
    operation,
    message,
  });

const awsRequest = <A>(operation: string, request: () => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => lifecycleError("aws", operation, `${operation} failed`, cause),
  });

const findAwsInstance = (config: AwsCloudboxConfig, client: EC2Client) =>
  Effect.gen(function* () {
    const response = yield* awsRequest("DescribeInstances", () =>
      client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:cloudbox", Values: [config.name] },
            {
              Name: "instance-state-name",
              Values: ["pending", "running", "stopping", "stopped"],
            },
          ],
        }),
      ),
    );
    const decoded = yield* Schema.decodeUnknownEffect(DescribeInstancesResult)(response).pipe(
      Effect.mapError((cause) =>
        lifecycleError(
          "aws",
          "DescribeInstances",
          "DescribeInstances returned an invalid response",
          cause,
        ),
      ),
    );
    const instances = decoded.Reservations.flatMap((reservation) => reservation.Instances);
    if (instances.length !== 1) {
      return yield* Effect.fail(
        lifecycleError(
          "aws",
          "status",
          `Expected exactly one live AWS instance tagged cloudbox=${config.name}; found ${String(instances.length)}`,
        ),
      );
    }
    const instance = instances[0];
    if (instance === undefined) {
      return yield* Effect.fail(
        lifecycleError("aws", "status", "AWS returned an empty instance list"),
      );
    }
    return {
      instanceId: instance.InstanceId,
      state: instance.State.Name,
      publicIp: instance.PublicIpAddress,
    } satisfies ProviderInstance;
  });

const makeAwsLifecycle = (config: AwsCloudboxConfig): ProviderLifecycle => {
  const client = new EC2Client({ region: config.region });
  const status = findAwsInstance(config, client);

  return {
    provider: "aws",
    status,
    sleep: Effect.gen(function* () {
      const instance = yield* status;
      yield* awsRequest("StopInstances", () =>
        client.send(
          new StopInstancesCommand({
            InstanceIds: [instance.instanceId],
            Hibernate: true,
          }),
        ),
      );
    }),
    wake: Effect.gen(function* () {
      const instance = yield* status;
      if (instance.state !== "running" && instance.state !== "pending") {
        yield* awsRequest("StartInstances", () =>
          client.send(new StartInstancesCommand({ InstanceIds: [instance.instanceId] })),
        );
      }
      yield* awsRequest("wait for instance running", () =>
        waitUntilInstanceRunning(
          { client, maxWaitTime: 600, minDelay: 5, maxDelay: 15 },
          { InstanceIds: [instance.instanceId] },
        ),
      );
      return yield* findAwsInstance(config, client);
    }),
  };
};

const gcpInstanceName = (config: GcpCloudboxConfig): string => `cloudbox-${config.name}`;

const makeGcpClient = (config: GcpCloudboxConfig) =>
  new GcpApi({ project: config.gcp.project, credentials: config.gcp.credentials });

const gcpEffect = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      lifecycleError("gcp", operation, `${operation} failed`, cause),
    ),
  );

const findGcpInstance = (config: GcpCloudboxConfig, client: GcpApi) =>
  Effect.gen(function* () {
    const name = gcpInstanceName(config);
    const instance = yield* gcpEffect(
      "get GCP instance",
      client.requestOptional(
        `get instance ${name}`,
        client.projectPath(
          `/zones/${encodeURIComponent(config.gcp.zone)}/instances/${encodeURIComponent(name)}`,
        ),
        GcpInstance,
      ),
    );
    if (instance === undefined || instance.labels?.cloudbox !== config.name) {
      return yield* Effect.fail(
        lifecycleError(
          "gcp",
          "status",
          `No owned GCP instance named ${name} in ${config.gcp.zone}`,
        ),
      );
    }
    return {
      instanceId: instance.name,
      state: instance.status,
      publicIp: instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
    } satisfies ProviderInstance;
  });

const runGcpAction = (
  config: GcpCloudboxConfig,
  client: GcpApi,
  action: "start" | "resume" | "suspend",
) =>
  gcpEffect(
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

const waitForGcpRunning = (config: GcpCloudboxConfig, client: GcpApi) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const instance = yield* findGcpInstance(config, client);
      if (isRunningState("gcp", instance.state)) return instance;
      yield* Effect.sleep(5_000);
    }
    return yield* Effect.fail(
      lifecycleError("gcp", "wake", "Instance did not reach RUNNING in 10 minutes"),
    );
  });

const makeGcpLifecycle = (config: GcpCloudboxConfig): ProviderLifecycle => {
  const client = makeGcpClient(config);
  const status = findGcpInstance(config, client);

  return {
    provider: "gcp",
    status,
    sleep: Effect.gen(function* () {
      const instance = yield* status;
      if (isSleepingState("gcp", instance.state)) return;
      if (!isRunningState("gcp", instance.state)) {
        return yield* Effect.fail(
          lifecycleError(
            "gcp",
            "sleep",
            `Instance must be RUNNING or SUSPENDED; current state is ${instance.state}`,
          ),
        );
      }
      yield* runGcpAction(config, client, "suspend");
    }),
    wake: Effect.gen(function* () {
      const instance = yield* status;
      const normalized = instance.state.toLowerCase();
      if (normalized === "suspended") {
        yield* runGcpAction(config, client, "resume");
      } else if (normalized === "terminated") {
        yield* runGcpAction(config, client, "start");
      } else if (normalized !== "running") {
        return yield* Effect.fail(
          lifecycleError(
            "gcp",
            "wake",
            `Instance must be RUNNING, SUSPENDED, or TERMINATED; current state is ${instance.state}`,
          ),
        );
      }
      return yield* waitForGcpRunning(config, client);
    }),
  };
};

export const makeProviderLifecycle = (config: CloudboxConfig): ProviderLifecycle =>
  config.provider === "aws" ? makeAwsLifecycle(config) : makeGcpLifecycle(config);

export const isSleepingState = (provider: "aws" | "gcp", state: string): boolean => {
  const normalized = state.toLowerCase();
  return provider === "aws" ? normalized === "stopped" : normalized === "suspended";
};

export const isRunningState = (_provider: "aws" | "gcp", state: string): boolean =>
  state.toLowerCase() === "running";
