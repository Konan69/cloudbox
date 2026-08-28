import { readFileSync, writeFileSync } from "node:fs";
import * as Schema from "effect/Schema";

import { renderBootstrap } from "../src/bootstrap/render.ts";
import { CloudboxConfig } from "../src/config.ts";

const outputPath = process.argv[2];
if (outputPath === undefined || outputPath.length === 0) {
  throw new Error("usage: tsx scripts/render-bootstrap.ts <output-path>");
}

const config = Schema.decodeUnknownSync(CloudboxConfig)(
  JSON.parse(readFileSync("cloudbox.example.json", "utf8")),
);

writeFileSync(
  outputPath,
  renderBootstrap({
    config,
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDUMMYCLOUDBOXSTATICCHECK acceptance@example",
    idleBundle: "console.log('cloudbox static-check idle bundle')",
  }),
  { mode: 0o700 },
);
