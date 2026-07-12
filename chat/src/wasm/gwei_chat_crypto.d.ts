/* tslint:disable */
/* eslint-disable */

export function createInbound(account_pickle: string, key: Uint8Array, their_identity_key: string, expected_one_time_key: string, message: string): string;

export function createOutbound(account_pickle: string, key: Uint8Array, their_identity_key: string, their_one_time_key: string, plaintext: string): string;

export function discardOneTimeKey(account_pickle: string, key: Uint8Array, one_time_key: string): string;

export function generateOneTimeKey(account_pickle: string, key: Uint8Array): string;

export function newAccount(key: Uint8Array): string;

export function sessionDecrypt(session_pickle: string, key: Uint8Array, message: string): string;

export function sessionEncrypt(session_pickle: string, key: Uint8Array, plaintext: string): string;

export function signManifest(account_pickle: string, key: Uint8Array, manifest: string): string;

export function verifyManifest(public_key: string, manifest: string, signature: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly createInbound: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly createOutbound: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly discardOneTimeKey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly generateOneTimeKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly newAccount: (a: number, b: number, c: number) => void;
    readonly sessionDecrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sessionEncrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly signManifest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly verifyManifest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
