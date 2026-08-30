import { describe, expect, it } from "vitest";

import {
  detectResumeGrace,
  IDLE_CHECK_INTERVAL_MS,
  isAuthenticatedT3Busy,
} from "./idle.ts";

describe("authenticated T3 activity", () => {
  it("does not keep the box awake for a background-connected client", () => {
    expect(
      isAuthenticatedT3Busy({
        clients: [{ connected: true }],
        runningSessions: 0,
      }),
    ).toBe(false);
  });

  it("keeps the box awake while a thread session is running", () => {
    expect(
      isAuthenticatedT3Busy({
        clients: [],
        runningSessions: 1,
      }),
    ).toBe(true);
  });
});

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
