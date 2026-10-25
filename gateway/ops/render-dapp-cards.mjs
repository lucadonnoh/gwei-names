// Draws the link-preview cards of gwei.domains and its guide (dapp/og-card.png, dapp/og-card-guide.png)
// with the same renderer as the name pages' cards, so the whole site previews alike. Run it by hand
// after changing share-card.js or the text below:  node gateway/ops/render-dapp-cards.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCard } from '../share-card.js';

const cards = {
  'og-card.png': { kind: 'site', title: 'yourname.gwei', lead: 'The ownerless and unruggable ENS alternative on Ethereum.', footer: 'gwei.domains' },
  'og-card-guide.png': { kind: 'site', title: 'Host a website on your .gwei name', lead: 'IPFS, Swarm or a contract. No servers, no DNS.', footer: 'gwei.domains/guide' },
};
for (const [file, card] of Object.entries(cards)) {
  const target = fileURLToPath(new URL(`../../dapp/${file}`, import.meta.url));
  writeFileSync(target, await renderCard(card));
  console.log(target);
}
