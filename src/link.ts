// Contrato do link. Tudo o que a atribuição precisa viaja na URL, porque o
// webview do app (Instagram, TikTok...) muitas vezes não manda referrer.
//
//   https://conty.app/l/campaign/cmp_verao26      ← link que circula (curto, sem click id)
//        │  GET no nosso redirecionador: grava o clique e gera o ct_click
//        ▼
//   conty://open?ct_src=campaign&ct_ref=cmp_verao26&ct_click=clk_…&ct_at=2026-05-01T12:00:00.000Z
//        (ou https://conty.app/open?… como universal link / app link)
//
// ct_src   canal: campaign | referral | community
// ct_ref   quem: id da campanha, código de indicação do criador, id da comunidade
// ct_click id único do clique, gerado no servidor. É a chave de idempotência.
// ct_at    instante do clique, carimbado no servidor (não no relógio do aparelho)

export const SOURCES = ["campaign", "referral", "community"] as const;
export type Source = (typeof SOURCES)[number];

export type LinkParams = { source: Source; ref: string; clickId: string; clickedAt: string };

export const SHARE_BASE = "https://conty.app/l";
export const APP_OPEN_BASE = "https://conty.app/open";

const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSource(value: unknown): value is Source {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

/** Link curto que a Conty distribui. */
export function shareLink(source: Source, ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error("ref inválido");
  return `${SHARE_BASE}/${source}/${encodeURIComponent(ref)}`;
}

/** Link que o redirecionador entrega ao app, já com o clique carimbado. */
export function appOpenLink(params: LinkParams, base = APP_OPEN_BASE): string {
  const query = new URLSearchParams({
    ct_src: params.source,
    ct_ref: params.ref,
    ct_click: params.clickId,
    ct_at: params.clickedAt,
  });
  return `${base}?${query.toString()}`;
}

/** Lê os parâmetros de qualquer URL que o app recebeu. Retorna null se não for um link de origem válido. */
export function parseAppOpenLink(url: string): LinkParams | null {
  let query: URLSearchParams;
  try {
    query = new URL(url).searchParams;
  } catch {
    return null;
  }
  const source = query.get("ct_src");
  const ref = query.get("ct_ref") ?? "";
  const clickId = query.get("ct_click") ?? "";
  const clickedAt = query.get("ct_at") ?? "";
  if (!isSource(source) || !REF_PATTERN.test(ref) || !/^clk_[A-Za-z0-9-]{8,64}$/.test(clickId)) return null;
  if (Number.isNaN(Date.parse(clickedAt))) return null;
  return { source, ref, clickId, clickedAt: new Date(clickedAt).toISOString() };
}
