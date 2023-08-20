import { Chess } from "chess.js";
import { Subprocess } from "bun";
import { mkdir } from "node:fs/promises";
import { ok as assert } from "node:assert";
import { dirname } from "node:path";
import { sql } from "./db";
import { makeTmpDir } from "./utils";
import rawfenstxt from "../fens.txt";

export async function getElo(botId: number): Promise<number> {
  const res = await sql`SELECT elo FROM bot_elos WHERE bot_id = ${botId}`;
  return res[0].elo;
}

const startingPositions = rawfenstxt.split('\n');

const colors = {
  reset: "\x1b[0m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

interface BotInstance {
  id: number,
  time_ms: number,
  proc?: Subprocess<"pipe", "pipe", "inherit">
};

async function spawnBotProcess(tmpdir: string, hash: string) {
  // This function will try to use bubblewrap to securely run the bot, if possible.
  const dotnetBin = Bun.which("dotnet");
  if (dotnetBin == null) throw Error("Couldn't find dotnet in PATH");

  if (Bun.which("bwrap") == null) {
    return {
      proc: Bun.spawn(["dotnet", `${tmpdir}/${hash}.dll`], { stdin: "pipe", stdout: "pipe" }),
      cgname: null,
    };
  }

  const cgname = `${new Date().getTime()}-${hash}`;
  console.log('Cgname', cgname);
  await Bun.spawn(["cgcreate", "-g", `memory:${cgname}`]).exited;
  await Bun.spawn(["cgset", "-r", "memory.max=2G", cgname]).exited;

  // Start the bot inside the C# VM inside bubblewrap inside a cgroup inside the Heizner VM...
  // Something's wrong I can feel it

  const proc = Bun.spawn([
    "cgexec", "-g", `memory:${cgname}`, "bwrap",
    "--ro-bind", "/usr", "/usr",
    "--dir", "/tmp", // Dotnet needs /tmp to exist
    "--proc", "/proc", // Dotnet refuses to start without proc to audit itself
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", dirname(dotnetBin), "/dotnet", // Mount the dotnet install directory
    "--ro-bind", tmpdir, "/fight",
    "--chdir", "/fight",

    // Thanks to discord user Omsk for finding this!
    // https://nvd.nist.gov/vuln/detail/CVE-2017-5226
    // https://github.com/containers/bubblewrap/pull/560
    "--new-session",

    "--unshare-all", // This disables practically everything, including reading other pids, network, etc.
    "--clearenv", // Do not leak any other env variable, not that they would help
    "--", "/dotnet/dotnet", `${hash}.dll` // Actually start the damn bot!
  ], { stdin: "pipe", stdout: "pipe" });

  return { proc, cgname };
}

async function cp(src: string, dst: string) {
  // This works without throwing EXDEV: Cross-device link like Bun.write does.
  // https://discord.com/channels/876711213126520882/1140443747511963728
  await Bun.spawn(["cp", src, dst]).exited;
}

/*
 * This class menages the the bot processes and the database records needed to follow the game live.
 */
export class Arena {
  initial_time_ms: number;
  gameId: number; // As recorded in the db.
  lastMoveTime: Date;
  bots: Record<'w' | 'b', BotInstance>;
  board: Chess;
  moveTimeoutId: Timer;
  gameEnded = false;

  constructor(wid: number, bid: number, initial_time_ms: number = 60 * 1000) {
    this.initial_time_ms = initial_time_ms;
    this.bots = {
      w: { id: wid, time_ms: initial_time_ms },
      b: { id: bid, time_ms: initial_time_ms }
    };
  }

  async start() {
    const whash = (await sql`SELECT hash FROM bots WHERE id = ${this.bots.w.id}`)[0].hash;
    const bhash = (await sql`SELECT hash FROM bots WHERE id = ${this.bots.b.id}`)[0].hash;
    assert(whash != null && bhash != null);

    const startingPosition = startingPositions[Math.floor(Math.random() * startingPositions.length)];
    this.board = new Chess(startingPosition);

    this.gameId = (await sql`
        INSERT INTO games (wid, bid, started, initial_time_ms, initial_position, current_position)
        VALUES (${this.bots.w.id}, ${this.bots.b.id}, NOW(), ${this.initial_time_ms}, ${startingPosition}, ${startingPosition})
        RETURNING id
    `)[0].id;

    const tmpdir = makeTmpDir();
    await mkdir(tmpdir, { recursive: true });

    // Copy the actual dlls.
    await cp(`compiled/${whash}.dll`, `${tmpdir}/${whash}.dll`);
    await cp(`compiled/${bhash}.dll`, `${tmpdir}/${bhash}.dll`);

    // Copy the runtimeconfig file that dotnet DEMANDS for some reason.
    await cp("runtimeconfig.json", `${tmpdir}/${whash}.runtimeconfig.json`);
    await cp("runtimeconfig.json", `${tmpdir}/${bhash}.runtimeconfig.json`);

    const wspawn = await spawnBotProcess(tmpdir, whash);
    const bspawn = await spawnBotProcess(tmpdir, bhash);
    this.bots.w.proc = wspawn.proc;
    this.bots.b.proc = bspawn.proc;

    await this.#pokeAtTheBotThatIsOnTurn();

    console.log("Deleting cgroups");
    if (wspawn.cgname != null) await Bun.spawn(["cgdelete", "-g", `memory:${wspawn.cgname}`]).exited;
    if (bspawn.cgname != null) await Bun.spawn(["cgdelete", "-g", `memory:${bspawn.cgname}`]).exited;

    console.log("Deleting tmpdir");
    await Bun.spawn(["rm", "-rf", tmpdir]).exited;
  }

  async #pokeAtTheBotThatIsOnTurn() {
    this.lastMoveTime = new Date();
    const col = this.board.turn();
    const other = col === 'w' ? 'b' : 'w';
    const fullname = col === 'w' ? 'White' : 'Black';

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }
    this.moveTimeoutId = setTimeout(() => this.#timeout(), this.bots[col].time_ms + 1);

    const timerString = `${this.bots[col].time_ms} ${this.bots[other].time_ms} ${this.initial_time_ms}`;
    // console.log(`${colors.gray}Sending to ${col}'s stdin...${colors.reset}`)
    try {
      this.bots[col].proc.stdin.write(this.board.fen() + '\n' + timerString + '\n');
      this.bots[col].proc.stdin.flush();
    } catch (e) {
      return this.#endGame(other, `${fullname} kicked to bucket early (crashed)`);
    }

    const reader = this.bots[col].proc.stdout.getReader();
    const readResult = await reader.read();

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    reader.releaseLock();
    const move = new TextDecoder().decode(readResult.value);
    await this.#procWrote(col, move);
  }

  #timeout() {
    const color = this.board.turn();
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';
    this.#endGame(other, `${fullname} timed out [debug 2]`);
  }

  async #procWrote(color: 'w' | 'b', move: string) {
    // console.log(`${colors.gray}${color} wrote: ${JSON.stringify(move)}${colors.reset}`);

    if (this.gameEnded) {
      console.log(`${colors.cyan}#procWrote called after game has ended. This should only be possible if a timeout was triggered during #endGame!${colors.reset}`);
      return;
    }
    assert(this.board.turn() === color);

    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';

    const moveTime: number = new Date().getTime() - this.lastMoveTime.getTime();
    this.bots[color].time_ms -= moveTime;
    // console.log(`wtime: ${this.bots.w.time_ms}, btime: ${this.bots.b.time_ms}`);
    if (this.bots[color].time_ms < 0) {
      return this.#endGame(other, `${fullname} timed out [debug 1]`);
    }

    try {
      this.board.move(move);
    } catch (e) {
      return this.#endGame(other, `${fullname} made an illegal move: ${move}`);
    }

    const hist = this.board.history();
    const parsedMove = hist[hist.length - 1];

    await sql`INSERT INTO moves (game_id, move, color, time_ms) VALUES (${this.gameId}, ${parsedMove}, ${color}, ${moveTime})`
    await sql`UPDATE games SET current_position = ${this.board.fen()} WHERE id = ${this.gameId}`;

    if (this.board.isGameOver()) { // Be careful about the order of the checks.
      if (this.board.isStalemate()) return this.#endGame('d', 'Stalemate');
      if (this.board.isInsufficientMaterial()) return this.#endGame('d', 'Insufficient Material');
      if (this.board.isThreefoldRepetition()) return this.#endGame('d', 'Threefold Repetition');
      if (this.board.isDraw()) return this.#endGame('d', '50 move rule');
      if (this.board.isCheckmate()) return this.#endGame(color, 'Checkmate');
      return this.#endGame('d', 'Unknown'); // This should not happen.
    }

    await this.#pokeAtTheBotThatIsOnTurn();
  }

  async #endGame(winner: string, reason: string) {
    console.log(`Game ${this.gameId} won by ${winner} - ${reason}`);

    this.gameEnded = true;

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    await Bun.spawn(["pkill", "-P", String(this.bots.w.proc.pid)]).exited;
    await Bun.spawn(["pkill", "-P", String(this.bots.b.proc.pid)]).exited;

    // this.bots.w.proc.kill(9);
    // this.bots.b.proc.kill(9);

    // Record the game result
    await sql`UPDATE games SET ended=NOW(), winner=${winner}, reason=${reason} WHERE id=${this.gameId}`;
    console.log("Game saved as ended")

    // Calculate new elo - https://www.youtube.com/watch?v=AsYfbmp0To0
    const welo = await getElo(this.bots.w.id);
    const belo = await getElo(this.bots.b.id);
    console.log(`welo=${welo} belo=${belo}`);
    const expectedScore = 1 / (1 + Math.pow(10, (belo - welo) / 400));
    const actualScore = { 'w': 1.0, 'b': 0.0, 'd': 0.5 }[winner];

    const wchange = +1 * 32 * (actualScore - expectedScore);
    const bchange = -1 * 32 * (actualScore - expectedScore);
    await sql`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (${this.gameId},${this.bots.w.id},${wchange})`;
    await sql`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (${this.gameId},${this.bots.b.id},${bchange})`;
    console.log("Elo updates saved");
  }
}

async function pickBotByNumberOfGamesPlayed(): Promise<{ id: number, elo: number }> {
  // Bots that have played FEWER games have a HIGHER chance to be picked.
  // Playing more than 100 games does not change your weight.

  const stats = await sql`
    WITH bot_games AS (
      SELECT bots.id, LEAST(COUNT(*), 100)::int AS cnt FROM bots
      LEFT JOIN games ON games.wid = bots.id OR games.bid = bots.id
      LEFT JOIN bot_elos ON bot_elos.bot_id = bots.id
      WHERE paused = FALSE
      GROUP BY bots.id
    )
    SELECT bot_elos.bot_id AS id, bot_games.cnt, bot_elos.elo
    FROM bot_elos
    JOIN bot_games ON bot_games.id = bot_elos.bot_id
    ORDER BY cnt
  ` as { id: number, cnt: number, elo: number }[];

  const weightSum = stats.reduce((tot, curr) => tot + 1 / curr.cnt, 0);
  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const st of stats) {
    prefSum += 1 / st.cnt;
    if (prefSum >= random) return { id: st.id, elo: st.elo };
  }
}

async function pickBotThatHasCloseElo(otherBot: { id: number, elo: number }): Promise<number> {
  // Bots that have elo that is CLOSE to otherBotId have MORE chance to be picked up.

  const stats = await sql`
    SELECT bot_id, elo FROM bot_elos
    JOIN bots ON bots.id = bot_id
    WHERE bot_id != ${otherBot.id} AND paused = FALSE
  ` as { bot_id: number, elo: number }[];

  const W = 50;
  const P = 2;
  const calcWeight = (elo: number) => 1 / Math.pow(Math.abs(elo - otherBot.elo) + W, P);

  const weightSum = stats.reduce((tot, curr) => tot + calcWeight(curr.elo), 0);

  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const { bot_id, elo } of stats) {
    prefSum += calcWeight(elo);
    if (prefSum >= random) return bot_id;
  }
  console.log("HERE")
}

async function match() {
  let bot1 = await pickBotByNumberOfGamesPlayed();
  if (bot1 == null) return;

  let id2 = await pickBotThatHasCloseElo(bot1);
  if (id2 == null) return;

  if (bot1.id == id2) return;

  if (Math.random() > 0.5) var arena = new Arena(bot1.id, id2);
  else var arena = new Arena(id2, bot1.id);

  console.log(`${colors.green}Starting game between ${arena.bots.w.id} and ${arena.bots.b.id}${colors.reset}`);
  await arena.start();
}

await match();
console.log("Done")
process.exit(0);
