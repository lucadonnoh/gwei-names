import {
  COMPUTE_ID_SELECTOR,
  GNS_CONTRACT,
  GNS_PROTOCOL,
  RESOLVE_SELECTOR,
  REVERSE_RESOLVE_SELECTOR,
} from './constants';

type Hex = `0x${string}`;

export type GnsAddressResolution = {
  domainName: string;
  protocol: string;
  resolvedAddress: string;
};

export type GnsDomainResolution = {
  protocol: string;
  resolvedDomain: string;
};

/**
 * Restrict forward lookups to complete .gwei names. The manifest matcher keeps
 * unrelated requests away from the Snap, and this check keeps the handler safe
 * when it is called directly.
 *
 * @param domain - Domain supplied by MetaMask.
 * @returns Whether the domain has a non-empty .gwei suffix.
 */
export function isGweiDomain(domain: string): boolean {
  const value = domain.trim();
  return value.length > 5 && value.toLowerCase().endsWith('.gwei');
}

/**
 * Check the native EVM address shape without requesting account access.
 *
 * @param address - Address supplied by MetaMask.
 * @returns Whether the address is 20 bytes of hexadecimal data.
 */
export function isEvmAddress(address: string): address is Hex {
  return /^0x[0-9a-fA-F]{40}$/u.test(address);
}

function encodeWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodeString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const data = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const paddedLength = Math.ceil(data.length / 64) * 64;
  return `${encodeWord(32n)}${encodeWord(BigInt(bytes.length))}${data.padEnd(
    paddedLength,
    '0',
  )}`;
}

function encodeAddress(address: Hex): string {
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function decodeWord(result: Hex, wordIndex = 0): bigint {
  const start = 2 + wordIndex * 64;
  const word = result.slice(start, start + 64);
  if (word.length !== 64 || !/^[0-9a-fA-F]{64}$/u.test(word)) {
    throw new Error('Invalid ABI word returned by GNS.');
  }
  return BigInt(`0x${word}`);
}

function decodeAddress(result: Hex): Hex | null {
  const word = result.slice(2, 66);
  if (word.length !== 64 || !/^[0-9a-fA-F]{64}$/u.test(word)) {
    throw new Error('Invalid address returned by GNS.');
  }
  const address = `0x${word.slice(24).toLowerCase()}` as Hex;
  return /^0x0{40}$/u.test(address) ? null : address;
}

function decodeString(result: Hex): string {
  const offset = Number(decodeWord(result));
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) {
    throw new Error('Invalid string offset returned by GNS.');
  }

  const lengthWordIndex = offset / 32;
  const length = Number(decodeWord(result, lengthWordIndex));
  if (!Number.isSafeInteger(length)) {
    throw new Error('Invalid string length returned by GNS.');
  }

  const dataStart = 2 + (lengthWordIndex + 1) * 64;
  const data = result.slice(dataStart, dataStart + length * 2);
  if (data.length !== length * 2 || !/^[0-9a-fA-F]*$/u.test(data)) {
    throw new Error('Truncated string returned by GNS.');
  }

  const bytes = new Uint8Array(
    data.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function ethCall(data: Hex): Promise<Hex> {
  const result = await ethereum.request<string>({
    method: 'eth_call',
    params: [{ data, to: GNS_CONTRACT }, 'latest'],
  });

  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/u.test(result)) {
    throw new Error('Ethereum provider returned invalid call data.');
  }
  return result as Hex;
}

/**
 * Use MetaMask's provider on the exact chain named by the lookup request.
 *
 * @param chainId - Requested EVM chain as a hexadecimal chain ID.
 */
export async function configureProvider(chainId: Hex): Promise<void> {
  await ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId }],
  });
}

/**
 * Resolve a .gwei name through the immutable GNS NameNFT contract.
 *
 * @param domain - Complete .gwei name.
 * @returns MetaMask's forward-resolution record, or null when not found.
 */
export async function resolveDomain(
  domain: string,
): Promise<GnsAddressResolution | null> {
  if (!isGweiDomain(domain)) {
    return null;
  }

  const domainName = domain.trim();
  const tokenId = decodeWord(
    await ethCall(`${COMPUTE_ID_SELECTOR}${encodeString(domainName)}` as Hex),
  );
  const resolvedAddress = decodeAddress(
    await ethCall(`${RESOLVE_SELECTOR}${encodeWord(tokenId)}` as Hex),
  );

  if (!resolvedAddress) {
    return null;
  }

  return {
    domainName,
    protocol: GNS_PROTOCOL,
    resolvedAddress,
  };
}

/**
 * Reverse-resolve an address to its forward-confirmed primary .gwei name.
 *
 * @param address - EVM address supplied by MetaMask.
 * @returns MetaMask's reverse-resolution record, or null when not found.
 */
export async function resolveAddress(
  address: string,
): Promise<GnsDomainResolution | null> {
  if (!isEvmAddress(address)) {
    return null;
  }

  const resolvedDomain = decodeString(
    await ethCall(
      `${REVERSE_RESOLVE_SELECTOR}${encodeAddress(address)}` as Hex,
    ),
  );

  if (!isGweiDomain(resolvedDomain)) {
    return null;
  }

  return {
    protocol: GNS_PROTOCOL,
    resolvedDomain,
  };
}
