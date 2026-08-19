/**
 * 前端派生：文档产物。引擎 `ToolOutput.artifacts` 弱时从工具路径/正文长出。
 * 代码路径永不进 Artifact；无 docId 不在此创建 persist。
 */

import { basename, extractPath, parseArgs } from './humanize';
import type { ArtifactNode, ProjectToolCallInput } from './types';

const DOC_PATH_RE = /\.(md|markdown|txt|rst|adoc)$/i;
const CODE_PATH_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|go|py|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|swift|rb|php|scala|lua|sql|sh|bash|zsh|ps1|bat|cmd|css|scss|less|json|ya?ml|toml|xml|html?|vue|svelte|wasm|zig|dart|proto)$/i;
const ARTIFACT_CONTENT_CHAR_CAP = 8000;
const SYNTHETIC_DOC_IDS = new Set(['silent-doc']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(
  rec: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function fileNameOf(path: string): string {
  const cut = path.split(/[?#]/)[0] ?? path;
  return basename(cut);
}

/** 前端派生：md/txt 报告路径才算文档产物 */
export function isDocumentArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  return DOC_PATH_RE.test(fileNameOf(path));
}

/** 前端派生：源码/配置永不进 Notebook */
export function isCodeArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  const name = fileNameOf(path);
  if (DOC_PATH_RE.test(name)) return false;
  return CODE_PATH_RE.test(name);
}

function parseNoteUri(raw: string): string | undefined {
  const m = /^(?:note|notebook):(.*)$/i.exec(raw.trim());
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1] ?? '').trim();
  } catch {
    return (m[1] ?? '').trim();
  }
}

/** 前端派生：已有笔记 id 才可用；拒静默壳 / 诚实空 */
export function usableArtifactDocId(
  raw: string | undefined | null,
): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const fromUri = parseNoteUri(s);
  if (fromUri !== undefined) {
    if (!fromUri) return undefined;
    if (SYNTHETIC_DOC_IDS.has(fromUri)) return undefined;
    if (/^strict-/i.test(fromUri)) return undefined;
    return fromUri;
  }
  if (SYNTHETIC_DOC_IDS.has(s)) return undefined;
  if (/^strict-/i.test(s)) return undefined;
  if (/^(note|notebook)$/i.test(s)) return undefined;
  return s;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(s);
    if (Array.isArray(parsed)) return { artifacts: parsed };
    return asRecord(parsed);
  } catch {
    return null;
  }
}

interface EngineFileArt {
  title: string;
  path: string;
  text: string;
  docId?: string;
  uri: string;
}

function readEngineFileArts(output: string | undefined): EngineFileArt[] {
  if (!output) return [];
  const rec = tryParseJson(output);
  if (!rec) return [];
  const list = rec['artifacts'];
  if (!Array.isArray(list)) return [];
  const out: EngineFileArt[] = [];
  for (const item of list) {
    const obj = asRecord(item);
    if (!obj) continue;
    if (obj['kind'] !== 'file') continue;
    const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
    const uri = typeof obj['uri'] === 'string' ? obj['uri'].trim() : '';
    const text = typeof obj['text'] === 'string' ? obj['text'] : '';
    const meta = asRecord(obj['metadata']);
    const docId = usableArtifactDocId(
      meta ? pickString(meta, ['docId', 'doc_id', 'noteId', 'note_id']) : '',
    );
    const path = uri || title;
    out.push({
      title: title || fileNameOf(path) || '文档',
      path,
      text,
      ...(docId ? { docId } : {}),
      uri,
    });
  }
  return out;
}

function looksLikeStatusLine(raw: string): boolean {
  const s = raw.trim();
  if (!s) return true;
  if (s.includes('\n') && s.length > 80) return false;
  if (s.length >= 200) return false;
  return /^(wrote|created|updated|saved|ok|success|written|已写入|已保存|已创建|已更新)\b/i.test(
    s,
  );
}

function capContent(raw: string): string {
  if (raw.length <= ARTIFACT_CONTENT_CHAR_CAP) return raw;
  return `${raw.slice(0, ARTIFACT_CONTENT_CHAR_CAP)}\n…`;
}

function pickContent(
  engineText: string,
  args: Record<string, unknown>,
  output: string | undefined,
): string {
  if (engineText.trim()) return capContent(engineText);
  const fromArgs = pickString(args, [
    'contents',
    'content',
    'markdown',
    'body',
    'new_string',
    'text',
  ]);
  if (fromArgs && fromArgs.length > 1 && !/^[\\/]?\S+\.\w{1,12}$/.test(fromArgs)) {
    return capContent(fromArgs);
  }
  const out = String(output ?? '').trim();
  if (!out) return '';
  const parsed = tryParseJson(out);
  if (parsed) {
    const text = pickString(parsed, ['text', 'markdown', 'content']);
    if (text) return capContent(text);
  }
  if (looksLikeStatusLine(out)) return '';
  return capContent(out);
}

function docIdFromNoteUri(raw: string | undefined): string | undefined {
  if (!raw || !/^(?:note|notebook):/i.test(raw.trim())) return undefined;
  return usableArtifactDocId(raw);
}

function pickDocId(
  engine: EngineFileArt | undefined,
  args: Record<string, unknown>,
  path: string,
): string | undefined {
  return (
    engine?.docId ||
    usableArtifactDocId(
      pickString(args, ['docId', 'doc_id', 'documentId', 'noteId', 'note_id']),
    ) ||
    docIdFromNoteUri(engine?.uri) ||
    docIdFromNoteUri(path)
  );
}

function mimeOf(title: string, path: string): ArtifactNode['mime'] {
  const name = fileNameOf(title || path);
  return /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text';
}

/**
 * 前端派生：单条 tool → 文档 Artifact；代码 / 非文档返回 null。
 */
export function deriveArtifactFromTool(
  tc: Pick<
    ProjectToolCallInput,
    'id' | 'name' | 'arguments' | 'status' | 'output'
  >,
): ArtifactNode | null {
  if (!tc || tc.status === 'pending_approval') return null;

  const args = parseArgs(tc.arguments);
  const engineArts = readEngineFileArts(tc.output);
  const engine = engineArts.find(
    (a) => !isCodeArtifactPath(a.path) && !isCodeArtifactPath(a.title),
  );
  const path = extractPath(tc.arguments) || engine?.path || '';

  if (isCodeArtifactPath(path)) return null;
  if (engine && isCodeArtifactPath(engine.path || engine.title)) return null;

  const title = engine?.title || (path ? fileNameOf(path) : '');
  const looksDoc =
    isDocumentArtifactPath(path) ||
    isDocumentArtifactPath(title) ||
    Boolean(engine);

  if (!looksDoc) return null;

  const content = pickContent(engine?.text ?? '', args, tc.output);
  const docId = pickDocId(engine, args, path);
  const node: ArtifactNode = {
    kind: 'artifact',
    id: `art-${tc.id}`,
    title: title || '文档',
    mime: mimeOf(title, path),
    content,
    derived: engine ? 'engine' : 'frontend',
  };
  if (path && !/^(note|notebook):/i.test(path)) node.path = path;
  if (docId) node.docId = docId;
  return node;
}

/** 前端派生：多条 tool → 文档 Artifact 列表（跳过代码） */
export function deriveArtifacts(
  toolCalls: readonly ProjectToolCallInput[] | undefined,
): ArtifactNode[] {
  const out: ArtifactNode[] = [];
  for (const tc of toolCalls ?? []) {
    const node = deriveArtifactFromTool(tc);
    if (node) out.push(node);
  }
  return out;
}
