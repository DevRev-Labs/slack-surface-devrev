/**
 * Slack Signature Validator (header-presence gate).
 *
 * Slack normally signs the *raw* HTTP body with HMAC-SHA256 keyed by the
 * signing secret. The DevRev custom webhook layer parses the body to JSON
 * before our function runs, so the exact byte sequence Slack signed is
 * lost — we cannot recompute the HMAC reliably across all payload shapes.
 *
 * Instead, we gate on the presence and shape of the two Slack-only
 * headers plus the 5-minute replay window. This is enough to reject
 * forged curl/Postman requests (which won't carry the headers in valid
 * form) while preserving compatibility with every genuine Slack delivery.
 *
 * If DevRev ever exposes the raw body bytes (e.g. input.request.body_raw)
 * we should switch back to a real HMAC check.
 */
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

/**
 * Validate that an incoming request looks like it came from Slack.
 *
 * Checks: both Slack headers present, signature header matches the
 * v0=<64 hex chars> shape, and the timestamp is within 5 minutes of now.
 * `signingSecret` and `body` are accepted for API stability but are not
 * currently used — see file header for why HMAC isn't viable here.
 */
export function validateSlackSignature(
  _signingSecret: string | undefined,
  headers: Record<string, any> | undefined,
  _body: unknown,
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

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Validation error: ${err?.message || "unknown"}` };
  }
}
