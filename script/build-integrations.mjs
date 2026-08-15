#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'dapp', 'integrations.json');
const HTML_PATH = path.join(ROOT, 'dapp', 'gweiNS.html');
const LOGO_DIR = path.join(ROOT, 'dapp', 'integration-logos');
const START = '    <!-- BEGIN GENERATED INTEGRATIONS -->';
const END = '    <!-- END GENERATED INTEGRATIONS -->';
const CATEGORIES = new Set([
  'community',
  'defi',
  'developer',
  'name management',
  'wallet',
  'web access'
]);
const LINK_LABELS = new Set([
  'Chrome Web Store',
  'Download',
  'GitHub',
  'npm',
  'Website'
]);

function fail(message) {
  throw new Error(`integrations: ${message}`);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function validateDescription(description, name) {
  const tags = description.match(/<[^>]+>/g) || [];
  if (tags.some((tag) => tag !== '<code>' && tag !== '</code>')) {
    fail(`${name} description may only use <code> markup`);
  }
  if ((description.match(/<code>/g) || []).length !== (description.match(/<\/code>/g) || []).length) {
    fail(`${name} description has unbalanced <code> markup`);
  }
}

function logoMarkup(filename, name) {
  if (path.basename(filename) !== filename) fail(`${name} logo must be a filename`);
  const logoPath = path.join(LOGO_DIR, filename);
  if (!fs.existsSync(logoPath)) fail(`${name} logo does not exist: ${filename}`);

  if (filename.endsWith('.svg')) {
    const svg = fs.readFileSync(logoPath, 'utf8').trim();
    if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) fail(`${name} logo is not an SVG`);
    if (/<script|\son\w+=/i.test(svg)) fail(`${name} logo contains executable markup`);
    return svg;
  }

  if (filename.endsWith('.png')) {
    const encoded = fs.readFileSync(logoPath).toString('base64');
    return `<img src="data:image/png;base64,${encoded}" alt="" width="18" height="18">`;
  }

  fail(`${name} logo must be an .svg or .png file`);
}

function validateIntegration(integration, index, names) {
  const prefix = `entry ${index + 1}`;
  if (!integration || typeof integration !== 'object' || Array.isArray(integration)) fail(`${prefix} must be an object`);
  const { name, category, description, logo, links } = integration;
  for (const [field, value] of Object.entries({ name, category, description, logo })) {
    if (typeof value !== 'string' || !value.trim()) fail(`${prefix} needs a non-empty ${field}`);
  }
  if (names.has(name)) fail(`duplicate name: ${name}`);
  names.add(name);
  if (!CATEGORIES.has(category)) fail(`${name} has unknown category: ${category}`);
  validateDescription(description, name);
  if (!Array.isArray(links) || links.length === 0) fail(`${name} needs at least one link`);
  for (const link of links) {
    if (!link || typeof link !== 'object' || Array.isArray(link)) fail(`${name} has an invalid link`);
    if (!LINK_LABELS.has(link.label)) fail(`${name} has unknown link label: ${link.label}`);
    let url;
    try {
      url = new URL(link.url);
    } catch {
      fail(`${name} has an invalid ${link.label} URL`);
    }
    if (url.protocol !== 'https:') fail(`${name} ${link.label} URL must use HTTPS`);
  }
}

function renderCard(integration) {
  const { name, category, description, logo, links } = integration;
  const renderedLinks = links
    .map(({ label, url }) => `        <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`)
    .join('\n');
  return `    <div class="int-card">
      <div class="int-head">
        <span class="int-logo" aria-hidden="true">${logoMarkup(logo, name)}</span>
        <span class="int-name">${escapeHtml(name)}</span>
        <span class="int-tag">${escapeHtml(category)}</span>
      </div>
      <p class="int-desc">${description}</p>
      <div class="int-links">
${renderedLinks}
      </div>
    </div>`;
}

function build() {
  const integrations = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!Array.isArray(integrations)) fail('integrations.json must contain an array');
  const names = new Set();
  integrations.forEach((integration, index) => validateIntegration(integration, index, names));

  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) fail('generated markers are missing or out of order');

  const generated = integrations.map(renderCard).join('\n');
  return html.slice(0, start + START.length) + `\n${generated}\n` + html.slice(end);
}

const next = build();
const current = fs.readFileSync(HTML_PATH, 'utf8');
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('dapp/gweiNS.html is stale; run node script/build-integrations.mjs');
    process.exitCode = 1;
  }
} else if (next !== current) {
  fs.writeFileSync(HTML_PATH, next);
  console.log('dapp/gweiNS.html: integration cards regenerated');
} else {
  console.log('dapp/gweiNS.html: integration cards already current');
}
