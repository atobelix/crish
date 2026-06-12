/**
 * message-pipeline.ts 单元测试
 *
 * 覆盖核心消息操作：
 * - reduceChatMessages: 去重合并、时间排序、不可变性
 * - removeChatMessages: 删除单条/多条、空集
 * - truncateChatMessages: 截断、未找到
 * - updateChatMessage: 更新字段、未找到
 * - popLastChatMessage: 弹出、空列表
 */

import { describe, expect, test } from "vitest";
import {
  reduceChatMessages,
  removeChatMessages,
  truncateChatMessages,
  updateChatMessage,
  popLastChatMessage,
} from "./message-pipeline";
import type { ChatMessage } from "./app-state";

function msg(id: string, timestamp: number, role: ChatMessage["role"] = "user", content = `msg-${id}`): ChatMessage {
  return { id, timestamp, role, content };
}

const MSG_A = msg("a", 1000);
const MSG_B = msg("b", 2000, "assistant");
const MSG_C = msg("c", 3000, "system");
const MSG_D = msg("d", 4000, "assistant");

// ─── reduceChatMessages ──────────────────────────────────

describe("reduceChatMessages", () => {
  test("returns current when incoming is empty", () => {
    const result = reduceChatMessages([MSG_A, MSG_B], []);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  test("appends new messages at correct position by timestamp", () => {
    const result = reduceChatMessages([MSG_A, MSG_C], [MSG_B]);
    expect(result).toHaveLength(3);
    expect(result.map(m => m.id)).toEqual(["a", "b", "c"]);
  });

  test("merges same-id messages (later wins)", () => {
    const updated = reduceChatMessages([MSG_A], [{ id: "a", timestamp: 1000, role: "assistant", content: "updated" }]);
    expect(updated).toHaveLength(1);
    expect(updated[0].role).toBe("assistant");
    expect(updated[0].content).toBe("updated");
  });

  test("does not mutate input arrays", () => {
    const orig = [MSG_A];
    const incoming = [MSG_B];
    const snapshot = JSON.stringify(orig);
    reduceChatMessages(orig, incoming);
    expect(JSON.stringify(orig)).toBe(snapshot);
  });

  test("merges partial fields (keeps unset fields from original)", () => {
    const base = msg("x", 100, "assistant", "hello");
    const result = reduceChatMessages([base], [{ id: "x", timestamp: 100, role: "system", content: "hi" }]);
    expect(result[0].content).toBe("hi");
    expect(result[0].role).toBe("system");
  });
});

// ─── removeChatMessages ──────────────────────────────────

describe("removeChatMessages", () => {
  test("removes single message", () => {
    const result = removeChatMessages([MSG_A, MSG_B, MSG_C], "b");
    expect(result.map(m => m.id)).toEqual(["a", "c"]);
  });

  test("removes multiple messages", () => {
    const result = removeChatMessages([MSG_A, MSG_B, MSG_C, MSG_D], "a", "c");
    expect(result.map(m => m.id)).toEqual(["b", "d"]);
  });

  test("empty ids does nothing", () => {
    const result = removeChatMessages([MSG_A, MSG_B]);
    expect(result).toHaveLength(2);
  });

  test("non-existent id returns filtered copy (same elements)", () => {
    const orig = [MSG_A, MSG_B];
    const result = removeChatMessages(orig, "nonexistent");
    expect(result).not.toBe(orig);
    expect(result.map(m => m.id)).toEqual(["a", "b"]);
  });
});

// ─── truncateChatMessages ────────────────────────────────

describe("truncateChatMessages", () => {
  test("truncates at found id", () => {
    const result = truncateChatMessages([MSG_A, MSG_B, MSG_C, MSG_D], "b");
    expect(result.map(m => m.id)).toEqual(["a", "b"]);
  });

  test("returns original when id not found", () => {
    const orig = [MSG_A, MSG_B];
    const result = truncateChatMessages(orig, "z");
    expect(result).toBe(orig);
  });
});

// ─── updateChatMessage ───────────────────────────────────

describe("updateChatMessage", () => {
  test("updates single field", () => {
    const result = updateChatMessage([MSG_A, MSG_B], "a", { content: "updated" });
    expect(result[0].content).toBe("updated");
    expect(result[1].content).toBe("msg-b");
  });

  test("does not mutate original", () => {
    const orig = [MSG_A, MSG_B];
    updateChatMessage(orig, "a", { content: "changed" });
    expect(orig[0].content).toBe("msg-a");
  });

  test("returns original when id not found", () => {
    const orig = [MSG_A];
    const result = updateChatMessage(orig, "z", { content: "x" });
    expect(result).toBe(orig);
  });
});

// ─── popLastChatMessage ──────────────────────────────────

describe("popLastChatMessage", () => {
  test("pops last message", () => {
    const [popped, rest] = popLastChatMessage([MSG_A, MSG_B, MSG_C]);
    expect(popped?.id).toBe("c");
    expect(rest.map(m => m.id)).toEqual(["a", "b"]);
  });

  test("returns null + empty for empty list", () => {
    const [popped, rest] = popLastChatMessage([]);
    expect(popped).toBeNull();
    expect(rest).toHaveLength(0);
  });

  test("single element list", () => {
    const [popped, rest] = popLastChatMessage([MSG_A]);
    expect(popped?.id).toBe("a");
    expect(rest).toHaveLength(0);
  });
});