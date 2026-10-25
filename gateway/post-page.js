// A name's posts (posts/SPEC.md) as pages under <name>.gwei.domains: one page per post and an Atom
// feed. Bodies are rendered by markdown.js, which escapes everything; the page CSP allows no scripts.

import { excerpt, renderMarkdown } from './markdown.js';
import { postPath } from './posts-format.js';
import { avatarHtml, cardImage, escapeHtml, faviconLinks, humanDate, metaTags, postCard, postCardPath, renderLayout, textOn } from './profile-page.js';

const short = (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

function onchainRows(post) {
  const rows = [];
  if (post.onchain) {
    rows.push(['Status', `On Ethereum since block <a href="https://etherscan.io/block/${post.onchain.block}">${post.onchain.block}</a>`]);
    rows.push(['Blob', `<a href="https://blobscan.com/blob/${post.onchain.blob}">${short(post.onchain.blob)}</a>`]);
    rows.push(['Transaction', `<a href="https://etherscan.io/tx/${post.onchain.tx}">${short(post.onchain.tx)}</a>`]);
  } else {
    rows.push(['Status', 'Authorized by the owner, waiting for its blob']);
  }
  rows.push(['Post hash', `<a href="https://gwei.domains/api/posts/${post.hash}">${short(post.hash)}</a>`]);
  return rows.map(([label, value]) => `<div><span>${label}</span>${value}</div>`).join('');
}

// `post` is { hash, title, body, time, onchain } as returned by the post index.
export function renderPostPage({ name, pageUrl, profile, post }) {
  const accent = profile.page?.color || null;
  const url = new URL(postPath(post.hash, post.title), pageUrl).href;
  const description = excerpt(post.body) || `A post by ${name}.`;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(url)}`;
  const body =
    `<a class="byline" href="/">${avatarHtml(profile)}<span>${escapeHtml(name)}</span></a>` +
    `<h2 class="post-title">${escapeHtml(post.title)}</h2>` +
    `<div class="post-meta"><time datetime="${new Date(post.time * 1000).toISOString().slice(0, 10)}">${humanDate(post.time)}</time></div>` +
    `<div class="post-body">${renderMarkdown(post.body)}</div>` +
    `<div class="panel">${onchainRows(post)}</div>` +
    `<div class="actions"><a class="btn"${accent ? ` style="background:${accent};border-color:${accent};color:${textOn(accent)}"` : ''} href="/">More from ${escapeHtml(name)}</a>` +
    `<a class="btn secondary" href="${escapeHtml(share)}" rel="noopener">Share</a></div>` +
    '<p class="note">Posts on .gwei names are stored in Ethereum blobs and can be published by anyone. ' +
    '<a href="https://github.com/lucadonnoh/gwei-names/blob/main/posts/SPEC.md">How it works →</a></p>';
  return renderLayout({
    title: `${post.title} · ${name}`,
    subtitle: '.gwei post',
    icon: faviconLinks(profile),
    head: `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(name)}" href="/feed.xml">` +
      metaTags({
        title: `${post.title} · ${name}`, description, url, type: 'article',
        ...cardImage(postCard(name, profile, post, pageUrl), postCardPath(post.hash), pageUrl, `${post.title}, a post by ${name}`),
      }),
    body,
  });
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Atom feed of the posts listed on the profile; `posts` carry their bodies.
export function renderFeed({ name, pageUrl, posts }) {
  const updated = posts.length ? Math.max(...posts.map((p) => p.time)) : 0;
  const entries = posts.map((p) => {
    const link = new URL(postPath(p.hash, p.title), pageUrl).href;
    return `<entry><title>${xml(p.title)}</title><link href="${xml(link)}"/><id>urn:gwei-post:${p.hash}</id>` +
      `<updated>${iso(p.time)}</updated><content type="html">${xml(renderMarkdown(p.body || ''))}</content></entry>`;
  }).join('');
  return '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
    `<title>${xml(name)}</title><link href="${xml(pageUrl)}"/><link rel="self" href="${xml(new URL('/feed.xml', pageUrl).href)}"/>` +
    `<id>${xml(pageUrl)}</id><updated>${iso(updated)}</updated><author><name>${xml(name)}</name></author>${entries}</feed>`;
}
