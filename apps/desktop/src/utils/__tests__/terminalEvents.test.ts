import { describe, it, expect, vi } from "vitest";
import { dispatchTerminalEvent } from "../terminalEvents";

describe("dispatchTerminalEvent", () => {
  it("routes chunks to onOutput and the exit to onExit", () => {
    const onOutput = vi.fn();
    const onExit = vi.fn();
    dispatchTerminalEvent({ type: "chunk", data: "hi" }, onOutput, onExit);
    dispatchTerminalEvent({ type: "exit", code: 3 }, onOutput, onExit);
    dispatchTerminalEvent({ type: "exit", code: null }, onOutput, undefined);
    expect(onOutput).toHaveBeenCalledWith("hi");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(3);
  });
});
