/**
 * Persistent Approval Rule Store & Pattern Matcher
 * 
 * 职责：
 * - 借鉴 OpenCode (`permission.ts`) 中的 `PermissionSaved` 机制
 * - 允许用户选择“对当前项目/会话始终允许 (Always Allow)”，避免对相同的工具或 shell 命令重复弹出审批弹窗
 * - 支持通配符匹配 (如 `git *`, `npm test`, `read_file:*`)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
      this.rules = JSON.parse(raw);
    } catch {
      this.rules = [];
    }
  }

  /** 保存权限规则到本地 */
  private save(): void {
    if (!this.filePath) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
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
    if (pattern === '*' || pattern === target) return true;
    const regexPattern = '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try {
      return new RegExp(regexPattern, 'i').test(target);
    } catch {
      return false;
    }
  }

  public getRules(): PersistentPermissionRule[] {
    return [...this.rules];
  }
}
