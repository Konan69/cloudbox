import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";

import type { CloudboxConfig } from "../config.ts";
import {
  isRunningState,
  isSleepingState,
  type ProviderInstance,
  type ProviderLifecycle,
} from "../provider/lifecycle.ts";

export const VerificationResult = Schema.Struct({
  name: Schema.NonEmptyString,
  pass: Schema.Boolean,
  evidence: Schema.String,
  durationMs: Schema.Number,
});

export type VerificationResult = typeof VerificationResult.Type;

export interface VerificationReport {
  readonly ok: boolean;
  readonly results: ReadonlyArray<VerificationResult>;
}

export class AcceptanceError extends Data.TaggedError("AcceptanceError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SshTarget {
  readonly host: string;
  readonly user: string;
  readonly privateKeyPath: string;
}

export interface AcceptanceCheck {
  readonly name: string;
  readonly run: Effect.Effect<VerificationResult>;
}

const acceptanceError = (operation: string, message: string, cause?: unknown) =>
  new AcceptanceError({
    ...(cause === undefined ? {} : { cause }),
    operation,
    message,
  });

const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  input: string,
  timeoutMs = 300_000,
): Effect.Effect<ProcessOutput, AcceptanceError> =>
  Effect.callback<ProcessOutput, AcceptanceError>((resume) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(
        Effect.fail(acceptanceError(command, `Could not start ${command}`, cause)),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(
        Effect.succeed({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: timedOut ? `${stderr}\ncommand timed out after ${String(timeoutMs)}ms` : stderr,
        }),
      );
    });
    child.stdin.end(input);
  });

export const privateKeyPathFromConfig = (publicKeyPath: string): string => {
  const expanded = publicKeyPath === "~" || publicKeyPath.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), publicKeyPath.slice(2))
    : NodePath.resolve(publicKeyPath);
  if (!expanded.endsWith(".pub")) {
    throw acceptanceError(
      "SSH key",
      `sshPublicKeyPath must end in .pub so verification can select its private key: ${publicKeyPath}`,
    );
  }
  return expanded.slice(0, -4);
};

const sshTarget = (config: CloudboxConfig, host: string): SshTarget => ({
  host,
  user: config.boxUser,
  privateKeyPath: privateKeyPathFromConfig(config.sshPublicKeyPath),
});

const makeSshTarget = (config: CloudboxConfig, host: string) =>
  Effect.try({
    try: () => sshTarget(config, host),
    catch: (cause) =>
      cause instanceof AcceptanceError
        ? cause
        : acceptanceError("SSH target", "Could not resolve the configured SSH key", cause),
  });

const runSsh = (target: SshTarget, script: string, timeoutMs?: number) =>
  runProcess(
    "ssh",
    [
      "-i",
      target.privateKeyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      `${target.user}@${target.host}`,
      "bash",
      "-s",
    ],
    script,
    timeoutMs,
  );

const evidenceFrom = (output: ProcessOutput): string => {
  const evidence = output.exitCode === 0 ? output.stdout.trim() : `${output.stdout}\n${output.stderr}`.trim();
  return evidence.length === 0 ? `exit=${String(output.exitCode)}` : evidence;
};

const remoteCheck = (
  target: SshTarget,
  name: string,
  body: string,
  timeoutMs?: number,
): AcceptanceCheck => ({
  name,
  run: Effect.gen(function* () {
    const startedAt = Date.now();
    const output = yield* runSsh(
      target,
      `set -euo pipefail\nexport PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:/usr/local/bin:/usr/bin:/bin"\n${body}\n`,
      timeoutMs,
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ exitCode: 1, stdout: "", stderr: error.message }),
        onSuccess: (output) => output,
      }),
    );
    return {
      name,
      pass: output.exitCode === 0,
      evidence: evidenceFrom(output),
      durationMs: Date.now() - startedAt,
    };
  }),
});

const bootstrapCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "bootstrap",
    `marker_evidence=''
if sudo test -f /var/lib/cloudbox/bootstrapped; then
  marker_evidence='marker=bootstrapped'
else
  phases=(
    01-host-packages
    02-zfs
    03-incus
    04-incus-verification
    05-golden
    06-t3
    07-t3-idle-token
    08-cloudbox-tools
  )
  for phase_name in "\${phases[@]}"; do
    sudo test -f "/var/lib/cloudbox/host-v2-$phase_name.done"
  done
  marker_evidence='markers=host-v2:8/8'
fi
sudo test -f /var/log/cloudbox-bootstrap.log
if sudo grep -nE '(^|[^[:alnum:]_])ERROR([^[:alnum:]_]|$)' /var/log/cloudbox-bootstrap.log; then
  echo "bootstrap log contains ERROR" >&2
  exit 1
fi
printf '%s log_errors=0\\n' "$marker_evidence"`,
  );

const versionsCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "tool versions",
    `failed=0
for tool in node vp claude codex pi opencode; do
  if ! command -v "$tool" >/dev/null; then
    printf '%s=missing\\n' "$tool"
    failed=1
    continue
  fi
  version="$($tool --version 2>&1 || true)"
  version="$(printf '%s\\n' "$version" | head -n 1)"
  if [[ -z "$version" ]]; then
    printf '%s=invalid-version\\n' "$tool"
    failed=1
  else
    printf '%s=%s\\n' "$tool" "$version"
  fi
done
pnpm_version="$(cd /home/dev/t3code && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version)"
if [[ "$pnpm_version" != 11.* ]]; then failed=1; fi
printf 'pnpm=%s\\n' "$pnpm_version"
exit "$failed"`,
  );

const zfsCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "zfs tank",
    `health="$(sudo zpool list -H -o health tank)"
test "$health" = ONLINE
for dataset in tank/incus tank/archive; do
  sudo zfs list -H -o name "$dataset" | grep -Fx "$dataset" >/dev/null
done
printf 'pool=tank health=%s datasets=tank/incus,tank/archive\\n' "$health"`,
  );

const incusCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "incus",
    `incus admin waitready --timeout=60
server_version="$(incus version | tail -n 1)"
printf 'ready=true version=%s\\n' "$server_version"`,
  );

const cleanIncusInstance = `cleanup() { incus delete --force accept-ct </dev/null >/dev/null 2>&1 || true; }
trap cleanup EXIT
if incus info accept-ct </dev/null >/dev/null 2>&1; then incus delete --force accept-ct </dev/null; fi`;

const containerCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "incus container",
    `${cleanIncusInstance}
incus launch images:ubuntu/24.04 accept-ct </dev/null
uname_output="$(incus exec accept-ct -- uname -a </dev/null)"
test -n "$uname_output"
printf '%s\\n' "$uname_output"`,
    300_000,
  );

const vmCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "incus vm",
    `${cleanIncusInstance}
test -e /dev/kvm
incus launch images:ubuntu/24.04 accept-ct --vm </dev/null
deadline=$((SECONDS + 240))
uname_output=''
until uname_output="$(incus exec accept-ct -- uname -a </dev/null 2>/dev/null)"; do
  if (( SECONDS >= deadline )); then echo 'VM agent did not become ready' >&2; exit 1; fi
  sleep 5
done
test -n "$uname_output"
printf 'kvm=present %s\\n' "$uname_output"`,
    300_000,
  );

const goldenImageCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "golden image",
    `aliases="$(incus image alias list --format json)"
printf '%s' "$aliases" | jq -e 'type == "array" and any(.[]; .name == "golden")' >/dev/null
printf 'alias=golden present=true\\n'`,
  );

const t3Check = (target: SshTarget) =>
  remoteCheck(
    target,
    "t3 server",
    `environment="$(curl --fail --silent --show-error http://127.0.0.1:3773/.well-known/t3/environment)"
printf '%s' "$environment" | jq -e 'type == "object"' >/dev/null
token="$(cat /home/dev/.t3/idle-detector.token)"
test -n "$token"
clients="$(curl --fail --silent --show-error -H "Authorization: Bearer $token" http://127.0.0.1:3773/api/auth/clients)"
printf '%s' "$clients" | jq -e 'type == "array"' >/dev/null
service_state="$(XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active t3code-fork.service)"
test "$service_state" = active
printf 'environment=json clients=%s service=%s\\n' "$(printf '%s' "$clients" | jq 'length')" "$service_state"`,
  );

const machinesCliCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "machines cli",
    `command -v /usr/local/bin/cloudbox-machines >/dev/null
machines="$(/usr/local/bin/cloudbox-machines list)"
printf '%s' "$machines" | jq -e 'type == "array" or type == "object"' >/dev/null
printf 'cloudbox-machines=json\\n'`,
  );

const idleTimerCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "idle timer",
    `state="$(systemctl is-active cloudbox-idle.timer)"
test "$state" = active
printf 'cloudbox-idle.timer=%s\\n' "$state"`,
  );

const dockerCheck = (target: SshTarget) =>
  remoteCheck(
    target,
    "docker",
    `server_version="$(docker info --format '{{.ServerVersion}}')"
test -n "$server_version"
printf 'user=%s server=%s\\n' "$(id -un)" "$server_version"`,
  );

export const makeAcceptanceChecks = (
  config: CloudboxConfig,
  host: string,
  expectVm: boolean,
): ReadonlyArray<AcceptanceCheck> => {
  const target = sshTarget(config, host);
  const checks = [
    bootstrapCheck(target),
    versionsCheck(target),
    zfsCheck(target),
    incusCheck(target),
    containerCheck(target),
  ];
  if (expectVm) checks.push(vmCheck(target));
  checks.push(
    goldenImageCheck(target),
    t3Check(target),
    machinesCliCheck(target),
    idleTimerCheck(target),
    dockerCheck(target),
  );
  return checks;
};

export const runAcceptanceSuite = (
  config: CloudboxConfig,
  host: string,
  expectVm: boolean,
) =>
  Effect.gen(function* () {
    yield* makeSshTarget(config, host);
    const results: Array<VerificationResult> = [];
    for (const check of makeAcceptanceChecks(config, host, expectVm)) {
      results.push(yield* check.run);
    }
    return { ok: results.every((result) => result.pass), results } satisfies VerificationReport;
  });

const pad = (value: string, width: number): string => value.padEnd(width, " ");
const oneLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

export const formatVerificationReport = (report: VerificationReport): string => {
  const nameWidth = Math.max("CHECK".length, ...report.results.map((result) => result.name.length));
  const rows = [
    `${pad("CHECK", nameWidth)}  RESULT  EVIDENCE`,
    `${"-".repeat(nameWidth)}  ------  --------`,
    ...report.results.map(
      (result) =>
        `${pad(result.name, nameWidth)}  ${pad(result.pass ? "PASS" : "FAIL", 6)}  ${oneLine(result.evidence)}`,
    ),
  ];
  return rows.join("\n");
};

export const verificationReportJson = (report: VerificationReport): string =>
  JSON.stringify(report, null, 2);

const RemoteSleepState = Schema.Struct({
  uptime: Schema.Number,
  pid: Schema.Number,
});

type RemoteSleepState = typeof RemoteSleepState.Type;

const readSleepState = (target: SshTarget, markerPid?: number) =>
  runSsh(
    target,
    markerPid === undefined
      ? `set -euo pipefail\nuptime="$(cut -d ' ' -f 1 /proc/uptime)"\nsleep 100000 >/dev/null 2>&1 &\npid=$!\nprintf '{"uptime":%s,"pid":%s}\\n' "$uptime" "$pid"\n`
      : `set -euo pipefail\nuptime="$(cut -d ' ' -f 1 /proc/uptime)"\nkill -0 ${String(markerPid)}\nprintf '{"uptime":%s,"pid":%s}\\n' "$uptime" '${String(markerPid)}'\nkill ${String(markerPid)}\n`,
  ).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.try({
            try: () => JSON.parse(output.stdout) as unknown,
            catch: (cause) =>
              acceptanceError("parse sleep state", "Host returned invalid sleep-state JSON", cause),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(RemoteSleepState),
            ),
            Effect.mapError((cause) =>
              cause instanceof AcceptanceError
                ? cause
                : acceptanceError(
                    "parse sleep state",
                    "Host returned invalid sleep-state fields",
                    cause,
                  ),
            ),
          )
        : Effect.fail(
            acceptanceError("read sleep state", evidenceFrom(output)),
          ),
    ),
  );

const waitForProviderState = (
  lifecycle: ProviderLifecycle,
  predicate: (instance: ProviderInstance) => boolean,
  timeoutSeconds: number,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (true) {
      const instance = yield* lifecycle.status;
      if (predicate(instance)) return instance;
      if (Date.now() >= deadline) {
        return yield* Effect.fail(
          acceptanceError(
            "wait for provider state",
            `Timed out after ${String(timeoutSeconds)}s; last state=${instance.state}`,
          ),
        );
      }
      yield* Effect.sleep(5_000);
    }
  });

const waitForSshState = (
  target: SshTarget,
  markerPid: number,
  timeoutSeconds: number,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (true) {
      const attempt = yield* Effect.result(readSleepState(target, markerPid));
      if (Result.isSuccess(attempt)) return attempt.success;
      if (Date.now() >= deadline) return yield* Effect.fail(attempt.failure);
      yield* Effect.sleep(5_000);
    }
  });

const lifecycleResult = (
  name: string,
  pass: boolean,
  evidence: string,
  startedAt: number,
): VerificationResult => ({ name, pass, evidence, durationMs: Date.now() - startedAt });

export const verifySleepRoundtrip = (
  config: CloudboxConfig,
  lifecycle: ProviderLifecycle,
  timeoutSeconds: number,
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1_000;
    const remainingSeconds = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
    const initial = yield* lifecycle.status;
    if (!isRunningState(lifecycle.provider, initial.state) || initial.publicIp === undefined) {
      return yield* Effect.fail(
        acceptanceError(
          "verify sleep",
          `Instance must be running with a public IP; state=${initial.state}`,
        ),
      );
    }
    const initialTarget = yield* makeSshTarget(config, initial.publicIp);
    const before = yield* readSleepState(initialTarget);
    yield* lifecycle.sleep;
    const sleeping = yield* waitForProviderState(
      lifecycle,
      (instance) => isSleepingState(lifecycle.provider, instance.state),
      remainingSeconds(),
    );
    const running = yield* lifecycle.wake;
    if (running.publicIp === undefined) {
      return yield* Effect.fail(
        acceptanceError("verify sleep", "Woken instance has no public IP"),
      );
    }
    const resumedTarget = yield* makeSshTarget(config, running.publicIp);
    const after = yield* waitForSshState(
      resumedTarget,
      before.pid,
      remainingSeconds(),
    );
    const uptimeContinued = after.uptime >= before.uptime;
    const results = [
      lifecycleResult(
        "provider sleep",
        true,
        `state=${sleeping.state}`,
        startedAt,
      ),
      lifecycleResult(
        "uptime continued",
        uptimeContinued,
        `before=${String(before.uptime)} after=${String(after.uptime)}`,
        startedAt,
      ),
      lifecycleResult(
        "memory marker",
        after.pid === before.pid,
        `pid=${String(before.pid)} alive=true`,
        startedAt,
      ),
    ];
    return { ok: results.every((result) => result.pass), results } satisfies VerificationReport;
  });

export const verifyIdleSleep = (
  config: CloudboxConfig,
  lifecycle: ProviderLifecycle,
  timeoutSeconds: number,
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const untouchedSeconds = (config.idleMinutes + 5) * 60;
    if (timeoutSeconds <= untouchedSeconds) {
      return yield* Effect.fail(
        acceptanceError(
          "verify idle",
          `--timeout must exceed idleMinutes+5 (${String(untouchedSeconds)} seconds)`,
        ),
      );
    }
    const initial = yield* lifecycle.status;
    if (!isRunningState(lifecycle.provider, initial.state)) {
      return yield* Effect.fail(
        acceptanceError("verify idle", `Instance must start running; state=${initial.state}`),
      );
    }
    yield* Effect.sleep(untouchedSeconds * 1_000);
    const sleeping = yield* waitForProviderState(
      lifecycle,
      (instance) => isSleepingState(lifecycle.provider, instance.state),
      timeoutSeconds - untouchedSeconds,
    );
    const results = [
      lifecycleResult(
        "automatic idle sleep",
        true,
        `idle=${String(config.idleMinutes)}m grace=5m state=${sleeping.state}`,
        startedAt,
      ),
    ];
    return { ok: true, results } satisfies VerificationReport;
  });
