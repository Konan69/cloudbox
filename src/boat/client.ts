import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const BOAT_API_KEY_FILE = join(homedir(), ".config", "cloudbox", "boat-api-key");

/** The stored Boat API key, or undefined when setup has not written one. */
const readBoatApiKeyFile = (): string | undefined => {
  if (!existsSync(BOAT_API_KEY_FILE)) return undefined;
  const key = readFileSync(BOAT_API_KEY_FILE, "utf8").trim();
  return key.length === 0 ? undefined : key;
};

export const BOAT_API_BASE = "https://boat.dev/api/v1";

export const BoatMachineType = Schema.Literals(["small", "default", "large", "xlarge"]);
export type BoatMachineType = typeof BoatMachineType.Type;

export const BoatSandboxState = Schema.Literals([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
]);
export type BoatSandboxState = typeof BoatSandboxState.Type;

const NullableString = Schema.NullOr(Schema.String);
const NullableInteger = Schema.NullOr(Schema.Number.check(Schema.isInt()));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const BoatSandbox = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  state: BoatSandboxState,
  type: Schema.optionalKey(BoatMachineType),
  vcpu: Schema.optionalKey(PositiveInteger),
  memoryGB: Schema.optionalKey(PositiveInteger),
  billingMultiplier: Schema.optionalKey(Schema.Number),
  url: Schema.optionalKey(NullableString),
  ip: Schema.optionalKey(NullableString),
  // IPv4 `host:port` Boat publishes for SSH. The sandbox's own `ip` is IPv6
  // only, which WSL2 and many home networks cannot route.
  sshEndpoint: Schema.optionalKey(NullableString),
  createdAt: Schema.optionalKey(NullableString),
  updatedAt: Schema.optionalKey(NullableString),
  archiveAfter: Schema.optionalKey(NullableString),
  desktopAvailable: Schema.Boolean,
  desktopUrl: Schema.optionalKey(NullableString),
  snapshotAvailable: Schema.Boolean,
  snapshotCompletedAt: Schema.optionalKey(NullableString),
  subdomain: Schema.optionalKey(NullableString),
  lastSnapshotAttemptAt: Schema.optionalKey(NullableString),
  lastSnapshotStatus: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["queued", "in_progress", "completed", "failed", "cancelled"])),
  ),
  setupStatus: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["pending", "running", "done", "failed"])),
  ),
  setupError: Schema.optionalKey(NullableString),
  environment: Schema.optionalKey(NullableString),
  environmentVersion: Schema.optionalKey(NullableInteger),
});
export type BoatSandbox = typeof BoatSandbox.Type;

const PageInfo = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
  limit: PositiveInteger,
});

export const BoatLimitsResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("limits.info"),
  canStart: Schema.Boolean,
  activeSandboxes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  maxActiveSandboxes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  billingStatus: Schema.String,
  checkoutRequired: Schema.optionalKey(Schema.Boolean),
  startBlockedReason: Schema.optionalKey(NullableString),
  creditBalanceHours: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  creditBalanceSeconds: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
});
export type BoatLimitsResponse = typeof BoatLimitsResponse.Type;

const SandboxInfoResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.info"),
  sandbox: BoatSandbox,
});

/**
 * PATCH /sandboxes/:id answers with its own envelope tag. Verified against the
 * live API on 2026-10-03; decoding it as `sandbox.info` failed every rename and
 * TTL update after the change had already been applied.
 */
const SandboxUpdatedResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.updated"),
  sandbox: BoatSandbox,
});

const SandboxListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.list"),
  sandboxes: Schema.Array(BoatSandbox),
  pageInfo: PageInfo,
});
export type SandboxListResponse = typeof SandboxListResponse.Type;

const CreateSandboxResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.created"),
  status: Schema.Literal("provisioning"),
  ttlSeconds: Schema.NullOr(PositiveInteger),
  sandbox: BoatSandbox,
});
export type CreateSandboxResponse = typeof CreateSandboxResponse.Type;

const SandboxActionResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  sandbox: Schema.optionalKey(Schema.NullOr(BoatSandbox)),
});
export type SandboxActionResponse = typeof SandboxActionResponse.Type;

const DeletionOperation = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["sandbox", "snapshot"]),
  targetId: Schema.NonEmptyString,
  reason: Schema.Literals(["explicit", "zdr", "account"]),
  status: Schema.Literals(["pending", "processing", "blocked", "completed"]),
  attemptCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  requestedAt: Schema.NonEmptyString,
  completedAt: NullableString,
});

const DeletionOperationResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literals(["deletion.operation", "sandbox.deleting", "snapshot.deleting"]),
  operation: DeletionOperation,
});
export type DeletionOperationResponse = typeof DeletionOperationResponse.Type;

export const CommandFinishedResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("command.finished"),
  success: Schema.Boolean,
  exitCode: NullableInteger,
  signal: Schema.optionalKey(NullableString),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.optionalKey(Schema.Boolean),
  stderrTruncated: Schema.optionalKey(Schema.Boolean),
  timedOut: Schema.Boolean,
  cwd: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  finishedAt: Schema.optionalKey(Schema.String),
});
export type CommandFinishedResponse = typeof CommandFinishedResponse.Type;

export const CommandStartedResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("command.started"),
  success: Schema.Boolean,
  processId: PositiveInteger,
  pid: PositiveInteger,
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  logPath: Schema.optionalKey(Schema.String),
  errLogPath: Schema.optionalKey(Schema.String),
});
export type CommandStartedResponse = typeof CommandStartedResponse.Type;

export const CommandStatusResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("command.status"),
  success: Schema.Boolean,
  processId: PositiveInteger,
  pid: Schema.optionalKey(PositiveInteger),
  status: Schema.Literals(["running", "exited", "lost"]),
  known: Schema.optionalKey(Schema.Boolean),
  running: Schema.Boolean,
  exitCode: NullableInteger,
  signal: Schema.optionalKey(NullableString),
  command: Schema.optionalKey(NullableString),
  cwd: Schema.optionalKey(NullableString),
  startedAt: Schema.optionalKey(NullableString),
  finishedAt: Schema.optionalKey(NullableString),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.optionalKey(Schema.Boolean),
  stderrTruncated: Schema.optionalKey(Schema.Boolean),
  logPath: Schema.optionalKey(Schema.String),
  errLogPath: Schema.optionalKey(Schema.String),
});
export type CommandStatusResponse = typeof CommandStatusResponse.Type;

const SshKeyResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("ssh_key.configured"),
  success: Schema.Boolean,
  machineIp: Schema.NullOr(Schema.NonEmptyString),
  sshUser: Schema.Literal("user"),
});
export type SshKeyResponse = typeof SshKeyResponse.Type;

const ErrorEnvelope = Schema.Struct({
  ok: Schema.Literal(false),
  type: Schema.NonEmptyString,
  status: Schema.Number.check(Schema.isInt()),
  code: Schema.NonEmptyString,
  message: Schema.String,
  error: Schema.Struct({
    code: Schema.NonEmptyString,
    message: Schema.String,
    status: Schema.Number.check(Schema.isInt()),
    details: Schema.optionalKey(Schema.Unknown),
  }),
  requestId: Schema.NonEmptyString,
});

type ErrorEnvelope = typeof ErrorEnvelope.Type;

export class BoatConfigError extends Data.TaggedError("BoatConfigError")<{
  readonly message: string;
}> {}

export class BoatApiError extends Data.TaggedError("BoatApiError")<{
  readonly operation: string;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details: unknown;
}> {}

export class BoatDecodeError extends Data.TaggedError("BoatDecodeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class BoatTransportError extends Data.TaggedError("BoatTransportError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class BoatPollingError extends Data.TaggedError("BoatPollingError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export interface CreateSandboxInput {
  readonly type: BoatMachineType;
  readonly ttlSeconds: number | null;
  readonly environment?: string;
  readonly idempotencyKey?: string;
}

export interface ResumeSandboxInput {
  readonly type: BoatMachineType;
  readonly ttlSeconds: number | null;
  readonly environment?: string;
}

export interface ForkSandboxInput extends ResumeSandboxInput {
  readonly idempotencyKey?: string;
}

export interface ExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
}

export interface BoatClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export interface BoatClientShape {
  readonly limits: Effect.Effect<BoatLimitsResponse, BoatClientError>;
  readonly create: (input: CreateSandboxInput) => Effect.Effect<CreateSandboxResponse, BoatClientError>;
  readonly get: (sandboxId: string) => Effect.Effect<BoatSandbox, BoatClientError>;
  readonly list: (cursor?: string) => Effect.Effect<SandboxListResponse, BoatClientError>;
  readonly stop: (sandboxId: string) => Effect.Effect<SandboxActionResponse, BoatClientError>;
  readonly resume: (sandboxId: string, input: ResumeSandboxInput) => Effect.Effect<SandboxActionResponse, BoatClientError>;
  readonly fork: (sandboxId: string, input: ForkSandboxInput) => Effect.Effect<SandboxActionResponse, BoatClientError>;
  readonly delete: (sandboxId: string) => Effect.Effect<DeletionOperationResponse, BoatClientError>;
  readonly updateTtl: (sandboxId: string, ttlSeconds: number | null) => Effect.Effect<BoatSandbox, BoatClientError>;
  readonly updateName: (sandboxId: string, name: string) => Effect.Effect<BoatSandbox, BoatClientError>;
  readonly exec: (sandboxId: string, input: ExecInput) => Effect.Effect<CommandFinishedResponse, BoatClientError>;
  readonly execDetached: (sandboxId: string, input: ExecInput) => Effect.Effect<CommandStartedResponse, BoatClientError>;
  readonly commandStatus: (sandboxId: string, processId: number) => Effect.Effect<CommandStatusResponse, BoatClientError>;
  readonly execDetachedAndWait: (sandboxId: string, input: ExecInput) => Effect.Effect<CommandStatusResponse, BoatClientError>;
  readonly configureSshKey: (sandboxId: string, publicKey: string) => Effect.Effect<SshKeyResponse, BoatClientError>;
}

export type BoatClientError =
  | BoatApiError
  | BoatDecodeError
  | BoatTransportError
  | BoatPollingError;

export class BoatClient extends Context.Service<BoatClient, BoatClientShape>()(
  "cloudbox/boat/BoatClient",
) {
  static make(options: BoatClientOptions): BoatClientShape {
    return makeBoatClient(options);
  }

  static layer(options: BoatClientOptions) {
    return Layer.succeed(BoatClient, BoatClient.of(makeBoatClient(options)));
  }
}

const decodeJson = <S extends Schema.Top>(operation: string, schema: S, text: string) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        new BoatDecodeError({
          operation,
          message: `${operation} returned invalid JSON`,
          cause,
        }),
    });
    return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new BoatDecodeError({
            operation,
            message: `${operation} returned an unexpected response`,
            cause,
          }),
      ),
    );
  });

const errorFromEnvelope = (operation: string, envelope: ErrorEnvelope) =>
  new BoatApiError({
    operation,
    status: envelope.status,
    code: envelope.code,
    message: envelope.message,
    requestId: envelope.requestId,
    details: envelope.error.details,
  });

export const makeBoatClient = (options: BoatClientOptions): BoatClientShape => {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new BoatConfigError({ message: "BOAT_API_KEY is required" });
  }
  const baseUrl = (options.baseUrl ?? BOAT_API_BASE).replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxPolls = options.maxPolls ?? 600;

  const request = <S extends Schema.Top>(
    operation: string,
    path: string,
    schema: S,
    init: RequestInit = {},
  ): Effect.Effect<S["Type"], BoatApiError | BoatDecodeError | BoatTransportError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${baseUrl}${path}`, {
            ...init,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${apiKey}`,
              ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
              ...init.headers,
            },
          }),
        catch: (cause) =>
          new BoatTransportError({
            operation,
            message: `${operation} request failed`,
            cause,
          }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new BoatTransportError({
            operation,
            message: `${operation} response could not be read`,
            cause,
          }),
      });
      if (!response.ok) {
        const envelope = yield* decodeJson(operation, ErrorEnvelope, text);
        return yield* Effect.fail(errorFromEnvelope(operation, envelope));
      }
      return yield* decodeJson(operation, schema, text);
    });

  const jsonBody = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });
  const sandboxPath = (sandboxId: string): string =>
    `/sandboxes/${encodeURIComponent(sandboxId)}`;

  const limits = request("get Boat limits", "/limits", BoatLimitsResponse);
  const get = (sandboxId: string) =>
    request("get sandbox", sandboxPath(sandboxId), SandboxInfoResponse).pipe(
      Effect.map((response) => response.sandbox),
    );
  const list = (cursor?: string) => {
    const query = new URLSearchParams({ limit: "200", sort: "desc" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return request("list sandboxes", `/sandboxes?${query.toString()}`, SandboxListResponse);
  };
  const create = (input: CreateSandboxInput) =>
    request("create sandbox", "/sandboxes", CreateSandboxResponse, {
      method: "POST",
      ...jsonBody({
        type: input.type,
        ttlSeconds: input.ttlSeconds,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { headers: { "Idempotency-Key": input.idempotencyKey } }),
    });
  const action = (
    operation: string,
    sandboxId: string,
    actionName: "stop" | "resume" | "fork",
    body: unknown,
    idempotencyKey?: string,
  ) =>
    request(operation, `${sandboxPath(sandboxId)}/${actionName}`, SandboxActionResponse, {
      method: "POST",
      ...jsonBody(body),
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { "Idempotency-Key": idempotencyKey } }),
    });
  const stop = (sandboxId: string) => action("stop sandbox", sandboxId, "stop", {});
  const resume = (sandboxId: string, input: ResumeSandboxInput) =>
    action("resume sandbox", sandboxId, "resume", {
      type: input.type,
      ttlSeconds: input.ttlSeconds,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });
  const fork = (sandboxId: string, input: ForkSandboxInput) =>
    action(
      "fork sandbox",
      sandboxId,
      "fork",
      {
        type: input.type,
        ttlSeconds: input.ttlSeconds,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      },
      input.idempotencyKey,
    );
  const deleteSandbox = (sandboxId: string) =>
    request("delete sandbox", sandboxPath(sandboxId), DeletionOperationResponse, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": sandboxId },
    });
  const patchSandbox = (operation: string, sandboxId: string, body: unknown) =>
    request(operation, sandboxPath(sandboxId), SandboxUpdatedResponse, {
      method: "PATCH",
      ...jsonBody(body),
    }).pipe(Effect.map((response) => response.sandbox));
  const updateTtl = (sandboxId: string, ttlSeconds: number | null) =>
    patchSandbox("update sandbox TTL", sandboxId, { ttlSeconds });
  const updateName = (sandboxId: string, name: string) =>
    patchSandbox("update sandbox name", sandboxId, { name });
  const command = <S extends Schema.Top>(
    operation: string,
    sandboxId: string,
    input: ExecInput,
    detached: boolean,
    schema: S,
  ) =>
    request(operation, `${sandboxPath(sandboxId)}/commands`, schema, {
      method: "POST",
      ...jsonBody({
        command: input.command,
        detached,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      }),
    });
  const exec = (sandboxId: string, input: ExecInput) =>
    command("execute sandbox command", sandboxId, input, false, CommandFinishedResponse);
  const execDetached = (sandboxId: string, input: ExecInput) =>
    command("start detached sandbox command", sandboxId, input, true, CommandStartedResponse);
  const commandStatus = (sandboxId: string, processId: number) =>
    request(
      "get detached command status",
      `${sandboxPath(sandboxId)}/commands/${encodeURIComponent(String(processId))}`,
      CommandStatusResponse,
    );
  const execDetachedAndWait = (sandboxId: string, input: ExecInput) =>
    Effect.gen(function* () {
      const started = yield* execDetached(sandboxId, input);
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const status = yield* commandStatus(sandboxId, started.processId);
        if (!status.running) return status;
        if (pollIntervalMs > 0) yield* Effect.sleep(Duration.millis(pollIntervalMs));
      }
      return yield* Effect.fail(
        new BoatPollingError({
          operation: "wait for detached sandbox command",
          message: `Command ${String(started.processId)} did not finish after ${String(maxPolls)} polls`,
        }),
      );
    });
  const configureSshKey = (sandboxId: string, publicKey: string) =>
    request("configure sandbox SSH key", `${sandboxPath(sandboxId)}/sshkey`, SshKeyResponse, {
      method: "POST",
      ...jsonBody({ key: publicKey }),
    });

  return {
    limits,
    create,
    get,
    list,
    stop,
    resume,
    fork,
    delete: deleteSandbox,
    updateTtl,
    updateName,
    exec,
    execDetached,
    commandStatus,
    execDetachedAndWait,
    configureSshKey,
  };
};

export const makeBoatClientFromEnvironment = (
  options: Omit<BoatClientOptions, "apiKey"> = {},
): Effect.Effect<BoatClientShape, BoatConfigError> => {
  // Windows OpenSSH starts the proxy through wsl.exe, where the key only
  // arrives if WSLENV forwards it. The key file is the same credential stored
  // by setup (mode 600), so the proxy works without that fragile hop.
  const apiKey = process.env.BOAT_API_KEY?.trim() || readBoatApiKeyFile();
  if (apiKey === undefined || apiKey.length === 0) {
    return Effect.fail(new BoatConfigError({ message: "BOAT_API_KEY is required" }));
  }
  return Effect.succeed(makeBoatClient({ ...options, apiKey }));
};
