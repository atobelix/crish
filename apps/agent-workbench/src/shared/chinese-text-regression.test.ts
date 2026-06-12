import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const scannedRoots = [
  join(appRoot, "src"),
  join(appRoot, "FRONTEND-DESIGN-PLAN.md"),
  join(appRoot, "AGENT-COORDINATION.md"),
  join(repoRoot, "DEVELOPMENT_LOG.md"),
];

const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".md",
  ".rs",
  ".ts",
  ".tsx",
]);

const forbiddenSequences = [
  cps(0x9422, 0x3126, 0x57db),
  cps(0x6d60, 0xff47, 0x721c),
  cps(0x7490, 0xfe38, 0x57db),
  cps(0x7490, 0xfe3d, 0x57db),
  cps(0x59af, 0x2033, 0x7037),
  cps(0x6769, 0x70ab, 0x5e34),
  cps(0x6769, 0x70b4, 0x5e34),
  cps(0x6d60, 0x8be8, 0x59df),
  cps(0x6d60, 0x8bf2, 0x59df),
  cps(0x6924, 0x572d, 0x6d30),
  cps(0x93bc, 0x6ec5, 0x50a8),
  cps(0x7035, 0x55db, 0x631c),
  cps(0x6dc7, 0x6fc6, 0x74e8),
  cps(0x59dd, 0xff45, 0x6e6a),
  cps(0x93c6, 0x509b, 0x68e4),
  cps(0x9477, 0x7039, 0x6c2b, 0x7b9f),
  cps(0x9359, 0x9422),
  cps(0x6e1a, 0x0444, 0x722e, 0x7035, 0x8270, 0x57c5),
];

describe("Chinese text regression guard", () => {
  it("keeps common UTF-8/GBK mojibake sequences out of Workbench source and planning files", () => {
    const matches: string[] = [];
    for (const file of filesToScan(scannedRoots)) {
      const text = readFileSync(file, "utf8");
      for (const sequence of forbiddenSequences) {
        if (text.includes(sequence)) {
          matches.push(`${relativePath(file)} contains suspicious sequence ${codePoints(sequence)}`);
        }
      }
      if (text.includes("\uFFFD")) {
        matches.push(`${relativePath(file)} contains Unicode replacement characters`);
      }
    }

    expect(matches).toEqual([]);
  });
});

function cps(...values: number[]): string {
  return String.fromCodePoint(...values);
}

function codePoints(value: string): string {
  return [...value].map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ");
}

function* filesToScan(paths: string[]): Iterable<string> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry === "dist") continue;
        yield* filesToScan([join(path, entry)]);
      }
    } else if (textExtensions.has(extname(path))) {
      yield path;
    }
  }
}

function relativePath(path: string): string {
  return path.replace(repoRoot, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
}
