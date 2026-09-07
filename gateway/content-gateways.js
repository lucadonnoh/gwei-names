// Shared retrieval policy for all storage-backed names. No site/CID overrides.
export function createGatewayPool({ fetchImpl = (...args) => fetch(...args), timeoutMs = 8000, hedgeMs = 300, cooldownMs = 30000 } = {}) {
  const unhealthyUntil = new Map();
  return function retrieve(gateways, suffix, headers = {}) {
    const now = Date.now();
    const unique = [...new Set(gateways)];
    const healthy = unique.filter(url => (unhealthyUntil.get(url) || 0) <= now);
    const candidates = healthy.length ? healthy : unique.slice().sort((a, b) => unhealthyUntil.get(a) - unhealthyUntil.get(b)).slice(0, 1);
    return new Promise(resolve => {
      let next = 0, active = 0, finished = false, hedge;
      const controllers = new Set();
      function done(response, winner) {
        if (finished) { void response?.body?.cancel().catch(() => {}); return; }
        finished = true; clearTimeout(hedge);
        for (const controller of controllers) if (controller !== winner) controller.abort();
        resolve(response);
      }
      function launch() {
        clearTimeout(hedge);
        if (finished) return;
        if (next === candidates.length) { if (!active) done(null); return; }
        const endpoint = candidates[next++], controller = new AbortController();
        controllers.add(controller); active++;
        if (next < candidates.length) hedge = setTimeout(launch, hedgeMs);
        void (async () => {
          let timer;
          try {
            const fetchPromise = Promise.resolve().then(() => fetchImpl(endpoint + suffix, { headers, redirect: 'follow', signal: controller.signal }));
            // Close a late body even if an upstream ignores cancellation.
            void fetchPromise.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
            const upstream = await Promise.race([
              fetchPromise,
              new Promise((_, reject) => {
                const abort = () => reject(new Error('Gateway request cancelled.'));
                controller.signal.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => { unhealthyUntil.set(endpoint, Date.now() + cooldownMs); controller.abort(); }, timeoutMs);
              }),
            ]);
            if (finished) { void upstream.body?.cancel().catch(() => {}); return; }
            if (upstream.ok || upstream.status === 304) {
              unhealthyUntil.delete(endpoint);
              done(upstream, controller);
            } else {
              if (upstream.status === 429 || upstream.status >= 500) unhealthyUntil.set(endpoint, Date.now() + cooldownMs);
              void upstream.body?.cancel().catch(() => {});
            }
          } catch {
            if (!finished) unhealthyUntil.set(endpoint, Date.now() + cooldownMs);
          } finally {
            clearTimeout(timer); controllers.delete(controller); active--;
            if (!finished) launch();
          }
        })();
      }
      launch();
    });
  };
}

export function configuredGateways(value, defaults) {
  if (!value) return defaults;
  const urls = JSON.parse(value);
  if (!Array.isArray(urls) || !urls.length || urls.length > 5) throw new Error('Configure one to five storage gateways.');
  return urls.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Storage gateways must be HTTPS origins.');
    return url.origin;
  });
}
