import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateSystemUiQuality } from "./ui-quality-gate";

const root = process.argv[2];
if (!root) {
  console.error("Usage: npx tsx packages/agent-runtime/scripts/check-ui-quality.ts <generated-ui-root>");
  process.exit(2);
}

const outputRoot = resolve(process.cwd(), root);
const readOptionalText = (name: string): string => {
  const file = join(outputRoot, name);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const result = evaluateSystemUiQuality({
  html: readOptionalText("index.html"),
  css: readOptionalText("styles.css"),
  js: readOptionalText("app.js"),
  minHtmlChars: readIntegerEnv("MIMO_UI_MIN_HTML_CHARS", 18_000),
  minCssChars: readIntegerEnv("MIMO_UI_MIN_CSS_CHARS", 14_000),
  minJsChars: readIntegerEnv("MIMO_UI_MIN_JS_CHARS", 6_000),
  requireSelfIteration: process.env.MIMO_UI_REQUIRE_SELF_ITERATION !== "0"
});

console.log(JSON.stringify({ outputRoot, ...result }, null, 2));
if (result.warnings.length > 0) {
  process.exitCode = 1;
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}
