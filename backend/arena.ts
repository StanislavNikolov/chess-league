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
}

import { Chess } from "chess.js";
import { Subprocess } from "bun";
import { mkdir } from "node:fs/promises";
import { ok as assert } from "node:assert";
import { dirname } from "node:path";
import sql from "./db";
import { makeTmpDir, getElo } from "./utils";
import rawfenstxt from "../fens.txt";

const startingPositions = rawfenstxt.split('\n');

interface BotInstance {
  id: number,
  time_ms: number,
  proc?: Subprocess<"pipe", "pipe", "inherit">
};

function spawnBotProcess(tmpdir: string, hash: string) {
  // This function will try to use bubblewrap to securely run the bot, if possible.
  const dotnetBin = Bun.which("dotnet");
  if (dotnetBin == null) throw Error("Couldn't find dotnet in PATH");

  if (Bun.which("bwrap") == null) {
    console.warn("bubblewrap (bwrap) not installed. Running insecurely!");
    return Bun.spawn(["dotnet", `${tmpdir}/${hash}.dll`], { stdin: "pipe", stdout: "pipe" });
  }

  return Bun.spawn([
    "bwrap",
    "--ro-bind", "/usr", "/usr",
    "--dir", "/tmp", // Dotnet needs /tmp to exist
    "--proc", "/proc", // Dotnet refuses to start without proc to audit itself
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", dirname(dotnetBin), "/dotnet", // Mount the dotnet install directory
    "--ro-bind", tmpdir, "/fight",
    "--chdir", "/fight",
    "--unshare-all", // This disables practically everything, including reading other pids, network, etc.
    "--clearenv", // Do not leak any other env variable, not that they would help
    "--", "/dotnet/dotnet", `${hash}.dll` // Actually start the damn bot!
  ], { stdin: "pipe", stdout: "pipe" });
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
    await Bun.write(Bun.file(`${tmpdir}/${whash}.dll`), Bun.file(`compiled/${whash}.dll`));
    await Bun.write(Bun.file(`${tmpdir}/${bhash}.dll`), Bun.file(`compiled/${bhash}.dll`));

    // Copy the runtimeconfig file that dotnet DEMANDS for some reason.
    await Bun.write(Bun.file(`${tmpdir}/${whash}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));
    await Bun.write(Bun.file(`${tmpdir}/${bhash}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));

    this.bots.w.proc = spawnBotProcess(tmpdir, whash);
    this.bots.b.proc = spawnBotProcess(tmpdir, bhash);

    await this.#pokeAtTheBotThatIsOnTurn();

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
    try {
      this.bots[col].proc.stdin.write(this.board.fen() + '\n' + timerString + '\n');
      this.bots[col].proc.stdin.flush();
      console.log(`${colors.gray}Waiting for response from ${col}${colors.reset}`)
    } catch (e) {
      return this.#endGame(other, `${fullname} kicked to bucket early (crashed)`);
    }

    const reader = this.bots[col].proc.stdout.getReader();
    const readResult = await reader.read();
    reader.releaseLock();
    const move = new TextDecoder().decode(readResult.value);
    await this.#procWrote(col, move);
  }

  #timeout() {
    const color = this.board.turn();
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';
    this.#endGame(other, `${fullname} timed out`);
  }

  async #procWrote(color: 'w' | 'b', move: string) {
    console.log(`${colors.gray}${color} wrote: ${JSON.stringify(move)}${colors.reset}`);
    assert(!this.gameEnded);
    assert(this.board.turn() === color);

    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';

    const moveTime: number = new Date().getTime() - this.lastMoveTime.getTime();
    this.bots[color].time_ms -= moveTime;
    if (this.bots[color].time_ms < 0) {
      return this.#endGame(other, `${fullname} timed out`);
    }

    try {
      this.board.move(move);
    } catch (e) {
      // TODO test this
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
    console.log(`${colors.cyan}Game ${this.gameId} won by ${winner} - ${reason}${colors.reset}`);

    this.gameEnded = true;
    this.bots.w.proc.kill(9);
    this.bots.b.proc.kill(9);

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    // Record the game result
    await sql`UPDATE games SET ended=NOW(), winner=${winner}, reason=${reason} WHERE id=${this.gameId}`;

    // Calculate new elo - https://www.youtube.com/watch?v=AsYfbmp0To0
    const welo = await getElo(this.bots.w.id);
    const belo = await getElo(this.bots.b.id);
    const expectedScore = 1 / (1 + Math.pow(10, (belo - welo) / 400));
    const actualScore = { 'w': 1.0, 'b': 0.0, 'd': 0.5 }[winner];

    const wchange = +1 * 32 * (actualScore - expectedScore);
    const bchange = -1 * 32 * (actualScore - expectedScore);
    await sql`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (${this.gameId},${this.bots.w.id},${wchange})`;
    await sql`INSERT INTO elo_updates (game_id, bot_id, change) VALUES (${this.gameId},${this.bots.b.id},${bchange})`;
  }
}

async function pickBotByNumberOfGamesPlayed(): Promise<number> {
  // Bots that have played FEWER games have a HIGHER chance to be picked.
  // Playing more than 100 games does not change your weight.

  const stats = await sql`
    SELECT bots.id, LEAST(COUNT(*), 100)::int AS cnt FROM bots
    LEFT JOIN games ON games.wid = bots.id OR games.bid = bots.id
    GROUP BY bots.id
    ORDER BY cnt
  ` as { id: number, cnt: number }[];

  const weightSum = stats.reduce((tot, curr) => tot + 1 / curr.cnt, 0);
  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const { id, cnt } of stats) {
    prefSum += 1 / cnt;
    if (prefSum >= random) return id;
  }
}

async function pickBotThatHasCloseElo(otherBotId: number): Promise<number> {
  // Bots that have elo that is CLOSE to otherBotId have MORE chance to be picked up.

  const otherElo = await getElo(otherBotId);
  const stats = await sql`
    SELECT bot_id, coalesce(SUM(change), 0)::int AS elo
    FROM elo_updates WHERE bot_id != ${otherBotId}
    GROUP BY bot_id
  ` as { bot_id: number, elo: number }[];

  const calcWeight = (elo: number) => 1 / Math.pow(Math.abs(elo - otherElo) + 1, 1.5);

  const weightSum = stats.reduce((tot, curr) => tot + calcWeight(curr.elo), 0);

  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const { bot_id, elo } of stats) {
    prefSum += calcWeight(elo);
    if (prefSum >= random) return bot_id;
  }
}

async function match() {
  let id1 = await pickBotByNumberOfGamesPlayed();
  if (id1 == null) return;

  let id2 = await pickBotThatHasCloseElo(id1);
  if (id2 == null) return;

  if (id1 == id2) return;

  if (Math.random() > 0.5) [id1, id2] = [id2, id1];

  console.log(`${colors.gray}Starting game between ${id1} and ${id2}${colors.reset}`);
  const arena = new Arena(id1, id2);
  await arena.start();
}

while (true) {
  await match();
}
