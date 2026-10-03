import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";

import {
  BoatSshConfigError,
  renderBoatWindowsSshBlock,
  runBoatSshProxy,
  updateBoatManagedSshConfig,
} from "./ssh.ts";

const blockInput = {
  name: "dev",
  distribution: "Ubuntu-24.04",
  workingDirectory: "/home/dev/cloudbox",
  nodePath: "/usr/local/bin/node",
  cliPath: "/home/dev/cloudbox/dist/cli.mjs",
};

describe("Boat Windows SSH config", () => {
  it("renders the Windows OpenSSH entry and WSL proxy command", () => {
    const block = renderBoatWindowsSshBlock(blockInput);

    expect(block).toContain("# BEGIN CLOUDBOX BOAT cloudbox-dev");
    expect(block).toContain("Host cloudbox-dev");
    expect(block).toContain("    User user");
    expect(block).toContain("    IdentityFile ~/.ssh/ascii_box_ed25519");
    expect(block).toContain("    StrictHostKeyChecking no");
    expect(block).toContain("    UserKnownHostsFile NUL");
    expect(block).toContain(
      "ProxyCommand C:/Windows/System32/wsl.exe --distribution Ubuntu-24.04 --cd /home/dev/cloudbox --exec /usr/local/bin/node /home/dev/cloudbox/dist/cli.mjs boat proxy dev %p",
    );
    expect(block).toContain("# END CLOUDBOX BOAT cloudbox-dev");
  });

  it("adds and replaces only its managed block, idempotently", () => {
    const original = "Host existing\r\n    User somebody\r\n";
    const first = updateBoatManagedSshConfig(
      original,
      "dev",
      renderBoatWindowsSshBlock(blockInput),
    );
    const second = updateBoatManagedSshConfig(
      first,
      "dev",
      renderBoatWindowsSshBlock(blockInput),
    );

    expect(second).toBe(first);
    expect(second.startsWith(original)).toBe(true);
    expect(second.match(/BEGIN CLOUDBOX BOAT/gu)).toHaveLength(1);
    expect(second).toContain("Host existing\r\n    User somebody\r\n");
  });

  it("refuses malformed markers instead of touching other entries", () => {
    expect(() =>
      updateBoatManagedSshConfig(
        "Host existing\n# BEGIN CLOUDBOX BOAT cloudbox-dev\n",
        "dev",
        renderBoatWindowsSshBlock(blockInput),
      ),
    ).toThrow(BoatSshConfigError);
  });
});

describe("Boat SSH stdio proxy", () => {
  it("retries boat_restoring, then carries the SSH stream", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      if (connections === 1) {
        socket.end("boat_restoring\n");
        return;
      }
      socket.write("SSH-2.0-boat-test\r\n");
      socket.on("data", (chunk) => socket.end(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");

    const input = new PassThrough();
    const output = new PassThrough();
    let received = "";
    output.on("data", (chunk) => {
      received += chunk.toString();
    });
    const proxy = runBoatSshProxy({
      host: "127.0.0.1",
      port: address.port,
      input,
      output,
      retryDelayMs: 0,
      handshakeTimeoutMs: 1_000,
      maxAttempts: 3,
    });
    input.end("hello");
    await proxy;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );

    expect(connections).toBe(2);
    expect(received).toBe("SSH-2.0-boat-test\r\necho:hello");
  });
});
