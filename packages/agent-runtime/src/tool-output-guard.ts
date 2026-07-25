/**
 * Tool-output injection guard.
 *
 * Untrusted tool outputs are wrapped with explicit boundary markers before
 * they enter provider projection. Optional heuristic strips pseudo-system
 * instruction patterns that tools sometimes echo.
 *
 * Pipeline order (see context-projection):
 *   raw → blob externalize → budget → guard wrap → provider
 */
import type { JsonObject, ToolOutput } from '@crish/shared-types';
import { stringifyToolOutput } from './tool-output-budget';

export interface ToolOutputGuardOptions {
  /** Default true. Set false to disable wrapping. */
  enabled?: boolean;
  /** Default true. Strip common injection-like instruction prefixes. */
  stripPseudoInstructions?: boolean;
  toolName?: string;
}

const DEFAULT_ENABLED = true;
const DEFAULT_STRIP = true;

/** Patterns that look like tool output trying to inject system/user directives. */
const PSEUDO_INSTRUCTION_PATTERNS: RegExp[] = [
  /^\s*(system|assistant|developer)\s*:\s*/gim,
  /^\s*\[(?:SYSTEM|INST|SYS)\]\s*/gim,
  /^\s*<<\s*SYS\s*>>\s*/gim,
  /^\s*ignore\s+(all\s+)?(previous|prior)\s+instructions\b/gim,
  /^\s*you\s+are\s+now\s+/gim,
];

/**
 * Strip common pseudo-instruction prefixes from untrusted text (conservative).
 */
export function stripPseudoInstructions(text: string): string {
  let out = text;
  for (const re of PSEUDO_INSTRUCTION_PATTERNS) {
    out = out.replace(re, '');
  }
  return out;
}

/**
 * Wrap tool output text in untrusted boundary markers for provider context.
 */
export function wrapUntrustedToolOutput(
  text: string,
  toolName?: string
): string {
  const name = (toolName ?? 'tool').replace(/[<>"\n\r]/g, '_').slice(0, 64);
  return `<tool_output tool="${name}" untrusted="true">\n${text}\n</tool_output>`;
}

/**
 * Guard a ToolOutput for provider projection.
 * Returns the same reference when disabled and no strip changes apply.
 */
export function guardToolOutputForContext(
  output: ToolOutput,
  options: ToolOutputGuardOptions = {}
): ToolOutput {
  const enabled = options.enabled ?? DEFAULT_ENABLED;
  const strip = options.stripPseudoInstructions ?? DEFAULT_STRIP;
  if (!enabled && !strip) return output;

  let text = stringifyToolOutput(output);
  if (strip) {
    text = stripPseudoInstructions(text);
  }
  if (enabled) {
    text = wrapUntrustedToolOutput(text, options.toolName);
  }

  const original = stringifyToolOutput(output);
  if (text === original) return output;

  const guardMeta: JsonObject = {
    toolOutputGuard: {
      wrapped: enabled,
      stripped: strip,
      toolName: options.toolName ?? null,
    },
  };

  return {
    text,
    ...(output.artifacts !== undefined ? { artifacts: output.artifacts } : {}),
    json: {
      ...(typeof output.json === 'object' &&
      output.json !== null &&
      !Array.isArray(output.json)
        ? (output.json as JsonObject)
        : {}),
      ...guardMeta,
    },
  };
}
