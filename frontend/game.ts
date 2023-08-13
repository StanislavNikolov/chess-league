import "chessboard-element"; // This actually loads the web component
import { ChessBoardElement } from "chessboard-element"; // This is needed for type info
import { Chess } from "chess.js";

const chessBoard = document.querySelector("chess-board") as ChessBoardElement;
const infoSide = document.querySelector("#info-side") as HTMLElement;

// Fuck you chessboardelement
window.onload = () => chessBoard.shadowRoot?.querySelector("#dragged-pieces")?.remove();

const gameId = window.location.pathname.split('/')[2];

interface Game {
  initial_position: string,
  initial_time_ms: number,
  wid: number,
  bid: number,
  wname: string,
  bname: string,
  winner: "w" | "b" | "d",
  reason: string,
  moves: { move: string, color: "w" | "b", time_ms: number }[],
};

let game: Game;

infoSide.addEventListener("mouseover", ev => {
  const hoveredMove = ev.target?.closest(".move");
  if (!hoveredMove) return;
  const moveIdx = Number(hoveredMove.getAttribute("data-idx"));

  const board = new Chess(game.initial_position);
  const times = { 'w': game.initial_time_ms, 'b': game.initial_time_ms };
  for (let i = 0; i <= moveIdx; i++) {
    const { move, color, time_ms } = game.moves[i];
    times[color] -= time_ms;
    board.move(move);
  }
  document.querySelector(".white .time")!.innerText = `${(times.w / 1000).toFixed(3)}s`;
  document.querySelector(".black .time")!.innerText = `${(times.b / 1000).toFixed(3)}s`;
  chessBoard.setPosition(board.fen());
});


fetch(`/api/game/${gameId}/`)
  .then(res => res.json())
  .then(_game => {
    game = _game;

    chessBoard.setPosition(game.initial_position);

    let html = '<div class="move" data-idx="-1">Start</div>';
    const tmpBoard = new Chess(game.initial_position);
    for (let i = 0; i < game.moves.length; i++) {
      const { move, color, time_ms } = game.moves[i];
      tmpBoard.move(move);
      html += `
      <div class="move ${color}" data-idx="${i}">${move}<span class="time">${time_ms}ms</span></div>
      `;
    }
    infoSide.innerHTML = html;

    const pgnLines = tmpBoard.pgn().split('\n');
    pgnLines.shift();
    const encodedPGN = encodeURIComponent(pgnLines.join('\n'));
    document.querySelector("#open-in-chesscom").href = `https://www.chess.com/analysis?pgn=${encodedPGN}`;

    document.querySelector(".white .name")!.innerText = game.wname;
    document.querySelector(".black .name")!.innerText = game.bname;

    if (game.reason == "Checkmate" && Math.random() < 0.02) {
      game.reason = "Absolutely brutal checkmate";
    }
    document.querySelector("#reason").innerText = game.reason;

    if (game.winner === 'w') {
      document.querySelector("#winner").innerText = `${game.wname} won as white`;
    }
    if (game.winner === 'b') {
      document.querySelector("#winner").innerText = `${game.bname} won as black`;
    }
    if (game.winner === 'd') {
      document.querySelector("#winner").innerText = 'Draw';
      if (Math.random() < 0.001) {
        document.querySelector("#winner").innerText = 'In war, there are no winners, only widows';
      }
    }
  });
