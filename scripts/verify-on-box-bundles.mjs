import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "cloudbox-bundles-"));

try {
  for (const artifact of ["dist/idle.mjs", "dist/machines.mjs"]) {
    const source = resolve(artifact);
    const destination = join(temporaryDirectory, basename(artifact));
    cpSync(source, destination);

    const bundle = readFileSync(destination, "utf8");
    const externalImports = [...bundle.matchAll(/\b(?:from|import\()\s*["']([^"']+)/g)].map(
      (match) => match[1],
    );
    const nonBuiltinImports = externalImports.filter((specifier) => !specifier.startsWith("node:"));
    if (nonBuiltinImports.length > 0) {
      throw new Error(`${artifact} has non-builtin imports: ${nonBuiltinImports.join(", ")}`);
    }

    const result = spawnSync(process.execPath, [destination, "--help"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    });
    if (result.status !== 0) {
      throw new Error(
        `${artifact} is not self-contained (exit ${String(result.status)}):\n${result.stderr}`,
      );
    }
    if (!result.stdout.toLowerCase().includes("usage")) {
      throw new Error(`${artifact} --help did not print usage information`);
    }
  }

  console.log(`Verified idle.mjs and machines.mjs without node_modules in ${temporaryDirectory}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
