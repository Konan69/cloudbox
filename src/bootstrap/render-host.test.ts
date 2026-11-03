import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { IdleConfig } from "../box/idleConfig.ts";
import {
  HOST_AGENT_PACKAGES,
  renderFetchWrapper,
  renderHostBootstrap,
} from "./render-host.ts";

const config = {
  boxUser: "dev",
  name: "test",
  project: "cloudbox-project",
  zone: "us-central1-a",
  zfsDataDevice: "/dev/disk/by-id/google-agent-data",
  idleMinutes: 45,
  t3Port: 3773,
  t3: {
    repoUrl: "https://github.com/pingdotgg/t3code.git",
    branch: "main",
    relayUrl: "https://relay.t3.codes",
    clerkPublishableKey: "example-publishable-key",
    clerkCliOauthClientId: "example-client-id",
  },
} as const;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describe("renderHostBootstrap", () => {
  it("renders the settled host phases and interpolates config", () => {
    const script = renderHostBootstrap(config);

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("/var/log/cloudbox-bootstrap.log");
    expect(script).toContain("host-v2-$name.done");
    expect(script).toContain('run_phase 05-golden-v2 "$REBUILD_GOLDEN" phase_golden');
    expect(script).not.toContain('run_phase 05-golden "$REBUILD_GOLDEN" phase_golden');
    expect(script).toContain("run_phase 06a-t3-machine-identity-unit");
    expect(script).toContain("/dev/disk/by-id/google-agent-data");
    expect(script).toContain("zpool create");
    expect(script).toContain("source: tank/incus");
    expect(script).toContain("incusbr0");
    expect(script).toContain("images:ubuntu/24.04/cloud testvm --vm </dev/null");
    expect(script).toContain("security.nesting=true");
    expect(script).toContain("incus publish golden-build --alias golden");
    expect(script).toContain('box_uid="$(id -u "$BOX_USER")"');
    expect(script).toContain('box_gid="$(id -g "$BOX_USER")"');
    expect(script).toContain("userdel -r ubuntu");
    expect(script).toContain("groupdel ubuntu");
    expect(script).toContain('groupmod -g "$HOST_GID" "$USER_NAME"');
    expect(script).toContain('usermod -u "$HOST_UID" -g "$HOST_GID"');
    expect(script).toContain('chown -R "$HOST_UID:$HOST_GID" "/home/$USER_NAME"');
    expect(script).toContain('incus exec golden-build -- getent passwd ubuntu');
    expect(script).toContain("--rebuild");
    expect(script).toContain("https://github.com/pingdotgg/t3code.git");
    expect(script).toContain("main");
    expect(script).toContain("apps/server/dist/bin.mjs serve");
    expect(script).toContain("--host 127.0.0.1 --port 3773");
    expect(script).toContain(
      "Environment=T3_MACHINE_IDENTITY_MANIFEST=/home/dev/.config/cloudbox/machine-identity.json",
    );
    expect(script).not.toContain(
      'cat > "/home/$BOX_USER/.config/cloudbox/machine-identity.json"',
    );
    expect(script).toContain("--label idle-detector");
    const encodedConfig = /printf '%s' '([^']+)' \| base64 --decode > \/etc\/cloudbox\/config\.json/.exec(
      script,
    )?.[1];
    expect(encodedConfig).toBeDefined();
    const idleConfig = Schema.decodeUnknownSync(Schema.fromJsonString(IdleConfig))(
      Buffer.from(encodedConfig ?? "", "base64").toString("utf8"),
    );
    expect(idleConfig).toEqual({
      provider: {
        kind: "gcp",
        name: "test",
        project: "cloudbox-project",
        zone: "us-central1-a",
      },
      idleMinutes: 45,
      t3Port: 3773,
      t3Activity: {
        kind: "authenticated",
        baseDir: "/home/dev/.t3",
        tokenPath: "/home/dev/.t3/idle-detector.token",
      },
      checkIncus: true,
    });
    expect(script).not.toContain("service install");
    for (const packageName of HOST_AGENT_PACKAGES) expect(script).toContain(packageName);
  });

  it("renders valid bash", () => {
    const result = spawnSync("bash", ["-n"], {
      input: renderHostBootstrap(config),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps bundles out of the inner bootstrap", () => {
    const script = renderHostBootstrap(config);

    expect(script).toContain("test -s /opt/cloudbox/idle.mjs");
    expect(script).toContain("test -s /opt/cloudbox/machines.mjs");
    expect(script).not.toContain("console.log('idle bundle')");
  });
});

describe("renderFetchWrapper", () => {
  it("renders a sub-4 KiB authenticated wrapper with content-addressed assets", () => {
    const bootstrap = renderHostBootstrap(config);
    const idle = "console.log('idle')\n";
    const machines = "console.log('machines')\n";
    const wrapper = renderFetchWrapper({
      bucketName: "cloudbox-test-assets-deadbeef00",
      bootstrap: {
        objectName: sha256(bootstrap),
        sha256: sha256(bootstrap),
        destination: "/var/lib/cloudbox/host-bootstrap.sh",
        mode: "700",
      },
      idle: {
        objectName: sha256(idle),
        sha256: sha256(idle),
        destination: "/opt/cloudbox/idle.mjs",
        mode: "755",
      },
      machines: {
        objectName: sha256(machines),
        sha256: sha256(machines),
        destination: "/opt/cloudbox/machines.mjs",
        mode: "755",
      },
    });

    expect(Buffer.byteLength(wrapper, "utf8")).toBeLessThan(4 * 1024);
    expect(wrapper).toContain("Metadata-Flavor: Google");
    expect(wrapper).toContain(`/${sha256(bootstrap)}?alt=media`);
    expect(wrapper).toContain(`/${sha256(idle)}?alt=media`);
    expect(wrapper).toContain(`/${sha256(machines)}?alt=media`);
    expect(wrapper).toContain(`printf '%s  %s\\n' "$expected" "$temporary" | sha256sum --check --status`);
    expect(wrapper).toContain("exec bash '/var/lib/cloudbox/host-bootstrap.sh' </dev/null");
    const result = spawnSync("bash", ["-n"], { input: wrapper, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
