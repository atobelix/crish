import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodeTextBuffer } from "./encoding";

export interface AgentSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  content: string;
  disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
  skills: AgentSkill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiagnostic {
  severity: "warning";
  path: string;
  message: string;
}

interface ParsedFrontmatter {
  data: Record<string, string | boolean>;
  body: string;
}

export async function loadSkillsFromDirectory(dir: string): Promise<LoadSkillsResult> {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  await loadSkillsInto(dir, result, true);
  return result;
}

export function formatSkillInvocation(skill: AgentSkill, userInstruction?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return userInstruction ? `${block}\n\n${userInstruction}` : block;
}

async function loadSkillsInto(dir: string, result: LoadSkillsResult, includeRootMarkdown: boolean): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    const skill = await loadSkillFile(join(dir, "SKILL.md"));
    if (skill) {
      result.skills.push(skill);
    }
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await loadSkillsInto(fullPath, result, false);
      continue;
    }
    if (includeRootMarkdown && entry.isFile() && entry.name.endsWith(".md")) {
      const skill = await loadSkillFile(fullPath);
      if (skill) {
        result.skills.push(skill);
      }
    }
  }
}

async function loadSkillFile(filePath: string): Promise<AgentSkill | null> {
  let content: string;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }
    const decoded = decodeTextBuffer(await readFile(filePath));
    if (decoded.encoding === "binary") {
      return null;
    }
    content = decoded.text;
  } catch {
    return null;
  }

  const parsed = parseFrontmatter(content);
  const baseDir = dirname(filePath);
  const fallbackName = basename(baseDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = String(parsed.data.name || fallbackName);
  const description = String(parsed.data.description || firstMarkdownSentence(parsed.body) || name);
  return {
    name,
    description,
    filePath,
    baseDir,
    content: parsed.body.trim(),
    disableModelInvocation: parsed.data["disable-model-invocation"] === true
  };
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith("---")) {
    return { data: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: content };
  }
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!.trim();
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    data[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return { data, body };
}

function firstMarkdownSentence(content: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  return line?.slice(0, 160);
}
