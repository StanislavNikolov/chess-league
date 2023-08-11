import { Hono } from "hono";
import { serveStatic } from "hono/serve-static.bun";

import { compile } from "./compile";
import sql from "./db";
import { getElo } from "./utils";

const app = new Hono();

app.use("/favicon.ico", serveStatic({ path: "./public/favicon.ico" }));
app.use("/", serveStatic({ path: "./public/index.html" }));
app.get("/game/:gameId/", serveStatic({ path: "./public/game.html" }));
app.get("/bot/:botId/", serveStatic({ path: "./public/bot.html" }));
app.use("/public/*", serveStatic({ root: "./" }));

app.use("*", async (c, next) => {
  const begin = performance.now();
  await next();
  const ms = (performance.now() - begin);
  const statusColor = c.res.status === 200 ? "\x1b[32m" : "\x1b[36m";
  const msColor = ms < 50 ? "\x1b[32m" : "\x1b[36m";
  const reset = "\x1b[0m";
  console.log(`${new Date().toISOString()} ${msColor}${ms.toFixed(1)}ms${reset}\t${statusColor}${c.res.status}${reset} ${c.req.method} ${c.req.url}`);
})

async function addDevIfNotExists(name: string, email: string): Promise<number> {
  try {
    return (await sql`INSERT INTO devs (name, email) VALUES (${name}, ${email}) RETURNING id`)[0].id
  } catch (err) {
    return (await sql`SELECT id FROM devs WHERE email = ${email}`)[0].id;
  }
}

async function addBotToLeague(code: string, name: string, devId: number): Promise<{ ok: boolean, msg: string }> {
  const res = await compile(code);
  if (!res.ok) {
    return { ok: false, msg: res.msg };
  }

  // TODO should we make names or hashes unique?
  const botId = (await sql`
    INSERT INTO bots (name, code, uploaded, hash, dev_id)
    VALUES (${name}, ${code}, NOW(), ${res.hash}, ${devId})
    RETURNING id
  `)[0].id;

  await sql`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (null, ${botId}, 1000)`;

  return { ok: true, msg: "" };
}

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
  if (typeof body.devname !== 'string') return c.text('Missing devname', 400);
  if (typeof body.email !== 'string') return c.text('Missing email', 400);
  if (body.devname.length > 30) return c.text('Devname name too long');
  if (body.botname.length > 30) return c.text('Botname too long');

  console.log("Starting upload", body.devname, body.email);
  const devId = await addDevIfNotExists(body.devname, body.email);
  const { ok, msg } = await addBotToLeague(code, body.botname, devId);

  // Is this abusing http status codes? Oh well...
  return c.text(msg, ok ? 200 : 400);
});

app.get("/api/bots/", async c => {
  const bots = await sql`
    SELECT bots.id, name, SUM(change)::float AS elo FROM bots
    LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
    GROUP BY bots.id
    ORDER BY elo DESC
  `;
  return c.json(bots);
});

app.get("/api/old-games/", async c => {
  const games = await sql`
    SELECT games.id, wid, bid, w.name as wname, b.name as bname, started, ended, winner
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    WHERE winner IS NOT NULL
    ORDER BY ended DESC
    LIMIT 50
  `;
  return c.json(games);
});

app.get("/api/live-games/", async c => {
  const games = await sql`
    WITH bot_elos AS ( SELECT bot_id, SUM(change)::float AS elo FROM elo_updates GROUP BY bot_id )
    SELECT games.id, initial_position, current_position AS fen, wid, bid, w.name as wname, b.name as bname, we.elo as welo, be.elo as belo
    FROM games
    JOIN bots AS w ON w.id = wid
    JOIN bots AS b ON b.id = bid
    JOIN bot_elos AS we ON we.bot_id = wid
    JOIN bot_elos AS be ON be.bot_id = bid
    WHERE winner IS NULL AND initial_position IS NOT NULL
    ORDER BY games.id DESC
  `;
  return c.json(games);
});

app.get("/api/game/:gameId/", async c => {
  const { gameId } = c.req.param();

  const res = await sql`
      SELECT initial_time_ms, initial_position, wid, bid, wbot.name AS wname, bbot.name AS bname, winner, reason
      FROM games
      JOIN bots AS wbot ON wbot.id = wid
      JOIN bots AS bbot ON bbot.id = bid
      WHERE games.id = ${gameId}
    `;

  if (res.length === 0) return c.text('', 404);

  const game = res[0];
  game.moves = await sql`SELECT move, color, time_ms FROM moves WHERE game_id = ${gameId} ORDER BY id`;

  return c.json(game);
});

app.get("/api/bot/:botId/", async c => {
  const botId = Number(c.req.param("botId"));

  const res = (await sql`SELECT name, uploaded FROM bots WHERE bots.id = ${botId}`);
  if (res.length === 0) return c.text('', 404);

  const bot = res[0];
  bot.elo = await getElo(botId);

  bot.games = await sql`
      SELECT games.id AS id, started, bid, wid, wbot.name AS wname, bbot.name AS bname, winner, reason, change as elo_change
      FROM games
      JOIN bots AS wbot ON games.wid = wbot.id
      JOIN bots AS bbot ON games.bid = bbot.id
      JOIN elo_updates ON game_id = games.id AND elo_updates.bot_id = ${botId}
      WHERE wid = ${botId} OR bid = ${botId} ORDER BY ended DESC
  `;

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

app.get("/api/devs/", async c => {
  const devs = await sql`
    SELECT devs.id, devs.name, MAX(b.elo) as elo FROM devs
    JOIN (
      SELECT bots.id, name, SUM(change)::float AS elo, dev_id FROM bots
      LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
      GROUP BY bots.id
      ORDER BY elo DESC
    ) b ON b.dev_id = devs.id
    GROUP BY devs.id
    ORDER BY elo DESC
  `;

  return c.json(devs);
});

if (process.argv.includes('recompile')) {
  console.log("==== Starting recompilation of all submissions ====");
  const bots = await sql`SELECT id, name, code FROM bots`;
  for (const bot of bots) {
    console.log(`Recompiling ${bot.id}:${bot.name}`);
    await compile(bot.code);
  }
  process.exit(0);
}

async function cleanDeadLiveGames() {
  const res = await sql`
    DELETE FROM games
    WHERE ended IS NULL
    AND EXTRACT(EPOCH FROM started) * 1000 + 3 * initial_time_ms < EXTRACT(EPOCH FROM NOW()) * 1000
  `;
  if (res.count > 0) {
    console.log(`Deleted ${res.count} dead games`);
  }
  setTimeout(cleanDeadLiveGames, 10 * 1000);
}
cleanDeadLiveGames();

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

