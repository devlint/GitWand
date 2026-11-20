import { describe, it, expect } from "vitest";
import { elicitConfirm } from "../confirm.js";

function fakeServer(caps: unknown, action = "accept") {
  const asked: unknown[] = [];
  return {
    asked,
    getClientCapabilities: () => caps as any,
    elicitInput: async (params: unknown, opts: unknown) => {
      asked.push({ params, opts });
      return { action } as any;
    },
  };
}

describe("elicitConfirm", () => {
  it("cannot ask a client without elicitation", async () => {
    expect(await elicitConfirm(fakeServer({}))("ok?")).toBeUndefined();
  });

  it("cannot ask a client that only opens URLs", async () => {
    const s = fakeServer({ elicitation: { url: {} } });
    expect(await elicitConfirm(s)("ok?")).toBeUndefined();
    expect(s.asked).toHaveLength(0);
  });

  it.each([[{}], [{ form: {} }], [{ form: {}, url: {} }]])("asks with a form: %j", async (elicitation) => {
    const s = fakeServer({ elicitation });
    expect(await elicitConfirm(s)("ok?")).toBe(true);
    expect((s.asked[0] as any).params).toMatchObject({ message: "ok?", requestedSchema: { type: "object", properties: {} } });
  });

  it("a decline or cancel is a no", async () => {
    expect(await elicitConfirm(fakeServer({ elicitation: {} }, "decline"))("ok?")).toBe(false);
    expect(await elicitConfirm(fakeServer({ elicitation: {} }, "cancel"))("ok?")).toBe(false);
  });

  it("asks within the tool call: its signal and a bounded wait", async () => {
    const s = fakeServer({ elicitation: {} });
    const ac = new AbortController();
    await elicitConfirm(s, ac.signal)("ok?");
    expect((s.asked[0] as any).opts).toMatchObject({ signal: ac.signal, timeout: 5 * 60_000 });
  });
});
