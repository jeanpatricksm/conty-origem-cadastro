# Origem do cadastro no app

Contrato e serviço de atribuição de origem do cadastro de criador: **campanha**, **indicação**, **comunidade** ou **orgânico**. Funciona mesmo quando o link abre num webview que não manda referrer.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3006
```

## O contrato

### 1. O que viaja no link

A Conty distribui um link curto. Ele passa pelo nosso redirecionador, que **carimba o clique no servidor** e abre o app com tudo na URL. Assim nada depende de referrer ou cookie.

| Tipo | Link que circula | O app abre com |
|---|---|---|
| Campanha | `https://conty.app/l/campaign/cmp_verao26` | `https://conty.app/open?ct_src=campaign&ct_ref=cmp_verao26&ct_click=clk_…&ct_at=2026-05-01T11%3A50%3A00.000Z` |
| Indicação | `https://conty.app/l/referral/ana` (código do criador que indicou) | `https://conty.app/open?ct_src=referral&ct_ref=ana&ct_click=clk_…&ct_at=…` |
| Comunidade | `https://conty.app/l/community/grupo-beleza` | `https://conty.app/open?ct_src=community&ct_ref=grupo-beleza&ct_click=clk_…&ct_at=…` |

- `ct_src`: canal (`campaign`, `referral` ou `community`).
- `ct_ref`: id da campanha, código de indicação ou id da comunidade.
- `ct_click`: id único do clique, gerado no servidor. É a chave de idempotência.
- `ct_at`: instante do clique, carimbado no servidor.

`https://conty.app/open` é o universal link (iOS) ou app link (Android). Sem o app instalado, ele cai na loja, e o app recebe o mesmo link pelo deferred deep link da loja ou da ferramenta de deep linking.

A posse do link não dá poder ao aparelho. Quando o `ct_click` existe na tabela `clicks`, **o canal e o instante gravados no servidor prevalecem** sobre o que veio na URL, e o toque fica `verified: true`. Um clique que o servidor não conhece (redirecionador fora do ar, link montado à mão) ainda é aceito, mas fica `verified: false` para auditoria.

### 2. O que o app grava

| Momento | Chamada |
|---|---|
| Primeira abertura (com ou sem link) | `POST /devices/:deviceId/first-open` `{ "opened_at": "...", "url": "<link com que abriu, se houver>" }` |
| Toda abertura por link | `POST /devices/:deviceId/touches` `{ "url": "..." }` |

- A **primeira abertura é gravada uma vez** por aparelho. Retry, reinstalação ou outra chamada não move a janela.
- **O mesmo clique não cria duas origens:** `(aparelho, ct_click)` é chave única. Abrir o mesmo link de novo responde `duplicate` e só incrementa `times_seen`.
- Clicar de novo no mesmo link gera um `ct_click` novo, que é outro toque. Na decisão ele aparece como `duplicate_of_winner_channel` se for do mesmo canal e ref do vencedor.

### 3. Como o cadastro consome

`POST /signups` `{ "user_id", "device_id", "signed_up_at" }` decide a origem com todos os toques do aparelho e **congela a decisão**. Repetir o cadastro devolve a mesma resposta (200). `GET /signups/:userId` mostra a decisão e os toques que chegaram depois dela, sem alterá-la.

## Qual toque vence

A regra fica num lugar só: [`src/decide.ts`](src/decide.ts), uma função pura e testada em [`test/decide.test.ts`](test/decide.test.ts).

**Janela de validade** (`ATTRIBUTION_POLICY`): o clique conta se foi entre **24h antes** e **7 dias depois da primeira abertura do app**, com os dois limites inclusos, **e até o instante do cadastro**. As 24h antes cobrem o caminho clique → loja → instalação → primeira abertura.

1. Entre os toques válidos, **vence o clique mais recente** (último toque): foi ele que trouxe o criador ao cadastro.
2. **Empate de horário:** `referral` > `campaign` > `community`. Indicação é a ação mais direta e pessoal, e costuma ter recompensa associada.
3. **Empate também no canal:** menor `ct_click`, só para o resultado ser determinístico.
4. **Sem toque válido:** `organic`, com o motivo gravado. Os motivos possíveis são: nenhum link aberto, todos fora da janela ou depois do cadastro, ou nenhuma primeira abertura registrada.

Cada toque considerado sai com `eligible`, `verdict` e `reason`:

- `winner`
- `outscored_by_later_touch`
- `lost_tie_on_priority`
- `lost_tie_on_id`
- `duplicate_of_winner_channel`
- `before_window`
- `after_window`
- `after_signup`

### Exemplo de resposta de cadastro

Neste exemplo há quatro cliques: um de campanha antiga fora da janela, o link de campanha que abriu o app e, no dia seguinte, um de indicação e um de comunidade no mesmo segundo.

```json
{
  "user_id": "usr_42",
  "device_id": "dev_1",
  "signed_up_at": "2026-05-02T10:00:00.000Z",
  "decided_at": "2026-05-02T10:00:00.000Z",
  "origin": "referral",
  "ref": "ana",
  "winning_touch_id": "clk_7b8cd730",
  "reason": "clique válido mais recente, empatado em 2026-05-02T09:00:00.000Z; venceu pela prioridade de canal referral",
  "window": {
    "opens_at": "2026-04-30T12:00:00.000Z",
    "closes_at": "2026-05-08T12:00:00.000Z"
  },
  "touches": [
    {
      "id": "clk_ca5d784e",
      "source": "campaign",
      "ref": "cmp_antiga",
      "clicked_at": "2026-04-20T09:00:00.000Z",
      "received_at": "2026-04-20T09:00:00.000Z",
      "verified": true,
      "times_seen": 1,
      "eligible": false,
      "verdict": "before_window",
      "reason": "clique antes de 2026-04-30T12:00:00.000Z (24h antes da primeira abertura)"
    },
    {
      "id": "clk_6b319dff",
      "source": "campaign",
      "ref": "cmp_verao26",
      "clicked_at": "2026-05-01T11:50:00.000Z",
      "received_at": "2026-05-01T12:00:00.000Z",
      "verified": true,
      "times_seen": 1,
      "eligible": true,
      "verdict": "outscored_by_later_touch",
      "reason": "houve clique válido mais recente (clk_7b8cd730)"
    },
    {
      "id": "clk_7b8cd730",
      "source": "referral",
      "ref": "ana",
      "clicked_at": "2026-05-02T09:00:00.000Z",
      "received_at": "2026-05-02T09:00:00.000Z",
      "verified": true,
      "times_seen": 1,
      "eligible": true,
      "verdict": "winner",
      "reason": "clique válido mais recente, empatado em 2026-05-02T09:00:00.000Z; venceu pela prioridade de canal referral"
    },
    {
      "id": "clk_de1d077e",
      "source": "community",
      "ref": "grupo-beleza",
      "clicked_at": "2026-05-02T09:00:00.000Z",
      "received_at": "2026-05-02T09:00:00.000Z",
      "verified": true,
      "times_seen": 1,
      "eligible": true,
      "verdict": "lost_tie_on_priority",
      "reason": "mesmo instante que clk_7b8cd730; referral tem prioridade sobre community"
    }
  ],
  "touches_after_decision": []
}
```

## O que ficou de fora

- **Identidade do aparelho:** `device_id` é o id que o app gera e guarda na instalação. Sem SDK de fingerprint, um clique no navegador que não chega ao app (deferred deep link falhou) se perde. É o caso que um SDK como Branch ou AppsFlyer resolve, e eu o integraria como mais uma fonte de toques no mesmo contrato.
- **Toque e cadastro em aparelhos diferentes:** a atribuição é por aparelho. Seria possível ligar os toques ao usuário após o login, mas preferi não inferir.
- **Last touch vs. first touch:** escolhi o último toque válido. Se o time quiser premiar quem trouxe primeiro (first touch), basta inverter a ordenação em `decideOrigin`, e os testes de empate continuam valendo.
- **Fraude de indicação** (o próprio criador clicar no próprio link, ou cliques em massa): fora do escopo. Os dados para detectar isso (`clicks`, `times_seen`, `verified`) já estão gravados.
- **Janela por canal:** hoje os 7 dias valem para todos. Se uma campanha precisar de janela própria, `ATTRIBUTION_POLICY` vira configuração por canal.

## Uso de IA

<!-- revise e ajuste com as suas palavras antes de enviar -->
O código, os testes e este README foram escritos com o Claude (Claude Code). Eu revisei o contrato do link, a regra de desempate, a janela a partir da primeira abertura e o formato da resposta de auditoria, e rodei `npm test` e `npm run typecheck`.
