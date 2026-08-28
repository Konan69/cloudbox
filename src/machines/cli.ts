import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { pathToFileURL } from "node:url";

import {
  archive,
  createFromGolden,
  destroy,
  exec,
  listMachines,
  MachinesLive,
  restore,
  snapshot,
  start,
  stop,
} from "./index.ts";

const nameArgument = Argument.string("name");

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const machines = yield* listMachines;
    yield* Console.log(JSON.stringify(machines, null, 2));
  }),
).pipe(Command.withDescription("List Incus machines as JSON."));

const createCommand = Command.make(
  "create",
  {
    threadId: Argument.string("thread-id"),
    vm: Flag.boolean("vm").pipe(
      Flag.withDescription("Create a virtual machine instead of a container."),
    ),
  },
  ({ threadId, vm }) =>
    Effect.gen(function* () {
      const name = yield* createFromGolden(threadId, { vm });
      yield* Console.log(name);
    }),
).pipe(Command.withDescription("Create a machine from the golden image."));

const startCommand = Command.make("start", { name: nameArgument }, ({ name }) => start(name)).pipe(
  Command.withDescription("Start a machine."),
);

const stopCommand = Command.make("stop", { name: nameArgument }, ({ name }) => stop(name)).pipe(
  Command.withDescription("Stop a machine."),
);

const execCommand = Command.make(
  "exec",
  {
    name: nameArgument,
    user: Flag.integer("user").pipe(Flag.withDescription("Required numeric UID.")),
    cwd: Flag.string("cwd").pipe(Flag.withDescription("Required working directory.")),
    tty: Flag.boolean("tty").pipe(Flag.withDescription("Allocate an interactive TTY.")),
    argv: Argument.string("argv").pipe(Argument.variadic({ min: 1 })),
  },
  ({ argv, cwd, name, tty, user }) => exec(name, argv, { user, cwd, tty }),
).pipe(Command.withDescription("Stream a command inside a machine."));

const snapshotCommand = Command.make(
  "snapshot",
  {
    name: nameArgument,
    snapshotName: Argument.string("snapshot-name"),
  },
  ({ name, snapshotName }) => snapshot(name, snapshotName),
).pipe(Command.withDescription("Create a named machine snapshot."));

const archiveCommand = Command.make(
  "archive",
  { name: nameArgument },
  ({ name }) =>
    Effect.gen(function* () {
      const path = yield* archive(name);
      yield* Console.log(path);
    }),
).pipe(Command.withDescription("Export to tank/archive, then destroy the machine."));

const restoreCommand = Command.make("restore", { name: nameArgument }, ({ name }) =>
  restore(name),
).pipe(Command.withDescription("Import a machine archive from tank/archive."));

const destroyCommand = Command.make("destroy", { name: nameArgument }, ({ name }) =>
  destroy(name),
).pipe(Command.withDescription("Destroy a machine and all snapshots."));

export const cloudboxMachines = Command.make("cloudbox-machines").pipe(
  Command.withDescription("Manage Cloudbox Incus machines on the host."),
  Command.withSubcommands([
    listCommand,
    createCommand,
    startCommand,
    stopCommand,
    execCommand,
    snapshotCommand,
    archiveCommand,
    restoreCommand,
    destroyCommand,
  ]),
);

export const program = Command.run(cloudboxMachines, { version: "0.1.0" }).pipe(
  Effect.scoped,
  Effect.provide(MachinesLive),
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(program);
}
