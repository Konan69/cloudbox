import { EC2Client, StopInstancesCommand } from "@aws-sdk/client-ec2";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "/etc/cloudbox/config.json";
const STATE_PATH = "/var/lib/cloudbox/idle.json";
const KEEP_AWAKE_PATH = "/run/cloudbox/keepawake";
const IMDS_BASE = "http://169.254.169.254/latest";

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const IdleConfig = Schema.Struct({
  name: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  idleMinutes: PositiveInteger,
  t3Port: PositiveInteger,
});

type IdleConfig = typeof IdleConfig.Type;

export const IdleState = Schema.Struct({
  idleSinceEpochMs: Schema.NullOr(Schema.Number),
  consecutiveChecks: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

type IdleState = typeof IdleState.Type;

type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly args: string;
};

export class IdleError extends Data.TaggedError("IdleError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const fail = (operation: string, cause: unknown) =>
  new IdleError({ operation, message: `${operation} failed`, cause });

const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<string, IdleError>((resume) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        resume(Effect.fail(fail(`${command} ${args.join(" ")}`, error)));
      } else {
        resume(Effect.succeed(stdout));
      }
    });
  });

const parseProcesses = (stdout: string): ReadonlyArray<ProcessRow> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (match === null) return [];
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3];
      const args = match[4];
      if (
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(ppid) ||
        command === undefined ||
        args === undefined
      ) {
        return [];
      }
      return [{ pid, ppid, command, args }];
    });

const hasBusyProcess = (rows: ReadonlyArray<ProcessRow>): boolean => {
  const agentNames = new Set(["claude", "codex", "pi", "opencode"]);
  const packageMarkers = [
    "@anthropic-ai/claude-code",
    "@openai/codex",
    "@earendil-works/pi-coding-agent",
    "opencode-ai",
  ];
  const isAgent = (row: ProcessRow): boolean => {
    if (agentNames.has(row.command)) return true;
    const executableNames = row.args
      .split(/\s+/)
      .slice(0, 3)
      .map((argument) => argument.split("/").at(-1)?.replace(/\.(?:js|mjs|cjs)$/, ""));
    return (
      executableNames.some((name) => name !== undefined && agentNames.has(name)) ||
      packageMarkers.some((marker) => row.args.includes(marker))
    );
  };
  if (rows.some(isAgent)) return true;

  const t3Pids = new Set(
    rows
      .filter(
        (row) =>
          row.args.includes("apps/server/dist/bin.mjs") &&
          (row.args.includes(" serve") || row.args.includes(" start")),
      )
      .map((row) => row.pid),
  );
  return rows.some((row) => t3Pids.has(row.ppid));
};

const readJson = <S extends Schema.Top>(path: string, schema: S) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(path);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents);
  }).pipe(Effect.mapError((cause) => fail(`read ${path}`, cause)));

const readState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(STATE_PATH);
  if (!exists) {
    return { idleSinceEpochMs: null, consecutiveChecks: 0 } satisfies IdleState;
  }
  return yield* readJson(STATE_PATH, IdleState);
});

const writeState = (state: IdleState) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory("/var/lib/cloudbox", { recursive: true });
    const temporary = `${STATE_PATH}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`);
    yield* fs.rename(temporary, STATE_PATH);
  }).pipe(Effect.mapError((cause) => fail(`write ${STATE_PATH}`, cause)));

const hasEstablishedConnection = (port: number) =>
  run("ss", [
    "-Htn",
    "state",
    "established",
    `( sport = :${String(port)} or dport = :${String(port)} )`,
  ]).pipe(Effect.map((stdout) => stdout.trim().length > 0));

const isBusy = (config: IdleConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(KEEP_AWAKE_PATH)) return true;
    const rows = yield* run("ps", ["-eo", "pid=,ppid=,comm=,args="]).pipe(
      Effect.map(parseProcesses),
    );
    if (hasBusyProcess(rows)) return true;
    return yield* hasEstablishedConnection(config.t3Port);
  }).pipe(Effect.mapError((cause) => fail("activity detection", cause)));

const fetchText = (operation: string, url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, init).then((response) => {
        if (!response.ok) {
          throw new Error(`${operation}: IMDS returned HTTP ${String(response.status)}`);
        }
        return response.text();
      }),
    catch: (cause) => fail(operation, cause),
  });

const getInstanceId = Effect.gen(function* () {
  const token = yield* fetchText("request IMDSv2 token", `${IMDS_BASE}/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
  });
  const instanceId = yield* fetchText(
    "read instance id",
    `${IMDS_BASE}/meta-data/instance-id`,
    { headers: { "X-aws-ec2-metadata-token": token } },
  );
  if (!instanceId.startsWith("i-")) {
    return yield* Effect.fail(fail("validate instance id", instanceId));
  }
  return instanceId.trim();
});

const hibernate = (config: IdleConfig) =>
  Effect.gen(function* () {
    const instanceId = yield* getInstanceId;
    const client = new EC2Client({ region: config.region });
    yield* Effect.tryPromise({
      try: () =>
        client.send(
          new StopInstancesCommand({
            InstanceIds: [instanceId],
            Hibernate: true,
          }),
        ),
      catch: (cause) => fail(`hibernate ${instanceId}`, cause),
    });
    yield* Effect.logInfo(`hibernation requested for ${instanceId}`);
  });

export const program = Effect.gen(function* () {
  const config = yield* readJson(CONFIG_PATH, IdleConfig);
  const busy = yield* isBusy(config);
  const now = yield* Effect.sync(() => Date.now());

  if (busy) {
    yield* writeState({ idleSinceEpochMs: null, consecutiveChecks: 0 });
    yield* Effect.logInfo("cloudbox is busy; idle streak reset");
    return;
  }

  const previous = yield* readState;
  const idleSinceEpochMs = previous.idleSinceEpochMs ?? now;
  const next: IdleState = {
    idleSinceEpochMs,
    consecutiveChecks: previous.consecutiveChecks + 1,
  };
  yield* writeState(next);

  const idleForMs = now - idleSinceEpochMs;
  const thresholdMs = config.idleMinutes * 60_000;
  yield* Effect.logInfo(
    `cloudbox idle for ${String(Math.floor(idleForMs / 60_000))} minute(s)`,
  );
  if (idleForMs >= thresholdMs) {
    yield* hibernate(config);
  }
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
