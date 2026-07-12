import { dummyEnvelope, ENVELOPE_SIZE } from "./envelope";

export const BLOB_SIZE = 131_072;
export const FIELD_ELEMENTS_PER_BLOB = 4_096;
export const BYTES_PER_FIELD_ELEMENT = 32;
export const DATA_BYTES_PER_FIELD_ELEMENT = 31;
export const ENVELOPES_PER_BLOB = 62;
export const CONTENT_TAG_LABEL = "gwei.chat.envelopes.v0";
export const CONTENT_TAG = "0x0e809357534e030cdd3d5c5dcb401ebadeaf0313a04d5e8a90222d216953ceac";

export const BLOB_DATA_SIZE = FIELD_ELEMENTS_PER_BLOB * DATA_BYTES_PER_FIELD_ELEMENT;

export type BytesLike = Uint8Array | ArrayBuffer;

if (BLOB_DATA_SIZE !== ENVELOPES_PER_BLOB * ENVELOPE_SIZE) {
  throw new Error("Blob geometry does not fit an exact number of envelopes");
}

function bytes(value: BytesLike): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function validateSlots(slots: readonly BytesLike[]): void {
  if (!Array.isArray(slots) || slots.length !== ENVELOPES_PER_BLOB) {
    throw new RangeError(`A blob batch must contain exactly ${ENVELOPES_PER_BLOB} envelopes`);
  }
  for (const slot of slots) {
    if (bytes(slot).length !== ENVELOPE_SIZE) {
      throw new RangeError(`Every envelope must be exactly ${ENVELOPE_SIZE} bytes`);
    }
  }
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const range = index + 1;
    const unbiasedLimit = Math.floor(0x1_0000_0000 / range) * range;
    let sample: number;
    do {
      sample = crypto.getRandomValues(new Uint32Array(1))[0]!;
    } while (sample >= unbiasedLimit);
    const other = sample % range;
    const current = values[index]!;
    values[index] = values[other]!;
    values[other] = current;
  }
}

export function packEnvelopeSlots(slots: readonly BytesLike[]): Uint8Array {
  validateSlots(slots);
  const payload = new Uint8Array(BLOB_DATA_SIZE);
  slots.forEach((slot, index) => payload.set(bytes(slot), index * ENVELOPE_SIZE));

  const blob = new Uint8Array(BLOB_SIZE);
  for (let fieldIndex = 0; fieldIndex < FIELD_ELEMENTS_PER_BLOB; fieldIndex += 1) {
    const blobOffset = fieldIndex * BYTES_PER_FIELD_ELEMENT;
    const payloadOffset = fieldIndex * DATA_BYTES_PER_FIELD_ELEMENT;
    // The high byte remains zero so every element is below the BLS scalar field modulus.
    blob.set(
      payload.subarray(payloadOffset, payloadOffset + DATA_BYTES_PER_FIELD_ELEMENT),
      blobOffset + 1,
    );
  }
  return blob;
}

export function unpackEnvelopeSlots(blobValue: BytesLike): Uint8Array[] {
  const payload = extractBlobData(blobValue);
  return Array.from({ length: ENVELOPES_PER_BLOB }, (_, index) =>
    payload.slice(index * ENVELOPE_SIZE, (index + 1) * ENVELOPE_SIZE),
  );
}

export function extractBlobData(blobValue: BytesLike): Uint8Array {
  const blob = bytes(blobValue);
  if (blob.length !== BLOB_SIZE) {
    throw new RangeError(`A blob must be exactly ${BLOB_SIZE} bytes`);
  }

  const payload = new Uint8Array(BLOB_DATA_SIZE);
  for (let fieldIndex = 0; fieldIndex < FIELD_ELEMENTS_PER_BLOB; fieldIndex += 1) {
    const blobOffset = fieldIndex * BYTES_PER_FIELD_ELEMENT;
    if (blob[blobOffset] !== 0) {
      throw new Error(`Blob field element ${fieldIndex} has a non-zero high byte`);
    }
    payload.set(
      blob.subarray(blobOffset + 1, blobOffset + BYTES_PER_FIELD_ELEMENT),
      fieldIndex * DATA_BYTES_PER_FIELD_ELEMENT,
    );
  }

  return payload;
}

export async function createPaddedBlobBatch(
  realEnvelopes: readonly BytesLike[],
): Promise<Uint8Array> {
  if (!Array.isArray(realEnvelopes) || realEnvelopes.length > ENVELOPES_PER_BLOB) {
    throw new RangeError(`At most ${ENVELOPES_PER_BLOB} real envelopes fit in one blob`);
  }
  for (const envelope of realEnvelopes) {
    if (bytes(envelope).length !== ENVELOPE_SIZE) {
      throw new RangeError(`Every envelope must be exactly ${ENVELOPE_SIZE} bytes`);
    }
  }

  const dummyCount = ENVELOPES_PER_BLOB - realEnvelopes.length;
  const dummies = await Promise.all(
    Array.from({ length: dummyCount }, () => dummyEnvelope()),
  );
  const slots = [...realEnvelopes.map((envelope) => bytes(envelope).slice()), ...dummies];
  shuffle(slots);
  return packEnvelopeSlots(slots);
}
