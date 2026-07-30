import type { JsonObject, JsonValue } from '@crish/shared-types';
import type {
  ProviderStreamToolCallEvent,
  ProviderStreamToolCall,
  ProviderStreamToolCallPhase,
  ProviderToolCallJsonDelta,
  ProviderToolCallJsonAccumulatorSnapshot,
  ProviderToolCallJsonRepairResult,
} from './types';

export class ProviderToolCallJsonAccumulator {
  private idValue: string | undefined;
  private indexValue: number | undefined;
  private toolNameValue = '';
  private argumentsValue = '';
  private doneValue = false;

  constructor(initial?: ProviderToolCallJsonDelta) {
    if (initial) this.append(initial);
  }

  append(
    delta: ProviderToolCallJsonDelta
  ): ProviderToolCallJsonAccumulatorSnapshot {
    if (delta.id !== undefined) this.idValue = delta.id;
    if (delta.index !== undefined) this.indexValue = delta.index;
    if (delta.toolName !== undefined) this.toolNameValue = delta.toolName;
    if (delta.argumentsText !== undefined) {
      this.argumentsValue = delta.replaceArguments
        ? delta.argumentsText
        : this.argumentsValue + delta.argumentsText;
    }
    if (delta.argumentsDelta !== undefined)
      this.argumentsValue += delta.argumentsDelta;
    if (delta.done === true) this.doneValue = true;
    return this.snapshot();
  }

  snapshot(): ProviderToolCallJsonAccumulatorSnapshot {
    return {
      ...(this.idValue !== undefined ? { id: this.idValue } : {}),
      ...(this.indexValue !== undefined ? { index: this.indexValue } : {}),
      toolName: this.toolNameValue,
      argumentsText: this.argumentsValue,
      done: this.doneValue,
    };
  }

  finalize(): ProviderToolCallJsonRepairResult {
    return repairToolCallJsonArguments(this.argumentsValue);
  }

  toToolCall(repair = this.finalize()): ProviderStreamToolCall {
    return {
      id: this.idValue ?? '',
      index: this.indexValue ?? 0,
      toolName: this.toolNameValue,
      argumentsText: this.argumentsValue,
      input: repair.input,
    };
  }
}

export function createProviderToolCallEventFromAccumulator(
  accumulator: ProviderToolCallJsonAccumulator,
  phase: ProviderStreamToolCallPhase = 'end'
): Omit<ProviderStreamToolCallEvent, 'sequence'> {
  const repair = accumulator.finalize();
  return {
    type: 'tool-call',
    phase,
    toolCall: accumulator.toToolCall(repair),
    repair,
  };
}

export function repairToolCallJsonArguments(
  raw: string
): ProviderToolCallJsonRepairResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      status: 'valid',
      raw,
      input: {},
      notes: [],
    };
  }

  const direct = parseJsonArguments(trimmed);
  if (direct.ok) {
    return {
      status: direct.repaired ? 'repaired' : 'valid',
      raw,
      input: direct.input,
      notes: direct.notes,
      ...(direct.repairedText !== undefined
        ? { repairedText: direct.repairedText }
        : {}),
    };
  }

  for (const candidate of jsonRepairCandidates(trimmed)) {
    if (candidate === trimmed) continue;
    const repaired = parseJsonArguments(candidate);
    if (repaired.ok) {
      return {
        status: 'repaired',
        raw,
        input: repaired.input,
        notes: [...repaired.notes, 'Repaired tool-call JSON arguments.'],
        repairedText: candidate,
      };
    }
  }

  return {
    status: 'invalid',
    raw,
    input: {
      __rawArguments: raw,
      __parseError: direct.error ?? 'Invalid JSON arguments',
    },
    notes: [
      'Preserved invalid tool-call JSON arguments as structured fallback.',
    ],
    ...(direct.error !== undefined ? { error: direct.error } : {}),
  };
}

function parseJsonArguments(text: string):
  | {
      ok: true;
      input: JsonObject;
      notes: string[];
      repaired: boolean;
      repairedText?: string;
    }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    if (isJsonObject(parsed)) {
      return { ok: true, input: parsed, notes: [], repaired: false };
    }
    return {
      ok: true,
      input: { value: parsed },
      notes: ['Wrapped non-object JSON arguments in value.'],
      repaired: true,
      repairedText: JSON.stringify({ value: parsed }),
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function jsonRepairCandidates(text: string): string[] {
  const stripped = stripJsonMarkdownFence(text);
  const seeds = uniqueStrings([
    text,
    stripped,
    removeTrailingJsonCommas(text),
    removeTrailingJsonCommas(stripped),
    quoteUnquotedObjectKeys(text),
    quoteUnquotedObjectKeys(stripped),
    replaceSingleQuotedJsonStrings(text),
    replaceSingleQuotedJsonStrings(stripped),
    completeTruncatedLiterals(text),
    completeTruncatedLiterals(stripped),
  ]);
  const candidates: string[] = [];
  for (const seed of seeds) {
    candidates.push(seed);
    candidates.push(removeTrailingJsonCommas(seed));
    candidates.push(balanceJsonContainers(seed));
    candidates.push(removeTrailingJsonCommas(balanceJsonContainers(seed)));
  }
  return uniqueStrings(candidates);
}

function stripJsonMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? text;
}

function removeTrailingJsonCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function quoteUnquotedObjectKeys(text: string): string {
  return text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
}

function replaceSingleQuotedJsonStrings(text: string): string {
  if (text.includes('"')) return text;
  return text.replace(/'/g, '"');
}

function completeTruncatedLiterals(text: string): string {
  if (text.endsWith('t')) text += 'rue';
  else if (text.endsWith('tr')) text += 'ue';
  else if (text.endsWith('f')) text += 'alse';
  else if (text.endsWith('fa')) text += 'lse';
  else if (text.endsWith('fal')) text += 'se';
  else if (text.endsWith('fals')) text += 'e';
  else if (text.endsWith('n')) text += 'ull';
  else if (text.endsWith('nu')) text += 'll';
  else if (text.endsWith('nul')) text += 'l';
  return text;
}

function balanceJsonContainers(text: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      closers.push('}');
    } else if (char === '[') {
      closers.push(']');
    } else if (char === '}' || char === ']') {
      const expected = closers.at(-1);
      if (expected === char) closers.pop();
    }
  }

  if (inString) {
    if (text.endsWith('\\') && !text.endsWith('\\\\')) {
      text = text.slice(0, -1);
    }
    text += '"';
  }
  return `${text}${closers.reverse().join('')}`;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
