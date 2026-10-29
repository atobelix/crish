// 工作区路径纯函数：相对路径拼接与展示名（零依赖，供接线 / VM / UI 共用）。

/** 相对路径拼接（父目录 relPath + 条目名；'' 根级 = 直接条目名，F4 §1.2 relPath 语义） */
export function joinRelPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 工作区根 → 展示名（路径叶名；空串/根符号兜底「工作区」） */
export function workspaceNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const leaf = trimmed.split(/[\\/]/).pop();
  return leaf ? leaf : '工作区';
}
