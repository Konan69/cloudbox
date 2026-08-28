import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GcpCredentials } from "../config.ts";
import { makeAccessTokenProvider, type AccessTokenProvider } from "./auth.ts";

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";

const ApiErrorItem = Schema.Struct({
  code: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const ApiErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    status: Schema.optional(Schema.String),
    errors: Schema.optional(Schema.Array(ApiErrorItem)),
  }),
});

type ApiErrorEnvelope = typeof ApiErrorEnvelope.Type;

export const Operation = Schema.Struct({
  name: Schema.NonEmptyString,
  status: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      errors: Schema.optional(Schema.Array(ApiErrorItem)),
    }),
  ),
});

export type Operation = typeof Operation.Type;
export type OperationScope = { readonly zone: string } | "global";

export class GcpAuthError extends Data.TaggedError("GcpAuthError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class GcpApiError extends Data.TaggedError("GcpApiError")<{
  readonly operation: string;
  readonly status: number;
  readonly code: number | undefined;
  readonly message: string;
  readonly details: ApiErrorEnvelope | undefined;
  readonly cause?: unknown;
}> {}

export class GcpDecodeError extends Data.TaggedError("GcpDecodeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class GcpOperationError extends Data.TaggedError("GcpOperationError")<{
  readonly operation: string;
  readonly message: string;
  readonly errors: ReadonlyArray<typeof ApiErrorItem.Type>;
}> {}

export interface GcpApiOptions {
  readonly project: string;
  readonly credentials?: GcpCredentials;
  readonly tokenProvider?: AccessTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly maxOperationPolls?: number;
}

export interface GcpRequestOptions extends RequestInit {
  readonly baseUrl?: string;
}

const parseJson = (text: string): unknown => (text.length === 0 ? undefined : JSON.parse(text));

const decodeApiError = (value: unknown): ApiErrorEnvelope | undefined => {
  try {
    return Schema.decodeUnknownSync(ApiErrorEnvelope)(value);
  } catch {
    return undefined;
  }
};

export class GcpApi {
  readonly project: string;
  readonly #tokenProvider: AccessTokenProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #pollIntervalMs: number;
  readonly #maxOperationPolls: number;

  constructor(options: GcpApiOptions) {
    this.project = options.project;
    if (options.tokenProvider === undefined && options.credentials === undefined) {
      throw new Error("GcpApi requires credentials or a tokenProvider");
    }
    this.#tokenProvider =
      options.tokenProvider ?? makeAccessTokenProvider(options.credentials as GcpCredentials);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#maxOperationPolls = options.maxOperationPolls ?? 180;
  }

  projectPath(path: string): string {
    return `/projects/${encodeURIComponent(this.project)}${path}`;
  }

  request<S extends Schema.Top>(
    operation: string,
    path: string,
    schema: S,
    init: GcpRequestOptions = {},
  ): Effect.Effect<
    S["Type"],
    GcpAuthError | GcpApiError | GcpDecodeError,
    S["DecodingServices"]
  > {
    const self = this;
    return Effect.gen(function* () {
      const token = yield* Effect.tryPromise({
        try: () => self.#tokenProvider(),
        catch: (cause) =>
          new GcpAuthError({ message: `Authentication failed for ${operation}`, cause }),
      });
      const { baseUrl = COMPUTE_API, ...requestInit } = init;
      const response = yield* Effect.tryPromise({
        try: () =>
          self.#fetch(`${baseUrl}${path}`, {
            ...requestInit,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              ...(requestInit.body === undefined ? {} : { "Content-Type": "application/json" }),
              ...requestInit.headers,
            },
          }),
        catch: (cause) =>
          new GcpApiError({
            operation,
            status: 0,
            code: undefined,
            message: `${operation} request failed`,
            details: undefined,
            cause,
          }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new GcpApiError({
            operation,
            status: response.status,
            code: undefined,
            message: `${operation} response could not be read`,
            details: undefined,
            cause,
          }),
      });
      let json: unknown;
      try {
        json = parseJson(text);
      } catch (cause) {
        return yield* Effect.fail(
          new GcpDecodeError({
            operation,
            message: `${operation} returned invalid JSON`,
            cause,
          }),
        );
      }
      if (!response.ok) {
        const details = decodeApiError(json);
        return yield* Effect.fail(
          new GcpApiError({
            operation,
            status: response.status,
            code: details?.error.code,
            message: details?.error.message ?? `${operation} failed with HTTP ${String(response.status)}`,
            details,
          }),
        );
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new GcpDecodeError({
              operation,
              message: `${operation} returned an unexpected response`,
              cause,
            }),
        ),
      );
    });
  }

  requestOptional<S extends Schema.Top>(
    operation: string,
    path: string,
    schema: S,
    init: GcpRequestOptions = {},
  ): Effect.Effect<
    S["Type"] | undefined,
    GcpAuthError | GcpApiError | GcpDecodeError,
    S["DecodingServices"]
  > {
    return this.request(operation, path, schema, init).pipe(
      Effect.catchTag("GcpApiError", (error) =>
        error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  }

  waitForOperation(
    initial: Operation,
    scope: OperationScope,
  ): Effect.Effect<Operation, GcpAuthError | GcpApiError | GcpDecodeError | GcpOperationError> {
    const finish = (operation: Operation) => {
      const errors = operation.error?.errors ?? [];
      return errors.length === 0
        ? Effect.succeed(operation)
        : Effect.fail(
            new GcpOperationError({
              operation: operation.name,
              message: errors.map((error) => error.message ?? error.code ?? "unknown error").join("; "),
              errors,
            }),
          );
    };

    const waitPath = (name: string) =>
      scope === "global"
        ? this.projectPath(`/global/operations/${encodeURIComponent(name)}/wait`)
        : this.projectPath(
            `/zones/${encodeURIComponent(scope.zone)}/operations/${encodeURIComponent(name)}/wait`,
          );

    const self = this;
    return Effect.gen(function* () {
      let operation = initial;
      for (let poll = 0; poll < self.#maxOperationPolls; poll += 1) {
        if (operation.status === "DONE") return yield* finish(operation);
        operation = yield* self.request(
          `wait for operation ${operation.name}`,
          waitPath(operation.name),
          Operation,
          { method: "POST" },
        );
        if (operation.status !== "DONE" && self.#pollIntervalMs > 0) {
          yield* Effect.sleep(Duration.millis(self.#pollIntervalMs));
        }
      }
      return yield* Effect.fail(
        new GcpOperationError({
          operation: initial.name,
          message: `Operation did not finish after ${String(self.#maxOperationPolls)} polls`,
          errors: [],
        }),
      );
    });
  }
}
