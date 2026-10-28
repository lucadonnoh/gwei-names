// A name's posts (posts/SPEC.md) as pages under <name>.gwei.domains: one page per post and an Atom
// feed. Bodies are rendered by markdown.js, which escapes everything; the page CSP allows no scripts
// but the theme's and REPLY_SCRIPT, by hash.

import { excerpt, renderMarkdown } from './markdown.js';
import { postPath } from './posts-format.js';
import { THEME_SCRIPT_HASH, avatarHtml, cardImage, escapeHtml, faviconLinks, humanDate, metaTags, postCard, postCardPath, renderLayout, textOn } from './profile-page.js';

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
// Replies (replies-format.js), all of them, as ethchat shows a room: each sender by the name the index
// found for it (GNS, else WNS, else ENS), else by address. Their text is shown as text, never markup.
const DAPP_REPLY = 'https://gwei.domains/#reply/';
function senderLink(r, site) {
  const label = (suffix) => r.name.slice(0, -suffix.length);
  let href;
  // A name's own host only for a plain label: anything a URL could read differently stays on gwei.domains.
  if (r.system === 'gns') href = /^[a-z0-9-]+$/.test(label('.gwei')) ? `https://${label('.gwei')}.${site}/` : `https://gwei.domains/#${encodeURIComponent(label('.gwei'))}`;
  else if (r.system === 'wns') href = `https://wei.domains/#${encodeURIComponent(label('.wei'))}`;
  else if (r.system === 'ens') href = `https://app.ens.domains/${encodeURIComponent(r.name)}`;
  if (r.name && href) return `<a href="${escapeHtml(href)}" rel="nofollow noopener">${escapeHtml(r.name)}</a>`;
  return `<a href="https://etherscan.io/address/${escapeHtml(r.from)}" rel="nofollow noopener">${escapeHtml(r.from.slice(0, 6) + '…' + r.from.slice(-4))}</a>`;
}

// The reply box. A post page is on its name's own host, where the owner's website takes over whenever
// they set one, so a wallet connected here would stay connected to whatever the owner puts here later.
// This script never touches a wallet: Reply opens gwei.domains (#reply/<hash>/<name>/<text>) in a small window,
// where the reply is sent, and that window posts back { type: 'gwei-reply', hash, tx, text } so the reply
// shows here at once. The script finds its form as the element just before it, so nothing a post's
// markup adds can stand in for it, and shows what it is told only as text.
export const REPLY_SCRIPT = "(()=>{const f=document.currentScript.previousElementSibling,h=f&&f.dataset.hash,k=f&&f.dataset.name;" +
  "if(!h||!/^0x[0-9a-f]{64}$/.test(h))return;" +
  "const t=f.querySelector('textarea'),b=f.querySelector('button'),s=f.querySelector('.reply-status'),e=new TextEncoder(),app='https://gwei.domains';" +
  "let w=null;const fit=()=>{const n=e.encode(t.value).length;b.disabled=!t.value.trim()||n>1024;" +
  "s.textContent=n>1024?'That is '+n+' bytes. A reply fits 1,024.':''};t.addEventListener('input',fit);fit();" +
  "b.addEventListener('click',()=>{const u=app+'/#reply/'+h+'/'+encodeURIComponent(k||'')+'/'+encodeURIComponent(t.value);" +
  "w=window.open(u,'gwei-reply','popup,width=520,height=760');if(!w){location.href=u;return}s.textContent='Send it from the gwei.domains window.'});" +
  "addEventListener('message',(m)=>{const d=m.data;if(m.origin!==app||!w||m.source!==w||!d||d.type!=='gwei-reply'||d.hash!==h||" +
  "typeof d.tx!=='string'||!/^0x[0-9a-f]{64}$/.test(d.tx)||typeof d.text!=='string'||e.encode(d.text).length>1024)return;" +
  "let l=f.previousElementSibling;while(l&&!l.classList.contains('replies'))l=l.previousElementSibling;if(!l)return;" +
  "const n=l.nextElementSibling;if(n&&n.classList.contains('no-replies'))n.remove();" +
  "const r=document.createElement('div'),hd=document.createElement('div'),y=document.createElement('span'),a=document.createElement('a'),x=document.createElement('div');" +
  "r.className='reply';hd.className='reply-head';y.textContent='You';a.className='reply-date';a.href='https://etherscan.io/tx/'+d.tx;a.rel='noopener';a.textContent='just now';" +
  "x.className='reply-text';x.textContent=d.text;hd.append(y,a);r.append(hd,x);l.append(r);t.value='';fit();" +
  "s.textContent='Sent. It shows here for everyone within a couple of minutes.'})})()";
export const REPLY_SCRIPT_HASH = "'sha256-j8l15sOZZqPfh4qjNO04730sXqHLeyoMPllAHmGn9mc='";
export const POST_CSP = `default-src 'none'; script-src ${THEME_SCRIPT_HASH} ${REPLY_SCRIPT_HASH}; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;

function replyForm(post, name) {
  return `<div class="reply-form" data-hash="${escapeHtml(post.hash)}" data-name="${escapeHtml(name)}">` +
    '<textarea rows="3" placeholder="Write a reply" aria-label="Your reply"></textarea>' +
    '<div class="reply-bar"><button class="btn" type="button">Reply</button><span class="reply-status" aria-live="polite"></span></div>' +
    '<p class="reply-hint">Sent from your wallet as an Ethereum transaction (1 wei plus gas). Replies are public and permanent, ' +
    'and show your .gwei, .wei or ENS name.</p></div>' +
    `<script>${REPLY_SCRIPT}</script>`;
}

function repliesHtml({ name, post, pageUrl, replies, repliesOff }) {
  if (repliesOff) return ''; // no replies section at all, as on a blog without comments
  const shown = replies?.replies || [];
  const site = new URL(pageUrl).hostname.split('.').slice(-2).join('.');
  const items = shown.map((r) => '<div class="reply"><div class="reply-head">' + senderLink(r, site) +
    `<a class="reply-date" href="https://etherscan.io/tx/${escapeHtml(r.tx)}" rel="nofollow noopener">${Number.isFinite(r.time) ? humanDate(r.time, 'short') : 'just now'}</a></div>` +
    `<div class="reply-text">${escapeHtml(r.text)}</div></div>`).join('');
  // Without scripts, the box can't open the reply window, so a plain link does.
  const total = Math.max(replies?.total ?? 0, shown.length);
  return `<div class="section">Replies${total ? ` (${total})` : ''}</div>` +
    (total > shown.length ? `<p class="note replies-note">The newest ${shown.length}.</p>` : '') +
    `<div class="replies">${items}</div>` + (items ? '' : '<p class="note replies-note no-replies">No replies yet.</p>') +
    replyForm(post, name) +
    `<div class="actions reply-link"><a class="btn secondary" href="${DAPP_REPLY}${escapeHtml(post.hash)}/${escapeHtml(encodeURIComponent(name))}">Reply</a></div>`;
}

export function renderPostPage({ name, pageUrl, profile, post, replies = null, repliesOff = false }) {
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
    repliesHtml({ name, post, pageUrl, replies, repliesOff }) +
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
