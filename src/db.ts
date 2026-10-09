import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
-- Cliques carimbados pelo redirecionador. Fonte de verdade do canal e do instante.
CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  clicked_at TEXT NOT NULL
);

-- Primeira abertura do app por aparelho. Gravada uma vez, nunca sobrescrita.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  first_open_at TEXT NOT NULL,
  first_open_received_at TEXT NOT NULL
);

-- Toques que o app viu. (aparelho, clique) é único: o mesmo clique não vira dois toques.
CREATE TABLE IF NOT EXISTS touches (
  device_id TEXT NOT NULL,
  click_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  clicked_at TEXT NOT NULL,
  verified INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (device_id, click_id)
);

-- Decisão congelada no cadastro, com todos os toques e o motivo de cada um.
CREATE TABLE IF NOT EXISTS signups (
  user_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  signed_up_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  ref TEXT,
  winning_click_id TEXT,
  reason TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
