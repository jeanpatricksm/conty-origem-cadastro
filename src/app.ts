import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { isSource } from "./link.ts";
import { OriginService } from "./origins.ts";

export type AppOptions = { now?: () => Date; appOpenBase?: string };

const isIso = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
const id = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function createApp(db: DatabaseSync, options: AppOptions = {}) {
  const service = new OriginService(db, options.now ?? (() => new Date()));
  const app = new Hono();
  const body = async (req: Request) => ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  app.get("/health", (c) => c.json({ ok: true }));

  // Link curto distribuído pela Conty. Carimba o clique e redireciona para o app.
  app.get("/l/:source/:ref", (c) => {
    const source = c.req.param("source");
    const ref = c.req.param("ref");
    if (!isSource(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return c.json({ error: "link inválido" }, 404);
    const { location } = service.click(source, ref, options.appOpenBase);
    return c.redirect(location, 302);
  });

  app.post("/devices/:deviceId/first-open", async (c) => {
    const input = await body(c.req.raw);
    if (!isIso(input.opened_at)) return c.json({ error: "opened_at (ISO 8601) é obrigatório" }, 400);
    const url = typeof input.url === "string" ? input.url : null;
    return c.json(service.firstOpen(c.req.param("deviceId"), new Date(input.opened_at).toISOString(), url));
  });

  app.post("/devices/:deviceId/touches", async (c) => {
    const input = await body(c.req.raw);
    if (typeof input.url !== "string") return c.json({ error: "url é obrigatória" }, 400);
    const result = service.touch(c.req.param("deviceId"), input.url);
    return c.json(result, result.outcome === "ignored" ? 422 : 200);
  });

  app.post("/signups", async (c) => {
    const input = await body(c.req.raw);
    const userId = id(input.user_id);
    const deviceId = id(input.device_id);
    if (!userId || !deviceId || !isIso(input.signed_up_at)) {
      return c.json({ error: "user_id, device_id e signed_up_at (ISO 8601) são obrigatórios" }, 400);
    }
    const result = service.signup(userId, deviceId, new Date(input.signed_up_at).toISOString());
    return c.json(result.signup, result.created ? 201 : 200);
  });

  app.get("/signups/:userId", (c) => {
    const view = service.signupView(c.req.param("userId"));
    return view ? c.json(view) : c.json({ error: "cadastro não encontrado" }, 404);
  });

  return app;
}
