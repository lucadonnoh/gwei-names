/**
 * Check if a string is a .gwei name.
 */
export function isGwei(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  return value.toLowerCase().endsWith('.gwei')
}

/**
 * Check if a string is a valid Ethereum address.
 */
export function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

/**
 * Normalize a .gwei name: lowercase, trim, ensure .gwei suffix.
 * Returns the full name with .gwei suffix.
 */
export function normalizeName(name: string): string {
  let normalized = name.toLowerCase().trim()
  if (!normalized.endsWith('.gwei')) {
    normalized += '.gwei'
  }
  return normalized
}

/**
 * Extract the label from a .gwei name.
 * e.g. "alice.gwei" → "alice"
 */
export function parseLabel(name: string): string {
  const normalized = name.toLowerCase().trim()
  if (normalized.endsWith('.gwei')) {
    return normalized.slice(0, -5)
  }
  return normalized
}
