import { formatAgentResponseForSlack } from '../format-text';

describe('formatAgentResponseForSlack', () => {
  test('returns empty string for null/undefined/empty input', () => {
    expect(formatAgentResponseForSlack(undefined)).toBe('');
    expect(formatAgentResponseForSlack(null)).toBe('');
    expect(formatAgentResponseForSlack('')).toBe('');
  });

  // -------------------------------------------------------------------------
  // DON resolution to human display IDs (TKT-7, ART-1, group-default10, ...)
  // -------------------------------------------------------------------------

  test('resolves a bare ticket DON to its display id', () => {
    expect(formatAgentResponseForSlack('Updated don:core:dvrv-us-1:devo/x:ticket/42 today.')).toBe(
      'Updated TKT-42 today.'
    );
  });

  test('resolves issue / article / enhancement DONs to their prefixes', () => {
    expect(formatAgentResponseForSlack('Issue don:core:dvrv-us-1:devo/x:issue/7 reopened.')).toBe(
      'Issue ISS-7 reopened.'
    );
    expect(formatAgentResponseForSlack('See don:core:dvrv-us-1:devo/x:article/1 for steps.')).toBe(
      'See ART-1 for steps.'
    );
    expect(
      formatAgentResponseForSlack('Tracking don:core:dvrv-us-1:devo/x:enhancement/9 here.')
    ).toBe('Tracking ENH-9 here.');
  });

  test('falls back to <object-name>-<value> for object kinds without a hard-coded prefix', () => {
    expect(
      formatAgentResponseForSlack('Linked don:core:dvrv-us-1:devo/x:custom_object/abc here')
    ).toBe('Linked custom_object-abc here');
    expect(formatAgentResponseForSlack('Linked don:core:dvrv-us-1:devo/x:meeting/m42 here')).toBe(
      'Linked meeting-m42 here'
    );
  });

  test('resolves an identity DON (devu, group)', () => {
    expect(
      formatAgentResponseForSlack('Owner don:identity:dvrv-us-1:devo/x:devu/1 reviewed it.')
    ).toBe('Owner DEVU-1 reviewed it.');
    expect(
      formatAgentResponseForSlack('Group don:identity:dvrv-us-1:devo/x:group/default10 has access.')
    ).toBe('Group group-default10 has access.');
  });

  test('resolves bracketed DONs (with and without angles)', () => {
    expect(
      formatAgentResponseForSlack('See [<don:core:dvrv-us-1:devo/x:ticket/42>] for details.')
    ).toBe('See TKT-42 for details.');
    expect(
      formatAgentResponseForSlack('See [don:core:dvrv-us-1:devo/x:ticket/42] for details.')
    ).toBe('See TKT-42 for details.');
  });

  test('resolves angle-bracketed DON mention', () => {
    expect(
      formatAgentResponseForSlack('Owner <don:identity:dvrv-us-1:devo/x:devu/1> reviewed.')
    ).toBe('Owner DEVU-1 reviewed.');
  });

  // -------------------------------------------------------------------------
  // DON-targeted links — Slack can't follow `don:` URLs; flatten to label.
  // -------------------------------------------------------------------------

  test('flattens [DON-label](don:DON) → resolved display id', () => {
    const input =
      'See [don:core:dvrv-us-1:devo/x:ticket/42](don:core:dvrv-us-1:devo/x:ticket/42) for details.';
    expect(formatAgentResponseForSlack(input)).toBe('See TKT-42 for details.');
  });

  test('flattens [Human label](don:…) keeping the human label', () => {
    const input = 'See [Verified Customers](don:identity:dvrv-us-1:devo/x:group/default10).';
    expect(formatAgentResponseForSlack(input)).toBe('See Verified Customers.');
  });

  test('flattens HTML anchor whose href is a DON', () => {
    const input = 'Owner <a href="don:identity:dvrv-us-1:devo/x:devu/1">Alice</a> reviewed it.';
    expect(formatAgentResponseForSlack(input)).toBe('Owner Alice reviewed it.');
  });

  test('iteratively strips overlapping HTML tags inside an anchor label', () => {
    const input =
      '<a href="don:identity:dvrv-us-1:devo/x:devu/1">hi <scr<script>ipt>alert(1)</script></a>';
    const out = formatAgentResponseForSlack(input);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<\/?script/i);
    expect(out).toContain('hi');
  });

  // -------------------------------------------------------------------------
  // Markdown → Slack mrkdwn translation
  // -------------------------------------------------------------------------

  test('converts **bold** → *bold*', () => {
    expect(formatAgentResponseForSlack('This is **bold** text.')).toBe('This is *bold* text.');
  });

  test('converts ~~strike~~ → ~strike~', () => {
    expect(formatAgentResponseForSlack('This is ~~struck~~ text.')).toBe('This is ~struck~ text.');
  });

  test('converts heading lines to bold lines', () => {
    expect(formatAgentResponseForSlack('# Heading\nbody')).toBe('*Heading*\nbody');
    expect(formatAgentResponseForSlack('### Smaller heading\nbody')).toBe(
      '*Smaller heading*\nbody'
    );
  });

  test('converts markdown bullets to • bullets', () => {
    const input = ['Items:', '- one', '- two', '* three'].join('\n');
    expect(formatAgentResponseForSlack(input)).toBe(
      ['Items:', '• one', '• two', '• three'].join('\n')
    );
  });

  test('converts http(s) markdown links to <url|label>', () => {
    expect(formatAgentResponseForSlack('Open [the runbook](https://runbook.example.com).')).toBe(
      'Open <https://runbook.example.com|the runbook>.'
    );
  });

  test('does not corrupt single-asterisk text (italic) when converting bold', () => {
    expect(formatAgentResponseForSlack('Mix of **bold** and *italic*.')).toBe(
      'Mix of *bold* and *italic*.'
    );
  });

  // -------------------------------------------------------------------------
  // Markdown tables → bullet lines (Slack does not render tables)
  // -------------------------------------------------------------------------

  test('flattens a 2-column table into bullet lines', () => {
    const input = ['| Name | Type |', '| --- | --- |', '| Alice | Dynamic |'].join('\n');
    expect(formatAgentResponseForSlack(input)).toBe('• Name: Alice | Type: Dynamic');
  });

  test('flattens a table with a row-number column by dropping the # column', () => {
    const input = [
      '| # | Name | Description |',
      '| --- | --- | --- |',
      '| 1 | Verified Customers | Verified customers group. |',
    ].join('\n');
    expect(formatAgentResponseForSlack(input)).toBe(
      '• Name: Verified Customers | Description: Verified customers group.'
    );
  });

  test('flattens a table whose cells contain DON refs — DONs become display ids', () => {
    const input = [
      '| Name | Description |',
      '| --- | --- |',
      '| Verified Customers | Group of all verified customers. [don:identity:dvrv-us-1:devo/x:group/default10] |',
      '| Support | Group for support. [don:identity:dvrv-us-1:devo/x:group/default4] |',
    ].join('\n');
    const out = formatAgentResponseForSlack(input);
    expect(out).not.toMatch(/don:/);
    expect(out).toContain(
      '• Name: Verified Customers | Description: Group of all verified customers. group-default10'
    );
    expect(out).toContain('• Name: Support | Description: Group for support. group-default4');
  });

  // -------------------------------------------------------------------------
  // End-to-end shapes from real agent replies
  // -------------------------------------------------------------------------

  test('end-to-end: ticket details bullet list shows the display id with mrkdwn bold', () => {
    const input = [
      'Your ticket has been created successfully! Here are the details:',
      '',
      '- **Title:** Sample ticket to check the format',
      '- **Ticket ID:** [don:core:dvrv-us-1:devo/x:ticket/7](don:core:dvrv-us-1:devo/x:ticket/7)',
      '- **Owner:** C Vijay Kumar',
    ].join('\n');
    const out = formatAgentResponseForSlack(input);
    expect(out).not.toMatch(/don:/);
    expect(out).toContain('• *Ticket ID:* TKT-7');
    expect(out).toContain('• *Title:* Sample ticket to check the format');
    expect(out).toContain('• *Owner:* C Vijay Kumar');
  });

  test('end-to-end: groups table renders display ids in bullet lines', () => {
    const input = [
      '| # | Name | Description |',
      '| --- | --- | --- |',
      '| 1 | Verified Customers | Verified. [don:identity:dvrv-us-1:devo/x:group/default10] |',
    ].join('\n');
    const out = formatAgentResponseForSlack(input);
    expect(out).toContain('• Name: Verified Customers | Description: Verified. group-default10');
    expect(out).not.toMatch(/don:/);
  });
});
