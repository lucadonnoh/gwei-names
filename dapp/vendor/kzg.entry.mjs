// KZG commitments for blobs, in the browser: micro-eth-signer's KZG with the fast mainnet trusted
// setup. The dapp uses it to compute a post's blob versioned hash before authorizing it.
import { KZG } from 'micro-eth-signer/kzg.js';
import { trustedSetup } from '@paulmillr/trusted-setups/fast-kzg.js';
import { sha256 } from '@noble/hashes/sha2.js';

let kzg;
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

export function blobCommitment(blob) {
  if (!ArrayBuffer.isView(blob) || blob.BYTES_PER_ELEMENT !== 1 || blob.length !== 131072) throw new Error('a blob is 131072 bytes');
  kzg ||= new KZG(trustedSetup);
  return kzg.blobToKzgCommitment('0x' + toHex(blob));
}

// EIP-4844 versioned hash: 0x01 || sha256(commitment)[1:]
export function blobVersionedHash(blob) {
  const digest = sha256(fromHex(blobCommitment(blob).slice(2)));
  digest[0] = 1;
  return '0x' + toHex(digest);
}
