import type { JsonObject } from '@crish/shared-types';
import type { AgentTool, ToolSource } from '@crish/shared-types';

export type ToolDiscoveryField =
  'name' | 'label' | 'description' | 'category' | 'token';

export interface ToolDiscoveryFieldScores {
  name: number;
  label: number;
  description: number;
  category: number;
  token: number;
}

export interface ToolDiscoveryToolMetadata {
  tool: AgentTool;
  label?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  tokens?: string[] | undefined;
  pluginId?: string | undefined;
  pluginName?: string | undefined;
  sourceId?: string | undefined;
  metadata?: JsonObject | undefined;
}

export type ToolDiscoveryToolInput = AgentTool | ToolDiscoveryToolMetadata;

export interface ToolDiscoveryMetadataSource extends ToolSource {
  listDiscoveryTools():
    Promise<ToolDiscoveryToolInput[]> | ToolDiscoveryToolInput[];
}

export interface ToolDiscoverySearchOptions {
  maxResults?: number | undefined;
  excludeNames?: Iterable<string> | undefined;
}

export interface ToolDiscoveryIndexOptions {
  maxResults?: number | undefined;
  fieldWeights?: Partial<ToolDiscoveryFieldScores> | undefined;
}

export interface ToolDiscoverySearchResult {
  tool: AgentTool;
  score: number;
  matchedTokens: string[];
  fieldScores: ToolDiscoveryFieldScores;
}

export interface DeferredToolSourceOptions extends ToolDiscoveryIndexOptions {
  id?: string;
  label?: string;
  tools?: Iterable<AgentTool>;
  activeTools?: Iterable<AgentTool>;
  deferredTools?: Iterable<ToolDiscoveryToolInput>;
  activeSource?: ToolSource;
  deferredSource?: ToolSource;
}

export interface DeferredToolSearchOptions extends ToolDiscoverySearchOptions {
  includeAlreadyActive?: boolean;
}

export interface DeferredToolActivationResult {
  query: string;
  matches: ToolDiscoverySearchResult[];
  activatedTools: AgentTool[];
  activatedNames: string[];
}

interface IndexedToolDocument {
  tool: AgentTool;
  fields: Record<ToolDiscoveryField, Map<string, number>>;
  length: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 1;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_FIELD_WEIGHTS: ToolDiscoveryFieldScores = {
  name: 6,
  label: 4,
  description: 2,
  category: 2,
  token: 3,
};
const TOOL_DISCOVERY_FIELDS: ToolDiscoveryField[] = [
  'name',
  'label',
  'description',
  'category',
  'token',
];

export class ToolDiscoveryIndex {
  readonly maxResults: number;
  readonly fieldWeights: ToolDiscoveryFieldScores;
  private readonly documents = new Map<string, IndexedToolDocument>();
  private averageLength = 1;
  private documentFrequencies = new Map<string, number>();

  constructor(
    tools?: Iterable<ToolDiscoveryToolInput>,
    options?: ToolDiscoveryIndexOptions
  ) {
    this.maxResults = normalizeMaxResults(
      options?.maxResults ?? DEFAULT_MAX_RESULTS
    );
    this.fieldWeights = { ...DEFAULT_FIELD_WEIGHTS, ...options?.fieldWeights };
    if (tools) {
      this.replaceTools(tools);
    }
  }

  get size(): number {
    return this.documents.size;
  }

  replaceTools(tools: Iterable<ToolDiscoveryToolInput>): void {
    this.documents.clear();
    for (const input of tools) {
      this.setTool(input);
    }
    this.rebuildStatistics();
  }

  addTool(input: ToolDiscoveryToolInput): void {
    this.setTool(input);
    this.rebuildStatistics();
  }

  removeTool(name: string): boolean {
    const removed = this.documents.delete(name);
    if (removed) {
      this.rebuildStatistics();
    }
    return removed;
  }

  getTool(name: string): AgentTool | undefined {
    return this.documents.get(name)?.tool;
  }

  hasTool(name: string): boolean {
    return this.documents.has(name);
  }

  listTools(): AgentTool[] {
    return [...this.documents.values()].map((document) => document.tool);
  }

  search(
    query: string,
    options?: ToolDiscoverySearchOptions
  ): ToolDiscoverySearchResult[] {
    const queryTokens = tokenizeToolDiscoveryText(query);
    if (queryTokens.length === 0) {
      throw new Error('Query must contain at least one letter or number.');
    }
    if (this.documents.size === 0) {
      return [];
    }

    const limit = normalizeMaxResults(options?.maxResults ?? this.maxResults);
    const excluded = new Set(options?.excludeNames ?? []);
    const queryTermCounts = countTerms(queryTokens);
    const results = [...this.documents.values()]
      .filter((document) => !excluded.has(document.tool.name))
      .map((document) => this.scoreDocument(document, queryTermCounts))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.tool.name.localeCompare(right.tool.name)
      );

    return results.slice(0, limit);
  }

  private scoreDocument(
    document: IndexedToolDocument,
    queryTermCounts: Map<string, number>
  ): ToolDiscoverySearchResult {
    const fieldScores = emptyFieldScores();
    const matchedTokens = new Set<string>();
    let score = 0;

    for (const [token, queryTermCount] of queryTermCounts) {
      const documentFrequency = this.documentFrequencies.get(token) ?? 0;
      if (documentFrequency === 0) {
        continue;
      }

      const idf = Math.log(
        1 +
          (this.documents.size - documentFrequency + 0.5) /
            (documentFrequency + 0.5)
      );
      const normalization =
        BM25_K1 *
        (1 - BM25_B + BM25_B * (document.length / this.averageLength));

      for (const field of TOOL_DISCOVERY_FIELDS) {
        const termFrequency = document.fields[field].get(token) ?? 0;
        if (termFrequency === 0) {
          continue;
        }

        const fieldScore =
          queryTermCount *
          idf *
          ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) +
            BM25_DELTA);
        fieldScores[field] += fieldScore;
        score += fieldScore;
        matchedTokens.add(token);
      }
    }

    return {
      tool: document.tool,
      score,
      matchedTokens: [...matchedTokens],
      fieldScores,
    };
  }

  private rebuildStatistics(): void {
    const documents = [...this.documents.values()];
    this.averageLength =
      documents.reduce((sum, document) => sum + document.length, 0) /
        documents.length || 1;
    this.documentFrequencies = new Map();

    for (const document of documents) {
      const tokens = new Set<string>();
      for (const field of TOOL_DISCOVERY_FIELDS) {
        for (const token of document.fields[field].keys()) {
          tokens.add(token);
        }
      }
      for (const token of tokens) {
        this.documentFrequencies.set(
          token,
          (this.documentFrequencies.get(token) ?? 0) + 1
        );
      }
    }
  }

  private setTool(input: ToolDiscoveryToolInput): void {
    const metadata = normalizeToolInput(input);
    this.documents.set(
      metadata.tool.name,
      buildIndexedDocument(metadata, this.fieldWeights)
    );
  }
}

export class DeferredToolSource implements ToolSource {
  readonly id: string;
  readonly label: string;
  readonly index: ToolDiscoveryIndex;
  private readonly staticActiveTools: AgentTool[];
  private readonly staticDeferredTools: ToolDiscoveryToolInput[];
  private readonly activeSource: ToolSource | undefined;
  private readonly deferredSource: ToolSource | undefined;
  private readonly activatedNames = new Set<string>();
  private activeTools = new Map<string, AgentTool>();

  constructor(options: DeferredToolSourceOptions = {}) {
    this.id = options.id ?? 'deferred-tools';
    this.label = options.label ?? 'Deferred tools';
    this.staticActiveTools = [
      ...(options.tools ?? []),
      ...(options.activeTools ?? []),
    ];
    this.staticDeferredTools = [...(options.deferredTools ?? [])];
    this.activeSource = options.activeSource;
    this.deferredSource = options.deferredSource;
    this.index = new ToolDiscoveryIndex([], options);
  }

  async listTools(): Promise<AgentTool[]> {
    await this.refresh();
    const tools = new Map(this.activeTools);
    for (const name of this.activatedNames) {
      const tool = this.index.getTool(name);
      if (tool) {
        tools.set(name, tool);
      }
    }
    return [...tools.values()];
  }

  async search(
    query: string,
    options?: DeferredToolSearchOptions
  ): Promise<ToolDiscoverySearchResult[]> {
    await this.refresh();
    const excludeNames = options?.includeAlreadyActive
      ? options.excludeNames
      : this.getAlreadyActiveNames(options?.excludeNames);
    return this.index.search(query, {
      maxResults: options?.maxResults,
      excludeNames,
    });
  }

  async activate(
    query: string,
    options?: DeferredToolSearchOptions
  ): Promise<DeferredToolActivationResult> {
    const matches = await this.search(query, options);
    const activatedTools: AgentTool[] = [];
    for (const match of matches) {
      this.activatedNames.add(match.tool.name);
      activatedTools.push(match.tool);
    }
    return {
      query,
      matches,
      activatedTools,
      activatedNames: activatedTools.map((tool) => tool.name),
    };
  }

  async activateToolNames(names: Iterable<string>): Promise<AgentTool[]> {
    await this.refresh();
    const activated: AgentTool[] = [];
    for (const name of names) {
      const tool = this.index.getTool(name);
      if (!tool) {
        continue;
      }
      this.activatedNames.add(name);
      activated.push(tool);
    }
    return activated;
  }

  clearActivatedTools(): void {
    this.activatedNames.clear();
  }

  async dispose(): Promise<void> {
    await this.activeSource?.dispose?.();
    await this.deferredSource?.dispose?.();
  }

  private async refresh(): Promise<void> {
    const activeTools = new Map<string, AgentTool>();
    for (const tool of this.staticActiveTools) {
      activeTools.set(tool.name, tool);
    }
    for (const tool of (await this.activeSource?.listTools()) ?? []) {
      activeTools.set(tool.name, tool);
    }

    const deferredTools: ToolDiscoveryToolInput[] = [];
    deferredTools.push(...this.staticDeferredTools);
    for (const tool of await listDiscoveryTools(this.deferredSource)) {
      deferredTools.push(tool);
    }

    this.activeTools = activeTools;
    this.index.replaceTools(
      deferredTools.filter(
        (input) => !activeTools.has(normalizeToolInput(input).tool.name)
      )
    );
  }

  private getAlreadyActiveNames(
    extraExcludedNames?: Iterable<string>
  ): Set<string> {
    const names = new Set<string>(extraExcludedNames ?? []);
    for (const name of this.activeTools.keys()) {
      names.add(name);
    }
    for (const name of this.activatedNames) {
      names.add(name);
    }
    return names;
  }
}

export function tokenizeToolDiscoveryText(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function normalizeToolInput(
  input: ToolDiscoveryToolInput
): ToolDiscoveryToolMetadata {
  if ('tool' in input) {
    return input;
  }
  return { tool: input };
}

function buildIndexedDocument(
  metadata: ToolDiscoveryToolMetadata,
  weights: ToolDiscoveryFieldScores
): IndexedToolDocument {
  const tool = metadata.tool;
  const fields: Record<ToolDiscoveryField, Map<string, number>> = {
    name: countWeightedTerms(tool.name, weights.name),
    label: countWeightedTerms(metadata.label ?? tool.label, weights.label),
    description: countWeightedTerms(
      metadata.description ?? tool.description,
      weights.description
    ),
    category: countWeightedTerms(
      metadata.category ?? tool.category,
      weights.category
    ),
    token: countWeightedTerms(
      [
        ...extractSchemaPropertyKeys(tool),
        metadata.sourceId,
        metadata.pluginId,
        metadata.pluginName,
        ...(metadata.tokens ?? []),
      ]
        .filter(isNonEmptyString)
        .join(' '),
      weights.token
    ),
  };
  const length = TOOL_DISCOVERY_FIELDS.reduce((sum, field) => {
    return (
      sum +
      [...fields[field].values()].reduce(
        (fieldSum, value) => fieldSum + value,
        0
      )
    );
  }, 0);
  return {
    tool,
    fields,
    length: length || 1,
  };
}

function countWeightedTerms(
  value: string | undefined,
  weight: number
): Map<string, number> {
  const terms = new Map<string, number>();
  if (!value) {
    return terms;
  }
  for (const token of tokenizeToolDiscoveryText(value)) {
    terms.set(token, (terms.get(token) ?? 0) + weight);
  }
  return terms;
}

function countTerms(tokens: string[]): Map<string, number> {
  const terms = new Map<string, number>();
  for (const token of tokens) {
    terms.set(token, (terms.get(token) ?? 0) + 1);
  }
  return terms;
}

function extractSchemaPropertyKeys(tool: AgentTool): string[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [];
  }
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.keys(properties).sort();
}

async function listDiscoveryTools(
  source: ToolSource | undefined
): Promise<ToolDiscoveryToolInput[]> {
  if (!source) {
    return [];
  }
  if (isToolDiscoveryMetadataSource(source)) {
    return await source.listDiscoveryTools();
  }
  return await source.listTools();
}

function isToolDiscoveryMetadataSource(
  source: ToolSource
): source is ToolDiscoveryMetadataSource {
  return (
    typeof (source as ToolDiscoveryMetadataSource).listDiscoveryTools ===
    'function'
  );
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function emptyFieldScores(): ToolDiscoveryFieldScores {
  return {
    name: 0,
    label: 0,
    description: 0,
    category: 0,
    token: 0,
  };
}

function normalizeMaxResults(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('maxResults must be a positive integer.');
  }
  return value;
}
