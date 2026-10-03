import * as Data from "effect/Data";
import { Socket, createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";

export const BOAT_SSH_USER = "user";
export const BOAT_WINDOWS_IDENTITY = "~/.ssh/ascii_box_ed25519";

export class BoatSshConfigError extends Data.TaggedError("BoatSshConfigError")<{
  readonly message: string;
}> {}

export class BoatSshProxyError extends Data.TaggedError("BoatSshProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BoatWindowsSshBlockInput {
  readonly name: string;
  readonly distribution: string;
  readonly workingDirectory: string;
  readonly nodePath: string;
  readonly cliPath: string;
}

/**
 * Quotes a ProxyCommand argument only when it needs quoting. Windows OpenSSH
 * hands the command to wsl.exe with quotes intact, and wsl.exe then looks up a
 * distribution literally named `"Ubuntu-24.04"` (verified 2026-10-03:
 * WSL_E_DISTRO_NOT_FOUND, which reached ssh as an invalid banner). Plain
 * values are therefore emitted bare.
 */
const sshConfigQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./~-]+$/u.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const markerName = (name: string): string => `cloudbox-${name}`;

export const boatSshConfigMarkers = (name: string) => ({
  begin: `# BEGIN CLOUDBOX BOAT ${markerName(name)}`,
  end: `# END CLOUDBOX BOAT ${markerName(name)}`,
});

export const renderBoatWindowsSshBlock = (input: BoatWindowsSshBlockInput): string => {
  const alias = markerName(input.name);
  const markers = boatSshConfigMarkers(input.name);
  const proxyCommand = [
    "C:/Windows/System32/wsl.exe",
    "--distribution",
    sshConfigQuote(input.distribution),
    "--cd",
    sshConfigQuote(input.workingDirectory),
    "--exec",
    sshConfigQuote(input.nodePath),
    sshConfigQuote(input.cliPath),
    "boat",
    "proxy",
    sshConfigQuote(input.name),
    "%p",
  ].join(" ");

  return [
    markers.begin,
    `Host ${alias}`,
    `    HostName ${alias}`,
    `    User ${BOAT_SSH_USER}`,
    `    IdentityFile ${BOAT_WINDOWS_IDENTITY}`,
    "    IdentitiesOnly yes",
    // Boat resumes onto a new machine with new SSH host keys. Never retain or
    // compare a key from the previous machine under this stable alias.
    "    StrictHostKeyChecking no",
    "    UserKnownHostsFile NUL",
    "    GlobalKnownHostsFile NUL",
    "    LogLevel ERROR",
    `    ProxyCommand ${proxyCommand}`,
    markers.end,
  ].join("\n");
};

const countOccurrences = (contents: string, value: string): number => {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = contents.indexOf(value, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + value.length;
  }
};

export const updateBoatManagedSshConfig = (
  existing: string,
  name: string,
  block: string,
): string => {
  const markers = boatSshConfigMarkers(name);
  const beginCount = countOccurrences(existing, markers.begin);
  const endCount = countOccurrences(existing, markers.end);
  if (beginCount !== endCount || beginCount > 1) {
    throw new BoatSshConfigError({
      message: `Malformed managed SSH block for ${markerName(name)}; expected one matching begin/end marker pair`,
    });
  }

  const lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
  const rendered = block.replaceAll("\n", lineEnding);
  if (beginCount === 0) {
    if (existing.length === 0) return `${rendered}${lineEnding}`;
    const separator = existing.endsWith(lineEnding)
      ? existing.endsWith(`${lineEnding}${lineEnding}`) ? "" : lineEnding
      : `${lineEnding}${lineEnding}`;
    return `${existing}${separator}${rendered}${lineEnding}`;
  }

  const start = existing.indexOf(markers.begin);
  const endMarkerStart = existing.indexOf(markers.end, start);
  const end = endMarkerStart + markers.end.length;
  return `${existing.slice(0, start)}${rendered}${existing.slice(end)}`;
};

export interface BoatSshProxyOptions {
  readonly host: string;
  readonly port: number;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly retryDelayMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly connect?: (host: string, port: number) => Socket;
}

type ProbeResult =
  | { readonly kind: "connected"; readonly socket: Socket; readonly preface: Buffer }
  | { readonly kind: "retry"; readonly reason: string };

const probeSsh = (
  host: string,
  port: number,
  timeoutMs: number,
  connect: (host: string, port: number) => Socket,
): Promise<ProbeResult> =>
  new Promise((resolve, reject) => {
    const socket = connect(host, port);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (result.kind === "retry") socket.destroy();
      resolve(result);
    };
    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new BoatSshProxyError({ message, ...(cause === undefined ? {} : { cause }) }));
    };
    const inspect = () => {
      const preface = Buffer.concat(chunks);
      const text = preface.toString("utf8");
      if (text.includes("boat_restoring")) {
        finish({ kind: "retry", reason: "boat_restoring" });
        return;
      }
      if (/(?:^|\r?\n)SSH-[0-9.]+-/u.test(text)) {
        finish({ kind: "connected", socket, preface });
        return;
      }
      if (preface.length > 8_192) {
        fail(`Boat SSH at ${host}:${String(port)} returned an invalid preface`);
      }
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      inspect();
    };
    const onError = (cause: NodeJS.ErrnoException) =>
      finish({ kind: "retry", reason: cause.code ?? cause.message });
    const onClose = () => {
      const text = Buffer.concat(chunks).toString("utf8");
      finish({
        kind: "retry",
        reason: text.includes("boat_restoring") ? "boat_restoring" : "connection closed before SSH was ready",
      });
    };
    const timer = setTimeout(
      () => finish({ kind: "retry", reason: "SSH handshake timed out" }),
      timeoutMs,
    );
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

const wait = (milliseconds: number): Promise<void> =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));

export const runBoatSshProxy = async (options: BoatSshProxyOptions): Promise<void> => {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 150;
  const connect = options.connect ?? ((host, port) => createConnection({ host, port }));
  let lastReason = "unknown error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await probeSsh(options.host, options.port, handshakeTimeoutMs, connect);
    if (result.kind === "retry") {
      lastReason = result.reason;
      if (attempt < maxAttempts) await wait(retryDelayMs);
      continue;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const complete = (error?: unknown) => {
        if (settled) return;
        settled = true;
        input.unpipe(result.socket);
        result.socket.unpipe(output);
        if (error === undefined) resolve();
        else reject(
          new BoatSshProxyError({
            message: `Boat SSH proxy connection to ${options.host}:${String(options.port)} failed`,
            cause: error,
          }),
        );
      };
      result.socket.once("error", complete);
      result.socket.once("close", () => complete());
      output.write(result.preface);
      input.pipe(result.socket);
      result.socket.pipe(output, { end: false });
    });
    return;
  }

  throw new BoatSshProxyError({
    message: `Boat SSH at ${options.host}:${String(options.port)} was not ready after ${String(maxAttempts)} attempts: ${lastReason}`,
  });
};
