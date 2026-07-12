export interface TransportSettings {
  batcherUrl: string;
  executionRpcUrl: string;
  beaconApiUrl: string;
  onchainEnabled: boolean;
}

interface PersistedTransportSettings extends TransportSettings {
  v: 0;
}

export const DEFAULT_TRANSPORT_SETTINGS: Readonly<TransportSettings> = Object.freeze({
  batcherUrl: "/relay",
  executionRpcUrl: "https://sepolia.drpc.org",
  beaconApiUrl: "https://ethereum-sepolia-beacon-api.publicnode.com",
  onchainEnabled: true,
});

export const TRANSPORT_SETTINGS_KEY = "gwei-chat-transport-v0";

function endpoint(
  value: unknown,
  label: string,
  origin: string,
  options: { relative: boolean; query: boolean },
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const trimmed = value.trim();
  const relative = options.relative && /^\/(?!\/)/u.test(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(trimmed, origin);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  const localHost = parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for localhost)`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.hash) throw new Error(`${label} must not contain a fragment`);
  if (!options.query && parsed.search) throw new Error(`${label} must not contain a query string`);

  if (relative) {
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    return pathname || "/";
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = normalizedPath || "/";
  const normalized = parsed.toString();
  return parsed.pathname === "/" && !parsed.search ? normalized.replace(/\/$/u, "") : normalized;
}

export function normalizeTransportSettings(
  value: TransportSettings,
  origin = "https://gwei.domains/",
): TransportSettings {
  return {
    batcherUrl: endpoint(value.batcherUrl, "Batcher URL", origin, {
      relative: true,
      query: false,
    }),
    executionRpcUrl: endpoint(value.executionRpcUrl, "Execution RPC", origin, {
      relative: false,
      query: true,
    }),
    beaconApiUrl: endpoint(value.beaconApiUrl, "Beacon API", origin, {
      relative: false,
      query: false,
    }),
    onchainEnabled: Boolean(value.onchainEnabled),
  };
}

function persistedSettings(value: string | null, origin: string): TransportSettings | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedTransportSettings>;
    if (parsed.v !== 0) return null;
    return normalizeTransportSettings(
      {
        batcherUrl: String(parsed.batcherUrl ?? ""),
        executionRpcUrl: String(parsed.executionRpcUrl ?? ""),
        beaconApiUrl: String(parsed.beaconApiUrl ?? ""),
        onchainEnabled: parsed.onchainEnabled === true,
      },
      origin,
    );
  } catch {
    return null;
  }
}

export function resolveTransportSettings(options: {
  origin: string;
  search?: string;
  stored?: string | null;
  defaults?: TransportSettings;
}): TransportSettings {
  const defaults = normalizeTransportSettings(
    options.defaults ?? { ...DEFAULT_TRANSPORT_SETTINGS },
    options.origin,
  );
  const saved = persistedSettings(options.stored ?? null, options.origin) ?? defaults;
  const query = new URLSearchParams(options.search ?? "");
  const batcherUrl = query.get("batcher") ?? query.get("relay") ?? saved.batcherUrl;
  const executionRpcUrl = query.get("executionRpc") ?? saved.executionRpcUrl;
  const beaconApiUrl = query.get("beaconApi") ?? saved.beaconApiUrl;
  const mode = query.get("onchain");
  const onchainEnabled = mode === null
    ? saved.onchainEnabled
    : !["0", "false", "off"].includes(mode.toLowerCase());
  return normalizeTransportSettings(
    { batcherUrl, executionRpcUrl, beaconApiUrl, onchainEnabled },
    options.origin,
  );
}

let cachedSettings: TransportSettings | undefined;

function environmentDefaults(): TransportSettings {
  return {
    batcherUrl: import.meta.env.VITE_BATCHER_URL ||
      import.meta.env.VITE_RELAY_URL ||
      DEFAULT_TRANSPORT_SETTINGS.batcherUrl,
    executionRpcUrl: import.meta.env.VITE_EXECUTION_RPC_URL ||
      DEFAULT_TRANSPORT_SETTINGS.executionRpcUrl,
    beaconApiUrl: import.meta.env.VITE_BEACON_API_URL || DEFAULT_TRANSPORT_SETTINGS.beaconApiUrl,
    onchainEnabled: import.meta.env.VITE_ONCHAIN_ENABLED !== "0",
  };
}

export function currentTransportSettings(): TransportSettings {
  if (!cachedSettings) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(TRANSPORT_SETTINGS_KEY);
    } catch {
      // Endpoint persistence is optional; defaults and query overrides still work.
    }
    cachedSettings = resolveTransportSettings({
      origin: location.href,
      search: location.search,
      stored,
      defaults: environmentDefaults(),
    });
  }
  return { ...cachedSettings };
}

export function saveTransportSettings(value: TransportSettings): TransportSettings {
  const normalized = normalizeTransportSettings(value, location.href);
  const persisted: PersistedTransportSettings = { v: 0, ...normalized };
  localStorage.setItem(TRANSPORT_SETTINGS_KEY, JSON.stringify(persisted));
  cachedSettings = normalized;
  return { ...normalized };
}

export function restoreDefaultTransportSettings(): TransportSettings {
  localStorage.removeItem(TRANSPORT_SETTINGS_KEY);
  cachedSettings = normalizeTransportSettings(environmentDefaults(), location.href);
  return { ...cachedSettings };
}
