// A decisão de origem mora só aqui. Função pura: recebe a primeira abertura,
// o cadastro e os toques, e devolve o vencedor e o veredito de cada toque.

import type { Source } from "./link.ts";

export const ATTRIBUTION_POLICY = {
  /** A origem vale por 7 dias a partir da primeira abertura do app. */
  windowAfterFirstOpenMs: 7 * 24 * 60 * 60 * 1000,
  /** Cliques antes da primeira abertura contam se foram até 24h antes (clique → loja → instalação). */
  lookbackBeforeFirstOpenMs: 24 * 60 * 60 * 1000,
  /** Desempate quando dois toques têm o mesmo instante: o menor índice vence. */
  sourcePriority: ["referral", "campaign", "community"] as Source[],
} as const;

export type Touch = { id: string; source: Source; ref: string; clicked_at: string; received_at: string };

export type Verdict =
  | "winner"
  | "outscored_by_later_touch"
  | "lost_tie_on_priority"
  | "lost_tie_on_id"
  | "duplicate_of_winner_channel"
  | "before_window"
  | "after_window"
  | "after_signup";

export type TouchVerdict = Touch & { eligible: boolean; verdict: Verdict; reason: string };

export type Decision = {
  origin: Source | "organic";
  ref: string | null;
  winning_touch_id: string | null;
  reason: string;
  window: { opens_at: string; closes_at: string } | null;
  touches: TouchVerdict[];
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Regra (último toque válido vence):
 * 1. Só contam toques com clique dentro da janela [primeira abertura − 24h, primeira abertura + 7d]
 *    e até o instante do cadastro.
 * 2. Entre os válidos, vence o clique mais recente: é o que levou ao cadastro.
 * 3. Empate de instante: referral > campaign > community.
 * 4. Empate também no canal: menor id do clique, só para ser determinístico.
 * 5. Nenhum válido, ou nenhuma primeira abertura registrada: orgânico, com o motivo.
 */
export function decideOrigin(input: { firstOpenAt: string | null; signedUpAt: string; touches: Touch[] }): Decision {
  const signup = Date.parse(input.signedUpAt);

  if (!input.firstOpenAt) {
    return {
      origin: "organic",
      ref: null,
      winning_touch_id: null,
      reason: "o app não registrou a primeira abertura deste aparelho; sem janela não há toque válido",
      window: null,
      touches: input.touches.map((touch) => ({
        ...touch,
        eligible: false,
        verdict: "before_window",
        reason: "sem primeira abertura registrada",
      })),
    };
  }

  const firstOpen = Date.parse(input.firstOpenAt);
  const opens = firstOpen - ATTRIBUTION_POLICY.lookbackBeforeFirstOpenMs;
  const closes = firstOpen + ATTRIBUTION_POLICY.windowAfterFirstOpenMs;
  const window = { opens_at: iso(opens), closes_at: iso(closes) };

  const judged: TouchVerdict[] = input.touches.map((touch) => {
    const at = Date.parse(touch.clicked_at);
    if (at > signup) return { ...touch, eligible: false, verdict: "after_signup", reason: `clique em ${touch.clicked_at}, depois do cadastro em ${input.signedUpAt}` };
    if (at < opens) return { ...touch, eligible: false, verdict: "before_window", reason: `clique antes de ${window.opens_at} (24h antes da primeira abertura)` };
    if (at > closes) return { ...touch, eligible: false, verdict: "after_window", reason: `clique depois de ${window.closes_at} (7 dias após a primeira abertura)` };
    return { ...touch, eligible: true, verdict: "winner", reason: "" };
  });

  const priority = (source: Source) => ATTRIBUTION_POLICY.sourcePriority.indexOf(source);
  const eligible = judged
    .filter((touch) => touch.eligible)
    .sort(
      (a, b) =>
        Date.parse(b.clicked_at) - Date.parse(a.clicked_at) ||
        priority(a.source) - priority(b.source) ||
        a.id.localeCompare(b.id),
    );
  const winner = eligible[0];

  for (const touch of eligible) {
    if (touch === winner) {
      const tied = eligible.filter((other) => other !== touch && other.clicked_at === touch.clicked_at);
      touch.reason = tied.length
        ? `clique válido mais recente, empatado em ${touch.clicked_at}; venceu pela prioridade de canal ${touch.source}`
        : "clique válido mais recente antes do cadastro";
      continue;
    }
    const sameChannel = touch.source === winner!.source && touch.ref === winner!.ref;
    if (touch.clicked_at !== winner!.clicked_at) {
      touch.verdict = sameChannel ? "duplicate_of_winner_channel" : "outscored_by_later_touch";
      touch.reason = sameChannel
        ? `clique repetido no mesmo link (${touch.source}/${touch.ref}); o mais recente já conta`
        : `houve clique válido mais recente (${winner!.id})`;
    } else if (priority(touch.source) !== priority(winner!.source)) {
      touch.verdict = "lost_tie_on_priority";
      touch.reason = `mesmo instante que ${winner!.id}; ${winner!.source} tem prioridade sobre ${touch.source}`;
    } else {
      touch.verdict = sameChannel ? "duplicate_of_winner_channel" : "lost_tie_on_id";
      touch.reason = sameChannel
        ? `clique repetido no mesmo link e no mesmo instante que ${winner!.id}`
        : `mesmo instante e mesmo canal que ${winner!.id}; desempate determinístico pelo id`;
    }
    touch.eligible = true;
  }

  if (!winner) {
    const reason = input.touches.length
      ? `nenhum dos ${input.touches.length} toques estava na janela ${window.opens_at} → ${window.closes_at} e antes do cadastro`
      : "nenhum link de origem foi aberto neste aparelho antes do cadastro";
    return { origin: "organic", ref: null, winning_touch_id: null, reason, window, touches: judged };
  }

  return {
    origin: winner.source,
    ref: winner.ref,
    winning_touch_id: winner.id,
    reason: winner.reason,
    window,
    touches: judged,
  };
}
