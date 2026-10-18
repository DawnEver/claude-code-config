// scripts/fleet-gateway/worker.mjs — the fleet gateway as a Cloudflare Worker (docs/fleet-gateway.md).
// Static assets (public/) are served by Cloudflare itself; every /api request goes to the one
// FleetHub Durable Object, which holds the registry (each host's last push, memory only) and
// the per-client rate counts, so all requests see one state. V0.1 has no write path to any
// session. Config is the FLEET_CONFIG secret, derived from the shared bridge config by deploy.mjs.

import { DurableObject } from 'cloudflare:workers';
import { createApi, parseFleetConfig } from './api.mjs';

export class FleetHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.api = createApi(parseFleetConfig(env.FLEET_CONFIG, env.TELEGRAM_PUBLIC_KEY), { log: (m) => console.log(m) });
  }

  fetch(request) {
    return this.api(request);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.FLEET.get(env.FLEET.idFromName('fleet')).fetch(request);
  },
};
