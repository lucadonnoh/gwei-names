// A small Markdown renderer for posts. Post bodies are untrusted, so this never passes HTML through:
// every character of the input is escaped, and the only markup is what the renderer itself emits.
// Links become http(s)/mailto URLs and images https/ipfs/data:image ones, or stay plain text.
//
// Supported: headings (with anchor ids), paragraphs (a newline is a line break), **bold**, *italic*,
// ~~strike~~, `code`, fenced code blocks, > quotes, - and 1. lists, ---, [links](url) (also relative
// /paths and #anchors), ![images](url), bare https:// links, and TeX math as $…$ or $$…$$ (math.js).

import { texToMathml } from './math.js';
import { avatarUrl } from './profile-page.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MAX_QUOTE_DEPTH = 4;

export function linkUrl(value) {
  const v = (value || '').trim();
  // A held span (\u0000N\u0000) inside a destination would be expanded inside the attribute later.
  if (v.includes('\u0000')) return null;
  // Same-page anchors and paths on the name's own site, which keep working wherever a post is shown.
  if (/^#[\p{L}\p{N}_-]{1,100}$/u.test(v) || /^\/(?![/\\])[^\s"'<>]{0,2000}$/.test(v)) return v;
  if (/^mailto:[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/i.test(v)) return v;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]{46,100})(\/[^\s?#"'<>]*)?$/.exec(v);
  if (ipfs) return `https://ipfs.filebase.io/ipfs/${ipfs[1]}${ipfs[2] || ''}`;
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

// A link destination: no spaces or angle brackets, parentheses only in balanced pairs (one level).
const DEST = '(?:[^\\s()<>]|\\([^\\s()<>]*\\)){1,2000}';

// Inline markup. Code spans, links, images and backslash escapes are cut out first as placeholders,
// the rest is escaped, emphasis is applied to the escaped text, then the placeholders go back in.
function inline(text) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  // The text of a held span, for alt text: expanded as markup there it would break out of the attribute.
  const plain = (html) => html.replace(/\u0000(\d+)\u0000/g, (_, i) => plain(slots[Number(i)] ?? '')).replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[e]));
  const math = (tex, display) => hold(texToMathml(tex, display) ?? `<code>${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`);
  let s = text
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim() || code)}</code>`))
    .replace(/(?<!\\)\$\$([^$]{1,2000}?)\$\$/g, (_, tex) => math(tex, true))
    // Inline math: no space just inside the dollars and no digit after, so "$5 and $10" stays text.
    .replace(/(^|[^\\$\w])\$(?=[^\s$])([^$\n]{0,2000}?[^\s$\\])\$(?![\w$])/g, (_, lead, tex) => lead + math(tex, false))
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|$])/g, (_, c) => hold(escapeHtml(c)))
    .replace(new RegExp(`!\\[([^\\]\\n]{0,300})\\]\\(\\s*(${DEST})(?:\\s+"[^"\\n]{0,200}")?\\s*\\)`, 'g'), (_, alt, src) => {
      const text = plain(alt);
      const url = src.includes('\u0000') ? null : avatarUrl(src);
      return url ? hold(`<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer">`) : hold(escapeHtml(text));
    })
    .replace(new RegExp(`\\[([^\\]\\n]{1,500})\\]\\(\\s*(${DEST})(?:\\s+"[^"\\n]{0,200}")?\\s*\\)`, 'g'), (_, label, href) => {
      const url = linkUrl(href);
      const inner = emphasis(escapeHtml(label));
      return hold(url ? `<a href="${escapeHtml(url)}" rel="nofollow ugc noopener">${inner}</a>` : inner);
    });
  // Bare links are held too, so emphasis never reaches into a URL.
  s = escapeHtml(s).replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<\u0000.,;:!?)\]'*_~])/g, (match, lead, href) => {
    const url = linkUrl(href.replace(/&amp;/g, '&'));
    return url ? lead + hold(`<a href="${escapeHtml(url)}" rel="nofollow ugc noopener">${href}</a>`) : match;
  });
  s = emphasis(s);
  // Slots can hold slots (an image inside a link), so restore until none are left.
  for (let pass = 0; pass < 4 && s.includes('\u0000'); pass++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return s;
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([^_]*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>');
}

// Fences and headings are matched on the line with trailing whitespace already removed, and the
// heading's closing #s are stripped separately: the one-regex forms backtracked polynomially on long
// runs of spaces (a 4096-space heading line took seconds).
const FENCE_RE = /^ {0,3}(```+|~~~+)\s*([\w+-]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+([\s\S]*)$/;
const FENCE = { exec: (line) => FENCE_RE.exec(line.trimEnd()), test: (line) => FENCE_RE.test(line.trimEnd()) };
const HEADING = {
  exec(line) {
    const m = HEADING_RE.exec(line.trimEnd());
    if (!m) return null;
    const closing = /(^|\s)#+$/.exec(m[2]);
    return [m[0], m[1], (closing ? m[2].slice(0, closing.index) : m[2]).trimEnd()];
  },
  test: (line) => HEADING_RE.test(line.trimEnd()),
};
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBER = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const isBlockStart = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) ||
  QUOTE.test(line) || BULLET.test(line) || NUMBER.test(line) || line.trim() === '$$';

// GitHub/Hugo-style heading ids, so #anchors into a post keep working.
function headingId(html, used) {
  const text = html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, '');
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';
  let id = base;
  for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function blocks(lines, depth, used = new Set()) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // The post's title is the page heading, so # and ## (the usual top level in a post body) are h2.
      const level = Math.min(Math.max(heading[1].length, 2), 4);
      const html = inline(heading[2]);
      out.push(`<h${level} id="${escapeHtml(headingId(html, used))}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim() === '$$') {
      const tex = [];
      for (i++; i < lines.length && lines[i].trim() !== '$$'; i++) tex.push(lines[i]);
      i++;
      const source = tex.join('\n');
      out.push(`<p>${texToMathml(source, true) ?? `<code>${escapeHtml(`$$${source}$$`)}</code>`}</p>`);
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(lines[i].replace(QUOTE, ''));
      out.push(depth < MAX_QUOTE_DEPTH
        ? `<blockquote>${blocks(quoted, depth + 1, used)}</blockquote>`
        : `<blockquote><p>${quoted.map(inline).join('<br>')}</p></blockquote>`);
      continue;
    }
    const ordered = NUMBER.exec(line);
    if (BULLET.test(line) || ordered) {
      const pattern = ordered ? NUMBER : BULLET;
      const items = [];
      while (i < lines.length) {
        const m = pattern.exec(lines[i]);
        if (m) {
          items.push([ordered ? m[2] : m[1]]);
          i++;
        } else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !isBlockStart(lines[i])) {
          items[items.length - 1].push(lines[i].trim()); // a continuation line of the item above
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && ordered[1] !== '1' ? ` start="${Number(ordered[1])}"` : '';
      out.push(`<${tag}${start}>${items.map((item) => `<li>${item.map(inline).join('<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [];
    for (; i < lines.length && lines[i].trim() && !(paragraph.length && isBlockStart(lines[i])); i++) {
      // A trailing backslash is CommonMark's explicit line break; lines break here anyway.
      paragraph.push(lines[i].trim().replace(/(^|[^\\])\\$/, '$1').trimEnd());
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

export function renderMarkdown(text) {
  // NUL is the placeholder delimiter above; other control characters have no business in a post.
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return blocks(clean.split('\n'), 0);
}

// Plain text for previews and link cards: the body without markup, squeezed onto one line.
export function excerpt(text, max = 200) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|~~|\*|`)(?=\S)([^*~`\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w])(__|_)(?=\S)([^_\n]*?\S)\2(?!\w)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  // Cut at a word boundary: drop the last word only if the cut lands inside it.
  const cut = plain.slice(0, max - 1);
  return (/\s/.test(plain[max - 1]) ? cut : cut.replace(/\s+\S*$/, '')).trimEnd() + '…';
}
