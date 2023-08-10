import { Chess } from "chess.js";

import { Hono } from "hono";
import { serveStatic } from "hono/serve-static.bun";

import { Arena, makeArenaIfNeeded } from "./arena";
import { compile } from "./compile";
import { db } from "./db";
import { getElo } from "./utils";

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
app.get("/game/:gameId/", serveStatic({ path: "./public/game.html" }));
app.get("/bot/:botId/", serveStatic({ path: "./public/bot.html" }));
app.use("/public/*", serveStatic({ root: "./" }));

app.use("*", async (c, next) => {
  const begin = performance.now();
  await next();
  const ms = (performance.now() - begin).toFixed(1);
  const statusColor = c.res.status === 200 ? "\x1b[32m" : "\x1b[36m";
  const msColor = ms < 40 ? "\x1b[32m" : "\x1b[36m";
  const reset = "\x1b[0m";
  console.log(`${new Date().toISOString()} ${msColor}${ms}ms${reset}\t${statusColor}${c.res.status}${reset} ${c.req.method} ${c.req.url}`);
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
  if (body.humanname.length > 30) return c.text('Human name too long');
  if (body.botname.length > 30) return c.text('Botname too long');

  console.log("Starting upload", body.humanname, body.email);
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

app.get("/api/bots/", c => {
  const bots = db.query(`
    SELECT bots.id, name, coalesce(SUM(change), 0) AS elo FROM bots
    LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
    GROUP BY bots.id
    ORDER BY elo DESC
  `).all();
  return c.json(bots);
});

app.get("/api/old-games/", c => {
  const games = db.query(`
    SELECT games.id, wid, bid, w.name as wname, b.name as bname, started, ended, winner
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    WHERE winner IS NOT NULL
    ORDER BY ended DESC
    LIMIT 50
  `).all();
  return c.json(games);
});

app.get("/api/live-games/", c => {
  const games = db.query(`
    WITH bot_elos AS ( SELECT bot_id, coalesce(SUM(change), 0) AS elo FROM elo_updates GROUP BY bot_id )
    SELECT games.id, initial_position, current_position AS fen, wid, bid, w.name as wname, b.name as bname, we.elo as welo, be.elo as belo
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    JOIN bot_elos AS we ON we.bot_id = wid
    JOIN bot_elos AS be ON be.bot_id = bid
    WHERE winner IS NULL AND initial_position IS NOT NULL
    ORDER BY games.id DESC
  `).all();
  return c.json(games);
});

app.get("/api/game/:gameId/", c => {
  const { gameId } = c.req.param();

  const game = db
    .query(`
      SELECT initial_time_ms, initial_position, wid, bid, wbot.name AS wname, bbot.name AS bname, winner, reason
      FROM games
      JOIN bots AS wbot ON wbot.id = wid
      JOIN bots AS bbot ON bbot.id = bid
      WHERE games.id = ?1
    `).get([gameId]);

  if (game == null) return c.text('', 404);

  game.moves = db
    .query("SELECT move, color, time FROM moves WHERE game_id = ?1 ORDER BY id")
    .values([gameId]);

  return c.json(game);
});

app.get("/api/bot/:botId/", c => {
  const botId = Number(c.req.param("botId"));

  const bot = db.query('SELECT name, uploaded FROM bots WHERE bots.id = ?1').get([botId]);

  if (bot == null) return c.text('', 404);

  bot.elo = getElo(botId);

  bot.games = db
    .query(`
      SELECT games.id AS id, started, bid, wid, wbot.name AS wname, bbot.name AS bname, winner, reason, change as elo_change
      FROM games
      JOIN bots AS wbot ON games.wid = wbot.id
      JOIN bots AS bbot ON games.bid = bbot.id
      JOIN elo_updates ON game_id = games.id AND elo_updates.bot_id = ?1
      WHERE wid = ?1 OR bid = ?1 ORDER BY started DESC
    `)
    .all([botId]);

  for (const g of bot.games) {
    // Truncate the illegal move messages.
    if (g.reason.startsWith("Black made an illegal move:")) {
      g.reason = "Black made an illegal move";
    }
    if (g.reason.startsWith("White made an illegal move:")) {
      g.reason = "White made an illegal move";
    }
  }

  return c.json(bot);
});

app.get("/api/humans/", c => {
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

if (process.argv.includes('recompile')) {
  console.log("==== Starting recompilation of all submissions ====");
  const bots = db.query("SELECT id, name, code FROM bots").all();
  for (const bot of bots) {
    console.log(`Recompiling ${bot.id}:${bot.name}`);
    await compile(bot.code);
  }
  process.exit(0);
}

setInterval(makeArenaIfNeeded, 1000);

// Bundle the frontend before starting the server.
for (const file of ["game.ts", "bot.ts"]) {
  await Bun.build({
    entrypoints: [`./frontend/${file}`],
    outdir: "./public/bundled/",
    minify: true,
    sourcemap: "external"
  });
}

const port = parseInt(process.env.PORT) || 3000;
console.log(`Running at http://localhost:${port}`);
export default {
  port,
  fetch: app.fetch,
};

