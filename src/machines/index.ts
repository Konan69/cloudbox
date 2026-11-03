import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import { chown } from "node:fs";

const GOLDEN_ALIAS = "golden";
const ARCHIVE_DIRECTORY = "/tank/archive";
const MACHINE_USER = process.env.CLOUDBOX_BOX_USER ?? "dev";

export const MachineName = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
      message: "machine names must be 1-63 lowercase letters, digits, or interior hyphens",
    }),
  ),
);

const IncusMachine = Schema.Struct({
  name: MachineName,
  status: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
});

export type Machine = typeof IncusMachine.Type;

export type CreateMachineOptions = {
  readonly vm?: boolean;
};

export type ExecOptions = {
  readonly cwd: string;
  readonly tty: boolean;
};

type MachineIdentity = {
  readonly uid: number;
  readonly gid: number;
};

type CommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

const UnixId = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export class MachineNameError extends Data.TaggedError("MachineNameError")<{
  readonly value: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class IncusCommandError extends Data.TaggedError("IncusCommandError")<{
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly message: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
}> {}

export class IncusDecodeError extends Data.TaggedError("IncusDecodeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type MachinesError = MachineNameError | IncusCommandError | IncusDecodeError;

const commandError = (
  operation: string,
  args: ReadonlyArray<string>,
  message: string,
  fields?: { readonly exitCode?: number; readonly cause?: unknown },
) =>
  new IncusCommandError({
    operation,
    args,
    message,
    ...(fields?.exitCode === undefined ? {} : { exitCode: fields.exitCode }),
    ...(fields?.cause === undefined ? {} : { cause: fields.cause }),
  });

export class IncusRunner extends Context.Service<
  IncusRunner,
  {
    readonly capture: (
      operation: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<CommandOutput, IncusCommandError>;
    readonly stream: (
      operation: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<void, IncusCommandError>;
    readonly setOwnership: (
      operation: string,
      path: string,
      uid: number,
      gid: number,
    ) => Effect.Effect<void, IncusCommandError>;
  }
>()("cloudbox/machines/IncusRunner") {
  static readonly layer = Layer.succeed(
    IncusRunner,
    IncusRunner.of({
      capture: (operation, args) =>
        Effect.callback<CommandOutput, IncusCommandError>((resume) => {
          const child = spawn("incus", [...args], { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          let finished = false;
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", (cause) => {
            if (finished) return;
            finished = true;
            resume(
              Effect.fail(commandError(operation, args, `could not start incus`, { cause })),
            );
          });
          child.once("close", (code) => {
            if (finished) return;
            finished = true;
            if (code === 0) {
              resume(Effect.succeed({ stdout, stderr }));
            } else {
              resume(
                Effect.fail(
                  commandError(
                    operation,
                    args,
                    `incus exited with status ${String(code ?? "signal")}: ${stderr.trim()}`,
                    code === null ? {} : { exitCode: code },
                  ),
                ),
              );
            }
          });
        }),
      stream: (operation, args) =>
        Effect.callback<void, IncusCommandError>((resume) => {
          const child = spawn("incus", [...args], { stdio: "inherit" });
          let finished = false;
          child.once("error", (cause) => {
            if (finished) return;
            finished = true;
            resume(
              Effect.fail(commandError(operation, args, `could not start incus`, { cause })),
            );
          });
          child.once("close", (code) => {
            if (finished) return;
            finished = true;
            if (code === 0) {
              resume(Effect.void);
            } else {
              resume(
                Effect.fail(
                  commandError(
                    operation,
                    args,
                    `incus exited with status ${String(code ?? "signal")}`,
                    code === null ? {} : { exitCode: code },
                  ),
                ),
              );
            }
          });
        }),
      setOwnership: (operation, path, uid, gid) =>
        Effect.callback<void, IncusCommandError>((resume) => {
          chown(path, uid, gid, (cause) => {
            if (cause === null) {
              resume(Effect.void);
            } else {
              resume(
                Effect.fail(
                  commandError(operation, [path, String(uid), String(gid)], `chown failed`, {
                    cause,
                  }),
                ),
              );
            }
          });
        }),
    }),
  );
}

const decodeUnixId = (operation: string, value: string) =>
  Schema.decodeUnknownEffect(UnixId)(value.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new IncusDecodeError({
          operation,
          message: `Could not decode ${operation}`,
          cause,
        }),
    ),
  );

const decodeMachineName = (value: string) =>
  Schema.decodeUnknownEffect(MachineName)(value).pipe(
    Effect.mapError(
      (cause) =>
        new MachineNameError({
          value,
          message: `Invalid machine name: ${value}`,
          cause,
        }),
    ),
  );

export const nameFromThreadId = (threadId: string) => decodeMachineName(`thread-${threadId}`);

export class Machines extends Context.Service<
  Machines,
  {
    readonly listMachines: Effect.Effect<ReadonlyArray<Machine>, IncusDecodeError | IncusCommandError>;
    readonly createFromGolden: (
      threadId: string,
      options: CreateMachineOptions,
    ) => Effect.Effect<string, MachinesError>;
    readonly start: (name: string) => Effect.Effect<void, MachinesError>;
    readonly stop: (name: string) => Effect.Effect<void, MachinesError>;
    readonly exec: (
      name: string,
      argv: ReadonlyArray<string>,
      options: ExecOptions,
    ) => Effect.Effect<void, MachinesError>;
    readonly snapshot: (
      name: string,
      snapshotName: string,
    ) => Effect.Effect<void, MachinesError>;
    readonly archive: (name: string) => Effect.Effect<string, MachinesError>;
    readonly restore: (name: string) => Effect.Effect<void, MachinesError>;
    readonly destroy: (name: string) => Effect.Effect<void, MachinesError>;
  }
>()("cloudbox/machines/Machines") {
  static readonly layer = Layer.effect(
    Machines,
    Effect.gen(function* () {
      const runner = yield* IncusRunner;
      const machineIdentities = new Map<string, MachineIdentity>();

      const checked = Effect.fn("Machines.checked")(function*(
        operation: string,
        args: ReadonlyArray<string>,
      ) {
        yield* runner.capture(operation, args);
      });

      const resolveMachineIdentity = Effect.fn("Machines.resolveMachineIdentity")(function*(
        name: string,
      ) {
        const cached = machineIdentities.get(name);
        if (cached !== undefined) return cached;

        const uidOperation = `resolve ${MACHINE_USER} uid in ${name}`;
        const uidResult = yield* runner.capture(uidOperation, [
          "exec",
          name,
          "--",
          "id",
          "-u",
          MACHINE_USER,
        ]);
        const uid = yield* decodeUnixId(uidOperation, uidResult.stdout);
        const gidOperation = `resolve ${MACHINE_USER} gid in ${name}`;
        const gidResult = yield* runner.capture(gidOperation, [
          "exec",
          name,
          "--",
          "id",
          "-g",
          MACHINE_USER,
        ]);
        const gid = yield* decodeUnixId(gidOperation, gidResult.stdout);
        const identity = { uid, gid };
        machineIdentities.set(name, identity);
        return identity;
      });

      const listMachines = runner.capture("list machines", ["list", "--format=json"]).pipe(
        Effect.flatMap(({ stdout }) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(IncusMachine)))(stdout),
        ),
        Effect.mapError((cause) =>
          cause instanceof IncusCommandError
            ? cause
            : new IncusDecodeError({
                operation: "list machines",
                message: "Could not decode incus list JSON",
                cause,
              }),
        ),
      );

      const createFromGolden = Effect.fn("Machines.createFromGolden")(function*(
        threadId: string,
        options: CreateMachineOptions,
      ) {
        const name = yield* nameFromThreadId(threadId);
        const args = ["launch", GOLDEN_ALIAS, name];
        if (options.vm === true) args.push("--vm");
        yield* checked(`create ${name} from ${GOLDEN_ALIAS}`, args);
        return name;
      });

      const start = Effect.fn("Machines.start")(function*(name: string) {
        const validName = yield* decodeMachineName(name);
        yield* checked(`start ${validName}`, ["start", validName]);
      });

      const stop = Effect.fn("Machines.stop")(function*(name: string) {
        const validName = yield* decodeMachineName(name);
        yield* checked(`stop ${validName}`, ["stop", validName]);
      });

      const exec = Effect.fn("Machines.exec")(function*(
        name: string,
        argv: ReadonlyArray<string>,
        options: ExecOptions,
      ) {
        const validName = yield* decodeMachineName(name);
        if (argv.length === 0) {
          return yield* Effect.fail(
            commandError(`exec ${validName}`, [], "exec requires at least one argv value"),
          );
        }
        const identity = yield* resolveMachineIdentity(validName);
        yield* runner.stream(`exec ${validName}`, [
          "exec",
          validName,
          "--user",
          String(identity.uid),
          "--group",
          String(identity.gid),
          "--cwd",
          options.cwd,
          options.tty ? "--force-interactive" : "--force-noninteractive",
          "--",
          ...argv,
        ]);
      });

      const snapshot = Effect.fn("Machines.snapshot")(function*(
        name: string,
        snapshotName: string,
      ) {
        const validName = yield* decodeMachineName(name);
        const validSnapshot = yield* decodeMachineName(snapshotName);
        yield* checked(`snapshot ${validName}`, ["snapshot", validName, validSnapshot]);
      });

      const archive = Effect.fn("Machines.archive")(function*(name: string) {
        const validName = yield* decodeMachineName(name);
        const archivePath = `${ARCHIVE_DIRECTORY}/${validName}.tar.zst`;
        yield* checked(`archive ${validName}`, [
          "export",
          validName,
          archivePath,
          "--compression=zstd",
        ]);
        const hostUid = process.getuid?.();
        const hostGid = process.getgid?.();
        if (hostUid === undefined || hostGid === undefined) {
          return yield* Effect.fail(
            commandError(
              `set ownership of ${archivePath}`,
              [archivePath],
              "host UID/GID APIs are unavailable",
            ),
          );
        }
        yield* runner.setOwnership(
          `set ownership of ${archivePath}`,
          archivePath,
          hostUid,
          hostGid,
        );
        yield* checked(`destroy archived machine ${validName}`, ["delete", validName, "--force"]);
        machineIdentities.delete(validName);
        return archivePath;
      });

      const restore = Effect.fn("Machines.restore")(function*(name: string) {
        const validName = yield* decodeMachineName(name);
        machineIdentities.delete(validName);
        yield* checked(`restore ${validName}`, [
          "import",
          `${ARCHIVE_DIRECTORY}/${validName}.tar.zst`,
          validName,
        ]);
      });

      const destroy = Effect.fn("Machines.destroy")(function*(name: string) {
        const validName = yield* decodeMachineName(name);
        yield* checked(`destroy ${validName}`, ["delete", validName, "--force"]);
        machineIdentities.delete(validName);
      });

      return Machines.of({
        listMachines,
        createFromGolden,
        start,
        stop,
        exec,
        snapshot,
        archive,
        restore,
        destroy,
      });
    }),
  );
}

export const listMachines = Effect.flatMap(Machines, (machines) => machines.listMachines);
export const createFromGolden = (threadId: string, options: CreateMachineOptions) =>
  Effect.flatMap(Machines, (machines) => machines.createFromGolden(threadId, options));
export const start = (name: string) => Effect.flatMap(Machines, (machines) => machines.start(name));
export const stop = (name: string) => Effect.flatMap(Machines, (machines) => machines.stop(name));
export const exec = (name: string, argv: ReadonlyArray<string>, options: ExecOptions) =>
  Effect.flatMap(Machines, (machines) => machines.exec(name, argv, options));
export const snapshot = (name: string, snapshotName: string) =>
  Effect.flatMap(Machines, (machines) => machines.snapshot(name, snapshotName));
export const archive = (name: string) =>
  Effect.flatMap(Machines, (machines) => machines.archive(name));
export const restore = (name: string) =>
  Effect.flatMap(Machines, (machines) => machines.restore(name));
export const destroy = (name: string) =>
  Effect.flatMap(Machines, (machines) => machines.destroy(name));

export const MachinesLive = Machines.layer.pipe(Layer.provide(IncusRunner.layer));
