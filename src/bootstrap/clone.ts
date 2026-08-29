import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";

import type { SshTransport } from "../ssh/transport.ts";

export class BootstrapCloneError extends Data.TaggedError("BootstrapCloneError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BootstrapProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BootstrapCloneInput {
  readonly paths: ReadonlyArray<string>;
  readonly excludes: ReadonlyArray<string>;
  readonly maxTransferMb: number;
  readonly cacheRoot: string;
  readonly source: SshTransport;
  readonly destination: SshTransport;
  readonly dryRun: boolean;
  readonly force: boolean;
}

export type BootstrapCloneRunner = (
  leg: "pull" | "push",
  path: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<BootstrapProcessOutput, BootstrapCloneError>;

interface BootstrapStats {
  readonly path: string;
  readonly files: number;
  readonly bytesToTransfer: number;
}

const withTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path : `${path}/`;

const cachePath = (input: BootstrapCloneInput, path: string): string => {
  const value = NodePath.join(input.cacheRoot, path.slice(2));
  return path.endsWith("/") ? withTrailingSlash(value) : value;
};

const commonArgs = (
  transport: SshTransport,
  excludes: ReadonlyArray<string>,
  dryRun: boolean,
): ReadonlyArray<string> => [
  "-az",
  "--protect-args",
  "--partial",
  "--partial-dir=.rsync-partial",
  "--mkpath",
  "--info=stats2,name1",
  "-e",
  transport.rsyncRemoteShell({ batchMode: true }),
  ...(dryRun ? ["--dry-run"] : []),
  ...excludes.map((exclude) => `--exclude=${exclude}`),
  "--",
];

export const buildBootstrapPullArgs = (
  input: BootstrapCloneInput,
  path: string,
  dryRun: boolean,
): ReadonlyArray<string> => [
  ...commonArgs(input.source, input.excludes, dryRun),
  `${input.source.target}:${path}`,
  cachePath(input, path),
];

export const buildBootstrapPushArgs = (
  input: BootstrapCloneInput,
  path: string,
  dryRun: boolean,
): ReadonlyArray<string> => [
  ...commonArgs(input.destination, input.excludes, dryRun),
  cachePath(input, path),
  `${input.destination.target}:${path}`,
];

const parseMetric = (path: string, output: string, label: string): number => {
  const match = new RegExp(`^${label}: ([0-9,]+)`, "m").exec(output);
  if (match === null || match[1] === undefined) {
    throw new BootstrapCloneError({
      operation: "parse rsync stats",
      message: `Invalid rsync statistics for ${path}: missing ${label}`,
    });
  }
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BootstrapCloneError({
      operation: "parse rsync stats",
      message: `Invalid rsync statistics for ${path}: invalid ${label}`,
    });
  }
  return value;
};

const parseStats = (path: string, output: string): BootstrapStats => ({
  path,
  files: parseMetric(path, output, "Number of regular files transferred"),
  bytesToTransfer: parseMetric(path, output, "Total transferred file size"),
});

const enforceTransferLimit = (
  leg: "source-to-cache" | "cache-to-destination",
  stats: ReadonlyArray<BootstrapStats>,
  maxTransferMb: number,
  force: boolean,
): Effect.Effect<void, BootstrapCloneError> => {
  const totalBytes = stats.reduce((total, item) => total + item.bytesToTransfer, 0);
  if (force || totalBytes <= maxTransferMb * 1_000_000) return Effect.void;
  const perPath = stats
    .map((item) => `  ${item.path}: ${String(item.bytesToTransfer)} bytes`)
    .join("\n");
  return Effect.fail(
    new BootstrapCloneError({
      operation: "bootstrap clone size guard",
      message: `Bootstrap ${leg} leg would transfer ${String(totalBytes)} bytes, exceeding bootstrap.maxTransferMb=${String(maxTransferMb)}.\n${perPath}\nTighten bootstrap.excludes or rerun with --force.`,
    }),
  );
};

export const runBootstrapClone = (
  input: BootstrapCloneInput,
  runner: BootstrapCloneRunner,
): Effect.Effect<void, BootstrapCloneError> => {
  const runLeg = (leg: "pull" | "push", dryRun: boolean) =>
    Effect.forEach(input.paths, (path) =>
      runner(
        leg,
        path,
        leg === "pull"
          ? buildBootstrapPullArgs(input, path, dryRun)
          : buildBootstrapPushArgs(input, path, dryRun),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new BootstrapCloneError({
              operation: `bootstrap ${leg}`,
              message: `${leg === "pull" ? "Source" : "Destination"} rsync failed for ${path}: ${cause.message}`,
              cause,
            }),
        ),
        Effect.flatMap((output) =>
          Effect.try({
            try: () => parseStats(path, output.stdout),
            catch: (cause) =>
              cause instanceof BootstrapCloneError
                ? cause
                : new BootstrapCloneError({
                    operation: "parse rsync stats",
                    message: `Invalid rsync statistics for ${path}`,
                    cause,
                  }),
          }),
        ),
      ),
    );

  return Effect.gen(function* () {
    const sourcePreview = yield* runLeg("pull", true);
    if (input.dryRun) return;
    yield* enforceTransferLimit(
      "source-to-cache",
      sourcePreview,
      input.maxTransferMb,
      input.force,
    );
    yield* runLeg("pull", false);
    const destinationPreview = yield* runLeg("push", true);
    yield* enforceTransferLimit(
      "cache-to-destination",
      destinationPreview,
      input.maxTransferMb,
      input.force,
    );
    yield* runLeg("push", false);
  });
};
