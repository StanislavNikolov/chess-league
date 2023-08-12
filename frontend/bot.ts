const botId = window.location.pathname.split('/')[2];

function sanitizeHTML(text) {
  const element = document.createElement('div');
  element.innerText = text;
  return element.innerHTML;
}

interface Game {
  id: number;
  wid: number;
  bid: number;
  wname: string;
  bname: string;
  winner: "w" | "b" | "d";
  reason: string;
  started: string;
  elo_change: number;
};

interface Bot {
  name: string;
  elo: number;
  uploaded: string;
  games: Game[];
};

const $ = (s: string) => document.querySelector(s) as HTMLElement;

fetch(`/api/bot/${botId}/`)
  .then(res => res.json())
  .then(renderPage);

function renderPage(bot: Bot) {
  console.log(bot);
  $("#bot-name").innerText = bot.name;
  $("#bot-elo").innerText = bot.elo.toFixed(0) + " ELO";
  $("#bot-uploaded").innerText = `Uploaded on ${bot.uploaded}`;
  $("#game-counter").innerText = String(bot.games.length);

  let html = '';
  for (const game of bot.games) {
    html += `
      <div class="game" data-game-id="${game.id}">
        <span class="elo">${game.elo_change > 0 ? "+" : ""}${game.elo_change.toFixed(0)}</span>
        <a class="white name" href="/bot/${game.wid}/">${sanitizeHTML(game.wname)}</a>
        <a class="black name" href="/bot/${game.bid}/">${sanitizeHTML(game.bname)}</a>
        <span class="reason">${game.reason}</span>
        <span class="started">${game.started}</span>
      </div>
    `;
  }
  $("#game-list").innerHTML = html;
}

$("#game-list").addEventListener("click", ev => {
  const clickedGame = ev.target!.closest(".game");
  if (!clickedGame) return;
  const gameId = clickedGame.getAttribute("data-game-id");
  window.location.href = `/game/${gameId}/`;
})
