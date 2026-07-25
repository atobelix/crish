import * as fs from "node:fs";
import * as path from "node:path";
import { DeclarativeProviderDef, normalizeDeclarativeDef } from "../declarative-schema";
import { validateBaseUrl } from "../auth/base-url-validator";

export interface ValidationReport {
  filePath: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateProviderFile(filePath: string): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(content) as Record<string, unknown>;

    if (!raw.providerId) errors.push("Missing required field: providerId");
    if (!raw.name) errors.push("Missing required field: name");
    if (!raw.engine) errors.push("Missing required field: engine");

    const engine = raw.engine as string;
    if (engine && !["openai-compatible", "anthropic-messages", "ollama"].includes(engine)) {
      errors.push(`Invalid engine: ${engine}. Must be one of: openai-compatible, anthropic-messages, ollama`);
    }

    if (!raw.baseUrl) errors.push("Missing required field: baseUrl");

    if (raw.baseUrl) {
      const urlCheck = validateBaseUrl(raw.baseUrl as string);
      if (!urlCheck.valid) errors.push(`Invalid baseUrl: ${urlCheck.error}`);
    }

    if (!raw.models || !Array.isArray(raw.models) || (raw.models as unknown[]).length === 0) {
      errors.push("At least one model is required");
    } else {
      for (const m of raw.models as Array<Record<string, unknown>>) {
        if (!m.id) errors.push("Model missing required field: id");
        const ctx = m.contextWindow as number | undefined;
        if (ctx != null && ctx < 1024) {
          warnings.push(`Model ${m.id} has unusually small contextWindow: ${ctx}`);
        }
      }
    }

    try {
      normalizeDeclarativeDef(raw as unknown as DeclarativeProviderDef);
    } catch (e) {
      errors.push(`Normalization failed: ${(e as Error).message}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      errors.push(`Invalid JSON: ${err.message}`);
    } else {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === "ENOENT") {
        errors.push(`File not found: ${filePath}`);
      } else {
        errors.push(`Unexpected error: ${(err as Error).message}`);
      }
    }
  }

  return { filePath, valid: errors.length === 0, errors, warnings };
}

export function validateProviderDirectory(directory: string): ValidationReport[] {
  const files = fs.readdirSync(directory).filter(f => f.endsWith(".json"));
  return files.map(f => validateProviderFile(path.join(directory, f)));
}
