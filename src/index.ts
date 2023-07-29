import { Hono } from "hono";
import { serveStatic } from "hono/serve-static.bun";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { startGame } from "./matchmaker";

import { Database } from "bun:sqlite";
const db = new Database("db.sqlite");

db.query(`
  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    uploaded TEXT NOT NULL,
    hash TEXT,
    email TEXT
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
    FOREIGN KEY(wid) REFERENCES bots(id),
    FOREIGN KEY(bid) REFERENCES bots(id)
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS moves (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL,
    move TEXT NOT NULL,
    ms_since_game_start NUMBER NOT NULL,
    FOREIGN KEY(game_id) REFERENCES games(id)
  );
`).run();

async function addBotToLeague(code: Blob, name: string, email: string): Promise<{ ok: bool, msg: string }> {
  const dir = "../simplified"; // TODO - every execution should have its own dir.

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await code.text());
  const hash = hasher.digest("base64url");

  // 1) Save the code to be compiled.
  await Bun.write(`${dir}/MyBot.cs`, code);

  // Clean up old compiled files.
  const rm = Bun.spawn(["rm", "-rf", `${dir}/obj`, `${dir}/bin`]);
  await rm.exited;

  // Run the compiler.
  // const proc = Bun.spawn(["dotnet", "publish", "-c", "Release", "--self-contained", "true"], {
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

  // TODO should we make names or hashes unique?
  db.query(`
    INSERT INTO bots (name, code, uploaded, email, hash)
    VALUES ($name, $code, $uploaded, $email, $hash)
  `).run({
    $name: name,
    $code: new Uint8Array(await code.arrayBuffer()), // ugh
    $uploaded: new Date().toISOString(),
    $email: email,
    $hash: hash,
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

app.post("/upload", async (c) => {
  const body = await c.req.parseBody();

  if (!(body.code instanceof Blob)) return c.text('Missing code', 401);
  if (typeof body.name !== 'string') return c.text('Missing name', 401);
  if (typeof body.email !== 'string') return c.text('Missing email', 401);

  const code = body.code;
  const name = body.name;
  const email = body.email;

  const { ok, msg } = await addBotToLeague(code, name, email);

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
    .query("INSERT INTO games (wid, bid) VALUES ($wid, $bid) RETURNING id")
    .get({ $wid: wid, $bid: bid }).id;

  startGame(db, gameId, dir, whash, bhash);

  return c.text('', 200);
});

app.get("/api/bots/", async c => {
  const bots = db.query("SELECT id, name, uploaded FROM bots").all();
  console.log(bots);
  return c.json(bots);
});

app.get("/api/games/", async c => {
  const games = db.query(`
    SELECT games.id, wid, bid, w.name as wname, b.name as bname, started, ended, winner
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    ORDER BY games.id DESC
    LIMIT 50
  `).all();
  return c.json(games);
});

const port = parseInt(process.env.PORT) || 3000;
console.log(`Running at http://localhost:${port}`);
export default {
  port,
  fetch: app.fetch,
};
