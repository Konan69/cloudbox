import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  IdleConfig,
  type AuthenticatedT3Activity,
  type AwsIdleProvider,
  type GcpIdleProvider,
} from "./idleConfig.ts";

const CONFIG_PATH = "/etc/cloudbox/config.json";
const STATE_PATH = "/var/lib/cloudbox/idle.json";
const KEEP_AWAKE_PATH = "/run/cloudbox/keepawake";
const AWS_IMDS_BASE = "http://169.254.169.254/latest";
const GCP_METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const GCP_COMPUTE_API = "https://compute.googleapis.com/compute/v1";

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

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const IncusInstance = Schema.Struct({
  name: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});

const T3Client = Schema.Struct({ connected: Schema.Boolean });

export class IdleError extends Data.TaggedError("IdleError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const fail = (operation: string, cause: unknown) =>
  new IdleError({ operation, message: `${operation} failed`, cause });

const runResult = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<CommandResult, IdleError>((resume) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resume(Effect.succeed({ exitCode: 0, stdout, stderr }));
        return;
      }
      if (typeof error.code === "number") {
        resume(Effect.succeed({ exitCode: error.code, stdout, stderr }));
        return;
      }
      resume(Effect.fail(fail(`${command} ${args.join(" ")}`, error)));
    });
  });

const run = (command: string, args: ReadonlyArray<string>) =>
  runResult(command, args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            fail(
              `${command} ${args.join(" ")}`,
              new Error(`exit ${String(result.exitCode)}: ${result.stderr.trim()}`),
            ),
          ),
    ),
  );

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
  return rows.some(
    (row) =>
      t3Pids.has(row.ppid) &&
      row.command !== "cloudflared" &&
      !row.args.includes("/cloudflared/"),
  );
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

const hasAuthenticatedT3Activity = (port: number, activity: AuthenticatedT3Activity) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const token = (yield* fs.readFileString(activity.tokenPath)).trim();
    const clientsJson = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/auth/clients`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`T3 returned HTTP ${String(response.status)}`);
        return response.text();
      },
      catch: (cause) => fail("read active T3 clients", cause),
    });
    const clients = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(T3Client)),
    )(clientsJson).pipe(Effect.mapError((cause) => fail("decode active T3 clients", cause)));
    if (clients.some((client) => client.connected)) return true;

    const count = yield* run("sqlite3", [
      "-readonly",
      `${activity.baseDir}/userdata/state.sqlite`,
      "SELECT COUNT(*) FROM projection_thread_sessions WHERE status IN ('starting','running');",
    ]);
    const running = yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(count.trim()).pipe(
      Effect.mapError((cause) => fail("decode running T3 agent count", cause)),
    );
    return running > 0;
  }).pipe(Effect.mapError((cause) => fail("authenticated T3 activity detection", cause)));

const hasIncusAgentProcess = Effect.gen(function* () {
  const stdout = yield* run("incus", ["list", "--format=json"]);
  const instances = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(IncusInstance)),
  )(stdout).pipe(Effect.mapError((cause) => fail("decode incus instance list", cause)));

  for (const instance of instances) {
    if (instance.status.toUpperCase() !== "RUNNING") continue;
    const probe = yield* runResult("incus", [
      "exec",
      instance.name,
      "--",
      "pgrep",
      "-f",
      "(^|/)([c]laude|[c]odex|[p]i|[o]pencode)( |$)|@anthropic-ai/claude-code|@openai/codex|@earendil-works/pi-coding-agent|opencode-ai",
    ]);
    if (probe.exitCode === 0) return true;
    if (probe.exitCode !== 1) {
      return yield* Effect.fail(
        fail(
          `probe agent processes in ${instance.name}`,
          new Error(`incus exec exited ${String(probe.exitCode)}: ${probe.stderr.trim()}`),
        ),
      );
    }
  }
  return false;
});

const isBusy = (config: IdleConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(KEEP_AWAKE_PATH)) return true;
    const rows = yield* run("ps", ["-eo", "pid=,ppid=,comm=,args="]).pipe(
      Effect.map(parseProcesses),
    );
    if (hasBusyProcess(rows)) return true;
    if (config.checkIncus && (yield* hasIncusAgentProcess)) return true;
    if (config.t3Activity.kind === "authenticated") {
      return yield* hasAuthenticatedT3Activity(config.t3Port, config.t3Activity);
    }
    return yield* hasEstablishedConnection(config.t3Port);
  }).pipe(Effect.mapError((cause) => fail("activity detection", cause)));

const fetchText = (operation: string, url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, init).then((response) => {
        if (!response.ok) {
          throw new Error(`${operation}: request returned HTTP ${String(response.status)}`);
        }
        return response.text();
      }),
    catch: (cause) => fail(operation, cause),
  });

const getAwsInstanceId = (token: string) =>
  Effect.gen(function* () {
    const instanceId = yield* fetchText(
      "read instance id",
      `${AWS_IMDS_BASE}/meta-data/instance-id`,
      { headers: { "X-Aws-Ec2-Metadata-Token": token } },
    );
    if (!instanceId.startsWith("i-")) {
      return yield* Effect.fail(fail("validate instance id", instanceId));
    }
    return instanceId.trim();
  });

const AwsRoleCredentials = Schema.Struct({
  AccessKeyId: Schema.NonEmptyString,
  SecretAccessKey: Schema.NonEmptyString,
  Token: Schema.NonEmptyString,
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmacSha256 = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

const hibernateAws = (provider: AwsIdleProvider) =>
  Effect.gen(function* () {
    const token = yield* fetchText("request IMDSv2 token", `${AWS_IMDS_BASE}/api/token`, {
      method: "PUT",
      headers: { "X-Aws-Ec2-Metadata-Token-Ttl-Seconds": "21600" },
    });
    const instanceId = yield* getAwsInstanceId(token);
    const metadataHeaders = { "X-Aws-Ec2-Metadata-Token": token };
    const roleName = (
      yield* fetchText(
        "read instance IAM role",
        `${AWS_IMDS_BASE}/meta-data/iam/security-credentials/`,
        { headers: metadataHeaders },
      )
    ).trim();
    if (roleName.length === 0 || roleName.includes("\n")) {
      return yield* Effect.fail(fail("validate instance IAM role", roleName));
    }
    const credentialsJson = yield* fetchText(
      "read instance IAM credentials",
      `${AWS_IMDS_BASE}/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`,
      { headers: metadataHeaders },
    );
    const credentials = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(AwsRoleCredentials),
    )(credentialsJson).pipe(
      Effect.mapError((cause) => fail("decode instance IAM credentials", cause)),
    );

    const body = new URLSearchParams({
      Action: "StopInstances",
      "InstanceId.1": instanceId,
      Hibernate: "true",
      Version: "2016-11-15",
    }).toString();
    const now = yield* Effect.sync(() => new Date());
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const host = `ec2.${provider.region}.${provider.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
    const contentType = "application/x-www-form-urlencoded; charset=utf-8";
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n` +
      `x-amz-security-token:${credentials.Token}\n`;
    const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token";
    const canonicalRequest = [
      "POST",
      "/",
      "",
      canonicalHeaders,
      signedHeaders,
      sha256(body),
    ].join("\n");
    const credentialScope = `${dateStamp}/${provider.region}/ec2/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join("\n");
    const dateKey = hmacSha256(`AWS4${credentials.SecretAccessKey}`, dateStamp);
    const regionKey = hmacSha256(dateKey, provider.region);
    const serviceKey = hmacSha256(regionKey, "ec2");
    const signingKey = hmacSha256(serviceKey, "aws4_request");
    const signature = hmacSha256(signingKey, stringToSign).toString("hex");

    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`https://${host}/`, {
          method: "POST",
          headers: {
            Authorization:
              `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${credentialScope}, ` +
              `SignedHeaders=${signedHeaders}, Signature=${signature}`,
            "Content-Type": contentType,
            "X-Amz-Date": amzDate,
            "X-Amz-Security-Token": credentials.Token,
          },
          body,
        });
        if (!response.ok) {
          throw new Error(`EC2 returned HTTP ${String(response.status)}: ${await response.text()}`);
        }
      },
      catch: (cause) => fail(`hibernate ${instanceId}`, cause),
    });
    yield* Effect.logInfo(`hibernation requested for ${instanceId}`);
  });

const gcpMetadata = (path: string) =>
  fetchText(`read GCP metadata ${path}`, `${GCP_METADATA_BASE}${path}`, {
    headers: { "Metadata-Flavor": "Google" },
  }).pipe(Effect.map((value) => value.trim()));

const suspendGcp = (config: GcpIdleProvider) =>
  Effect.gen(function* () {
    const [instanceName, metadataZone, metadataProject, tokenJson] = yield* Effect.all([
      gcpMetadata("/instance/name"),
      gcpMetadata("/instance/zone"),
      gcpMetadata("/project/project-id"),
      gcpMetadata("/instance/service-accounts/default/token"),
    ]);
    const zone = metadataZone.split("/").at(-1);
    if (
      zone === undefined ||
      zone !== config.zone ||
      metadataProject !== config.project ||
      instanceName !== `cloudbox-${config.name}`
    ) {
      return yield* Effect.fail(
        fail("validate GCP instance identity", {
          instanceName,
          metadataProject,
          metadataZone,
          config,
        }),
      );
    }
    const token = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ access_token: Schema.NonEmptyString })),
    )(tokenJson).pipe(Effect.mapError((cause) => fail("decode GCP metadata token", cause)));
    yield* fetchText(
      `suspend ${instanceName}`,
      `${GCP_COMPUTE_API}/projects/${encodeURIComponent(config.project)}/zones/${encodeURIComponent(config.zone)}/instances/${encodeURIComponent(instanceName)}/suspend`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    );
    yield* Effect.logInfo(`suspend requested for ${instanceName}`);
  });

const sleepHost = (provider: IdleConfig["provider"]) =>
  provider.kind === "aws" ? hibernateAws(provider) : suspendGcp(provider);

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
  const idleSinceEpochMs =
    previous.idleSinceEpochMs === null ? now : previous.idleSinceEpochMs;
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
    yield* sleepHost(config.provider);
  }
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: cloudbox-idle\n\nCheck host activity and suspend it after the configured idle period.");
  } else {
    program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
  }
}
