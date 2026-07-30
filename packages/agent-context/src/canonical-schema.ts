import type { JsonObject, JsonValue } from '@crish/shared-types';
import type { AgentTool } from '@crish/shared-types';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_DEPTH = 32;

const STRIP_KEYS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'markdownDescription',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const TIMESTAMP_FIELD_RE =
  /^(createdAt|updatedAt|deletedAt|timestamp|createTime|updateTime|deleteTime|created_at|updated_at|deleted_at|create_time|update_time|delete_time)$/i;

const SUB_SCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'contains',
  'not',
  'if',
  'then',
  'else',
]);

const SUB_SCHEMA_ARRAY_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function resolveLocalRef(
  ref: string,
  defs: Record<string, unknown>
): JsonObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let current: unknown = defs;
  for (const part of parts) {
    if (!isObject(current)) return undefined;
    current = (current as Record<string, unknown>)[decodeURIComponent(part)];
  }
  return isObject(current) ? (current as JsonObject) : undefined;
}

function canonicalizeJsonSchemaInternal(
  schema: JsonObject | undefined,
  depth: number,
  defs: Record<string, unknown>
): JsonObject {
  if (depth <= 0) return { type: 'object', properties: {} };
  if (!isObject(schema)) return { type: 'object', properties: {} };

  const ref = schema['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const resolved = resolveLocalRef(ref, defs);
    if (resolved) {
      return canonicalizeJsonSchemaInternal(resolved, depth - 1, defs);
    }
  }

  const entries: [string, JsonValue][] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (STRIP_KEYS.has(key)) continue;
    if (TIMESTAMP_FIELD_RE.test(key)) continue;
    if (key.startsWith('x-')) continue;

    if (SUB_SCHEMA_KEYS.has(key)) {
      if (isObject(value)) {
        entries.push([
          key,
          canonicalizeJsonSchemaInternal(value as JsonObject, depth - 1, defs),
        ]);
      } else {
        entries.push([key, value as JsonValue]);
      }
    } else if (SUB_SCHEMA_ARRAY_KEYS.has(key)) {
      if (Array.isArray(value)) {
        entries.push([
          key,
          value.map((item) =>
            isObject(item)
              ? canonicalizeJsonSchemaInternal(
                  item as JsonObject,
                  depth - 1,
                  defs
                )
              : (item as JsonValue)
          ),
        ]);
      }
    } else if (key === 'properties') {
      if (isObject(value)) {
        const props: Record<string, JsonValue> = {};
        const propKeys = Object.keys(value).sort();
        for (const propKey of propKeys) {
          const propVal = (value as Record<string, unknown>)[propKey];
          props[propKey] = isObject(propVal)
            ? canonicalizeJsonSchemaInternal(
                propVal as JsonObject,
                depth - 1,
                defs
              )
            : (propVal as JsonValue);
        }
        entries.push(['properties', props]);
      }
    } else if (key === 'patternProperties') {
      if (isObject(value)) {
        const pp: Record<string, JsonValue> = {};
        const ppKeys = Object.keys(value).sort();
        for (const ppKey of ppKeys) {
          const ppVal = (value as Record<string, unknown>)[ppKey];
          pp[ppKey] = isObject(ppVal)
            ? canonicalizeJsonSchemaInternal(
                ppVal as JsonObject,
                depth - 1,
                defs
              )
            : (ppVal as JsonValue);
        }
        entries.push(['patternProperties', pp]);
      }
    } else if (key === 'dependentSchemas') {
      if (isObject(value)) {
        const ds: Record<string, JsonValue> = {};
        const dsKeys = Object.keys(value).sort();
        for (const dsKey of dsKeys) {
          const dsVal = (value as Record<string, unknown>)[dsKey];
          ds[dsKey] = isObject(dsVal)
            ? canonicalizeJsonSchemaInternal(
                dsVal as JsonObject,
                depth - 1,
                defs
              )
            : (dsVal as JsonValue);
        }
        entries.push(['dependentSchemas', ds]);
      }
    } else if (key === 'prefixItems') {
      if (Array.isArray(value)) {
        entries.push([
          'prefixItems',
          value.map((item) =>
            isObject(item)
              ? canonicalizeJsonSchemaInternal(
                  item as JsonObject,
                  depth - 1,
                  defs
                )
              : (item as JsonValue)
          ),
        ]);
      }
    } else if (key === 'required') {
      if (Array.isArray(value)) {
        const strings = value.filter((v): v is string => typeof v === 'string');
        entries.push(['required', Array.from(new Set(strings)).sort()]);
      }
    } else if (key === 'enum') {
      if (Array.isArray(value)) {
        entries.push([
          'enum',
          [...value].sort((a, b) => String(a).localeCompare(String(b))),
        ]);
      }
    } else if (key === '$defs' || key === 'definitions') {
      if (isObject(value)) {
        const defResult: Record<string, JsonValue> = {};
        const defKeys = Object.keys(value).sort();
        for (const defKey of defKeys) {
          const defVal = (value as Record<string, unknown>)[defKey];
          defResult[defKey] = isObject(defVal)
            ? canonicalizeJsonSchemaInternal(
                defVal as JsonObject,
                depth - 1,
                defs
              )
            : (defVal as JsonValue);
        }
        entries.push([key, defResult]);
      }
    } else if (key === '$ref') {
      entries.push(['$ref', value as JsonValue]);
    } else {
      entries.push([key, value as JsonValue]);
    }
  }

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const result: JsonObject = {};
  for (const [k, v] of entries) {
    result[k] = v;
  }

  if (!('type' in result)) {
    result.type = 'object';
  }

  return result;
}

export function canonicalizeJsonSchema(
  schema: JsonObject | undefined,
  depth: number = DEFAULT_MAX_DEPTH
): JsonObject {
  const defs = isObject(schema) ? schema : {};
  return canonicalizeJsonSchemaInternal(schema, depth, defs);
}

export interface CacheProfile {
  toolsSchemaHash: string;
  systemPromptHash: string;
  prefixHash: string;
  toolsTokenEstimate: number;
  timestamp: number;
  toolCount: number;
}

export function canonicalizeTools(tools: AgentTool[]): AgentTool[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      ...tool,
      inputSchema: canonicalizeJsonSchema(tool.inputSchema),
    }));
}

export function canonicalJsonStringify(val: unknown): string {
  const seen = new Set<object>();

  function replacer(this: unknown, _key: string, value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        throw new Error(
          'Circular reference detected in canonicalJsonStringify'
        );
      }
      seen.add(value);
    }

    if (typeof value === 'number') {
      if (Number.isNaN(value)) return null;
      if (!Number.isFinite(value)) return null;
    }

    if (isObject(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }

    return value;
  }

  return JSON.stringify(val, replacer);
}

export function computeToolsSchemaHash(
  canonicalizedTools: AgentTool[]
): string {
  const json = canonicalJsonStringify(canonicalizedTools);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
