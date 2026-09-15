import type { ModelsCatalogSnapshot, ModelsYamlTree } from '../api/modelsCatalogTypes';

/** 空文档字面量（无 provider 的合法 yaml；ipc 与 store 两处用例共用） */
export const EMPTY_MODELS_DOC = 'version: 2\nproviders: {}\nactiveModel: null\n';

export interface CatalogSnapshotOverrides {
  path?: string;
  content?: string;
  revision?: string;
  tree?: ModelsYamlTree | null;
  credentialStates?: ModelsCatalogSnapshot['credentialStates'];
  parseError?: ModelsCatalogSnapshot['parseError'];
  template?: string;
}

/**
 * read 回执 mock 工厂（**唯一真源**）。
 *
 * 收敛背景（D3 契约防线 WARN，2026-09-15）：`modelsCatalogIpc.test.ts` 与
 * `modelsCatalogStore.test.ts` 此前各有一份本地 `snapshot()`，默认值已发散
 * ——`template`（空文档 vs `''`）、`parseError`（有 vs 无）、
 * `credentialStates.apiKeyLast4`（`'test'` vs 缺省）三处不一致。发散的回执
 * 夹具会让「守卫是否真的强制字段」这件事在两侧得到不同结论，故收敛为单一
 * 工厂：**默认值只在此处定义，差异一律经 overrides 显式传入**。
 *
 * 调用侧仍可保留一层薄包装，但只允许补「本文件特有的默认参数」
 * （如 tree 的默认值），不得再自行拼装回执字段。
 */
export function catalogSnapshot(
  overrides: CatalogSnapshotOverrides = {}
): ModelsCatalogSnapshot {
  const tree = overrides.tree ?? null;
  const snapshot: ModelsCatalogSnapshot = {
    path: overrides.path ?? 'C:/test/models.yaml',
    content: overrides.content ?? (tree ? JSON.stringify(tree) : EMPTY_MODELS_DOC),
    revision: overrides.revision ?? 'read-revision',
    tree,
    credentialStates: overrides.credentialStates ?? {
      Acme: { hasKey: true, apiKeyLast4: 'test' },
    },
    template: overrides.template ?? EMPTY_MODELS_DOC,
  };
  if (overrides.parseError !== undefined) {
    snapshot.parseError = overrides.parseError;
  }
  return snapshot;
}
