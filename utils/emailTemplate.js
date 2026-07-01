import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, '../templates');

/** Escape plain text for safe insertion into HTML email bodies. */
export function escapeHtmlForEmail(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Load an email template and substitute `{{key}}` placeholders.
 * @param {string} templateName - file name under templates/, without .html
 * @param {Record<string, unknown>} data
 * @returns {Promise<string>} rendered HTML
 */
export async function renderEmailTemplate(templateName, data = {}) {
  const templatePath = join(templatesDir, `${templateName}.html`);
  const template = await readFile(templatePath, 'utf-8');
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    data[key] !== undefined ? String(data[key]) : match,
  );
}

/** Naive HTML -> plain text fallback for the email's `text` part. */
export function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
