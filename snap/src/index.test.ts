import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import type { ChainId } from '@metamask/snaps-sdk';

const MAINNET = 'eip155:1' as ChainId;
const SEPOLIA = 'eip155:11155111' as ChainId;
const RESOLVED_ADDRESS = '0x30710e0cff3530bb6d34c5baaaf9c11267b56fc6';
const TOKEN_ID = 123n;
const GNS_CONTRACT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodeAddressResult(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function encodeStringResult(value: string): `0x${string}` {
  const bytes = new TextEncoder().encode(value);
  const data = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `0x${word(32n)}${word(BigInt(bytes.length))}${data.padEnd(
    Math.ceil(data.length / 64) * 64,
    '0',
  )}`;
}

function encodeStringArgument(value: string): string {
  return encodeStringResult(value).slice(2);
}

const encodedTokenId = `0x${word(TOKEN_ID)}`;
const encodedAddress = encodeAddressResult(RESOLVED_ADDRESS);
const encodedZeroAddress = encodeAddressResult(
  '0x0000000000000000000000000000000000000000',
);
const encodedDomain = encodeStringResult('test.gwei');
const encodedEmptyDomain = encodeStringResult('');

describe('onNameLookup', () => {
  it('resolves a .gwei name on Ethereum mainnet', async () => {
    const { mockJsonRpcOnce, onNameLookup } = await installSnap();
    mockJsonRpcOnce((request) => {
      if (request.method !== 'eth_call') {
        return undefined;
      }
      expect(request).toEqual(
        expect.objectContaining({
          method: 'eth_call',
          params: [
            {
              data: `0xfb021939${encodeStringArgument('test.gwei')}`,
              to: GNS_CONTRACT,
            },
            'latest',
          ],
        }),
      );
      return encodedTokenId;
    });
    mockJsonRpcOnce((request) => {
      if (request.method !== 'eth_call') {
        return undefined;
      }
      expect(request).toEqual(
        expect.objectContaining({
          method: 'eth_call',
          params: [
            {
              data: `0x4f896d4f${word(TOKEN_ID)}`,
              to: GNS_CONTRACT,
            },
            'latest',
          ],
        }),
      );
      return encodedAddress;
    });

    const response = await onNameLookup({
      chainId: MAINNET,
      domain: 'test.gwei',
    });

    expect(response).toRespondWith({
      resolvedAddresses: [
        {
          domainName: 'test.gwei',
          protocol: 'Gwei Name Service',
          resolvedAddress: RESOLVED_ADDRESS,
        },
      ],
    });
  });

  it('resolves a .gwei name on Sepolia', async () => {
    const { mockJsonRpcOnce, onNameLookup } = await installSnap();
    mockJsonRpcOnce({ method: 'eth_call', result: encodedTokenId });
    mockJsonRpcOnce({ method: 'eth_call', result: encodedAddress });

    const response = await onNameLookup({
      chainId: SEPOLIA,
      domain: 'test.gwei',
    });

    expect(response).toRespondWith({
      resolvedAddresses: [
        {
          domainName: 'test.gwei',
          protocol: 'Gwei Name Service',
          resolvedAddress: RESOLVED_ADDRESS,
        },
      ],
    });
  });

  it('returns null for an unregistered or expired name', async () => {
    const { mockJsonRpcOnce, onNameLookup } = await installSnap();
    mockJsonRpcOnce({ method: 'eth_call', result: encodedTokenId });
    mockJsonRpcOnce({ method: 'eth_call', result: encodedZeroAddress });

    const response = await onNameLookup({
      chainId: MAINNET,
      domain: 'missing.gwei',
    });

    expect(response).toRespondWith(null);
  });

  it('reverse-resolves a forward-confirmed primary name', async () => {
    const { mockJsonRpcOnce, onNameLookup } = await installSnap();
    mockJsonRpcOnce((request) => {
      if (request.method !== 'eth_call') {
        return undefined;
      }
      expect(request).toEqual(
        expect.objectContaining({
          method: 'eth_call',
          params: [
            {
              data: `0x9af8b7aa${RESOLVED_ADDRESS.slice(2).padStart(64, '0')}`,
              to: GNS_CONTRACT,
            },
            'latest',
          ],
        }),
      );
      return encodedDomain;
    });

    const response = await onNameLookup({
      address: RESOLVED_ADDRESS,
      chainId: MAINNET,
    });

    expect(response).toRespondWith({
      resolvedDomains: [
        {
          protocol: 'Gwei Name Service',
          resolvedDomain: 'test.gwei',
        },
      ],
    });
  });

  it('returns null when an address has no primary name', async () => {
    const { mockJsonRpcOnce, onNameLookup } = await installSnap();
    mockJsonRpcOnce({ method: 'eth_call', result: encodedEmptyDomain });

    const response = await onNameLookup({
      address: RESOLVED_ADDRESS,
      chainId: MAINNET,
    });

    expect(response).toRespondWith(null);
  });

  it('ignores domains outside the .gwei namespace', async () => {
    const { onNameLookup } = await installSnap();
    const response = await onNameLookup({
      chainId: MAINNET,
      domain: 'vitalik.eth',
    });

    expect(response).toRespondWith(null);
  });

  it('ignores unsupported chains', async () => {
    const { onNameLookup } = await installSnap();
    const response = await onNameLookup({
      chainId: 'eip155:10',
      domain: 'test.gwei',
    });

    expect(response).toRespondWith(null);
  });

  it('ignores malformed reverse-lookup addresses', async () => {
    const { onNameLookup } = await installSnap();
    const response = await onNameLookup({
      address: '0x1234',
      chainId: MAINNET,
    });

    expect(response).toRespondWith(null);
  });
});
