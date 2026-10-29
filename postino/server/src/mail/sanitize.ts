import sanitizeHtml from 'sanitize-html';

export type SanitizeResult = { html: string; hasRemoteImages: boolean };

const allowedTags = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'center', 'font', 'u', 's', 'strike', 'del', 'ins', 'small', 'big', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'h1', 'h2', 'span', 'div', 'hr', 'abbr', 'address', 'blockquote', 'pre', 'code', 'figure', 'figcaption',
  'style',
]);

const allowedAttributes: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['style', 'class', 'id', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'color', 'colspan', 'rowspan', 'nowrap', 'role', 'aria-label'],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'data-remote-src', 'data-cid'],
  font: ['face', 'size', 'color'],
  table: ['summary'],
  td: ['headers'],
  th: ['scope'],
};

const safeUrl = /^(https?:|mailto:|tel:|data:image\/(png|jpe?g|gif|webp|bmp);base64,)/i;

/**
 * Makes email HTML safe for a sandboxed iframe: strips scripts, event handlers,
 * forms, frames and dangerous URLs; rewrites cid: images to our attachment
 * endpoint; and parks remote images in data-remote-src so the client can block
 * tracking pixels until the user asks to load images.
 */
export function sanitizeEmailHtml(html: string, cidMap: Map<string, string>): SanitizeResult {
  let hasRemoteImages = false;
  const out = sanitizeHtml(html, {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    allowVulnerableTags: true, // we allow <style>, its content is CSS-only and runs inside a sandbox
    parseStyleAttributes: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'head', 'title'],
    exclusiveFilter: (frame) => frame.tag === 'style' && /expression\(|javascript:|@import|url\(/i.test(frame.text),
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        const attrs: Record<string, string> = { ...attribs };
        if (!safeUrl.test(href) || /^data:/i.test(href)) delete attrs.href;
        attrs.target = '_blank';
        attrs.rel = 'noopener noreferrer nofollow';
        return { tagName, attribs: attrs };
      },
      img: (tagName, attribs) => {
        const src = (attribs.src || '').trim();
        const attrs: Record<string, string> = { ...attribs };
        delete attrs.src;
        delete attrs['data-remote-src'];
        if (/^cid:/i.test(src)) {
          const cid = src.slice(4).replace(/^<|>$/g, '');
          const url = cidMap.get(cid) || cidMap.get(cid.toLowerCase());
          if (url) attrs.src = url;
          else attrs.alt = attrs.alt || '';
        } else if (/^https?:\/\//i.test(src)) {
          hasRemoteImages = true;
          attrs['data-remote-src'] = src;
        } else if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src)) {
          attrs.src = src;
        }
        return { tagName, attribs: attrs };
      },
    },
  });
  return { html: out, hasRemoteImages };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Turns plain text into simple HTML with clickable links and preserved line breaks. */
export function textToHtml(text: string): string {
  const linked = esc(text).replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g, (m) => `<a href="${m}">${m}</a>`);
  return `<div style="white-space:pre-wrap;word-wrap:break-word">${linked}</div>`;
}

/** Rough HTML → text used for snippets and search when there is no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&zwnj;|&zwj;|&#8203;|​|‌|‍|﻿/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
