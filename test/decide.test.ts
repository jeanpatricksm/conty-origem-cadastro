import { describe, expect, it } from "vitest";
import { decideOrigin, type Touch } from "../src/decide.ts";

const FIRST_OPEN = "2026-05-01T12:00:00.000Z";
const touch = (id: string, source: Touch["source"], ref: string, clicked_at: string): Touch => ({
  id,
  source,
  ref,
  clicked_at,
  received_at: clicked_at,
});
const verdicts = (touches: Array<{ id: string; verdict: string }>) => Object.fromEntries(touches.map((t) => [t.id, t.verdict]));

describe("qual toque vence", () => {
  it("dois links diferentes antes do cadastro: vence o clique mais recente", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-03T12:00:00.000Z",
      touches: [
        touch("clk_a", "campaign", "cmp_verao", "2026-05-01T11:00:00.000Z"),
        touch("clk_b", "referral", "ana", "2026-05-02T09:00:00.000Z"),
      ],
    });
    expect(decision).toMatchObject({ origin: "referral", ref: "ana", winning_touch_id: "clk_b" });
    expect(verdicts(decision.touches)).toEqual({ clk_a: "outscored_by_later_touch", clk_b: "winner" });
  });

  it("empate de horário: referral > campaign > community", () => {
    const at = "2026-05-02T09:00:00.000Z";
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-03T12:00:00.000Z",
      touches: [touch("clk_1", "community", "grupo", at), touch("clk_2", "campaign", "cmp", at), touch("clk_3", "referral", "ana", at)],
    });
    expect(decision.winning_touch_id).toBe("clk_3");
    expect(decision.reason).toContain("prioridade");
    expect(verdicts(decision.touches)).toEqual({ clk_1: "lost_tie_on_priority", clk_2: "lost_tie_on_priority", clk_3: "winner" });
  });

  it("empate de horário e de canal: desempate determinístico pelo id", () => {
    const at = "2026-05-02T09:00:00.000Z";
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-03T12:00:00.000Z",
      touches: [touch("clk_z", "campaign", "cmp_b", at), touch("clk_a", "campaign", "cmp_a", at)],
    });
    expect(decision).toMatchObject({ winning_touch_id: "clk_a", ref: "cmp_a" });
    expect(verdicts(decision.touches).clk_z).toBe("lost_tie_on_id");
  });

  it("clique repetido no mesmo link é marcado como repetição do vencedor", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-03T12:00:00.000Z",
      touches: [touch("clk_1", "campaign", "cmp", "2026-05-01T11:00:00.000Z"), touch("clk_2", "campaign", "cmp", "2026-05-02T11:00:00.000Z")],
    });
    expect(verdicts(decision.touches)).toEqual({ clk_1: "duplicate_of_winner_channel", clk_2: "winner" });
  });
});

describe("janela e cadastro", () => {
  it("toque depois do cadastro não vence, mesmo sendo o mais recente", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-02T12:00:00.000Z",
      touches: [touch("clk_a", "campaign", "cmp", "2026-05-01T13:00:00.000Z"), touch("clk_b", "referral", "ana", "2026-05-02T12:00:00.001Z")],
    });
    expect(decision.winning_touch_id).toBe("clk_a");
    expect(verdicts(decision.touches).clk_b).toBe("after_signup");
  });

  it("a janela vale da primeira abertura − 24h até + 7 dias, com os limites inclusos", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-20T00:00:00.000Z",
      touches: [
        touch("clk_early", "campaign", "cmp", "2026-04-30T11:59:59.999Z"),
        touch("clk_edge_open", "community", "g", "2026-04-30T12:00:00.000Z"),
        touch("clk_edge_close", "campaign", "cmp", "2026-05-08T12:00:00.000Z"),
        touch("clk_late", "referral", "ana", "2026-05-08T12:00:00.001Z"),
      ],
    });
    expect(decision.window).toEqual({ opens_at: "2026-04-30T12:00:00.000Z", closes_at: "2026-05-08T12:00:00.000Z" });
    expect(verdicts(decision.touches)).toMatchObject({
      clk_early: "before_window",
      clk_edge_open: "outscored_by_later_touch",
      clk_edge_close: "winner",
      clk_late: "after_window",
    });
  });

  it("sem toque válido: orgânico, com o motivo", () => {
    const none = decideOrigin({ firstOpenAt: FIRST_OPEN, signedUpAt: "2026-05-02T00:00:00.000Z", touches: [] });
    expect(none).toMatchObject({ origin: "organic", winning_touch_id: null });
    expect(none.reason).toMatch(/nenhum link/);

    const stale = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signedUpAt: "2026-05-02T00:00:00.000Z",
      touches: [touch("clk_old", "campaign", "cmp", "2026-04-01T00:00:00.000Z")],
    });
    expect(stale.origin).toBe("organic");
    expect(stale.reason).toMatch(/nenhum dos 1 toques/);
  });

  it("sem primeira abertura registrada: orgânico, com o motivo", () => {
    const decision = decideOrigin({
      firstOpenAt: null,
      signedUpAt: "2026-05-02T00:00:00.000Z",
      touches: [touch("clk_a", "campaign", "cmp", "2026-05-01T00:00:00.000Z")],
    });
    expect(decision.origin).toBe("organic");
    expect(decision.reason).toMatch(/primeira abertura/);
  });
});
