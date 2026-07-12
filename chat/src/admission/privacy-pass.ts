import { Oprf } from "@cloudflare/voprf-ts";
import { CryptoNoble } from "@cloudflare/voprf-ts/crypto-noble";

// Cloudflare's package defaults to its bundled SJCL provider. The supported
// Noble provider is browser-native, validates serialized curve points, and
// avoids pulling Node compatibility shims into the frontend.
Oprf.Crypto = CryptoNoble;

const [privateVerifiable, authentication] = await Promise.all([
  import("@cloudflare/privacypass-ts/lib/src/priv_verif_token.js"),
  import("@cloudflare/privacypass-ts/lib/src/auth_scheme/private_token.js"),
]);

export const {
  Client,
  Issuer,
  Origin,
  TokenRequest,
  TokenResponse,
  VOPRF,
  keyGen,
} = privateVerifiable;

export const {
  AuthorizationHeader,
  Token,
  TokenChallenge,
} = authentication;

export type Client = import(
  "@cloudflare/privacypass-ts/lib/src/priv_verif_token.js"
).Client;
export type Issuer = import(
  "@cloudflare/privacypass-ts/lib/src/priv_verif_token.js"
).Issuer;
export type TokenRequest = import(
  "@cloudflare/privacypass-ts/lib/src/priv_verif_token.js"
).TokenRequest;
export type Token = import(
  "@cloudflare/privacypass-ts/lib/src/auth_scheme/private_token.js"
).Token;
export type TokenChallenge = import(
  "@cloudflare/privacypass-ts/lib/src/auth_scheme/private_token.js"
).TokenChallenge;
