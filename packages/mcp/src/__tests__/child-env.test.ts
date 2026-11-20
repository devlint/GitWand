import { describe, it, expect, afterEach } from "vitest";
import { childEnv } from "../child-env.js";

describe("childEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("passes the base list and the extras, whatever their case (Windows spells it Path)", () => {
    process.env.Path = "C:\\Windows";
    process.env.PATHEXT = ".EXE";
    process.env.ProgramData = "C:\\ProgramData";
    process.env.ComSpec = "cmd.exe";
    process.env.SystemDrive = "C:";
    process.env.MY_EXTRA = "e";
    process.env.ANTHROPIC_API_KEY = "k";
    const env = childEnv(["MY_EXTRA"]);
    expect(env.Path).toBe("C:\\Windows");
    expect(env.PATHEXT).toBe(".EXE");
    expect(env.ProgramData).toBe("C:\\ProgramData");
    expect(env.ComSpec).toBe("cmd.exe");
    expect(env.SystemDrive).toBe("C:");
    expect(env.MY_EXTRA).toBe("e");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("takes more by prefix, minus what a filter refuses", () => {
    process.env.GIT_DIR = "/x";
    process.env.GIT_TOKEN = "t";
    const env = childEnv([], { prefix: "GIT_", refuse: /TOKEN/ });
    expect(env.GIT_DIR).toBe("/x");
    expect(env.GIT_TOKEN).toBeUndefined();
  });
});
