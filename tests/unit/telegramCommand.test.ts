import { describe, expect, it } from "vitest";
import { parseCheckCommand } from "../../server/services/TelegramCommandService";

describe("Telegram /check command", () => {
  it("uses /check without an id for all active XAUUSD orders", () => {
    expect(parseCheckCommand("/check")).toEqual({ kind: "ACTIVE_XAUUSD" });
    expect(parseCheckCommand("/check@my_bot  ")).toEqual({
      kind: "ACTIVE_XAUUSD",
    });
  });

  it("keeps the existing signal-id review command", () => {
    expect(parseCheckCommand('/check "12345678-abcd"')).toEqual({
      kind: "SIGNAL",
      id: "12345678-abcd",
    });
  });

  it("ignores malformed commands", () => {
    expect(parseCheckCommand("/check abc")).toBeNull();
    expect(parseCheckCommand("/other")).toBeNull();
  });
});
