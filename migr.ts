import { Database } from "bun:sqlite";
import postgres from "postgres";

const sql = postgres();
const db = new Database("db.sqlite");

// Humans -> devs
console.log("Migrating devs")
const humans = db.query("SELECT * FROM humans").all();
await sql`insert into devs ${sql(humans)}`;
await sql`SELECT SETVAL('public."devs_id_seq"', COALESCE(MAX(id), 1)) FROM "devs"`;

// Bots
console.log("Migrating bots")
const bots = db.query("SELECT * FROM bots").all();
for (const b of bots) {
  b.dev_id = b.human_id;
  delete b.human_id;
}
await sql`insert into bots ${sql(bots)}`;
await sql`SELECT SETVAL('public."bots_id_seq"', COALESCE(MAX(id), 1)) FROM "bots"`;

// Default elo updates
console.log("Mkaing empty elo updates")
for (const b of bots) {
  await sql`insert into elo_updates (game_id, bot_id, change) VALUES (null, ${b.id}, 1000)`;
}

// Games
// console.log("Migrating games")
// const games = db.query("SELECT * FROM games").all();
// for (const g of games) {
//   await sql`insert into games ${sql(g)}`;
// }

// Moves
// console.log("Migrating moves")
// const moves = db.query("SELECT * FROM moves").all();
// for (const m of moves) {
//   await sql`insert into moves ${sql(m)}`;
// }

console.log("done");
