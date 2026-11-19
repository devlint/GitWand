import { describe, it, expect } from "vitest";
import { COMMIT_SIGNATURE, withoutSignature } from "../commitSignature";

describe("withoutSignature", () => {
  it("removes the signature alone or as the closing paragraph", () => {
    expect(withoutSignature(COMMIT_SIGNATURE)).toBe("");
    expect(withoutSignature(`#7\n\n${COMMIT_SIGNATURE}`)).toBe("#7");
  });
  it("removes it from a closing paragraph where trailers follow it", () => {
    expect(withoutSignature(`body\n\n${COMMIT_SIGNATURE}\nSigned-off-by: A <a@x>`)).toBe("body\n\nSigned-off-by: A <a@x>");
  });
  it("leaves a description that does not end with it", () => {
    expect(withoutSignature("body")).toBe("body");
    expect(withoutSignature(`${COMMIT_SIGNATURE}\n\nbody`)).toBe(`${COMMIT_SIGNATURE}\n\nbody`);
  });
});
