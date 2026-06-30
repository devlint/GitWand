import { describe, it, expect } from "vitest";
import { dateBucket } from "../dateBucket";

const DAY = 86_400_000;
const now = Date.now();

describe("dateBucket", () => {
  it("returns 'today' for a timestamp less than 24 hours ago", () => {
    expect(dateBucket(now - 1_000, now)).toBe("today");
    expect(dateBucket(now - DAY + 1, now)).toBe("today");
  });

  it("returns 'yesterday' for timestamps between 24 and 48 hours ago", () => {
    expect(dateBucket(now - DAY, now)).toBe("yesterday");
    expect(dateBucket(now - 2 * DAY + 1, now)).toBe("yesterday");
  });

  it("returns 'thisWeek' for timestamps between 2 and 7 days ago", () => {
    expect(dateBucket(now - 2 * DAY, now)).toBe("thisWeek");
    expect(dateBucket(now - 7 * DAY + 1, now)).toBe("thisWeek");
  });

  it("returns 'thisMonth' for timestamps between 7 and 30 days ago", () => {
    expect(dateBucket(now - 7 * DAY, now)).toBe("thisMonth");
    expect(dateBucket(now - 30 * DAY + 1, now)).toBe("thisMonth");
  });

  it("returns 'older' for timestamps more than 30 days ago", () => {
    expect(dateBucket(now - 30 * DAY, now)).toBe("older");
    expect(dateBucket(now - 365 * DAY, now)).toBe("older");
  });
});
