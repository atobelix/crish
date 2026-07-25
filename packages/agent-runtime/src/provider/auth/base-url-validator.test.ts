import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateBaseUrl, setAllowTestLocalhost, isTestLocalhostAllowed } from "./base-url-validator";

describe("validateBaseUrl", () => {
  beforeEach(() => {
    setAllowTestLocalhost(false);
  });
  it("accepts valid public HTTPS URLs", () => {
    const result = validateBaseUrl("https://api.openai.com/v1");
    expect(result.valid).toBe(true);
  });

  it("accepts valid public HTTP URLs", () => {
    const result = validateBaseUrl("http://example.com/api");
    expect(result.valid).toBe(true);
  });

  it("rejects localhost", () => {
    const result = validateBaseUrl("https://localhost:8080");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden hostname");
  });

  it("rejects 127.0.0.1", () => {
    const result = validateBaseUrl("http://127.0.0.1:8080");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden hostname");
  });

  it("rejects private IPv4 10.x.x.x", () => {
    const result = validateBaseUrl("http://10.0.0.1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Private IP");
  });

  it("rejects private IPv4 172.16-31.x.x", () => {
    expect(validateBaseUrl("http://172.16.0.1").valid).toBe(false);
    expect(validateBaseUrl("http://172.31.255.255").valid).toBe(false);
  });

  it("rejects private IPv4 192.168.x.x", () => {
    const result = validateBaseUrl("http://192.168.1.1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Private IP");
  });

  it("rejects metadata.google.internal", () => {
    const result = validateBaseUrl("http://metadata.google.internal");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden hostname");
  });

  it("rejects 169.254.169.254 (cloud metadata)", () => {
    let r = validateBaseUrl("http://169.254.169.254");
    expect(r.valid).toBe(false);
    r = validateBaseUrl("https://169.254.169.254/latest/meta-data");
    expect(r.valid).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    expect(validateBaseUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateBaseUrl("ftp://example.com").valid).toBe(false);
    expect(validateBaseUrl("gopher://example.com").valid).toBe(false);
  });

  it("rejects invalid URLs", () => {
    const result = validateBaseUrl("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  it("rejects IPv6 loopback with brackets", () => {
    const result = validateBaseUrl("http://[::1]:8080");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Forbidden hostname");
  });

  it("rejects IPv6 link-local", () => {
    expect(validateBaseUrl("http://[fe80::1]").valid).toBe(false);
    expect(validateBaseUrl("http://fe80::1").valid).toBe(false);
  });

  it("rejects IPv6 unique-local", () => {
    expect(validateBaseUrl("http://[fc00::1]").valid).toBe(false);
    expect(validateBaseUrl("http://fc00::1").valid).toBe(false);
  });

  it("rejects 0.0.0.0", () => {
    expect(validateBaseUrl("http://0.0.0.0").valid).toBe(false);
  });

  it("rejects plain IPv6 loopback without brackets", () => {
    expect(validateBaseUrl("http://::1").valid).toBe(false);
  });

  it("accepts subdomains of public hosts", () => {
    expect(validateBaseUrl("https://api.anthropic.com/v1").valid).toBe(true);
    expect(validateBaseUrl("https://generativelanguage.googleapis.com/v1beta").valid).toBe(true);
    expect(validateBaseUrl("https://api.flowbit.me").valid).toBe(true);
  });

  describe("ALLOW_TEST_LOCALHOST", () => {
    afterEach(() => {
      setAllowTestLocalhost(false);
    });

    it("rejects localhost by default", () => {
      expect(validateBaseUrl("http://localhost:11434").valid).toBe(false);
    });

    it("allows localhost when flag is set", () => {
      setAllowTestLocalhost(true);
      expect(validateBaseUrl("http://localhost:11434").valid).toBe(true);
    });

    it("allows private IPs when flag is set", () => {
      setAllowTestLocalhost(true);
      expect(validateBaseUrl("http://127.0.0.1:8080").valid).toBe(true);
      expect(validateBaseUrl("http://192.168.1.1").valid).toBe(true);
    });

    it("isTestLocalhostAllowed returns correct state", () => {
      expect(isTestLocalhostAllowed()).toBe(false);
      setAllowTestLocalhost(true);
      expect(isTestLocalhostAllowed()).toBe(true);
    });

    it("still rejects invalid URLs when flag is set", () => {
      setAllowTestLocalhost(true);
      expect(validateBaseUrl("not-a-url").valid).toBe(false);
    });

    it("still rejects unsupported schemes when flag is set", () => {
      setAllowTestLocalhost(true);
      expect(validateBaseUrl("file:///etc/passwd").valid).toBe(false);
    });
  });
});
