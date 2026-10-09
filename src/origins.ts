import type { DatabaseSync } from "node:sqlite";
import { type Decision, decideOrigin, type Touch } from "./decide.ts";
import { appOpenLink, type LinkParams, parseAppOpenLink, type Source } from "./link.ts";

type TouchRow = {
  click_id: string;
  source: Source;
  ref: string;
  clicked_at: string;
  verified: number;
  received_at: string;
  times_seen: number;
};

export type TouchResult = { outcome: "recorded" | "duplicate" | "ignored"; reason?: string; click_id?: string };

export class OriginService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  /** Redirecionador: carimba o clique no servidor e devolve o link de abertura do app. */
  click(source: Source, ref: string, appBase?: string): { click_id: string; location: string } {
    const params: LinkParams = { source, ref, clickId: `clk_${crypto.randomUUID()}`, clickedAt: this.now().toISOString() };
    this.db
      .prepare("INSERT INTO clicks (id, source, ref, clicked_at) VALUES (?, ?, ?, ?)")
      .run(params.clickId, source, ref, params.clickedAt);
    return { click_id: params.clickId, location: appOpenLink(params, appBase) };
  }

  /**
   * O app chama na primeira abertura. Só a primeira chamada por aparelho grava o instante;
   * reinstalação ou retry não move a janela. Se o app abriu por um link, o toque vem junto.
   */
  firstOpen(deviceId: string, openedAt: string, url: string | null): { first_open_at: string; touch: TouchResult | null } {
    this.db
      .prepare("INSERT OR IGNORE INTO devices (id, first_open_at, first_open_received_at) VALUES (?, ?, ?)")
      .run(deviceId, openedAt, this.now().toISOString());
    const device = this.db.prepare("SELECT first_open_at FROM devices WHERE id = ?").get(deviceId) as { first_open_at: string };
    return { first_open_at: device.first_open_at, touch: url ? this.touch(deviceId, url) : null };
  }

  /** O app chama toda vez que abre por um link. */
  touch(deviceId: string, url: string): TouchResult {
    const parsed = parseAppOpenLink(url);
    if (!parsed) return { outcome: "ignored", reason: "o link não tem os parâmetros de origem válidos" };

    // O clique gravado no redirecionador manda: canal e instante não vêm do aparelho.
    const known = this.db.prepare("SELECT source, ref, clicked_at FROM clicks WHERE id = ?").get(parsed.clickId) as
      | { source: Source; ref: string; clicked_at: string }
      | undefined;
    const touch = known ?? { source: parsed.source, ref: parsed.ref, clicked_at: parsed.clickedAt };

    const existing = this.db
      .prepare("SELECT 1 FROM touches WHERE device_id = ? AND click_id = ?")
      .get(deviceId, parsed.clickId);
    if (existing) {
      this.db
        .prepare("UPDATE touches SET times_seen = times_seen + 1 WHERE device_id = ? AND click_id = ?")
        .run(deviceId, parsed.clickId);
      return { outcome: "duplicate", click_id: parsed.clickId };
    }
    this.db
      .prepare(
        "INSERT INTO touches (device_id, click_id, source, ref, clicked_at, verified, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(deviceId, parsed.clickId, touch.source, touch.ref, touch.clicked_at, known ? 1 : 0, this.now().toISOString());
    return { outcome: "recorded", click_id: parsed.clickId };
  }

  /** O cadastro consome os toques do aparelho e congela a decisão. Repetir o cadastro devolve a mesma. */
  signup(userId: string, deviceId: string, signedUpAt: string) {
    const existing = this.signupView(userId);
    if (existing) return { created: false, signup: existing };

    const device = this.db.prepare("SELECT first_open_at FROM devices WHERE id = ?").get(deviceId) as
      | { first_open_at: string }
      | undefined;
    const touches = this.touchesOf(deviceId).map(
      (row): Touch & { verified: boolean; times_seen: number } => ({
        id: row.click_id,
        source: row.source,
        ref: row.ref,
        clicked_at: row.clicked_at,
        received_at: row.received_at,
        verified: row.verified === 1,
        times_seen: row.times_seen,
      }),
    );
    const decision = decideOrigin({ firstOpenAt: device?.first_open_at ?? null, signedUpAt, touches });
    this.db
      .prepare(
        "INSERT INTO signups (user_id, device_id, signed_up_at, origin, ref, winning_click_id, reason, decision_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        userId,
        deviceId,
        signedUpAt,
        decision.origin,
        decision.ref,
        decision.winning_touch_id,
        decision.reason,
        JSON.stringify(decision),
        this.now().toISOString(),
      );
    return { created: true, signup: this.signupView(userId)! };
  }

  signupView(userId: string) {
    const row = this.db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as
      | { user_id: string; device_id: string; signed_up_at: string; decision_json: string; decided_at: string }
      | undefined;
    if (!row) return null;
    const decision = JSON.parse(row.decision_json) as Decision;
    const considered = new Set(decision.touches.map((touch) => touch.id));
    // Toques que chegaram depois do cadastro aparecem para auditoria, mas a decisão não muda.
    const later = this.touchesOf(row.device_id)
      .filter((touch) => !considered.has(touch.click_id))
      .map((touch) => ({
        id: touch.click_id,
        source: touch.source,
        ref: touch.ref,
        clicked_at: touch.clicked_at,
        received_at: touch.received_at,
        eligible: false,
        verdict: "after_signup" as const,
        reason: "chegou depois do cadastro; a origem já estava decidida",
      }));
    return {
      user_id: row.user_id,
      device_id: row.device_id,
      signed_up_at: row.signed_up_at,
      decided_at: row.decided_at,
      ...decision,
      touches_after_decision: later,
    };
  }

  private touchesOf(deviceId: string): TouchRow[] {
    return this.db
      .prepare("SELECT * FROM touches WHERE device_id = ? ORDER BY clicked_at, click_id")
      .all(deviceId) as TouchRow[];
  }
}
