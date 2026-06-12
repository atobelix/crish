import { describe, expect, it } from "vitest";
import { classifyTerminalCommand, getHardlineCommandBlock } from "./permission/command-classification";

describe("command classification (legacy)", () => {
  it("classifies safe read commands as read", () => {
    expect(classifyTerminalCommand("pwd")).toMatchObject({ risk: "read" });
    expect(classifyTerminalCommand("ls -la")).toMatchObject({ risk: "read" });
    expect(classifyTerminalCommand("cat file.txt")).toMatchObject({ risk: "read" });
    expect(classifyTerminalCommand("git status --short")).toMatchObject({ risk: "read" });
  });

  it("classifies write commands as write", () => {
    expect(classifyTerminalCommand("echo hello")).toMatchObject({ risk: "write" });
    expect(classifyTerminalCommand("mkdir newdir")).toMatchObject({ risk: "write" });
  });

  it("detects hardline commands", () => {
    expect(getHardlineCommandBlock("shutdown /s")).toBeDefined();
    expect(getHardlineCommandBlock("sudo rm -rf /")).toBeDefined();
    expect(getHardlineCommandBlock("ls -la")).toBeUndefined();
  });
});
