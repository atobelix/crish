import { describe, expect, it } from "vitest";
import { PreviewQueue } from "./preview-queue";

describe("PreviewQueue", () => {
  it("creates pending previews with TTL and artifact metadata", async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: () => "preview_1",
      defaultTtlMs: 1_000
    });

    const preview = await queue.createPreview({
      action: "edit",
      title: "Edit src/app.ts",
      payload: { path: "src/app.ts" },
      artifact: {
        kind: "diff",
        text: "--- before\n+++ after",
        metadata: {
          artifactKind: "edit-diff-preview",
          path: "src/app.ts"
        }
      },
      metadata: { sessionId: "session_1" }
    });

    expect(preview).toMatchObject({
      id: "preview_1",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:01.000Z",
      ttlMs: 1_000
    });
    expect(preview.artifact).toMatchObject({
      kind: "diff",
      title: "Edit src/app.ts",
      text: "--- before\n+++ after",
      metadata: {
        artifactKind: "edit-diff-preview",
        previewKind: "runtime-preview",
        previewId: "preview_1",
        previewAction: "edit",
        previewStatus: "pending",
        previewTtlMs: 1_000,
        path: "src/app.ts",
        sessionId: "session_1"
      }
    });
  });

  it("resolves previews through typed apply and discard outcomes", async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: sequentialIds("preview")
    });

    const first = await queue.createPreview({
      action: "edit",
      title: "Apply me",
      payload: { path: "src/apply.ts" }
    });
    clock.advance(5);
    const applied = await queue.resolve(first.id, {
      status: "applied",
      result: { changed: true },
      metadata: { toolCallId: "tool_1" }
    });

    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("expected applied preview");
    expect(applied.appliedAt).toBe("2026-01-01T00:00:00.005Z");
    expect(applied.result).toEqual({ changed: true });
    expect(applied.artifact.metadata).toMatchObject({
      previewStatus: "applied",
      previewAppliedAt: "2026-01-01T00:00:00.005Z",
      toolCallId: "tool_1"
    });

    const second = await queue.createPreview({
      action: "edit",
      title: "Discard me",
      payload: { path: "src/discard.ts" }
    });
    clock.advance(5);
    const discarded = await queue.discard(second.id, { reason: "user dismissed" });

    expect(discarded.status).toBe("discarded");
    expect(discarded.reason).toBe("user dismissed");
    expect(discarded.artifact.metadata).toMatchObject({
      previewStatus: "discarded",
      previewDiscardReason: "user dismissed"
    });
    await expect(queue.apply(second.id)).rejects.toThrow(/discarded status/);
  });

  it("expires pending previews by TTL before resolution", async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: () => "preview_ttl",
      defaultTtlMs: 10
    });

    const preview = await queue.createPreview({
      action: "edit",
      title: "Short lived",
      payload: { path: "src/ttl.ts" }
    });
    clock.advance(11);

    const expired = await queue.get(preview.id);
    expect(expired?.status).toBe("expired");
    if (expired?.status !== "expired") throw new Error("expected expired preview");
    expect(expired.expiredAt).toBe("2026-01-01T00:00:00.011Z");
    expect(expired.artifact.metadata).toMatchObject({
      previewStatus: "expired",
      previewExpiredAt: "2026-01-01T00:00:00.011Z"
    });
    await expect(queue.apply(preview.id)).rejects.toThrow(/expired status/);
    await expect(queue.list({ status: "expired" })).resolves.toHaveLength(1);
  });

  it("serializes concurrent resolutions so only one effect can settle a preview", async () => {
    const queue = new PreviewQueue({
      idFactory: () => "preview_concurrent"
    });
    const preview = await queue.createPreview({
      action: "edit",
      title: "Concurrent edit",
      payload: { path: "src/concurrent.ts" }
    });

    let releaseEffect!: () => void;
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effectCalls = 0;

    const applyPromise = queue.apply(preview.id, {
      effect: async (pending) => {
        effectCalls += 1;
        expect(pending.status).toBe("pending");
        markEffectStarted();
        await release;
        return { result: { ok: true } };
      }
    });
    await effectStarted;
    const discardPromise = queue.discard(preview.id, { reason: "late decision" });
    releaseEffect();

    const [applyResult, discardResult] = await Promise.allSettled([applyPromise, discardPromise]);
    expect(applyResult.status).toBe("fulfilled");
    expect(discardResult.status).toBe("rejected");
    expect(effectCalls).toBe(1);

    const finalPreview = await queue.get(preview.id);
    expect(finalPreview?.status).toBe("applied");
  });
});

function manualClock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}_${++next}`;
}
