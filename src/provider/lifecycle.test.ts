import { describe, expect, it } from "@effect/vitest";

import { isRunningState, isSleepingState } from "./lifecycle.ts";

describe("provider lifecycle states", () => {
  it("recognizes AWS hibernation states", () => {
    expect(isRunningState("aws", "running")).toBe(true);
    expect(isSleepingState("aws", "stopped")).toBe(true);
  });

  it("recognizes GCP suspend states for branch integration", () => {
    expect(isRunningState("gcp", "RUNNING")).toBe(true);
    expect(isSleepingState("gcp", "SUSPENDED")).toBe(true);
  });
});
