import { describe, expect, it } from "vitest";

import { detectResumeGrace, IDLE_CHECK_INTERVAL_MS } from "./idle.ts";

describe("idle resume grace", () => {
  it("detects a wall-clock jump larger than three idle intervals", () => {
    const now = 20 * 60_000;
    expect(
      detectResumeGrace(
        { lastTickEpochMs: 0, graceUntilEpochMs: undefined },
        now,
        12,
      ),
    ).toEqual({
      resumed: true,
      graceUntilEpochMs: now + 12 * 60_000,
    });
  });

  it("does not classify an ordinary delayed tick at the boundary as a resume", () => {
    expect(
      detectResumeGrace(
        { lastTickEpochMs: 1_000, graceUntilEpochMs: 99_000 },
        1_000 + 3 * IDLE_CHECK_INTERVAL_MS,
        12,
      ),
    ).toEqual({ resumed: false, graceUntilEpochMs: 99_000 });
  });

  it("preserves an existing grace marker between ordinary ticks", () => {
    expect(
      detectResumeGrace(
        { lastTickEpochMs: 1_000, graceUntilEpochMs: 600_000 },
        1_000 + IDLE_CHECK_INTERVAL_MS,
        12,
      ),
    ).toEqual({ resumed: false, graceUntilEpochMs: 600_000 });
  });
});
