import "chessboard-element";

const $ = s => document.querySelector(s);

function sanitizeHTML(text) {
  const element = document.createElement('div');
  element.innerText = text;
  return element.innerHTML;
}

function renderLeaderboardItem(place, name, elo, href) {
  let icon = `<b>${place}</b>`
  if (place <= 3) {
    icon = `<img src="/public/medal-${place}.svg"></img>`
  }

  return `
    <a class="leaderboard-item" href="${href}">
      <span class="place">${icon}</span>
      <span>${sanitizeHTML(name)}</span>
      <span class="elo">${elo.toFixed(0)} ELO</span>
    </a>
  `;
}

function updateBotLeaderboard() {
  fetch('/api/bots/')
    .then(req => req.json())
    .then(bots => {
      let html = '';
      for (let i = 0; i < bots.length; i++) {
        html += renderLeaderboardItem(i + 1, bots[i].name, bots[i].elo, `/bot/${bots[i].id}/`);
      }
      $('#bot-list').innerHTML = html;
    });

  setTimeout(updateBotLeaderboard, 2000);
}

function updateDevLeaderboard() {
  fetch('/api/devs/')
    .then(req => req.json())
    .then(devs => {
      let html = '';
      for (let i = 0; i < devs.length; i++) {
        html += renderLeaderboardItem(i + 1, devs[i].name, devs[i].elo, "");
      }
      $('#dev-list').innerHTML = html;
    });

  setTimeout(updateDevLeaderboard, 2000);
}

function renderGame(g) {
  return `
    <a class="game" href="/game/${g.id}/">
      <span class="bot white">
        ${g.winner === 'w' ? '<span class="crown w"></span>' : ''}
        ${sanitizeHTML(g.wname)}
      </span>
      <span class="bot black">
        ${sanitizeHTML(g.bname)}
        ${g.winner === 'b' ? '<span class="crown b"></span>' : ''}
      </span>
    </a>
  `;
}

function updateOldGames() {
  fetch('/api/old-games/')
    .then(req => req.json())
    .then(games => {
      let html = '';
      for (const g of games) {
        html += renderGame(g);
      }
      $('#old-games').innerHTML = html;
    });

  setTimeout(updateOldGames, 2000);
}

function renderLiveGame(g) {
  return `
    <div data-game-id=${g.id} class="live-game">
      <div class="name">${sanitizeHTML(g.bname)} <span class="elo">${g.belo.toFixed(0)}</span></div>
      <chess-board position=${g.fen}></chess-board>
      <div class="name">${sanitizeHTML(g.wname)} <span class="elo">${g.welo.toFixed(0)}</span></div>
    </div>
  `;
}

function updateLiveGames() {
  fetch('/api/live-games/')
    .then(req => req.json())
    .then(games => {
      for (const drawnGame of document.querySelectorAll("[data-game-id]")) {
        const gameId = Number(drawnGame.getAttribute("data-game-id"));
        if (!games.find(g => g.id === gameId)) drawnGame.removeAttribute("data-game-id");
      }

      for (const g of games) {
        const existingEl = document.querySelector(`[data-game-id="${g.id}"]`);
        // Try to update the already rendered board.
        if (existingEl) {
          existingEl.querySelector('chess-board').setPosition(g.fen);
          continue;
        }

        // Try to find an empty board to connect to - we do that to minimize the flashes
        const candidate = document.querySelector(".live-game:not([data-game-id])");
        if (candidate) {
          candidate.outerHTML = renderLiveGame(g);
          continue;
        }

        // Last resort - make a new square.
        $('#live-games').innerHTML += renderLiveGame(g);
      }

      // There is a bug with the chess-board library. It has an element
      // taking space that shouldn't exist.
      setTimeout(() => {
        for (const cb of document.querySelectorAll('chess-board')) {
          cb.shadowRoot.querySelector('#dragged-pieces')?.remove();
        }
      }, 0);
    });

  setTimeout(updateLiveGames, 500);
};

updateLiveGames();
updateBotLeaderboard();
updateDevLeaderboard();
updateOldGames();

$("#timer-content").innerHTML = ((new Date('2023-10-01') - new Date()) / (1000 * 60 * 60 * 24)).toFixed(0);

$("#open-upload-dialog").addEventListener("click", () => {
  $("#compilation-message").classList.toggle('hidden', true);
  $("dialog").showModal();
});

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();

  $('button[type="submit"]').disabled = true;

  const formData = new FormData($("form"));
  const req = await fetch("/api/upload/", {
    method: "POST",
    body: formData,
  });
  const resp = await req.text();

  $('button[type="submit"]').disabled = false;

  if (req.ok) {
    $("dialog").close();
  } else {
    $("#compilation-message").classList.toggle('hidden', false);
    $("#compilation-message code").innerText = resp;
  }
});

$("#faq-btn").addEventListener("click", () => {
  $("#faq").showModal();
});