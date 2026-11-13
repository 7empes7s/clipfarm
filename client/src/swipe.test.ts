import { describe, expect, it } from "vitest";
import { swipeIntent, SWIPE_MIN } from "./swipe";

describe("swipeIntent", () => {
  it("reads a drag to the right as approve and to the left as reject", () => {
    expect(swipeIntent(SWIPE_MIN + 1, 5)).toBe("approve");
    expect(swipeIntent(-(SWIPE_MIN + 1), -20)).toBe("reject");
  });

  it("reads a drag up as the next clip and down as the one before", () => {
    expect(swipeIntent(10, -(SWIPE_MIN + 1))).toBe("next");
    expect(swipeIntent(-10, SWIPE_MIN + 1)).toBe("back");
  });

  it("goes by the longer axis on a diagonal drag", () => {
    expect(swipeIntent(120, -90)).toBe("approve");
    expect(swipeIntent(90, -120)).toBe("next");
  });

  it("is a tap when the finger barely moved, and nothing for a short drag", () => {
    expect(swipeIntent(3, -4)).toBe("tap");
    expect(swipeIntent(40, 0)).toBeNull();
    expect(swipeIntent(0, -SWIPE_MIN)).toBeNull();
  });
});
