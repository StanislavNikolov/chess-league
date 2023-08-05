import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import { Database } from "bun:sqlite";


export function startGame(db: Database, gameId: number, dir: string, wid: number, bid: number, white_hash: string, black_hash: string) {
  const chess = new Chess();
  console.log(chess.ascii());

  // TODO add some bubblewrap.
  const color2proc = {
    'w': spawn('dotnet', [`${dir}/${white_hash}.dll`]),
    'b': spawn('dotnet', [`${dir}/${black_hash}.dll`]),
  }

  function endGame(winner: string, reason: string) {
    color2proc['w'].kill();
    color2proc['b'].kill();

    // Record the game result
    db.query("UPDATE games SET ended = ?1, winner = ?2, reason = ?3 WHERE id = ?4")
      .run([new Date().toISOString(), winner, reason, gameId]);

    // Calculate new elo - https://www.youtube.com/watch?v=AsYfbmp0To0
    const eloQuery = db.query("SELECT coalesce(SUM(change), 0) AS elo FROM elo_updates WHERE bot_id = ?1");
    const welo = eloQuery.get([wid]).elo;
    const belo = eloQuery.get([bid]).elo;
    const expectedScore = 1 / (1 + Math.pow(10, (welo - belo) / 400));
    const actualScore = { 'w': 1.0, 'b': 0.0, 'd': 0.5 }[winner];

    const eloUpdateQuery = db.query('INSERT INTO elo_updates (game_id, bot_id, change) VALUES (?,?,?)');
    eloUpdateQuery.run([gameId, wid, -1 * 32 * (actualScore - expectedScore)]);
    eloUpdateQuery.run([gameId, bid, +1 * 32 * (actualScore - expectedScore)]);
    console.log('endGame', { winner, reason });
  }

  function procWrote(color: string, data: Buffer) {
    const other = color === 'w' ? 'b' : 'w';
    const fullname = color === 'w' ? 'White' : 'Black';

    const move = data.toString();
    console.log(`${color} wrote:`, move);
    if (chess.turn() !== color) {
      endGame(other, `${fullname} made a move, but it wasn't on turn`);
    }

    try {
      chess.move(move);
    } catch (e) {
      // TODO test this
      return endGame(other, `${fullname} made an illegal move: ${move}`);
    }
    db.query("INSERT INTO moves (game_id, move, ms_since_game_start) VALUES (?1, ?2, ?3)")
      .run([gameId, move, (new Date() - gameStart)]);
    // console.log(chess.ascii());

    if (chess.isGameOver()) { // Be careful about the order of the checks.
      if (chess.isStalemate()) return endGame('d', 'Stalemate');
      if (chess.isInsufficientMaterial()) return endGame('d', 'Insufficient material');
      if (chess.isThreefoldRepetition()) return endGame('d', 'Threefold Repetition');
      if (chess.isDraw()) return endGame('d', '50 move rule');
      if (chess.isCheckmate()) return endGame(other, 'Checkmate');
      return endGame('d', 'Unknown'); // This should not happen.
    }

    color2proc[other].stdin.write(chess.fen() + '\n');
  }

  color2proc['w'].stdout.on('data', data => procWrote('w', data));
  color2proc['b'].stdout.on('data', data => procWrote('b', data));

  color2proc['w'].stderr.on('data', d => console.log('werr', d.toString()));
  color2proc['b'].stderr.on('data', d => console.log('berr', d.toString()));


  // Start the game.
  const gameStart = new Date();
  db.query("UPDATE games SET started = ?1 WHERE id = ?2").run([gameStart.toISOString(), gameId]);
  color2proc['w'].stdin.write(chess.fen() + '\n');
}
