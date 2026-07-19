import { runStartupTest, type StartupTest } from "./startup-runner";

const WARM_START_TEST: StartupTest = {
  name: "tauri.desktop.warm",
  measure: "warm",
  target: {
    skeletonMs: 20,
    interactiveMs: 100,
    fullMs: 200,
  },
  command: process.execPath,
  args: ["-e", "console.log('ready')"],
  readyPattern: "ready",
  timeoutMs: 15_000,
};

const WEB_CHROME_COLD: StartupTest = {
  name: "web.chrome.cold",
  measure: "cold",
  target: {
    skeletonMs: 100,
    interactiveMs: 400,
    fullMs: 1000,
  },
  command: process.execPath,
  args: ["--version"],
  readyPattern: "skeleton",
  timeoutMs: 30_000,
};

const isMain = process.argv[1]?.endsWith("measure-warm-start.ts");
if (isMain) {
  runStartupTest(WARM_START_TEST).then((result) => process.exit(result.passed ? 0 : 1));
}
