/**
 * applyFileDiff 路径安全子模块（从 applyFileDiff.ts 拆出，降低 hub 行数）。
 *
 * 职责：规范化 apply 路径、Windows 安全校验（保留名 / 控制符 / 越界段 / 占位名）。
 * 纯函数，无 IO，无对 hub 的运行时依赖。
 */

/** 解析器占位路径：不可自动落盘 */
const UNSAFE_PLACEHOLDER_PATHS = new Set(['变更', '文件', 'unknown', 'untitled']);

/** Windows 保留设备名（basename，忽略扩展名，大小写不敏感） */
const WINDOWS_RESERVED_BASENAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 控制字符 / 禁止字符（路径段内；盘符冒号单独处理） */
// eslint-disable-next-line no-control-regex -- 有意匹配 C0 控制字符（路径净化）
const PATH_CONTROL_OR_BAD = /[\x00-\x1f\x7f<>"|?*]/;

/**
 * 规范化 apply 路径：trim、引号剥离、`\`→`/`、折叠重复斜杠、去尾斜杠、去前导 `./`。
 * 不做 symlink / 大小写折叠；保留盘符形式 `C:/...`。
 */
export function normalizeApplyPath(filePath: string | null | undefined): string {
  let p = (filePath ?? '').trim();
  if (!p) return '';
  // 外壳偶发带引号
  if (
    (p.startsWith('"') && p.endsWith('"') && p.length >= 2) ||
    (p.startsWith("'") && p.endsWith("'") && p.length >= 2)
  ) {
    p = p.slice(1, -1).trim();
  }
  if (!p) return '';
  p = p.replace(/\\/g, '/');
  // 折叠重复 `/`（UNC 开头 // 也折叠成 /，后续安全校验会拒绝纯 UNC 根逃逸形态）
  p = p.replace(/\/{2,}/g, '/');
  // 去掉前导 ./
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  // 去尾 `/`（保留单个 `/` 作为绝对根——仍会在安全校验中处理）；
  // 剥斜杠后再剥尾随空白，保证规范化幂等（再规范化不变）
  if (p.length > 1 && p.endsWith('/')) {
    p = p.replace(/\/+$/, '').trimEnd();
  }
  return p;
}

function isWindowsDriveAbsolute(normalized: string): boolean {
  return /^[A-Za-z]:(\/|$)/.test(normalized);
}

function pathSegments(normalized: string): string[] {
  // 盘符绝对：C:/foo → ['C:', 'foo']；POSIX 绝对：/foo → ['', 'foo']
  return normalized.split('/');
}

function isReservedWindowsSegment(seg: string): boolean {
  if (!seg) return false;
  // 去掉末尾点/空格再判（Windows 会剥离）
  const cleaned = seg.replace(/[ .]+$/g, '');
  if (!cleaned) return false;
  return WINDOWS_RESERVED_BASENAME.test(cleaned);
}

/**
 * 可安全写入的相对/绝对路径校验（禁止空、空字节、.. 段、占位名、Windows 非法名）。
 * 真正的工作区沙箱由 Tauri write 侧 workspaceRoot 再收一道。
 * 成功时返回 **规范化** 路径。
 */
export function isSafeApplyPath(
  filePath: string | null | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
  const path = normalizeApplyPath(filePath);
  if (!path) return { ok: false, reason: '缺少文件路径' };
  if (path.includes('\0') || PATH_CONTROL_OR_BAD.test(path)) {
    return { ok: false, reason: '路径含非法字符' };
  }

  // 盘符外禁止冒号（ADS / 异常盘符）
  if (isWindowsDriveAbsolute(path)) {
    const rest = path.slice(2); // after "C:"
    if (rest.includes(':')) {
      return { ok: false, reason: '路径含非法字符' };
    }
  } else if (path.includes(':')) {
    return { ok: false, reason: '路径含非法字符' };
  }

  if (UNSAFE_PLACEHOLDER_PATHS.has(path)) {
    return { ok: false, reason: '路径不可识别' };
  }

  const parts = pathSegments(path);
  // 拒绝 `..` 越界（含 `foo/../bar` 与历史 `..\x`）
  if (parts.some((p) => p === '..')) {
    return { ok: false, reason: '路径含越界段' };
  }
  // 仅 `.` / 空段堆叠导致无有效文件名
  const meaningful = parts.filter((p) => p && p !== '.');
  if (meaningful.length === 0) {
    return { ok: false, reason: '缺少文件路径' };
  }

  // 段级 Windows 安全：保留名、尾随点/空格、空段（除 POSIX 绝对前导空）
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    // POSIX 绝对路径允许首段为空（leading /）
    if (seg === '' && i === 0) continue;
    // 盘符段 C: 允许
    if (i === 0 && /^[A-Za-z]:$/.test(seg)) continue;
    if (seg === '') {
      return { ok: false, reason: '路径含非法字符' };
    }
    if (seg === '.') continue;
    // 尾随空格或点（Windows 危险）
    if (/[ .]$/.test(seg)) {
      return { ok: false, reason: '路径含非法段' };
    }
    if (isReservedWindowsSegment(seg)) {
      return { ok: false, reason: '路径为 Windows 保留名' };
    }
  }

  // 单一占位 basename（规范化后仍是 unknown 等）
  const base = meaningful[meaningful.length - 1] || '';
  if (UNSAFE_PLACEHOLDER_PATHS.has(base)) {
    return { ok: false, reason: '路径不可识别' };
  }

  return { ok: true, path };
}
