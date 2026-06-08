/**
 * Outbound text formatting for Slack.
 *
 * Slack renders messages as `mrkdwn`, not standard markdown — it uses a
 * different syntax for bold (`*x*` instead of `**x**`), strikethrough
 * (`~x~`), and links (`<url|label>`), and it does NOT render markdown
 * tables. The agent emits standard markdown plus DevRev DON identifiers,
 * so we translate the response in three passes:
 *
 *   1. DevRev DON identifiers are resolved to their human-readable display
 *      id form (TKT-7, ISS-3, ART-1, group-default10, DEVU-1, ...). The
 *      DON is a routing token; the display id is what the user recognises.
 *
 *   2. Markdown links / HTML anchors whose href IS a DON are flattened to
 *      plain text — Slack cannot dereference a `don:` URL. We keep the
 *      visible label (resolved to its display id when the label is itself
 *      a DON).
 *
 *   3. Markdown tables — which Slack will not render — are flattened into
 *      `key: value` bullet lines per row, then standard markdown is
 *      rewritten into Slack mrkdwn.
 *
 * The DevRev timeline mirror bypasses this formatter so DONs round-trip
 * natively inside DevRev.
 *
 * The prefix table mirrors the parent Slack snap-in's `Prefix` enum at
 * slack/code/src/functions/shared/devrev_helpers/objects.ts so display ids
 * match across surfaces.
 */

const OBJECT_NAME_TO_PREFIX: Record<string, string> = {
  account: 'ACC',

  article: 'ART',

  capability: 'CAPL',

  // Other core objects
  conversation: 'CONV',

  devo: 'DEVO',

  // Identity
  devu: 'DEVU',

  enhancement: 'ENH',

  feature: 'FEAT',

  group: 'group',

  incident: 'INC',

  issue: 'ISS',

  linkable: 'LNKB',

  opportunity: 'OPP',

  // Parts
  product: 'PROD',

  revo: 'REVO',

  revu: 'REVU',

  runnable: 'RUNN',

  svcacc: 'SVCACC',

  sysu: 'SYSU',
  // Works
  ticket: 'TKT',
};

// Object-name segments may include underscores (e.g. `custom_object`), so
// allow `_` in the name part. The final value can be any alphanumeric or `_`.
const DON_RAW = String.raw`don:[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*\/[a-zA-Z0-9_]+)+`;
const DON_REGEX = new RegExp(DON_RAW, 'gi');

const MD_LINK_TO_DON = new RegExp(String.raw`!?\[([^\]]+)\]\(\s*<?(${DON_RAW})>?\s*\)`, 'gi');
const HTML_ANCHOR_TO_DON = new RegExp(
  String.raw`<a\b[^>]*href\s*=\s*(?:"|')(${DON_RAW})(?:"|')[^>]*>([\s\S]*?)<\/a>`,
  'gi'
);

/**
 * Convert a single DON id like `don:core:dvrv-us-1:devo/x:ticket/42` into
 * its display id form (`TKT-42`).
 *
 * Falls back to `<object-name>-<value>` for any DON whose object kind we
 * don't have a hard-coded prefix for (custom object types, newer DevRev
 * objects). The display id never fails — every well-formed DON renders as
 * *something* readable, so the user always sees an identifier rather than
 * a blank cell.
 *
 * Returns `undefined` only when the DON is malformed (no `<name>/<value>`
 * tail).
 */
function donToDisplayId(donId: string): string | undefined {
  const parts = donId.split(':');
  const last = parts[parts.length - 1];
  if (!last || !last.includes('/')) return undefined;
  const [objectName, value] = last.split('/');
  if (!objectName || !value) return undefined;
  const prefix = OBJECT_NAME_TO_PREFIX[objectName.toLowerCase()] ?? objectName;
  return `${prefix}-${value}`;
}

/**
 * Resolve a DON link's *label* to plain text. If the label is itself a DON
 * (the AI agent often emits `[don:…:ticket/42](don:…:ticket/42)`), render
 * the display id; otherwise leave the human-written label alone.
 */
function resolveLinkLabel(rawLabel: string): string {
  const cleaned = stripInlineHtml(rawLabel).trim();
  const donMatch = cleaned.match(new RegExp(String.raw`^<?(${DON_RAW})>?$`, 'i'));
  if (donMatch) {
    const resolved = donToDisplayId(donMatch[1]);
    if (resolved) return resolved;
  }
  return cleaned;
}

/**
 * Format an AI agent response for Slack:
 *   - Resolve DONs to display ids
 *   - Flatten DON-targeted links/anchors to their (resolved) label
 *   - Convert markdown tables to bullet lines (Slack can't render tables)
 *   - Translate standard markdown into Slack mrkdwn
 */
export function formatAgentResponseForSlack(text: string | undefined | null): string {
  if (!text) return '';
  let body = text;

  // 1. DON-targeted markdown link → resolved label as plain text.
  body = body.replace(MD_LINK_TO_DON, (_match, label: string) => resolveLinkLabel(label));

  // 2. DON-targeted HTML anchor → resolved label as plain text.
  body = body.replace(HTML_ANCHOR_TO_DON, (_match, _href: string, label: string) => resolveLinkLabel(label));

  // 3. Bracketed-with-angles `[<don:…>]` → display id.
  body = body.replace(new RegExp(String.raw`\[<(${DON_RAW})>\]`, 'gi'), (_match, donId: string) => {
    return donToDisplayId(donId) ?? '';
  });

  // 4. Bracketed `[don:…]` → display id.
  body = body.replace(new RegExp(String.raw`\[(${DON_RAW})\]`, 'gi'), (_match, donId: string) => {
    return donToDisplayId(donId) ?? '';
  });

  // 5. Angle-bracketed `<don:…>` → display id.
  body = body.replace(new RegExp(String.raw`<(${DON_RAW})>`, 'gi'), (_match, donId: string) => {
    return donToDisplayId(donId) ?? '';
  });

  // 6. Bare DON → display id.
  body = body.replace(DON_REGEX, (donId: string) => donToDisplayId(donId) ?? '');

  // 7. Markdown tables don't render in Slack — flatten to bullet lines.
  body = convertTableToText(body);

  // 8. Markdown → Slack mrkdwn.
  body = toSlackMarkdown(body);

  // Tidy whitespace artifacts left behind by any DONs that resolved to an
  // empty string. Don't touch newlines, list markers, or bold characters.
  body = body.replace(/\(\s*\)/g, '');
  body = body.replace(/\[\s*\]/g, '');
  body = body.replace(/[ \t]+([.,;:!?])/g, '$1');
  body = body.replace(/[ \t]{2,}/g, ' ');
  body = body.replace(/[ \t]+\n/g, '\n');
  body = body.trim();

  return body;
}

/**
 * Translate standard markdown into Slack `mrkdwn`:
 *   - `**bold**` → `*bold*`
 *   - `~~strike~~` → `~strike~`
 *   - `# Heading` → `*Heading*`
 *   - `- bullet` / `* bullet` → `• bullet`
 *   - `[label](url)` → `<url|label>`
 *
 * Bold conversion runs before single-asterisk italic stays unchanged: we
 * only collapse `**…**`, never single-star runs, so existing italics/
 * bullets aren't corrupted.
 */
function toSlackMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
}

/**
 * Convert a markdown table block into one bullet per row:
 *   `• Name: Alice | Type: Dynamic`
 *
 * Columns whose header is `#`, `No`, `No.`, or `Index` are dropped (they're
 * just row numbers). Empty cells and `-` placeholders are skipped. A
 * heuristic: a separator row of `---|---` flips us into table-mode and the
 * preceding row supplies the headers.
 */
function convertTableToText(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let headers: string[] = [];
  let inTable = false;
  let pendingHeaderIdx: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed.startsWith('|')) {
      if (pendingHeaderIdx !== null) {
        // Previous candidate header wasn't actually a table — keep it as-is.
        result.push(lines[pendingHeaderIdx]);
        pendingHeaderIdx = null;
      }
      inTable = false;
      headers = [];
      result.push(line);
      continue;
    }

    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    // Separator row (`---|---`) → confirm we're in a table; the previously
    // buffered row becomes the header.
    if (cells.every((c) => /^[-:]+$/.test(c))) {
      if (pendingHeaderIdx !== null) {
        headers = lines[pendingHeaderIdx]
          .trim()
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        pendingHeaderIdx = null;
      }
      inTable = true;
      continue;
    }

    if (!inTable) {
      // Could be a header row — buffer it. If the next line is a separator,
      // we'll consume it as headers; otherwise we'll flush it back as text.
      if (pendingHeaderIdx !== null) {
        result.push(lines[pendingHeaderIdx]);
      }
      pendingHeaderIdx = i;
      continue;
    }

    // Body row of a confirmed table.
    if (headers.length > 0) {
      const parts = cells
        .map((cell, idx) => {
          const header = headers[idx] || '';
          if (/^#$|^no\.?$|^index$/i.test(header)) return null;
          if (!cell || cell === '-') return null;
          return header ? `${header}: ${cell}` : cell;
        })
        .filter(Boolean);
      result.push(`• ${parts.join(' | ')}`);
    } else {
      result.push(`• ${cells.join(' | ')}`);
    }
  }

  if (pendingHeaderIdx !== null) {
    result.push(lines[pendingHeaderIdx]);
  }

  return result.join('\n');
}

/**
 * Iteratively strip HTML tags. A single-pass `replace(/<[^>]+>/g, '')` is
 * defeated by overlapping inputs like `<scr<script>ipt>` — after one pass
 * the inner match is removed and the outer halves rejoin into a fresh tag.
 * Loop until the output stabilises (bounded by length so termination is
 * guaranteed: each pass either removes characters or fixes the value).
 */
function stripInlineHtml(value: string): string {
  let prev: string;
  let next = value;
  do {
    prev = next;
    next = prev.replace(/<[^<>]*>/g, '');
  } while (next !== prev);
  return next;
}
