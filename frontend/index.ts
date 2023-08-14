import "chessboard-element";

const $ = s => document.querySelector(s);

function sanitizeHTML(text) {
  const element = document.createElement('div');
  element.innerText = text;
  return element.innerHTML;
}

interface MyBots {
  id?: number;
  name?: string;
  email?: string;
  bots: number[];
}
let globalMyBots: MyBots = { id: null, name: null, bots: [] };

interface Dev {
  id: number;
  name: string;
  elo: number;
}

interface OldGame {
  id: number;
  wid: number;
  wname: string;
  bid: number;
  bname: string;
  winner: "w" | "b" | "d";
  reason: string;
};

interface Bot {
  id: number;
  name: string;
  elo: number;
};
let globalBots: Bot[] = [];

function renderLeaderboardItem(place: number, name: string, elo: number, href: string) {
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

function renderEditableLeaderboardItem(place: number, name: string, elo: number, id: number, href: string) {
  let icon = `<b>${place}</b>`
  if (place <= 3) {
    icon = `<img src="/public/medal-${place}.svg"></img>`
  }

  return `
    <div class="my-bot" href="${href}" data-bot-id="${id}">
      <a href="${href}" class="leaderboard-item">
        <span class="place">${icon}</span>
        <span>${sanitizeHTML(name)}</span>
        <span class="elo">${elo.toFixed(0)} ELO</span>
      </a>
      <a class="delete">❌</a>
    </div>
  `;
}

function renderOldGame(g: OldGame) {
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

function renderLiveGame(g) {
  return `
    <div data-game-id=${g.id} class="live-game">
      <div class="name">${sanitizeHTML(g.bname)} <span class="elo">${g.belo.toFixed(0)}</span></div>
      <chess-board position=${g.fen}></chess-board>
      <div class="name">${sanitizeHTML(g.wname)} <span class="elo">${g.welo.toFixed(0)}</span></div>
    </div>
  `;
}

function rerenderAllBots() {
  $("#bot-list").innerHTML = globalBots
    .map((bot, idx) => renderLeaderboardItem(idx + 1, bot.name, bot.elo, `/bot/${bot.id}/`))
    .join('');

  if (globalMyBots.id != null) {
    $("#my-bot-list").innerHTML = globalBots
      .map((bot, idx) => { bot.origIdx = idx; return bot; })
      .filter(b => globalMyBots.bots.includes(b.id))
      .map(bot => renderEditableLeaderboardItem(bot.origIdx + 1, bot.name, bot.elo, bot.id, `/bot/${bot.id}/`))
      .join('');
  }
}

async function updateBotLeaderboard() {
  const req = await fetch('/api/bots/')
  globalBots = await req.json() as Bot[];
  rerenderAllBots();
  setTimeout(updateBotLeaderboard, 2000);
}

async function updateDevLeaderboard() {
  const req = await fetch('/api/devs/');
  const devs = await req.json() as Dev[];

  $('#dev-list').innerHTML = devs
    .map((dev, idx) => renderLeaderboardItem(idx + 1, dev.name, dev.elo, `/dev/${dev.id}/`))
    .join('');

  setTimeout(updateDevLeaderboard, 2000);
}

async function updateOldGames() {
  const req = await fetch('/api/old-games/')
  const games = await req.json() as OldGame[];
  $('#old-games').innerHTML = games.map(renderOldGame).join('');
  setTimeout(updateOldGames, 2000);
}

async function updateLiveGames() {
  const req = await fetch('/api/live-games/')
  const games = await req.json();

  for (const drawnGame of document.querySelectorAll("[data-game-id]")) {
    const gameId = Number(drawnGame.getAttribute("data-game-id"));
    if (!games.find(g => g.id === gameId)) drawnGame.removeAttribute("data-game-id");
  }

  for (const g of games) {
    const existingEl = document.querySelector(`[data-game-id="${g.id}"]`);
    // Try to update the already rendered board.
    if (existingEl) {
      existingEl.querySelector('chess-board')!.setPosition(g.fen);
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

  setTimeout(updateLiveGames, 500);
};

async function updateMyBots() {
  const req = await fetch('/api/my-bots/')
  globalMyBots = await req.json();

  if (!globalMyBots.id) {
    $("#my-bot-list").innerHTML = `
      <div id="login-info"> If you have uploaded any bots, <a id="login-txt">click here</a> to log in and see them.</div>`;

    $("#login-txt").addEventListener("click", () => $("#login").showModal());
  } else {
    // No need to allow editing the name and email if the user is logged in.
    $("input[name='devname']").value = globalMyBots.name;
    $("input[name='devname']").disabled = true;
    $("input[name='email']").value = globalMyBots.email;
    $("input[name='email']").disabled = true;

    rerenderAllBots();
  }
}


updateMyBots();
updateLiveGames();
updateOldGames();
updateDevLeaderboard();
updateBotLeaderboard();

$("#timer-content").innerHTML = ((new Date('2023-10-01') - new Date()) / (1000 * 60 * 60 * 24)).toFixed(0);

$("#open-upload-dialog").addEventListener("click", () => {
  $("#compilation-message").classList.toggle('hidden', true);
  $("dialog").showModal();
});

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();

  $('button[type="submit"]').disabled = true;

  // Loading the form data from the form does not work for disabled inputs.
  const formData = new FormData();
  formData.append("devname", $("[name='devname']").value);
  formData.append("email", $("[name='email']").value);
  formData.append("botname", $("[name='botname']").value);
  formData.append("code", $("[name='code']").value);

  const req = await fetch("/api/upload/", { method: "POST", body: formData });
  const resp = await req.text();

  $('button[type="submit"]').disabled = false;

  if (req.ok) {
    await updateMyBots();
    $("dialog").close();
  } else {
    $("#compilation-message").classList.toggle('hidden', false);
    $("#compilation-message code").innerText = resp;
  }
});

$("#faq-btn").addEventListener("click", () => {
  $("#faq").showModal();
});

$("#my-bot-list").addEventListener("click", async (ev) => {
  if (!ev.target.classList.contains("delete")) return;
  const botId = ev.target?.closest(".my-bot").getAttribute("data-bot-id");
  await fetch(`/api/bot/${botId}/`, { method: "DELETE" });
  await updateMyBots();
});