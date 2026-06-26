// Gwei Name Service is currently deployed on Sepolia only; pass a custom contract+rpc via config for other networks.
export const GNS_CONTRACT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6' as const

/** Namehash of the `.gwei` TLD node. */
export const GWEI_NODE = '0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f' as const

export const BASE_PORTAL = '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e' as const

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/** Registration period: 365 days in seconds. */
export const REGISTRATION_PERIOD = 365n * 24n * 60n * 60n

/** Grace period: 90 days in seconds. */
export const GRACE_PERIOD = 90n * 24n * 60n * 60n

/** Maximum subdomain depth. */
export const MAX_SUBDOMAIN_DEPTH = 5

/** Minimum commitment age in seconds before reveal. */
export const MIN_COMMITMENT_AGE = 60

/** Maximum commitment age in seconds before expiry. */
export const MAX_COMMITMENT_AGE = 86400

/** Default registration fee in wei. */
export const DEFAULT_FEE = 500000000000000n // 0.0005 ETH

/**
 * Compute the registration fee (in wei) for a label of the given byte length,
 * following the tiered schedule. Byte length is what the contract uses.
 */
export function getFee(length: number): bigint {
  switch (length) {
    case 1:
      return 500000000000000000n // 0.5 ETH
    case 2:
      return 100000000000000000n // 0.1 ETH
    case 3:
      return 50000000000000000n // 0.05 ETH
    case 4:
      return 10000000000000000n // 0.01 ETH
    default:
      return 500000000000000n // 0.0005 ETH (5+ chars)
  }
}
