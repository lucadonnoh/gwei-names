import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BLOB_SIZE,
  createPaddedBlobBatch,
  extractBlobData,
} from "../src/blob-batch";
import { sha256Base64Url } from "../src/encoding";
import { ENVELOPE_SIZE } from "../src/envelope";

const outputPath = resolve(process.argv[2] || "/tmp/gwei-chat.payload");
const blob = await createPaddedBlobBatch([]);
if (blob.length !== BLOB_SIZE) throw new Error("Generated blob has the wrong size");
const castEnvelopeCount = 61;
const payload = extractBlobData(blob).slice(0, castEnvelopeCount * ENVELOPE_SIZE);

await mkdir(dirname(outputPath), { recursive: true });
// Foundry's SimpleCoder reserves a full field element for its length header.
// Therefore this local ERC-8179 proof fits 61 envelopes in one cast blob. The
// application codec remains the headerless 62-envelope canonical blob.
await writeFile(outputPath, payload);
console.log(
  JSON.stringify({
    outputPath,
    castEnvelopeCount,
    payloadBytes: payload.length,
    canonicalBlobBytes: blob.length,
    canonicalBlobSha256: await sha256Base64Url(blob),
  }),
);
