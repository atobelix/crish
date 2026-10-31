// 存储驱动抽象（Z0 R2-13）：SqlDriver 接口 + 内存 mock 实现
// 背景（任务书 R2-13）：jest 环境无原生 SQLite → 定义 driver 接口 + 内存 mock 实现；
// 真实环境目标为 expo-sqlite（apps/crish-mobile/app.json config plugin 已含 sqlite，
// 接线点见 db.ts 的 openMobileDatabase 注释）。
// 纪律（M5 §1.2 规则 2）：存储层不得 import 网络层；本文件不 import expo-sqlite（注入模式）。

/**
 * 存储驱动接口：与 expo-sqlite 的常用方法面一一对应（execAsync/getFirstAsync/getAllAsync/withTransactionAsync）。
 * 真实实现适配器见 db.ts；测试使用 MemorySqlDriver。
 */
export interface SqlDriver {
  /** 执行无返回值的语句（CREATE/INSERT/UPDATE/DELETE/PRAGMA 设置） */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  /** 执行查询并返回首行（PRAGMA user_version / SELECT ... LIMIT 1） */
  getFirst<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** 执行查询并返回全部行 */
  getAll<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 在事务中执行（迁移层使用；内存 mock 直接透传，真实实现用 withTransactionAsync） */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * 内存 SQL 引擎（测试/开发用 mock）：支持本仓库 SQL 子集，语义对齐 SQLite：
 * - CREATE TABLE IF NOT EXISTS <t> (<列定义>, ...)：列定义支持 列名 类型 [NOT NULL] [PRIMARY KEY]、
 *   PRIMARY KEY (a, b)、UNIQUE (a, b)、CHECK (...)（忽略）；
 * - CREATE INDEX IF NOT EXISTS ... ON ...：忽略（内存引擎不需要索引）；
 * - INSERT INTO <t> (<列>) VALUES (?, ...) [ON CONFLICT(<列>) DO UPDATE SET <列> = ?, ...]：
 *   主键/唯一约束冲突抛错（对齐 SQLite）；带 ON CONFLICT DO UPDATE 时冲突改走原子更新分支；
 * - SELECT <*|列列表|COUNT(*)|MAX(列)> FROM <t> [WHERE ...] [ORDER BY 列 [ASC|DESC], ...] [LIMIT n] [OFFSET m]；
 * - UPDATE <t> SET 列 = ?, ... [WHERE ...]；DELETE FROM <t> [WHERE ...]；
 * - PRAGMA user_version（读/写）；
 * - WHERE 支持括号分组 + AND/OR；原子条件：列 运算符 值，运算符含 =、!=、<>、<、<=、>、>=、IN、NOT IN、IS NULL、IS NOT NULL；
 * - 参数占位符 `?`；字符串字面量单引号；数值自动转换比较（INTEGER 列存 number）。
 * 超出子集的语句抛错（fail-fast，防止测试用 SQL 与真实环境语义漂移）。
 */
export class MemorySqlDriver implements SqlDriver {
  /** 表名 → 表结构（列名 + 主键 + 唯一约束） */
  private readonly tables = new Map<
    string,
    {
      cols: string[];
      pks: string[];
      uniques: string[][];
      types: Map<string, string>;
    }
  >();
  /** 表名 → 行数组（行 = 列名 → 值） */
  private readonly rows = new Map<string, Record<string, unknown>[]>();
  /** PRAGMA user_version */
  private userVersion = 0;
  /** 事务嵌套深度（内存 mock 不做真实回滚，仅计数校验） */
  private txnDepth = 0;

  /** 已登记的表名（供测试断言迁移结果） */
  listTables(): string[] {
    return [...this.tables.keys()].sort();
  }

  /** 表内行数（供测试断言数据保留/清理） */
  rowCount(table: string): number {
    return this.rows.get(table)?.length ?? 0;
  }

  async exec(sql: string, params?: readonly unknown[]): Promise<void> {
    this.execute(sql, params ?? []);
  }

  async getFirst<T>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<T | null> {
    const rows = this.execute(sql, params ?? []) as T[];
    return rows.length > 0 ? rows[0]! : null;
  }

  async getAll<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.execute(sql, params ?? []) as T[];
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // 内存 mock 不做真实事务回滚（迁移的「失败不推进版本」由执行顺序保证）；
    // 仅维护深度计数以校验成对调用。
    this.txnDepth += 1;
    try {
      return await fn();
    } finally {
      this.txnDepth -= 1;
    }
  }

  /** 当前事务深度（测试自检用） */
  getTransactionDepth(): number {
    return this.txnDepth;
  }

  // ---------------------------------------------------------------------------
  // 执行器
  // ---------------------------------------------------------------------------

  private execute(sql: string, params: readonly unknown[]): unknown[] {
    const stmt = sql.trim();
    const upper = stmt.toUpperCase();
    if (upper.startsWith('PRAGMA ')) return this.execPragma(stmt, upper);
    if (upper.startsWith('CREATE TABLE '))
      return this.execCreateTable(stmt, upper);
    if (upper.startsWith('CREATE INDEX ')) return []; // 索引为优化项，内存引擎忽略
    if (upper.startsWith('DROP INDEX ')) return []; // 索引为优化项，内存引擎忽略
    if (upper.startsWith('DROP TABLE ')) return this.execDropTable(stmt);
    if (upper.startsWith('INSERT INTO ')) return this.execInsert(stmt, params);
    if (upper.startsWith('SELECT ')) return this.execSelect(stmt, params);
    if (upper.startsWith('UPDATE ')) return this.execUpdate(stmt, params);
    if (upper.startsWith('DELETE FROM ')) return this.execDelete(stmt, params);
    throw new Error(`内存驱动不支持的 SQL 前缀：${stmt.slice(0, 40)}`);
  }

  /** DROP TABLE [IF EXISTS] <表名>：删除表结构与行（v2 幽灵表清理） */
  private execDropTable(stmt: string): unknown[] {
    const m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+?)\s*;?$/i.exec(stmt);
    if (!m) throw new Error(`无法解析 DROP TABLE：${stmt.slice(0, 60)}`);
    const name = m[1]!;
    if (!this.tables.has(name) && !/if\s+exists/i.test(stmt)) {
      throw new Error(`表不存在：${name}`);
    }
    this.tables.delete(name);
    this.rows.delete(name);
    return [];
  }

  // ---------------------------------------------------------------------------
  // PRAGMA
  // ---------------------------------------------------------------------------

  private execPragma(_stmt: string, upper: string): unknown[] {
    // 仅支持 user_version 读写
    const m = /^PRAGMA\s+user_version(?:\s*=\s*(\d+))?\s*;?$/i.exec(upper);
    if (!m) throw new Error(`内存驱动仅支持 PRAGMA user_version：${upper}`);
    if (m[1] !== undefined) this.userVersion = Number(m[1]);
    return [{ user_version: this.userVersion }];
  }

  // ---------------------------------------------------------------------------
  // CREATE TABLE
  // ---------------------------------------------------------------------------

  private execCreateTable(stmt: string, _upper: string): unknown[] {
    const m =
      /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\S+)\s*\(([\s\S]*)\)\s*;?$/i.exec(
        stmt
      );
    if (!m) throw new Error(`无法解析 CREATE TABLE：${stmt.slice(0, 60)}`);
    const name = m[1]!;
    if (this.tables.has(name)) return []; // IF NOT EXISTS 幂等
    const defs = this.splitTopLevel(m[2]!);
    const cols: string[] = [];
    const pks: string[] = [];
    const uniques: string[][] = [];
    const types = new Map<string, string>();
    for (const raw of defs) {
      const def = raw.trim();
      if (!def) continue;
      const pkMatch = /^PRIMARY\s+KEY\s*\((.*)\)$/i.exec(def);
      if (pkMatch) {
        pks.push(...this.splitTopLevel(pkMatch[1]!).map((s) => s.trim()));
        continue;
      }
      const uqMatch = /^UNIQUE\s*\((.*)\)$/i.exec(def);
      if (uqMatch) {
        uniques.push(this.splitTopLevel(uqMatch[1]!).map((s) => s.trim()));
        continue;
      }
      if (/^CHECK\s*\(/i.test(def)) continue; // CHECK 约束仅作文档，内存引擎不校验
      const colMatch = /^(\S+)\s+(\S+)(?:\s+(.*))?$/i.exec(def);
      if (!colMatch) throw new Error(`无法解析列定义：${def}`);
      const col = colMatch[1]!;
      cols.push(col);
      types.set(col, colMatch[2]!.toUpperCase());
      const rest = (colMatch[3] ?? '').toUpperCase();
      if (rest.includes('PRIMARY KEY')) pks.push(col);
    }
    this.tables.set(name, { cols, pks, uniques, types });
    this.rows.set(name, []);
    return [];
  }

  // ---------------------------------------------------------------------------
  // INSERT
  // ---------------------------------------------------------------------------

  private execInsert(stmt: string, params: readonly unknown[]): unknown[] {
    // 支持 INSERT ... ON CONFLICT(<列>) DO UPDATE SET <列> = ?, ...（原子 upsert；
    // 语义对齐 SQLite：冲突时改走 UPDATE 分支，参数顺序 = VALUES 参数在前、SET 参数在后）
    const m =
      /^INSERT\s+INTO\s+(\S+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON\s+CONFLICT\s*\(([^)]*)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]*?))?\s*;?$/i.exec(
        stmt
      );
    if (!m) throw new Error(`无法解析 INSERT：${stmt.slice(0, 80)}`);
    if (!this.tables.has(m[1]!)) throw new Error(`表不存在：${m[1]}`);
    const table = this.tables.get(m[1]!)!;
    const cols = this.splitTopLevel(m[2]!).map((s) => s.trim());
    const valueTokens = this.splitTopLevel(m[3]!);
    if (cols.length !== valueTokens.length) {
      throw new Error(`INSERT 列数与值数不一致：${stmt.slice(0, 80)}`);
    }
    const row: Record<string, unknown> = {};
    let p = 0;
    for (let i = 0; i < cols.length; i++) {
      const token = valueTokens[i]!.trim();
      if (token === '?') {
        row[cols[i]!] = this.coerce(table.types.get(cols[i]!), params[p++]);
      } else if (/^\d+(\.\d+)?$/.test(token)) {
        row[cols[i]!] = Number(token);
      } else if (token.toUpperCase() === 'NULL') {
        row[cols[i]!] = null;
      } else {
        const lit = /^'(.*)'$/s.exec(token);
        if (!lit) throw new Error(`INSERT 值不支持：${token}`);
        row[cols[i]!] = lit[1]!;
      }
    }
    const existing = this.findConflicting(m[1]!, table, row);
    if (existing) {
      if (m[5] === undefined) {
        this.throwConflict(m[1]!, table, row);
        return [];
      }
      // DO UPDATE 分支：SET 列 = ? 逐项绑定（参数接在 VALUES 参数之后）
      const assignments = this.splitTopLevel(m[5]!).map((s) => s.trim());
      for (const assignment of assignments) {
        const am = /^(\S+)\s*=\s*(\?|\d+(?:\.\d+)?|NULL|'.*')$/s.exec(
          assignment
        );
        if (!am) throw new Error(`ON CONFLICT SET 不支持：${assignment}`);
        const col = am[1]!;
        if (am[2] === '?') {
          existing[col] = this.coerce(table.types.get(col), params[p++]);
        } else if (/^\d+(\.\d+)?$/.test(am[2]!)) {
          existing[col] = Number(am[2]);
        } else if (am[2]!.toUpperCase() === 'NULL') {
          existing[col] = null;
        } else {
          existing[col] = /^'(.*)'$/s.exec(am[2]!)![1]!;
        }
      }
      return [];
    }
    this.checkUnique(m[1]!, table, row);
    this.rows.get(m[1]!)!.push(row);
    return [];
  }

  /** 查找与 row 冲突（主键/唯一约束）的既有行（无冲突 → null） */
  private findConflicting(
    tableName: string,
    table: { cols: string[]; pks: string[]; uniques: string[][] },
    row: Record<string, unknown>
  ): Record<string, unknown> | null {
    const conflict = (cols: string[]) => {
      const existing = this.rows.get(tableName) ?? [];
      return existing.find((r) => cols.every((c) => this.eq(r[c], row[c])));
    };
    if (table.pks.length > 0) {
      const hit = conflict(table.pks);
      if (hit) return hit;
    }
    for (const u of table.uniques) {
      const hit = conflict(u);
      if (hit) return hit;
    }
    return null;
  }

  /** 校验主键/唯一约束冲突（对齐 SQLite 抛错） */
  private checkUnique(
    tableName: string,
    table: { cols: string[]; pks: string[]; uniques: string[][] },
    row: Record<string, unknown>
  ): void {
    if (this.findConflicting(tableName, table, row) !== null) {
      this.throwConflict(tableName, table, row);
    }
  }

  private throwConflict(
    tableName: string,
    table: { pks: string[]; uniques: string[][] },
    row: Record<string, unknown>
  ): void {
    const conflict = (cols: string[]) => {
      const existing = this.rows.get(tableName) ?? [];
      return existing.some((r) => cols.every((c) => this.eq(r[c], row[c])));
    };
    if (table.pks.length > 0 && conflict(table.pks)) {
      throw new Error(`主键冲突：${table.pks.join(',')}`);
    }
    for (const u of table.uniques) {
      if (conflict(u)) throw new Error(`唯一约束冲突：${u.join(',')}`);
    }
  }

  // ---------------------------------------------------------------------------
  // SELECT
  // ---------------------------------------------------------------------------

  private execSelect(stmt: string, params: readonly unknown[]): unknown[] {
    const m =
      /^SELECT(?:\s+DISTINCT)?\s+([\s\S]*?)\s+FROM\s+(\S+)(?:\s+WHERE\s+([\s\S]*?))?(?:\s+ORDER\s+BY\s+([\s\S]*?))?(?:\s+LIMIT\s+(\d+|\?))?(?:\s+OFFSET\s+(\d+|\?))?\s*;?$/i.exec(
        stmt
      );
    if (!m) throw new Error(`无法解析 SELECT：${stmt.slice(0, 80)}`);
    const distinct = /^SELECT\s+DISTINCT/i.test(stmt);
    const tableName = m[2]!;
    if (!this.tables.has(tableName)) throw new Error(`表不存在：${tableName}`);
    let rows = this.rows.get(tableName)!;

    if (m[3] !== undefined) {
      rows = rows.filter((r) => this.evalWhere(m[3]!, params, r));
    }
    if (m[4] !== undefined) {
      const order: { col: string; desc: boolean }[] = this.splitTopLevel(m[4]!)
        .map((s) => s.trim())
        .map((s) => {
          const om = /^(\S+)(?:\s+(ASC|DESC))?$/i.exec(s);
          if (!om) throw new Error(`无法解析 ORDER BY：${s}`);
          return {
            col: om[1]!,
            desc: (om[2] ?? 'ASC').toUpperCase() === 'DESC',
          };
        });
      rows = [...rows].sort((a, b) => {
        for (const o of order) {
          const cmp = this.compare(a[o.col], b[o.col]);
          if (cmp !== 0) return o.desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    // 参数顺序：WHERE 参数在前，随后是 LIMIT/OFFSET 的 `?` 参数
    let p = this.countParams(m[3] ?? '');
    const limit =
      m[5] !== undefined
        ? m[5] === '?'
          ? Number(params[p++])
          : Number(m[5])
        : Number.POSITIVE_INFINITY;
    const offset =
      m[6] !== undefined
        ? m[6] === '?'
          ? Number(params[p++])
          : Number(m[6])
        : 0;
    rows = rows.slice(offset, offset + limit);

    const selectList = m[1]!.trim();
    if (selectList === '*') {
      // DISTINCT 去重（仅支持单列场景，本仓库清理计算使用）
      if (distinct && rows.length > 1) {
        return dedupeRows(rows);
      }
      return rows;
    }
    const countMatch = /^COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+(\S+))?$/i.exec(
      selectList
    );
    if (countMatch) {
      const outName = countMatch[1] ?? 'count';
      return [{ [outName]: rows.length }];
    }
    const maxMatch = /^MAX\s*\(\s*(\S+)\s*\)(?:\s+AS\s+(\S+))?$/i.exec(
      selectList
    );
    if (maxMatch) {
      const col = maxMatch[1]!;
      const outName = maxMatch[2] ?? 'max';
      let max: unknown = null;
      for (const r of rows) {
        if (
          r[col] !== null &&
          r[col] !== undefined &&
          (max === null || this.compare(r[col], max) > 0)
        ) {
          max = r[col];
        }
      }
      return [{ [outName]: max }];
    }
    const minMatch = /^MIN\s*\(\s*(\S+)\s*\)(?:\s+AS\s+(\S+))?$/i.exec(
      selectList
    );
    if (minMatch) {
      const col = minMatch[1]!;
      const outName = minMatch[2] ?? 'min';
      let min: unknown = null;
      for (const r of rows) {
        if (
          r[col] !== null &&
          r[col] !== undefined &&
          (min === null || this.compare(r[col], min) < 0)
        ) {
          min = r[col];
        }
      }
      return [{ [outName]: min }];
    }
    // 普通列列表（支持 `列 AS 别名`）
    const cols = this.splitTopLevel(selectList).map((s) => {
      const am = /^(\S+)\s+AS\s+(\S+)$/i.exec(s.trim());
      return am !== null
        ? { key: am[2]!, source: am[1]! }
        : { key: s.trim(), source: s.trim() };
    });
    let outRows = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of cols) out[c.key] = r[c.source] ?? null;
      return out;
    });
    if (distinct && cols.length > 0) {
      outRows = dedupeRows(outRows);
    }
    return outRows;
  }

  // ---------------------------------------------------------------------------
  // UPDATE / DELETE
  // ---------------------------------------------------------------------------

  private execUpdate(stmt: string, params: readonly unknown[]): unknown[] {
    const m =
      /^UPDATE\s+(\S+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*?))?\s*;?$/i.exec(
        stmt
      );
    if (!m) throw new Error(`无法解析 UPDATE：${stmt.slice(0, 80)}`);
    const tableName = m[1]!;
    if (!this.tables.has(tableName)) throw new Error(`表不存在：${tableName}`);
    const table = this.tables.get(tableName)!;
    const sets: { col: string; value: unknown }[] = [];
    let p = 0;
    for (const raw of this.splitTopLevel(m[2]!)) {
      const sm = /^(\S+)\s*=\s*(.+)$/i.exec(raw.trim());
      if (!sm) throw new Error(`无法解析 SET 项：${raw}`);
      const valueToken = sm[2]!.trim();
      let value: unknown;
      if (valueToken === '?') {
        value = this.coerce(table.types.get(sm[1]!), params[p++]);
      } else if (/^\d+(\.\d+)?$/.test(valueToken)) {
        value = Number(valueToken);
      } else if (valueToken.toUpperCase() === 'NULL') {
        value = null;
      } else {
        const lit = /^'(.*)'$/s.exec(valueToken);
        if (!lit) throw new Error(`SET 值不支持：${valueToken}`);
        value = lit[1]!;
      }
      sets.push({ col: sm[1]!, value });
    }
    const rows = this.rows.get(tableName)!;
    const whereParams = params.slice(p); // SET 已消费的参数之后才是 WHERE 参数
    for (const r of rows) {
      if (m[3] === undefined || this.evalWhere(m[3]!, whereParams, r)) {
        for (const s of sets) r[s.col] = s.value;
      }
    }
    return [];
  }

  private execDelete(stmt: string, params: readonly unknown[]): unknown[] {
    const m = /^DELETE\s+FROM\s+(\S+)(?:\s+WHERE\s+([\s\S]*?))?\s*;?$/i.exec(
      stmt
    );
    if (!m) throw new Error(`无法解析 DELETE：${stmt.slice(0, 80)}`);
    const tableName = m[1]!;
    if (!this.tables.has(tableName)) throw new Error(`表不存在：${tableName}`);
    const rows = this.rows.get(tableName)!;
    const kept =
      m[2] === undefined
        ? []
        : rows.filter((r) => !this.evalWhere(m[2]!, params, r));
    this.rows.set(tableName, kept);
    return [];
  }

  // ---------------------------------------------------------------------------
  // WHERE 求值
  // ---------------------------------------------------------------------------

  /** 求值 WHERE 条件：按顶层 OR 分组 → 每组 AND 拆分 → 原子条件（参数按出现顺序消费） */
  private evalWhere(
    cond: string,
    params: readonly unknown[],
    row: Record<string, unknown>
  ): boolean {
    const orGroups = this.splitTopLevelGrouped(cond, 'OR');
    let offset = 0;
    for (const group of orGroups) {
      const andAtoms = this.splitTopLevelGrouped(group, 'AND');
      let andOk = true;
      for (const atomRaw of andAtoms) {
        const atom = atomRaw.trim();
        const consumed = this.countParams(this.stripParens(atom));
        if (!andOk) {
          // 短路：本组剩余原子不再求值，但参数仍需跳过（后续 OR 组对齐）
          offset += consumed;
          continue;
        }
        if (
          atom.startsWith('(') &&
          atom.endsWith(')') &&
          this.isBalanced(atom)
        ) {
          // 括号分组：递归求值（参数按子表达式顺序消费）
          const inner = this.stripParens(atom);
          if (inner === '') throw new Error(`空括号条件：${cond}`);
          const result = this.evalWhere(
            inner,
            params.slice(offset, offset + consumed),
            row
          );
          offset += consumed;
          andOk = andOk && result;
          continue;
        }
        andOk =
          andOk &&
          this.evalAtom(atom, params.slice(offset), row, (n) => (offset += n));
      }
      if (andOk) return true;
    }
    return false;
  }

  /** 剥离外层括号 */
  private stripParens(s: string): string {
    let t = s.trim();
    while (t.startsWith('(') && t.endsWith(')') && this.isBalanced(t))
      t = t.slice(1, -1).trim();
    return t;
  }

  /** 括号是否平衡（用于确认外层括号成对） */
  private isBalanced(s: string): boolean {
    let depth = 0;
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  }

  /** 统计条件中的参数占位符数量（用于参数消费记账） */
  private countParams(s: string): number {
    let n = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") inStr = !inStr;
      if (!inStr && ch === '?') n++;
    }
    return n;
  }

  /** 求值单个原子条件（无括号）：`列 运算符 值` 或 `列 IN (...)` 或 `列 IS [NOT] NULL` */
  private evalAtom(
    atomRaw: string,
    params: readonly unknown[],
    row: Record<string, unknown>,
    consume: (n: number) => void
  ): boolean {
    const atom = atomRaw.trim();
    const inMatch = /^(\S+)\s+NOT\s+IN\s*\((.*)\)$/is.exec(atom);
    if (inMatch)
      return this.evalIn(inMatch[1]!, inMatch[2]!, true, params, row, consume);
    const inMatch2 = /^(\S+)\s+IN\s*\((.*)\)$/is.exec(atom);
    if (inMatch2)
      return this.evalIn(
        inMatch2[1]!,
        inMatch2[2]!,
        false,
        params,
        row,
        consume
      );
    const isNull = /^(\S+)\s+IS\s+(NOT\s+)?NULL$/i.exec(atom);
    if (isNull) {
      const v = row[isNull[1]!];
      const isNullVal = v === null || v === undefined;
      return isNull[2] !== undefined ? !isNullVal : isNullVal;
    }
    const cmpMatch = /^(\S+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)$/is.exec(atom);
    if (!cmpMatch) throw new Error(`无法解析 WHERE 原子条件：${atom}`);
    const col = cmpMatch[1]!;
    const op = cmpMatch[2]!;
    const rhsToken = cmpMatch[3]!.trim();
    let rhs: unknown;
    let isParam = false;
    if (rhsToken === '?') {
      rhs = params[0];
      isParam = true;
    } else if (/^\d+(\.\d+)?$/.test(rhsToken)) {
      rhs = Number(rhsToken);
    } else if (rhsToken.toUpperCase() === 'NULL') {
      rhs = null;
    } else {
      const lit = /^'(.*)'$/s.exec(rhsToken);
      if (!lit) throw new Error(`WHERE 值不支持：${rhsToken}`);
      rhs = lit[1]!;
    }
    if (isParam) consume(1);
    const lv = row[col];
    switch (op) {
      case '=':
        return this.eq(lv, rhs);
      case '!=':
      case '<>':
        return !this.eq(lv, rhs);
      case '<':
        return this.compare(lv, rhs) < 0;
      case '<=':
        return this.compare(lv, rhs) <= 0;
      case '>':
        return this.compare(lv, rhs) > 0;
      case '>=':
        return this.compare(lv, rhs) >= 0;
      default:
        throw new Error(`未知运算符：${op}`);
    }
  }

  /** 求值 IN / NOT IN 列表 */
  private evalIn(
    col: string,
    listRaw: string,
    negate: boolean,
    params: readonly unknown[],
    row: Record<string, unknown>,
    consume: (n: number) => void
  ): boolean {
    const items = this.splitTopLevel(listRaw).map((s) => s.trim());
    const values: unknown[] = [];
    let used = 0;
    for (const item of items) {
      if (item === '?') {
        values.push(params[used]);
        used += 1;
      } else if (/^\d+(\.\d+)?$/.test(item)) {
        values.push(Number(item));
      } else {
        const lit = /^'(.*)'$/s.exec(item);
        if (!lit) throw new Error(`IN 列表值不支持：${item}`);
        values.push(lit[1]!);
      }
    }
    consume(used);
    const found = values.some((v) => this.eq(row[col], v));
    return negate ? !found : found;
  }

  // ---------------------------------------------------------------------------
  // 值比较与类型
  // ---------------------------------------------------------------------------

  /** 值相等（null 相等；数值字符串按数值比较） */
  private eq(a: unknown, b: unknown): boolean {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    const na = Number(a);
    const nb = Number(b);
    if (
      !Number.isNaN(na) &&
      !Number.isNaN(nb) &&
      typeof a !== 'boolean' &&
      typeof b !== 'boolean'
    ) {
      return na === nb;
    }
    return String(a) === String(b);
  }

  /** 比较（数值优先，退化为字符串比较） */
  private compare(a: unknown, b: unknown): number {
    if (a === null || a === undefined)
      return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    const na = Number(a);
    const nb = Number(b);
    if (
      !Number.isNaN(na) &&
      !Number.isNaN(nb) &&
      typeof a !== 'boolean' &&
      typeof b !== 'boolean'
    ) {
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  /** 按列类型转换参数值（INTEGER/REAL → number，TEXT → string） */
  private coerce(type: string | undefined, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (type === 'INTEGER' || type === 'REAL') {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    }
    if (type === 'TEXT') return String(v);
    return v;
  }

  // ---------------------------------------------------------------------------
  // 文本工具
  // ---------------------------------------------------------------------------

  /** 按顶层逗号分割（忽略括号内与字符串内的逗号） */
  private splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let inStr = false;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") inStr = !inStr;
      if (!inStr && ch === '(') depth++;
      if (!inStr && ch === ')') depth--;
      if (!inStr && ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
  }

  /** 按顶层关键字分组（忽略括号内与字符串内的关键字），保留原顺序 */ private splitTopLevelGrouped(
    s: string,
    keyword: 'AND' | 'OR'
  ): string[] {
    const out: string[] = [];
    let depth = 0;
    let inStr = false;
    let cur = '';
    const upper = s.toUpperCase();
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'") {
        inStr = !inStr;
        cur += ch;
        i++;
        continue;
      }
      if (!inStr && ch === '(') depth++;
      if (!inStr && ch === ')') depth--;
      if (!inStr && depth === 0) {
        const nextWord = upper
          .slice(i, i + keyword.length + 1)
          .replace(/\s+$/, '');
        if (
          nextWord === keyword ||
          (nextWord === keyword + ' ' &&
            /\s/.test(upper[i + keyword.length] ?? ''))
        ) {
          out.push(cur);
          cur = '';
          i += keyword.length;
          // 跳过随后的空白
          while (i < s.length && /\s/.test(s[i]!)) i++;
          continue;
        }
      }
      cur += ch;
      i++;
    }
    out.push(cur);
    return out;
  }
}

/** 行去重（按整行 JSON 形状相等；用于 DISTINCT） */
function dedupeRows(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
