import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/origens.sqlite");
const port = Number(process.env.PORT ?? 3006);

serve({ fetch: createApp(db).fetch, port }, (info) => {
  console.log(`origens em http://127.0.0.1:${info.port}`);
});
