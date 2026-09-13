import { expect, test } from "bun:test";
import {
  PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES,
  PersistentRemoteDataError,
  preparePersistentRemoteToolResult,
  redactPersistentRemoteText,
  requirePersistentRemoteToolResult,
} from "../src/persistent-remote-data";

test("task and public text are explicitly allowed through the persistent boundary", () => {
  for (const dataClass of ["task", "public"] as const) {
    expect(preparePersistentRemoteToolResult({ dataClass, content: "ordinary source output" })).toMatchObject({
      decision: "allow",
      text: "ordinary source output",
      redacted: false,
      truncated: false,
    });
  }
});

test("sensitive source is blocked without echoing its contents", () => {
  const decision = preparePersistentRemoteToolResult({ dataClass: "sensitive", content: "TOP_SECRET_VALUE" });
  expect(decision).toEqual({ decision: "block", reason: "SENSITIVE_DATA_CLASS" });
  expect(JSON.stringify(decision)).not.toContain("TOP_SECRET_VALUE");
  expect(() => requirePersistentRemoteToolResult({ dataClass: "sensitive", content: "TOP_SECRET_VALUE" }))
    .toThrow(PersistentRemoteDataError);
});

test("invalid classification, non-text, and binary control characters fail closed", () => {
  expect(preparePersistentRemoteToolResult({ dataClass: "unclassified" as never, content: "private" }))
    .toEqual({ decision: "block", reason: "INVALID_DATA_CLASS" });
  expect(preparePersistentRemoteToolResult({ dataClass: "task", content: { output: "private" } }))
    .toEqual({ decision: "block", reason: "NON_TEXT_CONTENT" });
  for (const content of ["a\0b", "a\u0001b"]) {
    expect(preparePersistentRemoteToolResult({ dataClass: "task", content }))
      .toEqual({ decision: "block", reason: "NON_TEXT_CONTENT" });
  }
});

test("known credential forms are redacted before durable remote exposure", () => {
  // Assemble scanner-shaped fixtures at runtime so repository secret scanning does not mistake them for live credentials.
  const openAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const slackToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
  const awsAccessKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const source = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    `api_key=${openAiKey}`,
    `github=${githubToken}`,
    `slack=${slackToken}`,
    `aws=${awsAccessKey}`,
    "password=hunter2",
    `{"password":"json-secret","client_secret":"json-client-secret"}`,
    "OPENAI_API_KEY=custom-key-value",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "//registry.npmjs.org/:_authToken=npm-secret-value",
    "https://alice:supersecret@example.test/path",
  ].join("\n");
  const decision = preparePersistentRemoteToolResult({ dataClass: "task", content: source });
  expect(decision.decision).toBe("allow");
  if (decision.decision !== "allow") return;
  expect(decision.redacted).toBe(true);
  expect(decision.redactionCount).toBeGreaterThanOrEqual(12);
  const jsonLine = decision.text.split("\n").find(line => line.startsWith("{"));
  expect(jsonLine).toBeDefined();
  expect(JSON.parse(jsonLine!)).toEqual({ password: "[redacted]", client_secret: "[redacted]" });
  for (const secret of [
    "abcdefghijklmnopqrstuvwxyz123456",
    "dXNlcjpwYXNzd29yZA==",
    githubToken,
    slackToken,
    awsAccessKey,
    "hunter2",
    "json-secret",
    "json-client-secret",
    "custom-key-value",
    "aws-secret-value",
    "npm-secret-value",
    "alice:supersecret",
  ]) expect(decision.text).not.toContain(secret);
});

test("private key blocks are removed as one credential unit", () => {
  const input = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_BODY\n-----END OPENSSH PRIVATE KEY-----\nafter";
  const { text, redactionCount } = redactPersistentRemoteText(input);
  expect(redactionCount).toBe(1);
  expect(text).toBe("before\n[redacted-private-key]\nafter");
  expect(text).not.toContain("PRIVATE_BODY");
});

test("oversized output is redacted then bounded by UTF-8 bytes", () => {
  const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const content = `${secret}\n${"😀".repeat(PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES)}`;
  const decision = preparePersistentRemoteToolResult({ dataClass: "task", content });
  expect(decision.decision).toBe("allow");
  if (decision.decision !== "allow") return;
  expect(decision.redacted).toBe(true);
  expect(decision.truncated).toBe(true);
  expect(decision.text).not.toContain(secret);
  expect(Buffer.byteLength(decision.text, "utf8")).toBeLessThanOrEqual(PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES);
  expect(decision.text.endsWith("[persistent remote result truncated]")).toBe(true);
});

test("custom result limit remains a hard persisted-byte ceiling", () => {
  const decision = preparePersistentRemoteToolResult({ dataClass: "public", content: "x".repeat(500), maxBytes: 128 });
  expect(decision.decision).toBe("allow");
  if (decision.decision !== "allow") return;
  expect(decision.persistedBytes).toBeLessThanOrEqual(128);
  expect(() => preparePersistentRemoteToolResult({ dataClass: "public", content: "x", maxBytes: 8 })).toThrow();
  expect(() => preparePersistentRemoteToolResult({
    dataClass: "public", content: "x", maxBytes: PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES + 1,
  })).toThrow();
});
