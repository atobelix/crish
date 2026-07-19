import { runStartupTest, type StartupTest } from "./startup-runner";

const COLD_START_TEST: StartupTest = {
  name: "tauri.desktop.cold",
  measure: "cold",
  target: {
    skeletonMs: 50,
    interactiveMs: 200,
    fullMs: 500,
  },
  command: process.execPath,
  args: ["--version"],
  readyPattern: "skeleton",
  timeoutMs: 30_000,
};

const isMain = process.argv[1]?.endsWith("measure-cold-start.ts");
if (isMain) {
  runStartupTest(COLD_START_TEST).then((result) => process.exit(result.passed ? 0 : 1));
}
