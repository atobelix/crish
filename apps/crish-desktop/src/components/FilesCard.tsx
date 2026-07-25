/**
 * 右侧文件管理器（组装层）
 * 核心实现拆分至 components/files/ 目录下：
 *  - FileTreeView.tsx: 文件树展示与扩展
 *  - FileSearchFilter.ts: 搜索与过滤逻辑纯函数
 *  - useFileTreeState.ts: 节点展开与选择 Hook
 */
export { FilesCard, type FilesCardProps } from './files/FilesCard';
