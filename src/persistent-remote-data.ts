const DEFAULT_MAX_BYTES = 32 * 1024;
const TRUNCATION_SUFFIX = "\n[persistent remote result truncated]";

export const PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES = DEFAULT_MAX_BYTES;

export type PersistentRemoteDataClass = "task" | "public" | "sensitive";
export type PersistentRemoteBlockReason = "INVALID_DATA_CLASS" | "SENSITIVE_DATA_CLASS" | "NON_TEXT_CONTENT";

export type PersistentRemoteDataDecision =
  | {
      decision: "allow";
      text: string;
      redacted: boolean;
      redactionCount: number;
      truncated: boolean;
      originalBytes: number;
      persistedBytes: number;
    }
  | {
      decision: "block";
      reason: PersistentRemoteBlockReason;
    };

export class PersistentRemoteDataError extends Error {
  constructor(public readonly code: PersistentRemoteBlockReason) {
    super(`Persistent remote data blocked: ${code}`);
    this.name = "PersistentRemoteDataError";
  }
}

function replaceCounted(
  value: string,
  pattern: RegExp,
  replacement: string | ((...args: string[]) => string),
): { value: string; count: number } {
  let count = 0;
  const next = value.replace(pattern, (...args: unknown[]) => {
    count += 1;
    if (typeof replacement === "string") return replacement;
    return replacement(...args.map(arg => String(arg)));
  });
  return { value: next, count };
}

export function redactPersistentRemoteText(value: string): { text: string; redactionCount: number } {
  let text = value;
  let redactionCount = 0;
  const rules: Array<[RegExp, string | ((...args: string[]) => string)]> = [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
    [/(\bAuthorization["']?\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;}\r\n]+/gi, (_whole, prefix) => `${prefix}[redacted]`],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, "Bearer [redacted]"],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]"],
    [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,})\b/g, "[redacted-access-token]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-aws-access-key]"],
    [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[redacted-api-key]"],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, (_whole, scheme) => `${scheme}[redacted-credentials]@`],
    [/((?:["']?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,
      (_whole, prefix, rawValue) => {
        const quote = rawValue[0];
        return quote === '"' || quote === "'"
          ? `${prefix}${quote}[redacted]${quote}`
          : `${prefix}[redacted]`;
      }],
  ];
  for (const [pattern, replacement] of rules) {
    const result = replaceCounted(text, pattern, replacement);
    text = result.value;
    redactionCount += result.count;
  }
  return { text, redactionCount };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

export function preparePersistentRemoteToolResult(input: {
  dataClass: PersistentRemoteDataClass;
  content: unknown;
  maxBytes?: number;
}): PersistentRemoteDataDecision {
  if (input.dataClass !== "task" && input.dataClass !== "public" && input.dataClass !== "sensitive") {
    return { decision: "block", reason: "INVALID_DATA_CLASS" };
  }
  if (input.dataClass === "sensitive") return { decision: "block", reason: "SENSITIVE_DATA_CLASS" };
  if (typeof input.content !== "string"
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(input.content)) {
    return { decision: "block", reason: "NON_TEXT_CONTENT" };
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes)
    || maxBytes <= utf8Bytes(TRUNCATION_SUFFIX)
    || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error(`Persistent remote data maxBytes must be within the hard ${DEFAULT_MAX_BYTES}-byte ceiling`);
  }
  const originalBytes = utf8Bytes(input.content);
  const redacted = redactPersistentRemoteText(input.content);
  let text = redacted.text;
  let truncated = false;
  if (utf8Bytes(text) > maxBytes) {
    const bodyBudget = maxBytes - utf8Bytes(TRUNCATION_SUFFIX);
    text = `${truncateUtf8(text, bodyBudget)}${TRUNCATION_SUFFIX}`;
    truncated = true;
  }
  return {
    decision: "allow",
    text,
    redacted: redacted.redactionCount > 0,
    redactionCount: redacted.redactionCount,
    truncated,
    originalBytes,
    persistedBytes: utf8Bytes(text),
  };
}

export function requirePersistentRemoteToolResult(input: {
  dataClass: PersistentRemoteDataClass;
  content: unknown;
  maxBytes?: number;
}): string {
  const decision = preparePersistentRemoteToolResult(input);
  if (decision.decision === "block") throw new PersistentRemoteDataError(decision.reason);
  return decision.text;
}
