import { getWorkspacePath } from '../../api/workspaceFsApi';

/**
 * 独立文件预览路径规范化纯函数 (DETAIL-PLAN-03 核心算法)
 *
 * 刚性保证：
 * 1. Windows 反斜杠统统转为标准正斜杠；
 * 2. 剥离前导 ./ 与路径中段 /./；
 * 3. 保护 UNC / WSL 路径；
 * 4. 相对路径基于工作区根目录解析为完整绝对路径；
 * 5. Windows 盘符强制转为大写 (C:/...)，根除同名 Tab 分裂；
 * 6. 剥离多余的尾部斜杠。
 */
export function normalizeViewerFilePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let p = rawPath.trim();
  if (!p) return '';

  // 1. Windows 反斜杠统统转换为标准正斜杠
  p = p.replace(/\\/g, '/');

  // 2. 剥离前导多余的 ./
  while (p.startsWith('./')) {
    p = p.slice(2);
  }

  // 3. 消除路径中段的 /./
  p = p.replace(/\/\.\//g, '/');

  // 4. 保护 UNC / WSL 路径 (//server/share 或 //wsl.localhost/...)
  const isUnc = p.startsWith('//');

  // 5. 相对路径基于工作区根目录拼接为绝对路径
  const isAbsolute = isUnc || p.startsWith('/') || /^[a-zA-Z]:\//.test(p);
  if (!isAbsolute) {
    const ws = (getWorkspacePath() || '').replace(/\\/g, '/').replace(/\/+$/, '');
    p = ws ? `${ws}/${p}` : p;
  }

  // 6. 核心：Windows 盘符强制归一化为大写 (c:/... -> C:/...)
  p = p.replace(/^([a-zA-Z]):\//, (_, drive: string) => `${drive.toUpperCase()}:/`);

  // 7. 消除尾部多余斜杠 (除根目录如 C:/ 或 / 外)
  if (p.length > 3 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }

  return p;
}
