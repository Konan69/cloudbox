import { describe, expect, it } from "@effect/vitest";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  formatVerificationReport,
  privateKeyPathFromConfig,
  verificationReportJson,
  type VerificationReport,
} from "./index.ts";

const report: VerificationReport = {
  ok: false,
  results: [
    { name: "bootstrap", pass: true, evidence: "marker=present", durationMs: 12 },
    { name: "docker", pass: false, evidence: "permission denied", durationMs: 34 },
  ],
};

describe("acceptance report", () => {
  it("formats pass/fail evidence as a table", () => {
    const output = formatVerificationReport(report);
    expect(output).toContain("bootstrap  PASS");
    expect(output).toContain("docker     FAIL");
    expect(output).toContain("permission denied");
  });

  it("formats the full report as JSON", () => {
    expect(JSON.parse(verificationReportJson(report))).toEqual(report);
  });

  it("derives the private key explicitly from the configured public key", () => {
    expect(privateKeyPathFromConfig("~/.ssh/id_ed25519.pub")).toBe(
      NodePath.join(NodeOs.homedir(), ".ssh/id_ed25519"),
    );
    expect(() => privateKeyPathFromConfig("~/.ssh/id_ed25519")).toThrow(
      "must end in .pub",
    );
  });
});
