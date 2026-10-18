// scripts/dashboard/worker.mjs — the dashboard as a Cloudflare Worker (docs/dashboard.md).
// Static assets (public/) are served by Cloudflare itself; every /api request goes to the one
// DashboardHub Durable Object, which holds the registry (each host's last push in memory; the
// events and alert state in its storage) and the per-client rate counts, so all requests see one state. V0.1 has no write path to any
// session. Config is the DASHBOARD_CONFIG secret, derived from the shared bridge config by deploy.mjs.

import { DurableObject } from 'cloudflare:workers';
import { createApi, parseDashboardConfig } from './api.mjs';

export class DashboardHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.api = createApi(parseDashboardConfig(env.DASHBOARD_CONFIG, env.TELEGRAM_PUBLIC_KEY), { log: (m) => console.log(m), store: ctx.storage.kv });
  }

  fetch(request) {
    return this.api(request);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.DASHBOARD.get(env.DASHBOARD.idFromName('dashboard')).fetch(request);
  },
};
