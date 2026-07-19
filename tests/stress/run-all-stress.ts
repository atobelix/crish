import { runAllStressTests } from "./stress-runner";
import { AI_STREAM_STRESS } from "./stress-ai-stream";
import { DIFF_LOAD_STRESS } from "./stress-diff-load";
import { SESSION_SWITCH_STRESS } from "./stress-session-switch";

async function main() {
  console.log("=".repeat(60));
  console.log("压力测试套件");
  console.log("=".repeat(60));

  await runAllStressTests([AI_STREAM_STRESS, DIFF_LOAD_STRESS, SESSION_SWITCH_STRESS]);
}

main().catch((err) => {
  console.error("压力测试失败:", err);
  process.exitCode = 1;
});
