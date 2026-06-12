#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const harness = resolve(fileURLToPath(new URL("./benchmark-daemon-streaming-harness.ts", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const runtime = String(args.runtime ?? "tsx");
const command = resolveCommand(runtime, process.argv.slice(2));

const child = spawn(command.file, command.args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    PATH: process.env.PATH ? `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH}` : join(repoRoot, "node_modules", ".bin")
  },
  shell: command.shell,
  stdio: "inherit",
  windowsHide: true
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.once("error", (error) => {
  console.error(`[stream-benchmark] Failed to start ${command.display}: ${error.message}`);
  process.exit(1);
});

function resolveCommand(runtime, rawArgs) {
  const forwardedArgs = rawArgs.filter((arg, index) => {
    if (arg === "--runtime") return false;
    if (rawArgs[index - 1] === "--runtime") return false;
    return !arg.startsWith("--runtime=");
  });

  if (runtime === "tsx") {
    const cli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const commandArgs = [cli, "--conditions", "development", harness, ...forwardedArgs];
    return { file: process.execPath, args: commandArgs, shell: false, display: `${process.execPath} ${commandArgs.join(" ")}` };
  }

  if (runtime === "bun-ts") {
    const probe = spawnSync("bun", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    if (probe.error || probe.status !== 0) {
      console.error("[stream-benchmark] Bun runtime requested but `bun` was not found. Install Bun or use --runtime tsx.");
      process.exit(2);
    }
    return {
      file: "bun",
      args: ["--conditions", "development", harness, ...forwardedArgs],
      shell: process.platform === "win32",
      display: `bun --conditions development ${harness}`
    };
  }

  throw new Error(`Unknown runtime "${runtime}". Use tsx or bun-ts.`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
