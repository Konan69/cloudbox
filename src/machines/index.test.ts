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
  readonly mode: "capture" | "stream" | "ownership";
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
                stdout:
                  operation === "list machines"
                    ? listJson
                    : operation.includes(" uid in ")
                      ? "1234\n"
                      : operation.includes(" gid in ")
                        ? "2345\n"
                        : "",
                stderr: "",
              };
            }),
          stream: (operation, args) =>
            Effect.sync(() => {
              calls.push({ mode: "stream", operation, args });
            }),
          setOwnership: (operation, path, uid, gid) =>
            Effect.sync(() => {
              calls.push({
                mode: "ownership",
                operation,
                args: [path, String(uid), String(gid)],
              });
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
        [
          "/tank/archive/thread-abc.tar.zst",
          String(process.getuid?.()),
          String(process.getgid?.()),
        ],
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

  it.effect("resolves and caches the in-machine exec identity by name", () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      const options = { cwd: "/home/dev/project", tty: false } as const;
      yield* exec("thread-abc", ["bash", "-lc", "pwd"], options);
      yield* exec("thread-abc", ["true"], options);

      expect(calls.map((call) => call.args)).toEqual([
        ["exec", "thread-abc", "--", "id", "-u", "dev"],
        ["exec", "thread-abc", "--", "id", "-g", "dev"],
        [
          "exec",
          "thread-abc",
          "--user",
          "1234",
          "--group",
          "2345",
          "--cwd",
          "/home/dev/project",
          "--force-noninteractive",
          "--",
          "bash",
          "-lc",
          "pwd",
        ],
        [
          "exec",
          "thread-abc",
          "--user",
          "1234",
          "--group",
          "2345",
          "--cwd",
          "/home/dev/project",
          "--force-noninteractive",
          "--",
          "true",
        ],
      ]);
    }).pipe(Effect.provide(testLayer(calls, "[]")));
  });
});
