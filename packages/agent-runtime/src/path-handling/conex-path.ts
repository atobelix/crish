/**
 * ConexPath - 统一路径处理
 *
 * 解决的问题：
 * 1. 项目中路径处理散落在多处，有的用 resolve，有的用 join，有的手动拼接
 * 2. 路径穿越攻击（path traversal）没有统一防护
 * 3. 相对路径/绝对路径/URI 混用，行为不一致
 * 4. 跨平台路径分隔符问题
 *
 * 设计原则：
 * 1. 所有路径操作必须通过 ConexPath，禁止直接使用 resolve/join
 * 2. 每个路径都有明确的"根"（root），所有操作相对于根进行
 * 3. 路径安全策略集中管理
 * 4. 路径操作的结果始终是绝对路径
 */

import { isAbsolute, join, normalize, resolve, dirname, basename, extname, relative, sep, posix } from "node:path";

// ─── 路径安全策略 ─────────────────────────────────────────

export interface PathSecurityPolicy {
  /** 是否允许路径穿越（默认 false） */
  allowTraversal: boolean;
  /** 是否允许符号链接（默认 true） */
  allowSymlinks: boolean;
  /** 允许的根目录列表（空列表 = 允许所有） */
  allowedRoots: string[];
  /** 禁止访问的路径模式 */
  deniedPatterns: RegExp[];
  /** 最大路径长度 */
  maxPathLength: number;
}

export const DEFAULT_PATH_SECURITY_POLICY: PathSecurityPolicy = {
  allowTraversal: false,
  allowSymlinks: true,
  allowedRoots: [],
  deniedPatterns: [
    /(^|[\/\\])\.\.([\/\\]|$)/,  // 路径穿越: ../ 或 ..\  (前后有分隔符或位于边界)
  ],
  maxPathLength: 4096,
};

// ─── 路径验证结果 ─────────────────────────────────────────

export type PathValidationResult =
  | { valid: true; resolvedPath: string }
  | { valid: false; reason: PathValidationFailure; detail: string };

export type PathValidationFailure =
  | "path-traversal"
  | "outside-allowed-roots"
  | "denied-pattern"
  | "path-too-long"
  | "empty-path"
  | "not-absolute";

// ─── ConexPath ────────────────────────────────────────────

/**
 * 统一路径处理器
 *
 * 每个实例绑定一个根目录，所有路径操作相对于该根目录进行。
 * 内置安全策略，防止路径穿越和未授权访问。
 */
export class ConexPath {
  private readonly normalizedRoot: string;

  constructor(
    /** 根目录（绝对路径） */
    private readonly root: string,
    private readonly securityPolicy: PathSecurityPolicy = DEFAULT_PATH_SECURITY_POLICY
  ) {
    this.normalizedRoot = normalize(resolve(root));
  }

  /**
   * 获取根目录
   */
  getRoot(): string {
    return this.normalizedRoot;
  }

  /**
   * 将路径解析为绝对路径
   *
   * - 绝对路径直接返回（如果安全策略允许）
   * - 相对路径相对于根目录解析
   * - 始终进行安全校验
   */
  resolve(path: string): PathValidationResult {
    if (!path || path.trim() === "") {
      return { valid: false, reason: "empty-path", detail: "Path is empty" };
    }

    if (path.length > this.securityPolicy.maxPathLength) {
      return { valid: false, reason: "path-too-long", detail: `Path exceeds maximum length of ${this.securityPolicy.maxPathLength}` };
    }

    // 检查禁止的模式
    for (const pattern of this.securityPolicy.deniedPatterns) {
      if (pattern.test(path)) {
        if (!this.securityPolicy.allowTraversal) {
          return { valid: false, reason: "denied-pattern", detail: `Path matches denied pattern: ${pattern.source}` };
        }
      }
    }

    // 解析路径
    const resolvedPath = isAbsolute(path)
      ? normalize(path)
      : normalize(resolve(this.normalizedRoot, path));

    // 检查路径穿越
    if (!this.securityPolicy.allowTraversal && !resolvedPath.startsWith(this.normalizedRoot)) {
      return { valid: false, reason: "path-traversal", detail: `Resolved path "${resolvedPath}" is outside root "${this.normalizedRoot}"` };
    }

    // 检查允许的根目录
    if (this.securityPolicy.allowedRoots.length > 0) {
      const isUnderAllowedRoot = this.securityPolicy.allowedRoots.some(
        (allowedRoot) => resolvedPath.startsWith(normalize(resolve(allowedRoot)))
      );
      if (!isUnderAllowedRoot) {
        return { valid: false, reason: "outside-allowed-roots", detail: `Path "${resolvedPath}" is not under any allowed root` };
      }
    }

    return { valid: true, resolvedPath };
  }

  /**
   * 安全地解析路径，如果校验失败则抛出异常
   */
  resolveOrThrow(path: string): string {
    const result = this.resolve(path);
    if (!result.valid) {
      throw new ConexPathError(result.reason, result.detail);
    }
    return result.resolvedPath;
  }

  /**
   * 检查路径是否在根目录下
   */
  isWithinRoot(path: string): boolean {
    const result = this.resolve(path);
    if (!result.valid) return false;
    return result.resolvedPath.startsWith(this.normalizedRoot);
  }

  /**
   * 获取相对路径（相对于根目录）
   */
  relative(path: string): string {
    const resolved = this.resolveOrThrow(path);
    return relative(this.normalizedRoot, resolved);
  }

  /**
   * 连接路径片段
   */
  join(...segments: string[]): PathValidationResult {
    const joined = join(this.normalizedRoot, ...segments);
    return this.resolve(joined);
  }

  /**
   * 获取父目录
   */
  dirname(path: string): PathValidationResult {
    const resolved = this.resolveOrThrow(path);
    return this.resolve(dirname(resolved));
  }

  /**
   * 获取文件名
   */
  basename(path: string): string {
    const resolved = this.resolveOrThrow(path);
    return basename(resolved);
  }

  /**
   * 获取扩展名
   */
  extname(path: string): string {
    const resolved = this.resolveOrThrow(path);
    return extname(resolved);
  }

  /**
   * 标准化路径分隔符为 POSIX 格式
   */
  toPosix(path: string): string {
    return path.split(sep).join(posix.sep);
  }

  /**
   * 从 URI 中提取路径（file:// 协议）
   */
  fromUri(uri: string): PathValidationResult {
    if (!uri.startsWith("file://")) {
      return { valid: false, reason: "not-absolute", detail: "Only file:// URIs are supported" };
    }
    const path = uri.replace("file://", "").replace(/^\/([A-Z]:)/, "$1");
    return this.resolve(path);
  }

  /**
   * 将路径转换为 file:// URI
   */
  toUri(path: string): string {
    const resolved = this.resolveOrThrow(path);
    const posixPath = this.toPosix(resolved);
    return `file://${posixPath.startsWith("/") ? posixPath : "/" + posixPath}`;
  }

  /**
   * 创建子路径处理器（以当前路径为根）
   */
  subPath(subRoot: string): ConexPath {
    const resolved = this.resolveOrThrow(subRoot);
    return new ConexPath(resolved, this.securityPolicy);
  }
}

// ─── ConexPathError ───────────────────────────────────────

export class ConexPathError extends Error {
  constructor(
    public readonly failureReason: PathValidationFailure,
    detail: string
  ) {
    super(`ConexPath validation failed: ${failureReason} - ${detail}`);
    this.name = "ConexPathError";
  }
}

// ─── 全局路径注册表 ───────────────────────────────────────

/**
 * 路径注册表
 *
 * 为项目中的不同区域创建独立的 ConexPath 实例，
 * 确保每个区域只能访问自己根目录下的文件。
 */
export class PathRegistry {
  private paths = new Map<string, ConexPath>();

  constructor(private readonly defaultSecurityPolicy: PathSecurityPolicy = DEFAULT_PATH_SECURITY_POLICY) {}

  /**
   * 注册一个路径区域
   */
  register(name: string, root: string, policy?: PathSecurityPolicy): ConexPath {
    const conexPath = new ConexPath(root, policy ?? this.defaultSecurityPolicy);
    this.paths.set(name, conexPath);
    return conexPath;
  }

  /**
   * 获取已注册的路径处理器
   */
  get(name: string): ConexPath | undefined {
    return this.paths.get(name);
  }

  /**
   * 获取已注册的路径处理器，不存在则抛出异常
   */
  getOrThrow(name: string): ConexPath {
    const path = this.paths.get(name);
    if (!path) {
      throw new Error(`Path registry: "${name}" is not registered`);
    }
    return path;
  }

  /**
   * 列出所有已注册的区域
   */
  list(): string[] {
    return [...this.paths.keys()];
  }
}
