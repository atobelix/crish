import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { decodeTextBuffer, isWritableTextEncoding, type WritableTextFileEncoding } from "../../encoding";
import { formatNumberedLines, splitTextLines } from "../shared";
import type { EditResultPreview, EditOperation } from "./types";

export async function resolveWriteEncoding(filePath: string, requested: string | undefined): Promise<WritableTextFileEncoding> {
  if (requested) {
    if (requested === "utf-8" || requested === "utf-8-bom" || requested === "utf-16le" || requested === "utf-16be") {
      return requested;
    }
    throw new Error(`Unsupported write encoding: ${requested}`);
  }

  const existing = await readFile(filePath).then(decodeTextBuffer).catch(() => null);
  if (!existing) return "utf-8";
  if (isWritableTextEncoding(existing.encoding)) return existing.encoding;
  throw new Error(
    `Refusing to overwrite ${basename(filePath)} because its detected encoding is ${existing.encoding}. ` +
      "Pass encoding: \"utf-8\" explicitly to convert it."
  );
}

export async function writeBytesAtomically(
  filePath: string,
  bytes: Buffer,
  options?: { createParents?: boolean }
): Promise<void> {
  if (options?.createParents !== false) {
    await mkdir(dirname(filePath), { recursive: true });
  }
  const tempPath = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1_000_000_000)}.tmp`
  );
  await writeFile(tempPath, bytes);
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createUnifiedDiffPreview(beforeText: string, afterText: string): string {
  const beforeLines = splitTextLines(beforeText);
  const afterLines = splitTextLines(afterText);
  const maxLines = 120;
  let beforeIndex = 0;
  let afterIndex = 0;
  const output: string[] = ["--- before", "+++ after"];

  while ((beforeIndex < beforeLines.length || afterIndex < afterLines.length) && output.length < maxLines + 2) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];
    if (beforeLine === afterLine) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    if (beforeLine !== undefined) {
      output.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
    if (afterLine !== undefined) {
      output.push(`+${afterLine}`);
      afterIndex += 1;
    }
  }

  if (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    output.push(`... diff preview truncated (${beforeLines.length} -> ${afterLines.length} lines)`);
  }
  if (output.length === 2) output.push("(no textual diff)");
  return output.join("\n");
}

export function createEditResultPreview(beforeText: string, afterText: string, fullWrite: boolean): EditResultPreview {
  const afterLines = splitTextLines(afterText);
  const totalLines = afterLines.length;
  const maxPreviewLines = 80;
  const contextLines = 3;
  const range = fullWrite ? { startLine: 1, endLine: totalLines } : findChangedAfterLineRange(beforeText, afterText);
  const startLine = fullWrite ? 1 : Math.max(1, range.startLine - contextLines);
  const endLine = fullWrite ? totalLines : Math.min(totalLines, range.endLine + contextLines);
  const selectedLineCount = Math.max(0, endLine - startLine + 1);
  const truncated = fullWrite ? totalLines > maxPreviewLines : selectedLineCount > maxPreviewLines;
  const visibleEndLine = truncated ? startLine + maxPreviewLines - 1 : endLine;
  const previewLines = afterLines.slice(startLine - 1, visibleEndLine);
  const omittedLines = Math.max(0, endLine - visibleEndLine);
  const scope = fullWrite ? "actual file" : "actual file around changes";
  const summary = truncated
    ? `Result preview (${scope}, lines ${startLine}-${visibleEndLine} of ${totalLines}; ${omittedLines} lines omitted):`
    : `Result preview (${scope}, lines ${startLine}-${visibleEndLine} of ${totalLines}):`;

  return {
    mode: fullWrite ? "full" : "changed-range",
    summary,
    text: previewLines.length > 0 ? formatNumberedLines(previewLines, startLine) : "(empty file)",
    startLine,
    endLine: visibleEndLine,
    totalLines,
    truncated,
    omittedLines
  };
}

function findChangedAfterLineRange(beforeText: string, afterText: string): { startLine: number; endLine: number } {
  const beforeLines = splitTextLines(beforeText);
  const afterLines = splitTextLines(afterText);
  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let beforeSuffixIndex = beforeLines.length - 1;
  let afterSuffixIndex = afterLines.length - 1;
  while (
    beforeSuffixIndex >= prefixLength &&
    afterSuffixIndex >= prefixLength &&
    beforeLines[beforeSuffixIndex] === afterLines[afterSuffixIndex]
  ) {
    beforeSuffixIndex -= 1;
    afterSuffixIndex -= 1;
  }

  const startLine = Math.min(prefixLength + 1, Math.max(1, afterLines.length));
  const endLine = afterSuffixIndex >= prefixLength ? afterSuffixIndex + 1 : startLine;
  return { startLine, endLine };
}

export function pickOldNewStrings(source: Record<string, JsonValue | undefined>): {
  oldString?: string;
  newString?: string;
  present: boolean;
} {
  const oldString =
    typeof source.old_string === "string"
      ? source.old_string
      : typeof source.oldString === "string"
        ? source.oldString
        : typeof source.old_str === "string"
          ? source.old_str
          : undefined;
  const newString =
    typeof source.new_string === "string"
      ? source.new_string
      : typeof source.newString === "string"
        ? source.newString
        : typeof source.new_str === "string"
          ? source.new_str
          : undefined;
  return {
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
    present: oldString !== undefined || newString !== undefined
  };
}

export function textReplaceFields(input: JsonObject): { oldString: string; newString: string } | undefined {
  const picked = pickOldNewStrings(input);
  if (!picked.present) return undefined;
  if (typeof picked.oldString !== "string") {
    throw new Error("old_string is required when new_string is provided");
  }
  if (typeof picked.newString !== "string") {
    throw new Error("new_string is required when old_string is provided");
  }
  return { oldString: picked.oldString, newString: picked.newString };
}

export function editOperationsField(input: JsonObject, key: string): EditOperation[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const operation = item as Record<string, JsonValue>;
    if (operation.anchor !== undefined || operation.endAnchor !== undefined) {
      throw new Error(`${key}[${index}] anchor fields are no longer supported. Use startLine, endLine, line, or replace_text with old_string/new_string.`);
    }
    const op = operation.op;
    if (
      op !== "replace" &&
      op !== "replace_text" &&
      op !== "insert_before" &&
      op !== "insert_after" &&
      op !== "insert_head" &&
      op !== "insert_tail" &&
      op !== "delete"
    ) {
      throw new Error(
        `${key}[${index}].op must be replace, replace_text, insert_before, insert_after, insert_head, insert_tail, or delete`
      );
    }

    if (op === "replace_text") {
      const picked = pickOldNewStrings(operation);
      if (typeof picked.oldString !== "string") {
        throw new Error(`${key}[${index}].old_string (or oldString) must be a string for replace_text`);
      }
      if (typeof picked.newString !== "string") {
        throw new Error(`${key}[${index}].new_string (or newString) must be a string for replace_text`);
      }
      return {
        op,
        oldString: picked.oldString,
        newString: picked.newString
      };
    }

    const content = operation.content;
    if ((op === "replace" || op === "insert_before" || op === "insert_after" || op === "insert_head" || op === "insert_tail") && typeof content !== "string") {
      throw new Error(`${key}[${index}].content must be a string for ${op}`);
    }
    const startLine = optionalLineNumber(operation.startLine, `${key}[${index}].startLine`);
    const endLine = optionalLineNumber(operation.endLine, `${key}[${index}].endLine`);
    const line = optionalLineNumber(operation.line, `${key}[${index}].line`);
    const contentStr = typeof content === "string" ? content : undefined;
    return {
      op,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(contentStr !== undefined ? { content: contentStr } : {}),
    };
  });
}

function optionalLineNumber(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
