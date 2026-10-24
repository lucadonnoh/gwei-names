// Used by test_poster.py: the versioned hash the dapp computes for a post, with the dapp's own blob
// layout check (gateway/posts-format.js, which gweiNS.test.js ties to the dapp) and vendored KZG.
//   node blobhash.mjs <post-bytes-hex>
import { encodeBlob } from '../../gateway/posts-format.js';
import { blobVersionedHash } from '../../dapp/vendor/kzg.bundle.mjs';

console.log(blobVersionedHash(encodeBlob([Uint8Array.from(Buffer.from(process.argv[2], 'hex'))])));
