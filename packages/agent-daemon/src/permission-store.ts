/**
 * Persistent Approval Rule Store & Pattern Matcher
 * 
 * 职责：
 * - 借鉴 OpenCode (`permission.ts`) 中的 `PermissionSaved` 机制
 * - 允许用户选择“对当前项目/会话始终允许 (Always Allow)”，避免对相同的工具或 shell 命令重复弹出审批弹窗
 * - 支持通配符匹配 (如 `git *`, `npm test`, `read_file:*`)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface PersistentPermissionRule {
  id: string;
  scope: 'project' | 'session' | 'global';
  targetPattern: string; // 如 "git *" 或 "write_file:src/*"
  action: 'allow' | 'deny';
  createdAt: number;
}

export class PermissionStore {
  private rules: PersistentPermissionRule[] = [];
  private filePath?: string;

  constructor(storageDir?: string) {
    if (storageDir) {
      this.filePath = join(storageDir, 'permissions.json');
      this.load();
    }
  }

  /** 加载保存的权限规则 */
  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // 防御非数组 JSON（如 null、对象、字符串）导致后续 push 崩溃
      this.rules = Array.isArray(parsed) ? parsed : [];
    } catch {
      // silent: JSON.parse 降级，损坏或空文件时重置为空规则列表
      this.rules = [];
    }
  }

  /** 保存权限规则到本地（原子写：tmp + fsync + rename） */
  private save(): void {
    if (!this.filePath) return;
    const dir = dirname(this.filePath);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // 原子写：先写到临时文件，fsync 确保落盘，再 rename 到目标路径
      // 避免写入过程中崩溃导致文件截断/损坏
      const tmpPath = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.rules, null, 2), 'utf-8');
      // best-effort fsync：确保数据写入磁盘（而非仅 OS 缓存）
      // 失败不阻止 rename（fsync 在某些平台/模式下可能不可用）
      try {
        const fd = openSync(tmpPath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // fsync 不可用或失败，忽略——rename 仍可保证原子性
      }
      renameSync(tmpPath, this.filePath);
    } catch {
      /* ignore write failure */
    }
  }

  /** 添加一条持久化权限规则 */
  public addRule(scope: 'project' | 'session' | 'global', targetPattern: string, action: 'allow' | 'deny' = 'allow'): PersistentPermissionRule {
    const rule: PersistentPermissionRule = {
      id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      scope,
      targetPattern: targetPattern.trim(),
      action,
      createdAt: Date.now(),
    };
    this.rules.push(rule);
    this.save();
    return rule;
  }

  /** 检查目标操作是否匹配已保存的规则 */
  public evaluate(target: string): 'allow' | 'deny' | null {
    const cleanTarget = target.trim();
    for (const rule of this.rules) {
      if (this.matchPattern(cleanTarget, rule.targetPattern)) {
        return rule.action;
      }
    }
    return null;
  }

  /** 通配符匹配 (如 `git *` 匹配 `git status`) */
  private matchPattern(target: string, pattern: string): boolean {
    // 防御从损坏 JSON 加载的非法规则（targetPattern 可能是 undefined/非字符串）
    if (typeof pattern !== 'string') return false;
    if (pattern === '*') return true;
    // 通配符语义：仅 * 和 ? 是通配符，其他 regex 元字符（. + ( ) [ ] \ ^ $ | { }）均为字面量。
    // 先转义所有 regex 元字符，再替换 * → .* 和 ? → . ，避免用户输入的 pattern 被当作 regex。
    const escaped = pattern.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    const regexPattern = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try {
      return new RegExp(regexPattern, 'i').test(target);
    } catch {
      // silent: 用户输入的通配符表达式非合法 regex 时降级拒绝匹配
      return false;
    }
  }

  public getRules(): PersistentPermissionRule[] {
    return [...this.rules];
  }

  /**
   * Check whether an MCP command has been previously approved.
   * Builds a target string from command + args for pattern matching.
   */
  public isMcpCommandApproved(command: string, args: string[]): boolean {
    const target = [command, ...args].join(' ');
    return this.evaluate(target) === 'allow';
  }

  /**
   * Record an MCP command approval so subsequent starts bypass the dialog.
   */
  public approveMcpCommand(
    command: string,
    args: string[],
    scope: 'project' | 'session' | 'global' = 'project',
  ): PersistentPermissionRule {
    const target = [command, ...args].join(' ');
    return this.addRule(scope, target, 'allow');
  }
}
