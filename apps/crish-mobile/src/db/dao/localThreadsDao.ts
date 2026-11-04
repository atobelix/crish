// local_threads / local_messages DAO：本地对话多线程历史的持久化真源（CON-4/L2）。
//
// 为什么在 SQLite：本地对话历史是「泄漏仅损失隐私」型数据（M5 §6.1 分层
// 原则，与 approval outbox 同层），且多线程全量 JSON 进 kv/SecureStore 会
// 撞 iOS Keychain 单值上限与 kv 读改写竞态；逐行落 SQLite 是仓内既有口径。
// 凭据纪律：本 DAO 只存 provider/model 二元身份，**不存 apiKeyRef、更不存
// 密钥材料**——发送瞬间经 localChatStore.readApiKey 从 SecureStore 读取。
import type { SqlDriver } from '../driver';
import type {
  LocalChatMessage,
  LocalThreadMeta,
  LocalThreadTitleSource,
} from '@/domain/types/localChat';

/** local_threads 行形状（snake_case，与 schema 对齐） */
export interface LocalThreadRow {
  id: string;
  title: string;
  /** 标题来源枚举原文（v4 列；读侧经 coerceTitleSource 收敛） */
  title_source: string;
  preview: string;
  provider_id: string | null;
  model_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 标题来源读侧收敛：库内只应出现四个枚举值；未知值（未来扩展/脏数据）
 * 按存量口径回落 derived（截断标题语义），不让未知字符串污染来源阶梯。
 */
export function coerceTitleSource(raw: string): LocalThreadTitleSource {
  return raw === 'placeholder' || raw === 'ai' || raw === 'user'
    ? raw
    : 'derived';
}

/** local_messages 行形状（snake_case，与 schema 对齐） */
export interface LocalMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  content: string;
  stopped: number;
  tool_call_count: number | null;
}

/** 行 → 线程元数据 */
export function rowToThreadMeta(row: LocalThreadRow): LocalThreadMeta {
  return {
    id: row.id,
    title: row.title,
    titleSource: coerceTitleSource(row.title_source),
    preview: row.preview,
    modelRef:
      row.provider_id !== null && row.model_id !== null
        ? { providerId: row.provider_id, modelId: row.model_id }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行 → 消息（可选字段按缺省纪律还原：0/null 不写出键） */
export function rowToLocalMessage(row: LocalMessageRow): LocalChatMessage {
  return {
    id: row.id,
    role: row.role as LocalChatMessage['role'],
    content: row.content,
    ...(row.stopped === 1 ? { stopped: true } : {}),
    ...(row.tool_call_count !== null
      ? { toolCallCount: row.tool_call_count }
      : {}),
  };
}

/** 全量消息行（hydrate 用：携带 threadId 分组） */
export interface LocalMessageWithThread {
  threadId: string;
  seq: number;
  message: LocalChatMessage;
}

/** 本地线程持久化 DAO 接口 */
export interface LocalThreadsDao {
  /** 全部线程元数据（updated_at 降序，与列表呈现同序） */
  listThreads(): Promise<LocalThreadMeta[]>;
  /** 单线程消息（seq 升序 = 时间线序） */
  listMessages(threadId: string): Promise<LocalChatMessage[]>;
  /** 全部消息（hydrate 一次读齐；按 thread_id、seq 排序供分组） */
  listAllMessages(): Promise<LocalMessageWithThread[]>;
  /** 线程元数据新增/更新（标题/摘要/模型/更新时间） */
  upsertThread(meta: LocalThreadMeta): Promise<void>;
  /** 消息新增/更新（按 id 冲突更新内容与标记：流式收尾回写走此路） */
  saveMessage(
    threadId: string,
    seq: number,
    message: LocalChatMessage
  ): Promise<void>;
  /** 删除线程（事务内连带其全部消息） */
  deleteThread(threadId: string): Promise<void>;
  /** 清空单线程消息（线程本体保留；「清空对话」语义） */
  deleteThreadMessages(threadId: string): Promise<void>;
}

const SELECT_THREADS_SQL =
  'SELECT id, title, title_source, preview, provider_id, model_id, created_at, updated_at ' +
  'FROM local_threads ORDER BY updated_at DESC';

const SELECT_MESSAGES_SQL =
  'SELECT id, thread_id, seq, role, content, stopped, tool_call_count ' +
  'FROM local_messages WHERE thread_id = ? ORDER BY seq ASC';

const SELECT_ALL_MESSAGES_SQL =
  'SELECT id, thread_id, seq, role, content, stopped, tool_call_count ' +
  'FROM local_messages ORDER BY thread_id ASC, seq ASC';

const UPSERT_THREAD_SQL =
  'INSERT INTO local_threads (id, title, title_source, preview, provider_id, model_id, created_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET title = ?, title_source = ?, preview = ?, provider_id = ?, model_id = ?, updated_at = ?';

const SAVE_MESSAGE_SQL =
  'INSERT INTO local_messages (id, thread_id, seq, role, content, stopped, tool_call_count) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET content = ?, stopped = ?, tool_call_count = ?';

/** 基于 SqlDriver 的本地线程 DAO 实现 */
export class SqlLocalThreadsDao implements LocalThreadsDao {
  constructor(private readonly driver: SqlDriver) {}

  async listThreads(): Promise<LocalThreadMeta[]> {
    const rows = await this.driver.getAll<LocalThreadRow>(SELECT_THREADS_SQL);
    return rows.map(rowToThreadMeta);
  }

  async listMessages(threadId: string): Promise<LocalChatMessage[]> {
    const rows = await this.driver.getAll<LocalMessageRow>(
      SELECT_MESSAGES_SQL,
      [threadId]
    );
    return rows.map(rowToLocalMessage);
  }

  async listAllMessages(): Promise<LocalMessageWithThread[]> {
    const rows = await this.driver.getAll<LocalMessageRow>(
      SELECT_ALL_MESSAGES_SQL
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      seq: row.seq,
      message: rowToLocalMessage(row),
    }));
  }

  async upsertThread(meta: LocalThreadMeta): Promise<void> {
    await this.driver.exec(UPSERT_THREAD_SQL, [
      meta.id,
      meta.title,
      meta.titleSource,
      meta.preview,
      meta.modelRef?.providerId ?? null,
      meta.modelRef?.modelId ?? null,
      meta.createdAt,
      meta.updatedAt,
      // ON CONFLICT DO UPDATE 的 SET 参数（顺序接在 VALUES 参数之后）
      meta.title,
      meta.titleSource,
      meta.preview,
      meta.modelRef?.providerId ?? null,
      meta.modelRef?.modelId ?? null,
      meta.updatedAt,
    ]);
  }

  async saveMessage(
    threadId: string,
    seq: number,
    message: LocalChatMessage
  ): Promise<void> {
    await this.driver.exec(SAVE_MESSAGE_SQL, [
      message.id,
      threadId,
      seq,
      message.role,
      message.content,
      message.stopped === true ? 1 : 0,
      message.toolCallCount ?? null,
      // ON CONFLICT DO UPDATE 的 SET 参数
      message.content,
      message.stopped === true ? 1 : 0,
      message.toolCallCount ?? null,
    ]);
  }

  async deleteThread(threadId: string): Promise<void> {
    // 事务内先删消息后删线程：避免半途失败留下孤儿消息行
    await this.driver.withTransaction(async () => {
      await this.driver.exec('DELETE FROM local_messages WHERE thread_id = ?', [
        threadId,
      ]);
      await this.driver.exec('DELETE FROM local_threads WHERE id = ?', [
        threadId,
      ]);
    });
  }

  async deleteThreadMessages(threadId: string): Promise<void> {
    await this.driver.exec('DELETE FROM local_messages WHERE thread_id = ?', [
      threadId,
    ]);
  }
}
