import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  archive,
  createFromGolden,
  exec,
  IncusRunner,
  listMachines,
  Machines,
} from "./index.ts";

type Call = {
  readonly mode: "capture" | "stream";
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
};

const testLayer = (calls: Array<Call>, listJson: string) =>
  Machines.layer.pipe(
    Layer.provide(
      Layer.succeed(
        IncusRunner,
        IncusRunner.of({
          capture: (operation, args) =>
            Effect.sync(() => {
              calls.push({ mode: "capture", operation, args });
              return {
                stdout: operation === "list machines" ? listJson : "",
                stderr: "",
              };
            }),
          stream: (operation, args) =>
            Effect.sync(() => {
              calls.push({ mode: "stream", operation, args });
            }),
        }),
      ),
    ),
  );

describe("Machines", () => {
  it.effect("decodes list output and maps lifecycle calls to incus", () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      const machines = yield* listMachines;
      expect(machines).toEqual([
        { name: "thread-abc", status: "RUNNING", type: "container" },
      ]);

      const name = yield* createFromGolden("abc", { vm: true });
      expect(name).toBe("thread-abc");
      const archivePath = yield* archive(name);
      expect(archivePath).toBe("/tank/archive/thread-abc.tar.zst");

      expect(calls.map((call) => call.args)).toEqual([
        ["list", "--format=json"],
        ["launch", "golden", "thread-abc", "--vm"],
        ["export", "thread-abc", "/tank/archive/thread-abc.tar.zst", "--compression=zstd"],
        ["delete", "thread-abc", "--force"],
      ]);
    }).pipe(
      Effect.provide(
        testLayer(
          calls,
          JSON.stringify([
            {
              name: "thread-abc",
              status: "RUNNING",
              type: "container",
              extra: "ignored",
            },
          ]),
        ),
      ),
    );
  });

  it.effect("passes explicit exec identity, cwd, and tty mode", () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      yield* exec("thread-abc", ["bash", "-lc", "pwd"], {
        user: 1000,
        cwd: "/home/dev/project",
        tty: false,
      });
      expect(calls[0]?.args).toEqual([
        "exec",
        "thread-abc",
        "--user",
        "1000",
        "--cwd",
        "/home/dev/project",
        "--force-noninteractive",
        "--",
        "bash",
        "-lc",
        "pwd",
      ]);
    }).pipe(Effect.provide(testLayer(calls, "[]")));
  });
});
