import { describe, expect, it } from "vitest";
import { rate, shiftTime, shown } from "./growthFormat";

describe("growth lab formatting", () => {
  it("shows a missing number as not available, and a real 0 as 0", () => {
    expect(shown(null)).toBe("not available");
    expect(shown(null, (n) => `${n}%`)).toBe("not available");
    expect(shown(0)).toBe("0");
    expect(shown(12400)).toBe("12,400");
    expect(shown(58.2, (n) => `${n}%`)).toBe("58.2%");
  });

  it("rounds rates for reading", () => {
    expect(rate(3.25)).toBe("3.3");
    expect(rate(212.6)).toBe("213");
  });

  it("moves a time between the device's clock and UTC, across midnight", () => {
    // getTimezoneOffset is minutes behind UTC: -120 for UTC+2.
    expect(shiftTime("09:00", "utc", -120)).toBe("07:00");
    expect(shiftTime("07:00", "local", -120)).toBe("09:00");
    expect(shiftTime("01:30", "utc", -120)).toBe("23:30");
    expect(shiftTime("22:00", "utc", 300)).toBe("03:00");
  });
});
