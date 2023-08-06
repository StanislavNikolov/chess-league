import { Chess } from "chess.js";

import { Hono } from "hono";
import { logger } from 'hono/logger';
import { serveStatic } from "hono/serve-static.bun";

import { Arena, makeArenaIfNeeded } from "./arena";
import { db } from "./db";
import { makeTmpDir } from "./utils";

async function compile(code: string) {
  // Copy the template project into a tmpdir.
  const tmpdir = makeTmpDir();
  const cp = Bun.spawn(["cp", "-r", "./bot-scaffold", tmpdir]);
  await cp.exited;

  // Save the code to be compiled.
  await Bun.write(`${tmpdir}/MyBot.cs`, code);

  // Run the compiler.
  const dotnet = Bun.spawn(["dotnet", "publish", "-c", "Release"], { cwd: tmpdir });
  await dotnet.exited;

  if (dotnet.exitCode !== 0) {
    // Delete the tmpdir.
    const rm = Bun.spawn(["rm", "-rf", tmpdir]);
    await rm.exited;

    // TODO - is stderr needed?
    const stdout = await new Response(dotnet.stdout).text();
    return { ok: false, msg: stdout };
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(code);
  const hash = hasher.digest("base64url");

  await Bun.write(
    Bun.file(`compiled/${hash}.dll`),
    Bun.file(`${tmpdir}/bin/Release/net7.0/Chess-Challenge.dll`),
  );

  // Delete the tmpdir.
  const rm = Bun.spawn(["rm", "-rf", tmpdir]);
  await rm.exited;

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
  const botId = db.query(`
    INSERT INTO bots (name, code, uploaded, hash, human_id)
    VALUES ($name, $code, $uploaded, $hash, $human_id)
    RETURNING id
  `).get({
    $name: name,
    $code: code,
    $uploaded: new Date().toISOString(),
    $hash: res.hash,
    $human_id: humanId
  }).id as number;

  db.query(`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (null, ?1, 1000)`)
    .run([botId]);

  return { ok: true, msg: "" };
}

const app = new Hono();

app.use("/favicon.ico", serveStatic({ path: "./public/favicon.ico" }));
app.use("/", serveStatic({ path: "./public/index.html" }));
app.use("/public/*", serveStatic({ root: "./" }));

app.use("*", async (c, next) => {
  const begin = performance.now();
  await next();
  // console.log(c);
  console.log(`${c.req.method} ${c.req.url} - ${c.res.status} ${(performance.now() - begin).toFixed(1)}ms`);
})

app.post("/api/upload/", async (c) => {
  const body = await c.req.parseBody();

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

  try {
    const arena = new Arena(wid, bid);
    arena.start();
  } catch (e) {
    return c.text('', 400);
  }

  return c.text('', 200);
});

app.get("/api/bots/", async c => {
  const bots = db.query(`
    SELECT bots.id, name, coalesce(SUM(change), 0) AS elo FROM bots
    LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
    GROUP BY bots.id
    ORDER BY elo DESC
  `).all();
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
    const moves = db.query('SELECT move, color, time FROM moves WHERE game_id = ?1 ORDER BY id').all(g.id);

    const chess = new Chess();
    const totalTime = { 'w': 0, 'b': 0 };
    for (const move of moves) {
      chess.move(move.move);
      totalTime[move.color] += move.time;
    }

    g.fen = chess.fen();
    g.totalTime = totalTime;
  }
  return c.json(games);
});

app.get("/api/humans/", async c => {
  const humans = db.query(`
    SELECT humans.id, humans.name, MAX(b.elo) as elo FROM humans
    JOIN (
      SELECT bots.id, name, coalesce(SUM(change), 0) AS elo, human_id FROM bots
      LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
      GROUP BY bots.id
      ORDER BY elo DESC
    ) b ON b.human_id = humans.id
    GROUP BY humans.id
    ORDER BY elo DESC
  `).all();
  return c.json(humans);
});

setInterval(makeArenaIfNeeded, 1000);

const port = parseInt(process.env.PORT) || 3000;
console.log(`Running at http://localhost:${port}`);
export default {
  port,
  fetch: app.fetch,
};
