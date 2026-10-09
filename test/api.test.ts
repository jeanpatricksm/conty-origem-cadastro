import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { appOpenLink, parseAppOpenLink, shareLink } from "../src/link.ts";

let now: Date;
let app: ReturnType<typeof createApp>;

type Signup = {
  origin: string;
  ref: string | null;
  reason: string;
  winning_touch_id: string | null;
  touches: Array<{ id: string; verdict: string; reason: string; times_seen: number; verified: boolean }>;
  touches_after_decision: Array<{ id: string; verdict: string }>;
};

beforeEach(() => {
  now = new Date("2026-05-01T12:00:00.000Z");
  app = createApp(openDatabase(), { now: () => now });
});

const at = (iso: string) => {
  now = new Date(iso);
};

/** Abre o link curto e devolve a URL com que o app abriria. */
async function click(path: string): Promise<string> {
  const res = await app.request(path, { redirect: "manual" });
  expect(res.status).toBe(302);
  return res.headers.get("location")!;
}

async function post<T>(path: string, body: unknown) {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

describe("contrato do link", () => {
  it("exemplos de link de campanha e de indicação", async () => {
    expect(shareLink("campaign", "cmp_verao26")).toBe("https://conty.app/l/campaign/cmp_verao26");
    expect(shareLink("referral", "ana")).toBe("https://conty.app/l/referral/ana");

    at("2026-05-01T11:00:00.000Z");
    const location = await click("/l/referral/ana");
    expect(location).toMatch(/^https:\/\/conty\.app\/open\?ct_src=referral&ct_ref=ana&ct_click=clk_[\w-]+&ct_at=2026-05-01T11%3A00%3A00.000Z$/);
    expect(parseAppOpenLink(location)).toMatchObject({ source: "referral", ref: "ana", clickedAt: "2026-05-01T11:00:00.000Z" });
  });

  it("link sem os parâmetros de origem é ignorado com motivo", async () => {
    const res = await post<{ outcome: string }>("/devices/dev_1/touches", { url: "https://conty.app/open?utm_source=x" });
    expect(res.status).toBe(422);
    expect(res.body.outcome).toBe("ignored");
  });
});

describe("fluxo completo", () => {
  it("clique → primeira abertura com o link → cadastro atribuído e auditável", async () => {
    at("2026-05-01T11:50:00.000Z");
    const url = await click("/l/campaign/cmp_verao26");
    at("2026-05-01T12:00:00.000Z");
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z", url });
    at("2026-05-01T12:10:00.000Z");
    const res = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T12:10:00.000Z" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ origin: "campaign", ref: "cmp_verao26" });
    expect(res.body.touches[0]).toMatchObject({ verdict: "winner", verified: true });
  });

  it("o mesmo clique aberto várias vezes não cria duas origens", async () => {
    const url = await click("/l/campaign/cmp_verao26");
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z", url });
    expect((await post<{ outcome: string }>("/devices/dev_1/touches", { url })).body.outcome).toBe("duplicate");
    expect((await post<{ outcome: string }>("/devices/dev_1/touches", { url })).body.outcome).toBe("duplicate");
    const { body } = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T13:00:00.000Z" });
    expect(body.touches).toHaveLength(1);
    expect(body.touches[0]?.times_seen).toBe(3);
  });

  it("dois links antes do cadastro: a resposta mostra os dois e por que cada um venceu ou não", async () => {
    const campaign = await click("/l/campaign/cmp_verao26");
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z", url: campaign });
    at("2026-05-02T09:00:00.000Z");
    await post("/devices/dev_1/touches", { url: await click("/l/referral/ana") });
    const { body } = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-02T10:00:00.000Z" });
    expect(body).toMatchObject({ origin: "referral", ref: "ana" });
    expect(body.touches.map((t) => t.verdict).sort()).toEqual(["outscored_by_later_touch", "winner"]);
    expect(body.touches.every((t) => t.reason.length > 0)).toBe(true);
  });

  it("primeira abertura não é sobrescrita: reinstalar não move a janela", async () => {
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z" });
    const again = await post<{ first_open_at: string }>("/devices/dev_1/first-open", { opened_at: "2026-05-20T12:00:00.000Z" });
    expect(again.body.first_open_at).toBe("2026-05-01T12:00:00.000Z");
  });

  it("link aberto depois do cadastro não conta e não muda a origem já gravada", async () => {
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z" });
    const first = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T12:30:00.000Z" });
    expect(first.body.origin).toBe("organic");
    expect(first.body.reason).toMatch(/nenhum link/);

    at("2026-05-01T13:00:00.000Z");
    await post("/devices/dev_1/touches", { url: await click("/l/referral/ana") });
    const again = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T12:30:00.000Z" });
    expect(again.status).toBe(200);
    expect(again.body.origin).toBe("organic");
    const view = (await (await app.request("/signups/usr_1")).json()) as Signup;
    expect(view.touches_after_decision).toEqual([expect.objectContaining({ verdict: "after_signup" })]);
  });

  it("canal e instante vêm do clique gravado no servidor, não do que o aparelho mandou", async () => {
    at("2026-04-01T00:00:00.000Z"); // clique antigo, fora da janela
    const real = await click("/l/community/grupo");
    const forged = real.replace(/ct_at=[^&]+/, "ct_at=2026-05-01T11%3A00%3A00.000Z").replace("ct_src=community", "ct_src=referral");
    at("2026-05-01T12:00:00.000Z");
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z", url: forged });
    const { body } = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T12:10:00.000Z" });
    expect(body.origin).toBe("organic");
    expect(body.touches[0]).toMatchObject({ verdict: "before_window", verified: true });
  });

  it("toque sem clique conhecido no servidor ainda conta, marcado como não verificado", async () => {
    const url = appOpenLink({ source: "campaign", ref: "cmp_x", clickId: "clk_offline-0001", clickedAt: "2026-05-01T11:00:00.000Z" });
    await post("/devices/dev_1/first-open", { opened_at: "2026-05-01T12:00:00.000Z", url });
    const { body } = await post<Signup>("/signups", { user_id: "usr_1", device_id: "dev_1", signed_up_at: "2026-05-01T12:10:00.000Z" });
    expect(body.origin).toBe("campaign");
    expect(body.touches[0]?.verified).toBe(false);
  });
});
