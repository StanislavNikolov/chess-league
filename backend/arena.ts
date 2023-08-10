import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "./db";
import { makeTmpDir, getElo } from "./utils";

class BotInstance {
  constructor(
    public db_id: number,
    public hash: string,
    public time_ms: number,
    public proc: any = null
  ) {
  }
};

function spawnBotProcess(tmpdir: string, hash: string) {
  // This function will try to use bubblewrap to securely run the bot, if possible.
  const dotnetBin = Bun.which("dotnet");
  if (dotnetBin == null) throw Error("Couldn't find dotnet in PATH");

  if (Bun.which("bwrap") == null) {
    console.warn("bubblewrap (bwrap) not installed. Running insecurely!");
    return spawn("dotnet", [`${tmpdir}/${hash}.dll`]);
  }

  return spawn("bwrap", [
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
  ]);
}

/*
 * This class menages the the bot processes and the database records needed to follow the game live.
 */
export class Arena {
  tmpdir: string;
  initial_time_ms: number;
  gameId: number; // As recorded in the db.
  lastMoveTime: Date;
  c2bi: Record<'w' | 'b', BotInstance>;
  board: Chess;
  moveTimeoutId: Timer;
  gameEnded = false;

  constructor(wid: number, bid: number, initial_time_ms: number = 60 * 1000) {
    const query = db.query("SELECT hash FROM bots WHERE id=?1");
    const whash = query.get(wid)?.hash;
    const bhash = query.get(bid)?.hash;
    if (!whash || !bhash) throw new Error();

    // Record the fact that the game is created.
    this.gameId = db
      .query("INSERT INTO games (wid, bid, initial_time_ms) VALUES (?1, ?2, ?3) RETURNING id")
      .get([wid, bid, initial_time_ms]).id;

    this.initial_time_ms = initial_time_ms;

    this.c2bi = {
      'w': new BotInstance(wid, whash, initial_time_ms),
      'b': new BotInstance(bid, bhash, initial_time_ms),
    };
  }

  async start() {
    const fens = (await Bun.file('./fens.txt').text()).split('\n');
    const fen = fens[Math.floor(Math.random() * fens.length)];
    this.board = new Chess(fen);

    await this.#prepare();
    db.query("UPDATE games SET started = ?1, initial_position = ?2 WHERE id = ?3").run([new Date().toISOString(), fen, this.gameId]);
    this.#pokeAtTheBotThatIsOnTurn();
  }

  async #prepare() {
    this.tmpdir = makeTmpDir();
    await mkdir(this.tmpdir, { recursive: true });

    // Copy the actual dlls.
    await Bun.write(Bun.file(`${this.tmpdir}/${this.c2bi['w'].hash}.dll`), Bun.file(`compiled/${this.c2bi['w'].hash}.dll`));
    await Bun.write(Bun.file(`${this.tmpdir}/${this.c2bi['b'].hash}.dll`), Bun.file(`compiled/${this.c2bi['b'].hash}.dll`));

    // Copy the runtimeconfig file that dotnet DEMANDS for some reason.
    await Bun.write(Bun.file(`${this.tmpdir}/${this.c2bi['w'].hash}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));
    await Bun.write(Bun.file(`${this.tmpdir}/${this.c2bi['b'].hash}.runtimeconfig.json`), Bun.file(`runtimeconfig.json`));

    this.c2bi['w'].proc = spawnBotProcess(this.tmpdir, this.c2bi['w'].hash);
    this.c2bi['b'].proc = spawnBotProcess(this.tmpdir, this.c2bi['b'].hash);

    this.c2bi['w'].proc.stdout.on('data', (data: Buffer) => this.#procWrote('w', data));
    this.c2bi['b'].proc.stdout.on('data', (data: Buffer) => this.#procWrote('b', data));

    // this.c2bi['w'].proc.stderr.on('data', d => console.log('werr', d.toString()));
    // this.c2bi['b'].proc.stderr.on('data', d => console.log('berr', d.toString()));
  }

  #pokeAtTheBotThatIsOnTurn() {
    this.lastMoveTime = new Date();
    const col = this.board.turn();
    const other = col === 'w' ? 'b' : 'w';
    const fullname = col === 'w' ? 'White' : 'Black';

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }
    this.moveTimeoutId = setTimeout(() => this.#timeout(), this.c2bi[col].time_ms + 1);

    const timerString = `${this.c2bi[col].time_ms} ${this.c2bi[other].time_ms} ${this.initial_time_ms}`;
    try {
      this.c2bi[col].proc.stdin.write(this.board.fen() + '\n' + timerString + '\n');
    } catch (e) {
      this.#endGame(other, `${fullname} kicked to bucket early (crashed)`);
    }
  }

  #timeout() {
    const color = this.board.turn();
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';
    this.#endGame(other, `${fullname} timed out`);
  }

  #procWrote(color: 'w' | 'b', data: Buffer) {
    if (this.gameEnded) {
      // I couldn't be bother to detach the procWrote event handler, so this should do.
      console.log(`It looks like ${color} managed to write after we tried to kill it.`);
      return;
    }
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';

    const move = data.toString();
    if (this.board.turn() !== color) {
      return this.#endGame(other, `${fullname} made a move, but it wasn't on turn`);
    }

    const moveTime: number = new Date().getTime() - this.lastMoveTime.getTime();
    this.c2bi[color].time_ms -= moveTime;
    if (this.c2bi[color].time_ms < 0) {
      return this.#endGame(other, `${fullname} timed out`);
    }

    try {
      this.board.move(move);
    } catch (e) {
      // TODO test this
      return this.#endGame(other, `${fullname} made an illegal move: ${move}`);
    }

    db.query("INSERT INTO moves (game_id, move, color, time) VALUES (?1, ?2, ?3, ?4)")
      .run([this.gameId, move, color, moveTime]);

    db.query("UPDATE games SET current_position = ?1 WHERE id = ?2").run([this.board.fen(), this.gameId]);

    if (this.board.isGameOver()) { // Be careful about the order of the checks.
      if (this.board.isStalemate()) return this.#endGame('d', 'Stalemate');
      if (this.board.isInsufficientMaterial()) return this.#endGame('d', 'Insufficient Material');
      if (this.board.isThreefoldRepetition()) return this.#endGame('d', 'Threefold Repetition');
      if (this.board.isDraw()) return this.#endGame('d', '50 move rule');
      if (this.board.isCheckmate()) return this.#endGame(color, 'Checkmate');
      return this.#endGame('d', 'Unknown'); // This should not happen.
    }

    this.#pokeAtTheBotThatIsOnTurn();
  }

  #endGame(winner: string, reason: string) {
    this.gameEnded = true;
    this.c2bi['w'].proc.kill(9);
    this.c2bi['b'].proc.kill(9);

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    // Record the game result
    db.query("UPDATE games SET ended = ?1, winner = ?2, reason = ?3 WHERE id = ?4")
      .run([new Date().toISOString(), winner, reason, this.gameId]);

    // Calculate new elo - https://www.youtube.com/watch?v=AsYfbmp0To0
    const welo = getElo([this.c2bi['w'].db_id]);
    const belo = getElo([this.c2bi['b'].db_id]);
    const expectedScore = 1 / (1 + Math.pow(10, (belo - welo) / 400));
    const actualScore = { 'w': 1.0, 'b': 0.0, 'd': 0.5 }[winner];

    const eloUpdateQuery = db.query('INSERT INTO elo_updates (game_id, bot_id, change) VALUES (?,?,?)');
    eloUpdateQuery.run([this.gameId, this.c2bi['w'].db_id, +1 * 32 * (actualScore - expectedScore)]);
    eloUpdateQuery.run([this.gameId, this.c2bi['b'].db_id, -1 * 32 * (actualScore - expectedScore)]);

    Bun.spawn(["rm", "-rf", this.tmpdir]);
    console.log(`Game ${this.gameId} won by ${winner} - ${reason}`);
  }
}

function pickBotByNumberOfGamesPlayed(): number {
  // Bots that have played FEWER games have a HIGHER chance to be picked.
  // Playing more than 100 games does not change your weight.

  const stats = db.query(`
    SELECT bots.id, MIN(COUNT(*), 100) AS cnt FROM bots
    LEFT JOIN games ON games.wid = bots.id OR games.bid = bots.id
    GROUP BY bots.id
    ORDER BY cnt
  `).all() as { id: number, cnt: number }[];

  const weightSum = stats.reduce((tot, curr) => tot + 1 / curr.cnt, 0);
  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const { id, cnt } of stats) {
    prefSum += 1 / cnt;
    if (prefSum >= random) return id;
  }
}

function pickBotThatHasCloseElo(otherBotId: number): number {
  // Bots that have elo that is CLOSE to otherBotId have MORE chance to be picked up.
  const otherElo = getElo(otherBotId);
  const stats = db.query(`
    SELECT bot_id, coalesce(SUM(change), 0) AS elo
    FROM elo_updates WHERE bot_id != ?1
    GROUP BY bot_id
  `).all([otherBotId]) as { bot_id: number, elo: number }[];

  const calcWeight = (elo: number) => 1 / Math.pow(Math.abs(elo - otherElo), 1.5);

  const weightSum = stats.reduce((tot, curr) => tot + calcWeight(curr.elo), 0);
  let prefSum = 0;
  const random = Math.random() * weightSum;
  for (const { bot_id, elo } of stats) {
    prefSum += calcWeight(elo);
    if (prefSum >= random) return bot_id;
  }
}

/*
 * Uncomment for debugging.
function testArenaAlgo() {
  for (let i = 0; i < 1000; i++) {
    let id1 = pickBotByNumberOfGamesPlayed();
    if (id1 == null) return;

    let id2 = pickBotThatHasCloseElo(id1);
    if (id2 == null) return;

    if (id1 == id2) return;

    if (Math.random() > 0.5) [id1, id2] = [id2, id1];

    const dbq = db.query(`
      SELECT name, SUM(change) as elo
      FROM bots
      JOIN elo_updates ON elo_updates.bot_id = bots.id
      WHERE bots.id = ?1
    `);
    const s1 = dbq.get(id1);
    const s2 = dbq.get(id2);
    console.log(`Starting game between ${s1.name}(${id1}-${s1.elo?.toFixed(0)}) and ${s2.name}(${id2}-${s2.elo?.toFixed(0)})`);
  }
}

testArenaAlgo();
*/

export function makeArenaIfNeeded() {
  let runningGames = db.query("SELECT COUNT(*) as c FROM games WHERE ended IS NULL").get().c;
  for (; runningGames < 4; runningGames++) {
    let id1 = pickBotByNumberOfGamesPlayed();
    if (id1 == null) return;

    let id2 = pickBotThatHasCloseElo(id1);
    if (id2 == null) return;

    if (id1 == id2) return;

    if (Math.random() > 0.5) [id1, id2] = [id2, id1];

    console.log(`Starting game between ${id1} and ${id2}`);
    new Arena(id1, id2).start();
  }
}
