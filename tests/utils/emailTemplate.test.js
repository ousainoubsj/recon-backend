import { escapeHtmlForEmail, renderEmailTemplate, htmlToText } from '../../utils/emailTemplate.js';

describe('escapeHtmlForEmail', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtmlForEmail(`<script>alert("hi")</script> & 'stuff'`)).toBe(
      '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; \'stuff\'',
    );
  });

  it('returns an empty string for null/undefined', () => {
    expect(escapeHtmlForEmail(null)).toBe('');
    expect(escapeHtmlForEmail(undefined)).toBe('');
  });
});

describe('renderEmailTemplate', () => {
  it('substitutes known placeholders from the real email-invitation template', async () => {
    const html = await renderEmailTemplate('email-invitation', {
      organizationName: 'Acme Corp',
      inviterEmail: 'admin@acme.com',
      role: 'analyst',
      acceptLink: 'https://app.example.com/accept-invite/abc123',
      expiresFormatted: 'Jul 3, 2026',
    });

    expect(html).toContain('Acme Corp');
    expect(html).toContain('admin@acme.com');
    expect(html).toContain('analyst');
    expect(html).toContain('https://app.example.com/accept-invite/abc123');
    expect(html).toContain('Jul 3, 2026');
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it('leaves unknown placeholders untouched', async () => {
    const html = await renderEmailTemplate('email-report', {
      fileAName: 'a.csv',
      // fileBName, matchedCount, totalRows, runDateFormatted intentionally omitted
    });

    expect(html).toContain('a.csv');
    expect(html).toContain('{{fileBName}}');
  });

  it('rejects when the template file does not exist', async () => {
    await expect(renderEmailTemplate('does-not-exist', {})).rejects.toThrow();
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes basic entities', () => {
    const html = '<div><h2>Hello &amp; welcome</h2><p>Line one</p> <p>Line   two</p></div>';
    expect(htmlToText(html)).toBe('Hello & welcomeLine one Line two');
  });
});
