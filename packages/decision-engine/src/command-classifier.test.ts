import { describe, expect, it } from "vitest";
import { classifyCommand } from "./command-classifier";

describe("classifyCommand Tier 0 read", () => {
  const reads = [
    "pwd",
    "ls -la",
    "dir",
    "tree",
    "Get-ChildItem",
    "cat README.md",
    "cat 测试文件_中文.py",
    'type "my file.txt"',
    "Get-Content note.md",
    "head -n 20 a.ts",
    "tail package.json",
    "rg foo",
    "grep -n bar src",
    "findstr hello",
    "Select-String pattern",
    "git status",
    "git log --oneline -5",
    "git blame src/a.ts",
    "npm test",
    "vitest run",
    "node -v",
    "python --version",
    "ps aux",
    "Get-Process",
    "ipconfig",
    "systeminfo",
    "pwd && ls",
    "cat a.txt | head",
    "Get-ChildItem | Select-Object Name",
  ];

  for (const cmd of reads) {
    it(`read: ${cmd}`, () => {
      expect(classifyCommand(cmd).risk).toBe("read");
    });
  }
});

describe("classifyCommand non-read", () => {
  it("write: npm install", () => {
    expect(classifyCommand("npm install lodash").risk).toBe("network");
  });
  it("write: git commit", () => {
    expect(classifyCommand("git commit -m x").risk).toBe("write");
  });
  it("destructive: rm -rf", () => {
    expect(classifyCommand("rm -rf dist").risk).toBe("destructive");
  });
  it("compound with write is not read", () => {
    expect(classifyCommand("ls && npm install x").risk).not.toBe("read");
  });
});
