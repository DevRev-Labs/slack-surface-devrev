/**
 * Slack form-body parsing helpers used by the interactivity handler.
 *
 * Slack delivers slash commands and Block-Kit interactivity as
 * `application/x-www-form-urlencoded`. The DevRev gateway forwards those
 * bodies in unpredictable shapes — sometimes already-parsed objects, sometimes
 * raw strings, sometimes empty objects with the bytes only in `body_raw`
 * (base64). The handler normalizes any of these into one canonical
 * JS object before signature verification + dispatch.
 *
 * These helpers are pure (no side effects, no I/O) so they're trivially
 * testable in isolation.
 */

/**
 * Parse `application/x-www-form-urlencoded` into a plain object.
 *
 * Implementation notes:
 *  - Hand-rolled rather than `URLSearchParams` because the gateway
 *    occasionally hands us malformed pairs (a bare key with no `=`); we
 *    surface those as keys with empty-string values rather than throwing.
 *  - `decodeURIComponent` is wrapped in try/catch so a single broken pair
 *    doesn't kill the entire parse.
 *  - Slack treats `+` as a space; we normalize before decoding to match.
 */
export function parseFormUrlEncoded(input: string): Record<string, string> {
  // Use a Map first to preserve correctness if the same key appears twice
  // (last-write-wins, matching URLSearchParams semantics).
  const out: Record<string, string> = {};
  for (const segment of input.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    const rawKey = eq >= 0 ? segment.slice(0, eq) : segment;
    const rawValue = eq >= 0 ? segment.slice(eq + 1) : '';
    try {
      const decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      const decodedValue = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      out[decodedKey] = decodedValue;
    } catch {
      // Malformed percent-encoding — keep the raw bytes so a downstream
      // consumer can still decide what to do.
      out[rawKey] = rawValue;
    }
  }
  return out;
}

/**
 * Does this object look like a parsed Slack interactivity body?
 *
 * Slack always populates at least one of these discriminator fields:
 *  - `command` (slash command)
 *  - `type`    (Block-Kit / view interactivity)
 *  - `payload` (legacy form-encoded interactivity wrapper)
 *
 * If none are present we know we have to fall back to parsing `body_raw`.
 */
export function bodyHasUsefulKey(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b['type'] === 'string' || typeof b['command'] === 'string' || typeof b['payload'] === 'string';
}

/**
 * Decode a base64 `body_raw` blob back into a UTF-8 string. Returns null on
 * invalid base64 — caller can then log + skip without throwing.
 */
export function decodeBase64BodyRaw(bodyRaw: string): string | null {
  try {
    return Buffer.from(bodyRaw, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Promote a `payload=…` form field whose value is URL-encoded JSON to a
 * top-level body. Returns the parsed object on success, or null if the field
 * is absent / not parseable. Does NOT throw — caller decides whether the
 * presence of the field was strictly required.
 */
export function tryPromotePayloadField(body: unknown): unknown | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b['payload'] !== 'string') return null;
  try {
    return JSON.parse(b['payload'] as string);
  } catch {
    return null;
  }
}
