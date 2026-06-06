import type {
  WorkbenchOutputReference,
  WorkbenchOutputReferenceKind,
  WorkbenchOutputReferenceRender,
  WorkbenchOutputReferenceSource
} from "./workbench-contract";

export interface WorkbenchOutputReferenceExtractionOptions {
  now?: string;
  defaultRender?: WorkbenchOutputReferenceRender;
}

interface ReferenceCandidate {
  label?: string;
  target: string;
  kind?: WorkbenchOutputReferenceKind;
  render?: WorkbenchOutputReferenceRender;
  source: WorkbenchOutputReferenceSource;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml"]);
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "swift",
  "sql",
  "html",
  "css",
  "scss",
  "vue",
  "svelte"
]);

export function extractOutputReferencesFromMarkdown(
  markdown: string,
  options: WorkbenchOutputReferenceExtractionOptions = {}
): WorkbenchOutputReference[] {
  const now = options.now ?? new Date().toISOString();
  const candidates = [
    ...extractWorkbenchTags(markdown),
    ...extractMarkdownImages(markdown),
    ...extractMarkdownLinks(markdown),
    ...extractPlainAbsolutePaths(markdown)
  ];
  const references = candidates.map((candidate, index) => createOutputReference(candidate, index, now, options));
  return dedupeOutputReferences(references);
}

export function createOutputReference(
  candidate: ReferenceCandidate,
  index: number,
  now: string,
  options: WorkbenchOutputReferenceExtractionOptions = {}
): WorkbenchOutputReference {
  const target = normalizeTarget(candidate.target);
  const url = isUrl(target) ? target : undefined;
  const path = url ? undefined : stripFileProtocol(target);
  const kind = candidate.kind ?? inferReferenceKind(target);
  const render = candidate.render ?? options.defaultRender ?? defaultRenderForReference(kind, candidate.source);
  const absolute = url ? true : isAbsoluteLocalPath(path ?? target);
  const label = candidate.label?.trim() || readableName(target) || "输出文件";
  const issues = absolute ? [] : ["建议使用绝对路径，避免桌面端无法定位文件。"];

  return {
    id: createReferenceId(target, index),
    label,
    kind,
    render,
    source: candidate.source,
    path,
    url,
    mimeType: inferMimeType(kind, target),
    previewable: isPreviewable(kind),
    editable: isEditable(kind),
    absolute,
    issues,
    createdAt: now
  };
}

export function defaultRenderForReference(
  kind: WorkbenchOutputReferenceKind,
  source: WorkbenchOutputReferenceSource
): WorkbenchOutputReferenceRender {
  if (source === "markdown-image" && kind === "image") return "inline";
  if (kind === "directory" || kind === "link") return "open";
  if (isPreviewable(kind)) return "sidebar";
  return "open";
}

export function inferReferenceKind(target: string): WorkbenchOutputReferenceKind {
  if (isUrl(target) && !isFileProtocol(target)) return "link";
  const clean = stripQueryAndHash(stripFileProtocol(target));
  if (/[\\/]$/.test(clean)) return "directory";
  const extension = extensionOf(clean);
  if (!extension) return "file";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "file";
}

export function isPreviewable(kind: WorkbenchOutputReferenceKind): boolean {
  return kind === "image" || kind === "markdown" || kind === "text" || kind === "code";
}

export function isEditable(kind: WorkbenchOutputReferenceKind): boolean {
  return kind === "markdown" || kind === "text";
}

function extractWorkbenchTags(markdown: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const pattern = /::workbench-(ref|image|file|directory|markdown|text)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const tag = match[1]!;
    const attrs = parseAttributes(match[2]!);
    const target = attrs.path ?? attrs.url ?? attrs.href;
    if (!target) continue;
    candidates.push({
      target,
      label: attrs.label ?? attrs.title,
      kind: normalizeKind(attrs.kind) ?? kindFromTag(tag),
      render: normalizeRender(attrs.render),
      source: "workbench-tag"
    });
  }
  return candidates;
}

function extractMarkdownImages(markdown: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const target = parseMarkdownDestination(match[2]!);
    if (!target) continue;
    candidates.push({
      label: match[1],
      target,
      source: "markdown-image",
      kind: "image",
      render: "inline"
    });
  }
  return candidates;
}

function extractMarkdownLinks(markdown: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const pattern = /(?<!!)\[([^\]]+)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const target = parseMarkdownDestination(match[2]!);
    if (!target) continue;
    candidates.push({
      label: match[1],
      target,
      source: "markdown-link"
    });
  }
  return candidates;
}

function extractPlainAbsolutePaths(markdown: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const pattern = /(?:file:\/\/\/[^\s<>"'）)]+|[A-Za-z]:[\\/][^\s<>"'）)]+|\\\\[^\s<>"'）)]+|\/[^\s<>"'）)]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const target = match[0]!;
    if (target.length < 3) continue;
    if (!hasPlainAbsolutePathBoundary(markdown, match.index, target)) continue;
    candidates.push({
      target,
      source: "final-summary"
    });
  }
  return candidates;
}

function hasPlainAbsolutePathBoundary(markdown: string, index: number, target: string): boolean {
  if (!target.startsWith("/")) return true;
  if (index === 0) return true;
  const previous = markdown[index - 1] ?? "";
  if (previous === ":" && target.startsWith("//")) return false;
  return /[\s([{<"'`\uFF0C\u3002\uFF1B\uFF1A]/.test(previous);
}

function parseMarkdownDestination(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();
  const quoted = trimmed.match(/^"([^"]+)"$/) ?? trimmed.match(/^'([^']+)'$/);
  if (quoted) return quoted[1]!.trim();
  const titleMatch = trimmed.match(/^(\S+)\s+["'][^"']+["']$/);
  return (titleMatch?.[1] ?? trimmed).trim();
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z][\w-]*)=("([^"]*)"|'([^']*)'|[^\s}]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    attrs[match[1]!] = match[3] ?? match[4] ?? match[2] ?? "";
  }
  return attrs;
}

function kindFromTag(tag: string): WorkbenchOutputReferenceKind | undefined {
  if (tag === "image") return "image";
  if (tag === "directory") return "directory";
  if (tag === "markdown") return "markdown";
  if (tag === "text") return "text";
  return undefined;
}

function normalizeKind(value: string | undefined): WorkbenchOutputReferenceKind | undefined {
  if (!value) return undefined;
  const allowed: WorkbenchOutputReferenceKind[] = ["image", "markdown", "text", "code", "directory", "file", "link", "unknown"];
  return allowed.includes(value as WorkbenchOutputReferenceKind) ? (value as WorkbenchOutputReferenceKind) : undefined;
}

function normalizeRender(value: string | undefined): WorkbenchOutputReferenceRender | undefined {
  if (value === "inline" || value === "sidebar" || value === "open") return value;
  return undefined;
}

function dedupeOutputReferences(references: WorkbenchOutputReference[]): WorkbenchOutputReference[] {
  const map = new Map<string, WorkbenchOutputReference>();
  for (const reference of references) {
    const key = `${reference.path ?? reference.url}:${reference.kind}`;
    const existing = map.get(key);
    if (!existing || reference.source === "workbench-tag" || (existing.render !== "inline" && reference.render === "inline")) {
      map.set(key, reference);
    }
  }
  return [...map.values()].map((reference, index) => ({
    ...reference,
    id: `${reference.id}-${index}`
  }));
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/^file:\/\/([A-Za-z]:)/, "file:///$1");
}

function stripFileProtocol(target: string): string {
  if (!isFileProtocol(target)) return target;
  return target.replace(/^file:\/\/\/?/i, "");
}

function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

function isFileProtocol(target: string): boolean {
  return /^file:\/\//i.test(target);
}

function isAbsoluteLocalPath(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target) || /^\\\\/.test(target) || /^\//.test(target);
}

function stripQueryAndHash(target: string): string {
  return target.split(/[?#]/, 1)[0] ?? target;
}

function extensionOf(target: string): string {
  const name = readableName(target);
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1]!.toLowerCase() : "";
}

function readableName(target: string): string {
  const clean = stripQueryAndHash(stripFileProtocol(target)).replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return decodeURIComponentSafe(parts.at(-1) ?? clean);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function inferMimeType(kind: WorkbenchOutputReferenceKind, target: string): string | undefined {
  const extension = extensionOf(target);
  if (kind === "image") {
    if (extension === "svg") return "image/svg+xml";
    if (extension === "jpg") return "image/jpeg";
    return extension ? `image/${extension}` : "image/*";
  }
  if (kind === "markdown") return "text/markdown";
  if (kind === "text" || kind === "code") return "text/plain";
  return undefined;
}

function createReferenceId(target: string, index: number): string {
  const base = target.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reference";
  return `ref-${base}-${index}`;
}
