import { Hono } from "hono";
import { logger } from 'hono/logger';
import { serveStatic } from "hono/serve-static.bun";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { startGame } from "./matchmaker";
import { Chess } from "chess.js";

import { Database } from "bun:sqlite";
const db = new Database("db.sqlite");

db.query('PRAGMA foreign_keys = ON;').run();

db.query(`
  CREATE TABLE IF NOT EXISTS humans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    uploaded TEXT NOT NULL,
    hash TEXT,
    human_id INTEGER NOT NULL,
    FOREIGN KEY(human_id) REFERENCES humans(id) ON DELETE CASCADE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    bid INTEGER NOT NULL,
    wid INTEGER NOT NULL,
    started TEXT,
    ended TEXT,
    winner VARCHAR(1),
    initial_time_ms NUMBER NOT NULL,
    reason TEXT,
    FOREIGN KEY(wid) REFERENCES bots(id) ON DELETE CASCADE,
    FOREIGN KEY(bid) REFERENCES bots(id) ON DELETE CASCADE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS moves (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL,
    move TEXT NOT NULL,
    ms_since_game_start NUMBER NOT NULL,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
  );
`).run();

async function compile(code: string) {
  const dir = "../simplified"; // TODO - every execution should have its own dir.

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(code);
  const hash = hasher.digest("base64url");

  // 1) Save the code to be compiled.
  await Bun.write(`${dir}/MyBot.cs`, code);

  // Clean up old compiled files.
  const rm = Bun.spawn(["rm", "-rf", `${dir}/obj`, `${dir}/bin`]);
  await rm.exited;

  // Run the compiler.
  const proc = Bun.spawn(["dotnet", "publish", "-c", "Release"], { cwd: dir });
  await proc.exited;

  if (proc.exitCode !== 0) {
    // TODO - is stderr needed?
    const stdout = await new Response(proc.stdout).text();
    return { ok: false, msg: stdout };
  }

  await Bun.write(
    Bun.file(`compiled/${hash}.dll`),
    Bun.file(`${dir}/bin/Release/net7.0/Chess-Challenge.dll`),
  );

  return { ok: true, msg: "", hash };
}

function addHumanIfNotExists(name: string, email: string): number {
  try {
    return db
      .query('INSERT INTO humans (name, email) VALUES (?1, ?2) RETURNING ID')
      .get([name, email]).id;
  } catch (err) {
    return db
      .query('SELECT id FROM humans WHERE email = ?1')
      .get([email]).id;
  }
}

async function addBotToLeague(code: string, name: string, humanId: number): Promise<{ ok: bool, msg: string }> {
  const res = await compile(code);
  if (!res.ok) {
    return { ok: false, msg: res.msg };
  }

  // TODO should we make names or hashes unique?
  db.query(`
    INSERT INTO bots (name, code, uploaded, hash, human_id)
    VALUES ($name, $code, $uploaded, $hash, $human_id)
  `).run({
    $name: name,
    $code: code,
    $uploaded: new Date().toISOString(),
    $hash: res.hash,
    $human_id: humanId
  });

  return { ok: true, msg: "" };
}

async function prepareDLLs(hash1: string, hash2: string): Promise<string> {
  // TODO this will not work if the same bots fight at the same time.
  const dir = `${tmpdir()}/fight-${hash1}-${hash2}`;
  await mkdir(dir, { recursive: true });

  // Copy the actual dlls.
  await Bun.write(Bun.file(`${dir}/${hash1}.dll`), Bun.file(`compiled/${hash1}.dll`));
  await Bun.write(Bun.file(`${dir}/${hash2}.dll`), Bun.file(`compiled/${hash2}.dll`));

  // Copy the runtimeconfig file that dotnet DEMANDS for some reason.
  await Bun.write(Bun.file(`${dir}/${hash1}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));
  await Bun.write(Bun.file(`${dir}/${hash2}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));

  return dir;
}

const app = new Hono();

app.use("/favicon.ico", serveStatic({ path: "./public/favicon.ico" }));
app.use("/", serveStatic({ path: "./public/index.html" }));
app.use("/public/*", serveStatic({ root: "./" }));
app.use('*', logger());

app.post("/api/upload/", async (c) => {
  const body = await c.req.parseBody();

  console.log(body)

  // Browser formdata comes as a string, but curl -Fcode=@file comes as a blob
  let code: string;
  if (body.code instanceof Blob) {
    code = await body.code.text();
  } else if (typeof (body.code) === "string") {
    code = body.code;
  } else {
    return c.text('Missing code', 400);
  }

  if (typeof body.botname !== 'string') return c.text('Missing botname', 400);
  if (typeof body.humanname !== 'string') return c.text('Missing humanname', 400);
  if (typeof body.email !== 'string') return c.text('Missing email', 400);

  const humanId = addHumanIfNotExists(body.humanname, body.email);
  const { ok, msg } = await addBotToLeague(code, body.botname, humanId);

  // Is this abusing http status codes? Oh well...
  return c.text(msg, ok ? 200 : 400);
});

app.post("/fight/:wid/:bid/", async (c) => {
  const { wid, bid } = c.req.param();
  const query = db.query("SELECT hash FROM bots WHERE id=?1");
  const whash = query.get(wid)?.hash;
  const bhash = query.get(bid)?.hash;

  if (!whash || !bhash) return c.text('', 400);

  const dir = await prepareDLLs(whash, bhash);

  const gameId = db
    .query("INSERT INTO games (wid, bid, initial_time_ms) VALUES ($wid, $bid, 1000) RETURNING id")
    .get({ $wid: wid, $bid: bid }).id;

  startGame(db, gameId, dir, whash, bhash);

  return c.text('', 200);
});

app.get("/api/bots/", async c => {
  const bots = db.query("SELECT id, name, uploaded FROM bots").all();
  // console.log(bots);
  return c.json(bots);
});

app.get("/api/old-games/", async c => {
  const games = db.query(`
    SELECT games.id, wid, bid, w.name as wname, b.name as bname, started, ended, winner
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    WHERE winner IS NOT NULL
    ORDER BY games.id DESC
    LIMIT 50
  `).all();
  return c.json(games);
});

app.get("/api/live-games/", async c => {
  const games = db.query(`
    SELECT games.id, wid, bid, w.name as wname, b.name as bname, started, ended, winner
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    WHERE winner IS NULL
    ORDER BY games.id DESC
    LIMIT 50
  `).all();

  // Simulate each game to calculate its fen string.
  for (const g of games) {
    const moves = db.query('SELECT move FROM moves WHERE game_id = ?1 ORDER BY id').all(g.id);

    const chess = new Chess();
    for (const { move } of moves) {
      chess.move(move);
    }

    g.fen = chess.fen();
  }
  return c.json(games);
});

app.get("/api/humans/", async c => {
  const humans = db.query("SELECT id, name FROM humans").all();
  return c.json(humans);
});

const port = parseInt(process.env.PORT) || 3000;
console.log(`Running at http://localhost:${port}`);
export default {
  port,
  fetch: app.fetch,
};
