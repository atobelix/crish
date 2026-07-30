import { describe, expect, it } from "vitest";
import {
  buildWindowsPowerShellScript,
  defaultProcessShell,
  encodePowerShellEncodedCommand,
  normalizePowerShellCommand,
  runProcessCommand,
  normalizeProcessGuard
} from "./process-executor";

describe("normalizePowerShellCommand", () => {
  it("routes classic cmd pipelines through cmd.exe", () => {
    const normalized = normalizePowerShellCommand("dir | findstr package");
    expect(normalized).toMatch(/^cmd\.exe \/d \/s \/c "/i);
    expect(normalized).toContain("dir | findstr package");
  });

  it("escapes double quotes for cmd.exe wrappers", () => {
    const normalized = normalizePowerShellCommand('echo "hello" | findstr hello');
    expect(normalized).toContain('echo ""hello"" | findstr hello');
  });

  it("splits && into fail-fast PowerShell segments", () => {
    const normalized = normalizePowerShellCommand("npm test && npm run build");
    expect(normalized).toContain("npm test");
    expect(normalized).toContain("npm run build");
    expect(normalized).toContain("if ($LASTEXITCODE");
  });
});

describe("PowerShell EncodedCommand wrapping", () => {
  it("encodes scripts as UTF-16LE base64 for -EncodedCommand", () => {
    const script = "Write-Output 'hi'";
    const encoded = encodePowerShellEncodedCommand(script);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  it("embeds user commands as base64 so special characters do not break the wrapper", () => {
    const userCommand = `echo "a|b" & echo 'c>d' | Write-Output`;
    const script = buildWindowsPowerShellScript(userCommand);
    expect(script).toContain("FromBase64String(");
    expect(script).not.toContain(userCommand);
    // Payload round-trips to the normalized form of the user command
    const match = script.match(/FromBase64String\('([^']+)'\)/);
    expect(match?.[1]).toBeTruthy();
    const decoded = Buffer.from(match![1]!, "base64").toString("utf8");
    expect(decoded).toBe(normalizePowerShellCommand(userCommand));
  });

  it("defaultProcessShell on win32 uses -EncodedCommand argv (not raw -Command string)", () => {
    if (process.platform !== "win32") return;
    const shell = defaultProcessShell();
    const args = shell.args(`Get-ChildItem | Select-Object -First 1; echo "x & y"`);
    expect(shell.command.toLowerCase()).toContain("powershell");
    expect(args).toContain("-EncodedCommand");
    expect(args).not.toContain("-Command");
    const encoded = args[args.indexOf("-EncodedCommand") + 1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("FromBase64String");
    expect(script).toContain("scriptblock]::Create");
  });

  it("executes commands with pipes, ampersands, and quotes on Windows", async () => {
    if (process.platform !== "win32") return;
    const result = await runProcessCommand(`Write-Output "a|b&c>d"`, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      maxOutputBytes: 50_000,
      signal: new AbortController().signal,
      shell: defaultProcessShell(),
      guard: normalizeProcessGuard(false)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a|b&c>d");
  }, 20_000);

  it("executes cmd-style findstr pipelines on Windows", async () => {
    if (process.platform !== "win32") return;
    const result = await runProcessCommand(`echo hello-special | findstr hello`, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      maxOutputBytes: 50_000,
      signal: new AbortController().signal,
      shell: defaultProcessShell(),
      guard: normalizeProcessGuard(false)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("hello");
  }, 20_000);
});
