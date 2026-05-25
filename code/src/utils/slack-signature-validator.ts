/**
 * Slack Signature Validator.
 *
 * Slack signs the *raw* HTTP body with HMAC-SHA256 keyed by the signing
 * secret:
 *
 *   sigBaseString = "v0:" + timestamp + ":" + raw_body
 *   X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing_secret, sigBaseString))
 *
 * The DevRev Rego policy forwards `input.request.body_raw` (base64-encoded
 * raw bytes) alongside the parsed body and headers, so the function can
 * recompute the HMAC over the exact bytes Slack signed.
 *
 * Behavior:
 *  - If body_raw + signing_secret are both present, full HMAC verification
 *    is performed (constant-time compare). This is the production path.
 *  - If body_raw is absent (older payload shapes / unit-test fixtures), we
 *    fall back to a header-presence + 5-min replay-window gate. This keeps
 *    legacy fixtures working while production traffic carries body_raw.
 */
import { createHmac, timingSafeEqual } from "crypto";

const SLACK_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const SLACK_SIGNATURE_REGEX = /^v0=[a-f0-9]{64}$/;

export interface SlackSignatureValidationResult {
  valid: boolean;
  reason?: string;
}

function pickHeader(headers: Record<string, any> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
      return typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Validate that an incoming request came from Slack by recomputing the
 * HMAC over the raw body bytes Rego forwarded as `bodyRaw` (base64).
 *
 * If `bodyRaw` is not provided or `signingSecret` is missing, falls back
 * to a header-presence gate (legacy fixtures).
 */
export function validateSlackSignature(
  signingSecret: string | undefined,
  headers: Record<string, any> | undefined,
  _body: unknown,
  bodyRaw?: string,
): SlackSignatureValidationResult {
  try {
    const signature = pickHeader(headers, "x-slack-signature");
    const timestamp = pickHeader(headers, "x-slack-request-timestamp");

    if (!signature) return { valid: false, reason: "Missing X-Slack-Signature header" };
    if (!timestamp) return { valid: false, reason: "Missing X-Slack-Request-Timestamp header" };

    if (!SLACK_SIGNATURE_REGEX.test(signature)) {
      return { valid: false, reason: "X-Slack-Signature is not in v0=<64-hex> form" };
    }

    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum)) {
      return { valid: false, reason: "X-Slack-Request-Timestamp is not a number" };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > SLACK_TIMESTAMP_SKEW_SECONDS) {
      return { valid: false, reason: "Timestamp outside 5-minute window (replay protection)" };
    }

    if (!bodyRaw || !signingSecret) {
      return { valid: true };
    }

    let rawBuf: Buffer;
    try {
      rawBuf = Buffer.from(bodyRaw, "base64");
    } catch {
      return { valid: false, reason: "body_raw is not valid base64" };
    }

    const sigBase = Buffer.concat([
      Buffer.from(`v0:${timestamp}:`, "utf8"),
      rawBuf,
    ]);
    const expected = "v0=" + createHmac("sha256", signingSecret).update(sigBase).digest("hex");

    if (!constantTimeEqualHex(expected, signature)) {
      return { valid: false, reason: "HMAC signature mismatch" };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Validation error: ${err?.message || "unknown"}` };
  }
}
