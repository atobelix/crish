import { describe, expect, it, beforeEach } from "vitest";
import { MediaPreprocessor } from "../../media/media-preprocessor";
import { ProviderMediaAdapter } from "../../media/provider-media-adapter";
import type { NormalizedMedia, ImageContent } from "../../media/media-types";

const SAMPLE_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg";
const SAMPLE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SAMPLE_GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

describe("MediaPreprocessor - base64 input", () => {
  let preprocessor: MediaPreprocessor;

  beforeEach(() => {
    preprocessor = new MediaPreprocessor();
  });

  it("normalizes a base64 image input", async () => {
    const result = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
    });

    expect(result.type).toBe("image");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.source).toBe("base64");
    expect(result.data).toBe(SAMPLE_JPEG_BASE64);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("detects PNG mime from base64 header", async () => {
    const result = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: SAMPLE_PNG_BASE64,
    });
    expect(result.mimeType).toBe("image/png");
  });

  it("detects GIF mime from base64 header", async () => {
    const result = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: SAMPLE_GIF_BASE64,
    });
    expect(result.mimeType).toBe("image/gif");
  });

  it("calculates correct sizeBytes from base64 string", async () => {
    const result = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
    });
    const expectedSize = Math.ceil((SAMPLE_JPEG_BASE64.length * 3) / 4);
    expect(result.sizeBytes).toBe(expectedSize);
  });

  it("accepts explicit mimeType override", async () => {
    const result = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: "someData",
      mimeType: "image/webp",
    });
    expect(result.mimeType).toBe("image/webp");
  });

  it("normalizes audio from base64", async () => {
    const result = await preprocessor.normalize({
      type: "audio",
      source: "base64",
      data: "UExBU1RJRUNBVFM=",
      mimeType: "audio/wav",
    });
    expect(result.type).toBe("audio");
    expect(result.mimeType).toBe("audio/wav");
  });

  it("throws for invalid media input", async () => {
    await expect(
      preprocessor.normalize({
        type: "image",
        source: "base64",
      } as any),
    ).rejects.toThrow(/Invalid media input/);
  });
});

describe("MediaPreprocessor - validation", () => {
  let preprocessor: MediaPreprocessor;

  beforeEach(() => {
    preprocessor = new MediaPreprocessor();
  });

  it("passes validation for valid image", async () => {
    const media = await preprocessor.normalize({
      type: "image",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
    });
    const result = preprocessor.validate(media);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects oversized media", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/jpeg",
      source: "base64",
      data: "data",
      sizeBytes: 30 * 1024 * 1024,
    };
    const result = preprocessor.validate(media, { maxSizeBytes: 20 * 1024 * 1024 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exceeds max");
  });

  it("rejects unsupported mime type", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/bmp",
      source: "base64",
      data: "data",
      sizeBytes: 100,
    };
    const result = preprocessor.validate(media);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Unsupported MIME");
  });

  it("accepts mime type when explicitly allowed", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/bmp",
      source: "base64",
      data: "data",
      sizeBytes: 100,
    };
    const result = preprocessor.validate(media, { allowedMimeTypes: ["image/bmp"] });
    expect(result.valid).toBe(true);
  });
});

describe("MediaPreprocessor - compress", () => {
  let preprocessor: MediaPreprocessor;

  beforeEach(() => {
    preprocessor = new MediaPreprocessor();
  });

  it("computes new dimensions when maxWidth is set", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/jpeg",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
      width: 1920,
      height: 1080,
      sizeBytes: 500_000,
    };

    const compressed = await preprocessor.compress(media, { maxWidth: 800 });
    expect(compressed.width).toBe(800);
    expect(compressed.height).toBe(450);
  });

  it("computes new dimensions when maxHeight is set", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/jpeg",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
      width: 1920,
      height: 1080,
      sizeBytes: 500_000,
    };

    const compressed = await preprocessor.compress(media, { maxHeight: 600 });
    expect(compressed.height).toBe(600);
    expect(compressed.width).toBe(1067);
  });

  it("does not upscale when dimensions are already smaller than max", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/jpeg",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
      width: 100,
      height: 100,
      sizeBytes: 10_000,
    };

    const compressed = await preprocessor.compress(media, { maxWidth: 800, maxHeight: 800 });
    expect(compressed.width).toBe(100);
    expect(compressed.height).toBe(100);
  });

  it("handles missing dimensions gracefully", async () => {
    const media: ImageContent = {
      type: "image",
      mimeType: "image/jpeg",
      source: "base64",
      data: SAMPLE_JPEG_BASE64,
      sizeBytes: 10_000,
    };

    const compressed = await preprocessor.compress(media, { maxWidth: 800 });
    expect(compressed.width).toBeUndefined();
    expect(compressed.height).toBeUndefined();
  });
});

describe("MediaPreprocessor - cache", () => {
  it("returns cached result on second normalize", async () => {
    const preprocessor = new MediaPreprocessor();
    const input = { type: "image" as const, source: "base64" as const, data: SAMPLE_JPEG_BASE64 };

    const r1 = await preprocessor.normalize(input);
    const r2 = await preprocessor.normalize(input);
    expect(r1).toBe(r2);
  });

  it("clearCache empties the cache", async () => {
    const preprocessor = new MediaPreprocessor();
    const input = { type: "image" as const, source: "base64" as const, data: SAMPLE_JPEG_BASE64 };

    await preprocessor.normalize(input);
    preprocessor.clearCache();
    const afterClear = await preprocessor.normalize(input);
    expect(afterClear).toBeDefined();
  });
});

describe("ProviderMediaAdapter - per-vendor format adaptation", () => {
  const adapter = new ProviderMediaAdapter();

  const base64Image: NormalizedMedia = {
    type: "image",
    mimeType: "image/png",
    source: "base64",
    data: SAMPLE_PNG_BASE64,
    sizeBytes: 100,
  };

  const urlImage: NormalizedMedia = {
    type: "image",
    mimeType: "image/jpeg",
    source: "url",
    data: "https://example.com/photo.jpg",
    sizeBytes: 0,
  };

  it("adapts for Anthropic format", () => {
    const result = adapter.adaptForProvider(base64Image, "anthropic");
    expect(result).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: SAMPLE_PNG_BASE64 },
    });
  });

  it("adapts for OpenAI Chat format", () => {
    const result = adapter.adaptForProvider(base64Image, "openai-chat");
    expect(result).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${SAMPLE_PNG_BASE64}` },
    });
  });

  it("adapts for OpenAI Responses format", () => {
    const result = adapter.adaptForProvider(base64Image, "openai-responses");
    expect(result).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${SAMPLE_PNG_BASE64}`,
    });
  });

  it("adapts base64 source for Gemini inline format", () => {
    const result = adapter.adaptForProvider(base64Image, "gemini");
    expect(result).toEqual({
      type: "inline_data",
      inline_data: { mime_type: "image/png", data: SAMPLE_PNG_BASE64 },
    });
  });

  it("adapts url source for Gemini file_data format", () => {
    const result = adapter.adaptForProvider(urlImage, "gemini");
    expect(result).toEqual({
      type: "file_data",
      file_data: { mime_type: "image/jpeg", file_uri: "https://example.com/photo.jpg" },
    });
  });

  it("adapts for Bedrock format", () => {
    const result = adapter.adaptForProvider(base64Image, "bedrock");
    expect(result).toEqual({
      type: "image",
      source: { bytes: SAMPLE_PNG_BASE64 },
      format: "png",
    });
  });

  it("throws for unsupported provider family", () => {
    expect(() => adapter.adaptForProvider(base64Image, "unknown" as any)).toThrow();
  });

  it("throws for unsupported media type in Anthropic", () => {
    const audio: NormalizedMedia = {
      type: "audio",
      mimeType: "audio/wav",
      source: "base64",
      data: "data",
      sizeBytes: 100,
    };
    expect(() => adapter.adaptForProvider(audio, "anthropic")).toThrow(/Anthropic does not support/);
  });

  it("throws for unsupported media type in OpenAI Chat", () => {
    const video: NormalizedMedia = {
      type: "video",
      mimeType: "video/mp4",
      source: "base64",
      data: "data",
      sizeBytes: 100,
    };
    expect(() => adapter.adaptForProvider(video, "openai-chat")).toThrow(/OpenAI Chat does not support/);
  });
});

describe("ProviderMediaAdapter - tool_result media processing", () => {
  const adapter = new ProviderMediaAdapter();

  it("returns inline when no media blocks present", () => {
    const blocks = [{ type: "text", text: "hello" }] as any;
    const result = adapter.processToolResultMedia(blocks, "openai-chat", "tool_1");
    expect(result.type).toBe("inline");
    expect(result.blocks).toHaveLength(1);
  });

  it("returns inline for Anthropic regardless of media blocks", () => {
    const blocks = [
      { type: "text", text: "result:" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ] as any;
    const result = adapter.processToolResultMedia(blocks, "anthropic", "tool_1");
    expect(result.type).toBe("inline");
  });

  it("splits media blocks for OpenAI Chat", () => {
    const blocks = [
      { type: "text", text: "Here is the image:" },
      { type: "image", source: { type: "base64", data: "imgdata" }, mimeType: "image/png" },
    ] as any;
    const result = adapter.processToolResultMedia(blocks, "openai-chat", "tool_1");
    expect(result.type).toBe("split");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.type).toBe("text");
    expect(result.mediaMessages).toHaveLength(1);
    expect(result.mediaMessages![0]!.role).toBe("user");
  });

  it("converts media blocks to file_data for Gemini", () => {
    const blocks = [
      { type: "image", source: { type: "url", url: "gs://bucket/img.jpg" }, mimeType: "image/jpeg" },
    ] as any;
    const result = adapter.processToolResultMedia(blocks, "gemini", "tool_1");
    expect(result.type).toBe("inline");
    const fileDataBlock = result.blocks[0] as any;
    expect(fileDataBlock.type).toBe("file_data");
    expect(fileDataBlock.file_data.mime_type).toBe("image/jpeg");
    expect(fileDataBlock.file_data.file_uri).toBe("gs://bucket/img.jpg");
  });

  it("returns inline for unsupported provider family", () => {
    const blocks = [{ type: "image", source: { data: "x" } }] as any;
    const result = adapter.processToolResultMedia(blocks, "bedrock", "tool_1");
    expect(result.type).toBe("inline");
  });
});
