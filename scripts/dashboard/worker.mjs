// scripts/dashboard/worker.mjs — the dashboard as a Cloudflare Worker (docs/dashboard.md).
// Static assets (public/) are served by Cloudflare itself; every /api request goes to the one
// DashboardHub Durable Object, which holds the registry (each host's last push in memory; the
// alert state in its storage) and the per-client rate counts, so all requests see one state. V0.1 has no write path to any
// session. Config is the DASHBOARD_CONFIG secret, derived from the shared bridge config by deploy.mjs;
// alerts go out as the dashboard bot (the DASHBOARD_BOT_TOKEN secret, notify.mjs).

import { DurableObject } from 'cloudflare:workers';
import { createApi, parseDashboardConfig } from './api.mjs';
import { telegramNotifier } from './notify.mjs';

export class DashboardHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const config = parseDashboardConfig(env.DASHBOARD_CONFIG, env.TELEGRAM_PUBLIC_KEY);
    const log = (m) => console.log(m);
    const send = env.DASHBOARD_BOT_TOKEN
      ? telegramNotifier({ token: env.DASHBOARD_BOT_TOKEN, chatIds: config.allowedUserIds, lang: config.alertLang, log })
      : (a) => log(`alert ${a.kind} not sent: no DASHBOARD_BOT_TOKEN (deploy.mjs deploy)`);
    // The send outlives the request that raised it.
    const notify = (a) => ctx.waitUntil(Promise.resolve(send(a)));
    this.api = createApi(config, { log, store: ctx.storage.kv, db: env.USAGE ?? null, notify });
    this.armed = false;
  }

  async fetch(request) {
    const res = await this.api(request);
    await this.#arm();
    return res;
  }

  /**
   * Wake when the next host would turn silent (Registry.sweep), never on a fixed timer: one alarm
   * per offlineAlertSeconds at most while hosts push, none once every host is alerted offline
   * (the next push re-arms it). Each wake is a Durable Object request: keep it rare.
   */
  async #arm() {
    if (this.armed) return;
    const at = this.api.registry.sweep();
    if (at === null) return;
    await this.ctx.storage.setAlarm(at);
    this.armed = true;
  }

  async alarm() {
    this.armed = false;
    await this.#arm();
  }
}

/** Cloudflare's version metadata as /api/health reports it: tag = the git commit deploy tagged it with. */
export const versionOf = (v) => (v ? { commit: v.tag || null, id: v.id, at: v.timestamp } : null);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    const res = await env.DASHBOARD.get(env.DASHBOARD.idFromName('dashboard')).fetch(request);
    // The version binding reaches the Worker, not the Durable Object: health gets it added here.
    if (url.pathname !== '/api/health' || !res.ok) return res;
    return Response.json({ ...(await res.json()), version: versionOf(env.CF_VERSION_METADATA) });
  },
};
