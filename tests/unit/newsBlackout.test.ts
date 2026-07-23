import { describe, expect, it } from "vitest";
import {
  isHighImpactCalendarEvent,
  newsBlackoutBlockReason,
} from "../../server/services/AutoTradeRunner";

describe("auto-trade economic news blackout", () => {
  const highOnly = new Set(["HIGH"]);

  it("recognizes configured high-impact events", () => {
    expect(isHighImpactCalendarEvent("Core CPI m/m", "High", highOnly)).toBe(true);
  });

  it.each([
    "Non-Farm Employment Change",
    "Employment Situation",
    "Core PCE Price Index m/m",
    "Advance GDP q/q",
    "Retail Sales m/m",
    "JOLTS Job Openings",
    "ISM Services PMI",
    "FOMC Rate Statement",
    "Fed Chair Testifies",
  ])("recognizes important USD event when provider omits impact: %s", (title) => {
    expect(isHighImpactCalendarEvent(title, "", highOnly)).toBe(true);
  });

  it("does not upgrade an explicitly low-impact employment release", () => {
    expect(
      isHighImpactCalendarEvent("ADP Weekly Employment Change", "Low", highOnly),
    ).toBe(false);
  });

  it("blocks exactly 60 minutes before and after an event", () => {
    const event = "2026-07-14T12:30:00.000Z|USD High CPI";
    expect(
      newsBlackoutBlockReason({
        now: new Date("2026-07-14T11:30:00.000Z"),
        enabled: true,
        events: event,
        minutes: 60,
        timeZone: "Asia/Saigon",
      }),
    ).toContain("60m before");
    expect(
      newsBlackoutBlockReason({
        now: new Date("2026-07-14T13:30:00.000Z"),
        enabled: true,
        events: event,
        minutes: 60,
        timeZone: "Asia/Saigon",
      }),
    ).toContain("60m after");
  });

  it("allows new entries outside the blackout window", () => {
    expect(
      newsBlackoutBlockReason({
        now: new Date("2026-07-14T13:31:00.000Z"),
        enabled: true,
        events: "2026-07-14T12:30:00.000Z|USD High CPI",
        minutes: 60,
        timeZone: "Asia/Saigon",
      }),
    ).toBeNull();
  });
});
