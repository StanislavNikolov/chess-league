import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import { mkdir } from "node:fs/promises";
import { db } from "./db";
import { makeTmpDir } from "./utils";

class BotInstance {
  constructor(
    public db_id: number,
    public hash: string,
    public time_ms: number,
    public proc: any = null
  ) {
  }
};

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

  constructor(wid: number, bid: number, initial_time_ms: number = 6 * 1000) {
    const query = db.query("SELECT hash FROM bots WHERE id=?1");
    const whash = query.get(wid)?.hash;
    const bhash = query.get(bid)?.hash;
    if (!whash || !bhash) throw new Error();

    // Record the fact that the game is created.
    this.gameId = db
      .query("INSERT INTO games (wid, bid, initial_time_ms) VALUES (?1, ?2, ?3) RETURNING id")
      .get([wid, bid, initial_time_ms]).id;

    this.initial_time_ms = initial_time_ms;
    this.board = new Chess();
    this.c2bi = {
      'w': new BotInstance(wid, whash, initial_time_ms),
      'b': new BotInstance(bid, bhash, initial_time_ms),
    };
  }

  async start() {
    await this.#prepare();
    db.query("UPDATE games SET started = ?1 WHERE id = ?2").run([new Date().toISOString(), this.gameId]);
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


    this.c2bi['w'].proc = spawn('dotnet', [`${this.tmpdir}/${this.c2bi['w'].hash}.dll`]);
    this.c2bi['b'].proc = spawn('dotnet', [`${this.tmpdir}/${this.c2bi['b'].hash}.dll`]);

    this.c2bi['w'].proc.stdout.on('data', (data: Buffer) => this.#procWrote('w', data));
    this.c2bi['b'].proc.stdout.on('data', (data: Buffer) => this.#procWrote('b', data));

    // color2proc['w'].proc.stderr.on('data', d => console.log('werr', d.toString()));
    // color2proc['b'].proc.stderr.on('data', d => console.log('berr', d.toString()));
  }

  #pokeAtTheBotThatIsOnTurn() {
    this.lastMoveTime = new Date();
    const col = this.board.turn();

    if (this.moveTimeoutId != null) {
      clearTimeout(this.moveTimeoutId);
    }
    this.moveTimeoutId = setTimeout(() => this.#timeout(), this.c2bi[col].time_ms + 1);

    this.c2bi[col].proc.stdin.write(this.board.fen() + '\n');
  }

  #timeout() {
    const color = this.board.turn();
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';
    this.#endGame(other, `${fullname} timed out`);
  }

  #procWrote(color: 'w' | 'b', data: Buffer) {
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';

    const move = data.toString();
    // console.log(this.c2bi[color].time_ms, `${color}: ${move}`);
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

    if (this.board.isGameOver()) { // Be careful about the order of the checks.
      if (this.board.isStalemate()) return this.#endGame('d', 'Stalemate');
      if (this.board.isInsufficientMaterial()) return this.#endGame('d', 'Insufficient Material');
      if (this.board.isThreefoldRepetition()) return this.#endGame('d', 'Threefold Repetition');
      if (this.board.isDraw()) return this.#endGame('d', '50 move rule');
      if (this.board.isCheckmate()) return this.#endGame(other, 'Checkmate');
      return this.#endGame('d', 'Unknown'); // This should not happen.
    }

    this.#pokeAtTheBotThatIsOnTurn();
  }

  #endGame(winner: string, reason: string) {
    this.c2bi['w'].proc.kill();
    this.c2bi['b'].proc.kill();

    // Record the game result
    db.query("UPDATE games SET ended = ?1, winner = ?2, reason = ?3 WHERE id = ?4")
      .run([new Date().toISOString(), winner, reason, this.gameId]);

    // Calculate new elo - https://www.youtube.com/watch?v=AsYfbmp0To0
    const eloQuery = db.query("SELECT coalesce(SUM(change), 0) AS elo FROM elo_updates WHERE bot_id = ?1");
    const welo = eloQuery.get([this.c2bi['w'].db_id]).elo;
    const belo = eloQuery.get([this.c2bi['b'].db_id]).elo;
    const expectedScore = 1 / (1 + Math.pow(10, (welo - belo) / 400));
    const actualScore = { 'w': 1.0, 'b': 0.0, 'd': 0.5 }[winner];

    const eloUpdateQuery = db.query('INSERT INTO elo_updates (game_id, bot_id, change) VALUES (?,?,?)');
    eloUpdateQuery.run([this.gameId, this.c2bi['w'].db_id, +1 * 32 * (actualScore - expectedScore)]);
    eloUpdateQuery.run([this.gameId, this.c2bi['b'].db_id, -1 * 32 * (actualScore - expectedScore)]);

    Bun.spawn(["rm", "-rf", this.tmpdir]);
    console.log('endGame', { winner, reason });
  }
}
