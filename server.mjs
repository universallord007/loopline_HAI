import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const users = new Map();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const eras = ["PAST", "NOW", "FUTURE"];
const verbs = ["SPLICE", "LIFT", "ANCHOR", "DECOY", "BOOST"];
const id = (n = 12) => randomBytes(n).toString("hex");
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const cleanName = (value) =>
  String(value || "Chrononaut")
    .replace(/[<>\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16) || "Chrononaut";
const makeCode = () =>
  Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

const coreNames = ["NOVA", "AFTERGLOW", "BLUE SHIFT", "ZERO POINT", "LUCID", "RED GIANT", "PARALLAX", "SUNDOG"];
const coreColors = ["#7ce8ff", "#ff946e", "#bb96ff", "#f8d76b", "#71f2c2", "#ff77b7", "#8fa7ff", "#f4a071"];

function makeLoop(room) {
  const count = Math.ceil(room.players.length / 2);
  const cores = Array.from({ length: count }, (_, i) => ({
    id: i,
    name: pick(coreNames) + (i > 0 ? `-${i + 1}` : ""),
    color: coreColors[(i + room.round * 2) % coreColors.length],
    safeEra: pick(["NOW", "FUTURE"]),
    stolen: false,
    by: null,
  }));
  const rules = room.round === 1
    ? [
        { title: "LUCID THREAD", text: "The first clean LIFT restores 1 stability.", kind: "lucid" },
        { title: "SOFT LANDING", text: "The first failed move costs no stability.", kind: "soft" },
      ]
    : room.round === 2
      ? [
          { title: "ECHO HEADSTART", text: "Ghosts act before the living crew in each time slice.", kind: "echoFirst" },
          { title: "AFTERIMAGE", text: "Ghosts act after the living crew in each time slice.", kind: "echoLast" },
        ]
      : [
          { title: "CAUSAL DRIFT", text: "Ghosts drift one slice forward. Matching their move adds Paradox.", kind: "drift" },
          { title: "INVERTED CAUSE", text: "Ghosts resolve in reverse player order. Matching their move adds Paradox.", kind: "reverse" },
        ];
  const rule = pick(rules);

  const echoEras = room.echoes.map((move) => move.era);
  const clueDeck = [
    "The splice gate is stable only in PAST.",
    ...cores.map((core) => `${core.name} survives the lift only in ${core.safeEra}.`),
  ];
  if (room.echoes.length) {
    const echo = pick(room.echoes);
    clueDeck.push(`Your memory catches ${echo.name}'s ghost: it will repeat ${echo.verb} in ${echo.era}.`);
  }
  if (room.round > 1 && echoEras.length) {
    const era = pick(echoEras);
    clueDeck.push(`An ANCHOR in ${era} erases every ghost passing through that slice.`);
  }
  room.players.forEach((player, index) => {
    player.memory = clueDeck[index % clueDeck.length];
    player.goal = pick([
      "You perform the splice that opens the vault.",
      `You personally lift ${cores[index % cores.length].name}.`,
    ]);
    if (room.round > 1 && room.echoes.length && Math.random() < 0.45) {
      const echo = pick(room.echoes);
      player.goal = `Anchor the ghost in ${echo.era}.`;
    }
    player.move = null;
    player.locked = false;
  });

  room.cores = cores;
  room.rule = rule;
  room.clues = clueDeck;
  room.outcome = null;
  room.phase = "planning";
  room.endsAt = Date.now() + 65000;
  room.paradoxThisLoop = 0;
  room.loopStartedAt = Date.now();
}

function actionResult(room, move, source, order) {
  const log = { ...move, source, order, result: "", paradox: 0 };
  if (move.verb === "SPLICE") {
    if (move.era !== "PAST") {
      log.result = "The gate rejected a late splice.";
      log.paradox = 1;
    } else if (room.gateOpen) {
      log.result = "The gate was already open; the duplicate splice fractures time.";
      log.paradox = 1;
    } else {
      room.gateOpen = true;
      room.spliceBy = move.playerId;
      log.result = "Gate open. The vault is exposed.";
    }
  } else if (move.verb === "LIFT") {
    const core = room.cores.find((item) => item.id === move.target);
    if (!core) {
      log.result = "No core matched the lift coordinates.";
      log.paradox = 1;
    } else if (!room.gateOpen) {
      log.result = `${core.name} hit a sealed vault.`;
      log.paradox = 1;
    } else if (core.safeEra !== move.era) {
      log.result = `${core.name} slipped through an unstable era.`;
      log.paradox = 1;
    } else if (core.stolen) {
      log.result = `A ghost already lifted ${core.name}; the duplicate tears the timeline.`;
      log.paradox = 1;
    } else {
      core.stolen = true;
      core.by = move.playerId;
      log.result = `${core.name} secured.`;
      room.playerStats[move.playerId].lifts += 1;
      if (room.rule.kind === "lucid" && !room.lucidEarned) {
        room.lucidEarned = true;
        room.stability = Math.min(8, room.stability + 1);
        log.result += " Lucid Thread +1 stability.";
      }
    }
  } else if (move.verb === "ANCHOR") {
    log.result = "Anchor field deployed.";
  } else if (move.verb === "DECOY") {
    room.stability = Math.min(8, room.stability + 1);
    log.result = "A false timeline absorbs the strain. +1 stability.";
    room.playerStats[move.playerId].decoys += 1;
  } else {
    room.score += 1;
    room.playerStats[move.playerId].boosts += 1;
    log.result = "A clean temporal shortcut. +1 chronon.";
  }
  if (log.paradox) {
    if (room.rule.kind === "soft" && !room.softUsed) { room.softUsed = true; log.paradox = 0; log.result += " Soft Landing absorbs the hit."; }
    room.paradoxThisLoop += log.paradox;
    room.stability = Math.max(0, room.stability - log.paradox);
    room.playerStats[move.playerId].paradox += log.paradox;
  }
  return log;
}

function resolve(room) {
  if (room.phase !== "planning") return;
  room.players.forEach((player) => {
    if (!player.move) {
      const ghostEra = (move) => room.rule?.kind === "drift" ? eras[(eras.indexOf(move.era) + 1) % eras.length] : move.era;
      const era = eras.find((slice) => !room.echoes.some((move) => ghostEra(move) === slice && ["DECOY", "BOOST"].includes(move.verb))) || "FUTURE";
      player.move = { verb: "BOOST", era, target: null, auto: true };
      player.locked = true;
    }
  });

  room.gateOpen = false;
  room.spliceBy = null;
  room.lucidEarned = false;
  room.softUsed = false;
  const log = [];
  const ghostMoves = room.echoes.map((move) => {
    const drift = room.rule.kind === "drift" ? eras[(eras.indexOf(move.era) + 1) % eras.length] : move.era;
    return { ...move, era: drift };
  });
  const currentAnchorers = new Map();
  room.players.filter((p) => p.move?.verb === "ANCHOR").forEach((p) => {
    if (!currentAnchorers.has(p.move.era)) currentAnchorers.set(p.move.era, []);
    currentAnchorers.get(p.move.era).push(p.id);
  });
  const anchors = new Set([...currentAnchorers.keys(), ...ghostMoves.filter((m) => m.verb === "ANCHOR").map((m) => m.era)]);
  let order = 0;
  const allEras = eras;
  for (const era of allEras) {
    const canceled = anchors.has(era) ? ghostMoves.filter((move) => move.era === era) : [];
    canceled.forEach((move) => {
      const anchorer = currentAnchorers.get(era)?.[0] || ghostMoves.find((candidate) => candidate.era === era && candidate.verb === "ANCHOR")?.playerId;
      if (move.verb === "ANCHOR") room.playerStats[move.playerId].anchors += 1;
      else if (anchorer) room.playerStats[anchorer].anchors += 1;
      log.push({ ...move, source: "ANCHOR", order: order++, result: move.verb === "ANCHOR" ? "Ghost anchor field cancels this slice." : "Ghost intercepted by an anchor field.", paradox: 0 });
    });
    const ghosts = ghostMoves.filter((move) => move.era === era && !anchors.has(era));
    const living = room.players.map((player, seat) => ({
      ...player.move,
      playerId: player.id,
      name: player.name,
      seat,
      era,
      source: "CREW",
    })).filter((move) => move.era === era);

    const runGhostsFirst = room.rule.kind === "echoFirst" || room.rule.kind === "drift" || room.rule.kind === "reverse";
    const orderedGhosts = room.rule.kind === "reverse" ? ghosts.slice().reverse() : ghosts;
    const sequence = runGhostsFirst
      ? [...orderedGhosts.map((m) => ({ ...m, source: "GHOST" })), ...living]
      : [...living, ...orderedGhosts.map((m) => ({ ...m, source: "GHOST" }))];

    for (const move of sequence) {
      if (move.source === "GHOST") {
        const core = room.cores.find((item) => item.id === move.target);
        if (move.verb === "SPLICE" && move.era === "PAST" && !room.gateOpen) {
          room.gateOpen = true;
          room.spliceBy = move.playerId;
          log.push({ ...move, source: "GHOST", order: order++, result: "Ghost splice opens the gate." });
        } else if (move.verb === "LIFT" && core && room.gateOpen && core.safeEra === move.era && !core.stolen) {
          core.stolen = true;
          core.by = move.playerId;
          room.playerStats[move.playerId].echoLifts += 1;
          let result = `Ghost crew secured ${core.name}.`;
          if (room.rule.kind === "lucid" && !room.lucidEarned) { room.lucidEarned = true; room.stability = Math.min(8, room.stability + 1); result += " Lucid Thread +1 stability."; }
          log.push({ ...move, source: "GHOST", order: order++, result });
        } else if (move.verb === "DECOY") {
          room.stability = Math.min(8, room.stability + 1);
          room.playerStats[move.playerId].decoys += 1;
          log.push({ ...move, source: "GHOST", order: order++, result: "Ghost decoy absorbs the strain. +1 stability." });
        } else if (move.verb === "BOOST") {
          room.score += 1;
          room.playerStats[move.playerId].boosts += 1;
          log.push({ ...move, source: "GHOST", order: order++, result: "Ghost shortcut banks +1 chronon." });
        } else {
          log.push({ ...move, source: "GHOST", order: order++, result: `Echo ${move.verb.toLowerCase()} passed through.` });
        }
        continue;
      }

      const collides = ["drift", "reverse"].includes(room.rule.kind) && ghosts.some((ghost) =>
        ghost.era === era && ghost.verb === move.verb && ghost.target === move.target);
      if (collides && !anchors.has(era)) {
        room.stability = Math.max(0, room.stability - 1);
        room.paradoxThisLoop += 1;
        room.playerStats[move.playerId].paradox += 1;
        log.push({ ...move, source: "CREW", order: order++, result: "Causal collision. Paradox +1.", paradox: 1 });
      } else {
        log.push(actionResult(room, move, "CREW", order++));
      }
    }
  }

  const stolen = room.cores.filter((core) => core.stolen).length;
  room.score += stolen * (room.round === 3 ? 2 : 1);
  room.stability = Math.max(0, room.stability - Math.max(0, room.cores.length - stolen));
  const earned = new Set(room.cores.filter((core) => core.stolen).map((core) => core.by));
  for (const player of room.players) {
    if (earned.has(player.id)) room.playerStats[player.id].contribution += 1;
  }
  room.players.forEach((player) => {
    const move = player.move;
    const successful = room.outcome === null
      ? (move.verb === "SPLICE" ? room.gateOpen && room.spliceBy === player.id
        : move.verb === "LIFT" ? room.cores.some((core) => core.by === player.id)
          : move.verb === "ANCHOR" ? anchors.has(move.era)
            : move.verb === "DECOY" || move.verb === "BOOST")
      : false;
    const goalWon = player.goal.startsWith("You perform the splice")
      ? room.gateOpen && room.spliceBy === player.id
      : player.goal.startsWith("You personally lift")
        ? room.cores.some((core) => core.by === player.id && core.name === player.goal.split("lift ")[1])
        : player.goal.startsWith("Anchor the ghost")
          ? anchors.has(player.goal.split("in ")[1])
          : false;
    if (goalWon) {
      room.playerStats[player.id].bonus += 1;
      room.score += 1;
    }
    if (successful) room.playerStats[player.id].cleanMoves += 1;
    player.goalWon = goalWon;
  });

  room.outcome = {
    log,
    cores: room.cores.map((core) => ({ ...core })),
    gateOpen: room.gateOpen,
    stolen,
    total: room.cores.length,
    success: stolen === room.cores.length,
    paradox: room.paradoxThisLoop,
    clues: room.players.map((player) => ({ name: player.name, memory: player.memory, goal: player.goal, goalWon: !!player.goalWon })),
    moves: room.players.map((player) => ({ id: player.id, name: player.name, ...player.move, goalWon: !!player.goalWon })),
    rule: room.rule,
    nextGhosts: room.players.map((player) => ({ playerId: player.id, name: player.name, verb: player.move.verb, era: player.move.era, target: player.move.target })),
  };
  room.history.push({ round: room.round, ...room.outcome });
  room.echoes = room.outcome.nextGhosts;
  room.phase = "reveal";
  room.endsAt = Date.now() + 12000;
}

function beginGame(room) {
  room.tutorialUsed = true;
  room.round = 0;
  room.score = 0;
  room.stability = 6;
  room.history = [];
  room.echoes = [];
  room.playerStats = Object.fromEntries(room.players.map((p) => [p.id, { lifts: 0, echoLifts: 0, anchors: 0, decoys: 0, boosts: 0, paradox: 0, contribution: 0, bonus: 0, cleanMoves: 0 }]));
  beginLoop(room);
}

function beginLoop(room) {
  room.round += 1;
  room.players.forEach((player) => { player.move = null; player.locked = false; player.goalWon = false; });
  makeLoop(room);
}

function finishGame(room) {
  const count = room.players.length;
  const maxScore = Math.ceil(count / 2) * 4 + count * 6;
  const thresholds = [Math.ceil(maxScore * 0.64), Math.ceil(maxScore * 0.4)];
  const successfulLoops = room.history.filter((loop) => loop.success).length;
  room.rating = room.score >= thresholds[0] && successfulLoops >= 2
    ? "TIMELINE LEGENDS"
    : successfulLoops >= 2 || room.score >= thresholds[1]
      ? "CLEAN GETAWAY"
      : "BARELY EXISTED";
  room.successfulLoops = successfulLoops;
  const stats = room.players.map((player) => ({ id: player.id, name: player.name, ...room.playerStats[player.id] }));
  room.winner = stats.slice().sort((a, b) => (b.bonus + b.contribution + b.cleanMoves) - (a.bonus + a.contribution + a.cleanMoves))[0]?.name || "The crew";
  const awards = [];
  const addAward = (title, field, icon) => {
    const winner = stats.slice().sort((a, b) => b[field] - a[field])[0];
    if (winner && winner[field] > 0) awards.push({ title, icon, name: winner.name, value: winner[field] });
  };
  addAward("Ghost Whisperer", "echoLifts", "◌");
  addAward("Paradox Wrangler", "anchors", "⌁");
  addAward("Vault Surgeon", "lifts", "✦");
  addAward("Timeline Menace", "paradox", "⚠");
  room.finalStats = stats;
  room.awards = awards;
  room.phase = "results";
  room.endsAt = 0;
}

function tick(room) {
  const now = Date.now();
  if (room.phase === "tutorial" && (room.players.every((player) => player.tutorialDone) || now >= room.endsAt)) beginGame(room);
  else if (room.phase === "planning" && now >= room.endsAt) resolve(room);
  else if (room.phase === "reveal" && now >= room.endsAt) {
    if (room.round < 3 && room.stability > 0) beginLoop(room);
    else finishGame(room);
  }
}

function publicRoom(room, token) {
  const me = room.players.find((player) => player.token === token);
  if (!me) return null;
  tick(room);
  const isReveal = room.phase === "reveal" || room.phase === "results";
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    endsAt: room.endsAt,
    stability: room.stability,
    score: room.score,
    hostId: room.hostId,
    players: room.players.map((player) => ({
      id: player.id, name: player.name, host: player.id === room.hostId,
      online: nowMs() - player.seen < 90000, locked: !!player.locked,
      memory: isReveal ? player.memory : undefined,
      goal: isReveal ? player.goal : undefined,
      goalWon: isReveal ? !!player.goalWon : undefined,
      stats: room.phase === "results" ? room.playerStats[player.id] : undefined,
    })),
    me: {
      id: me.id, token: me.token, name: me.name, host: me.id === room.hostId,
      memory: ["tutorial", "planning"].includes(room.phase) ? me.memory : undefined,
      goal: ["tutorial", "planning"].includes(room.phase) ? me.goal : undefined,
      move: room.phase === "planning" ? me.move : undefined,
      locked: !!me.locked,
      tutorialDone: !!me.tutorialDone,
      stats: room.phase === "results" ? room.playerStats[me.id] : undefined,
    },
    cores: ["planning", "reveal"].includes(room.phase) ? room.cores.map((core) => room.phase === "reveal" ? core : ({ id: core.id, name: core.name, color: core.color, safeEra: undefined })) : [],
    rule: room.rule,
    echoes: room.echoes.map((move) => ({ name: move.name, verb: move.verb, era: move.era, target: move.target })),
    outcome: isReveal ? room.outcome : null,
    history: room.phase === "results" ? room.history : undefined,
    rating: room.rating,
    successfulLoops: room.successfulLoops,
    winner: room.winner,
    awards: room.awards,
    finalStats: room.finalStats,
  };
}
function nowMs() { return Date.now(); }
const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
function accountForRequest(request) {
  const header = request.headers?.authorization || request.headers?.Authorization || "";
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const digest = hashToken(token);
  for (const user of users.values()) {
    if (user.sessionHash === digest && user.sessionExpires > Date.now()) return user;
  }
  return null;
}
function safeAccount(user) { return { id: user.id, username: user.username, displayName: user.displayName }; }
function passwordDigest(password, salt) { return scryptSync(password, salt, 64).toString("hex"); }
async function readBody(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (raw.length > 12000) throw new Error("Request too large");
  return raw ? JSON.parse(raw) : {};
}
function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}
function touch(room, player) {
  player.seen = Date.now();
  room.lastActivity = player.seen;
  if (room.hostId === player.id) room.hostSeen = player.seen;
}
function createPlayer(name, host = false) {
  return { id: id(6), token: id(18), name: cleanName(name), seen: Date.now(), tutorialDone: false, move: null, locked: false, memory: "", goal: "", host };
}
function resetForReplay(room) {
  room.phase = "lobby";
  room.round = 0;
  room.score = 0;
  room.stability = 6;
  room.history = [];
  room.echoes = [];
  room.outcome = null;
  room.rating = "";
  room.winner = "";
  room.awards = [];
  room.tutorialUsed = false;
  room.players.forEach((player) => {
    player.tutorialDone = false;
    player.move = null;
    player.locked = false;
    player.goalWon = false;
    player.memory = "";
    player.goal = "";
  });
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(path.join(root, "index.html")));
    }
    if (request.method === "GET" && url.pathname === "/style.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(path.join(root, "style.css")));
    }
    if (request.method === "GET" && url.pathname === "/loopline.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(path.join(root, "loopline.js")));
    }
    if (url.pathname === "/api/signup" && request.method === "POST") {
      const data = await readBody(request);
      const username = String(data.username || "").trim().toLowerCase();
      const password = String(data.password || "");
      if (!/^[a-z0-9_]{3,16}$/.test(username)) return sendJson(response, 400, { error: "Username must be 3–16 letters, numbers, or underscores." });
      if (password.length < 8 || password.length > 128) return sendJson(response, 400, { error: "Password must be 8–128 characters." });
      if (users.has(username)) return sendJson(response, 409, { error: "That username is already taken. Sign in or choose another." });
      const salt = randomBytes(16).toString("hex");
      const authToken = randomBytes(32).toString("base64url");
      const user = { id: id(12), username, displayName: cleanName(String(data.username || "")), salt, passwordHash: passwordDigest(password, salt), sessionHash: hashToken(authToken), sessionExpires: Date.now() + 30 * 86400000, failedAttempts: 0, lockedUntil: 0 };
      users.set(username, user);
      return sendJson(response, 201, { authToken, account: safeAccount(user) });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const data = await readBody(request);
      const username = String(data.username || "").trim().toLowerCase();
      const password = String(data.password || "");
      const user = users.get(username);
      if (user?.lockedUntil > Date.now()) return sendJson(response, 429, { error: "Too many sign-in tries. Wait 2 minutes and try again." });
      const digest = user && password.length <= 128 ? passwordDigest(password, user.salt) : "";
      const candidate = Buffer.from(digest || "0".repeat(128), "hex");
      const expected = Buffer.from(user?.passwordHash || "0".repeat(128), "hex");
      const ok = !!user && password.length <= 128 && timingSafeEqual(candidate, expected);
      if (!ok) {
        if (user) { user.failedAttempts = (user.failedAttempts || 0) + 1; if (user.failedAttempts >= 8) { user.lockedUntil = Date.now() + 120000; user.failedAttempts = 0; } }
        return sendJson(response, 401, { error: "Username or password is incorrect." });
      }
      user.failedAttempts = 0; user.lockedUntil = 0;
      const authToken = randomBytes(32).toString("base64url");
      user.sessionHash = hashToken(authToken); user.sessionExpires = Date.now() + 30 * 86400000;
      return sendJson(response, 200, { authToken, account: safeAccount(user) });
    }
    if (url.pathname === "/api/me" && request.method === "GET") {
      const user = accountForRequest(request);
      return user ? sendJson(response, 200, { account: safeAccount(user) }) : sendJson(response, 401, { error: "Sign in again to continue." });
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const user = accountForRequest(request);
      if (user) { user.sessionHash = ""; user.sessionExpires = 0; }
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === "/api/create" && request.method === "POST") {
      const account = accountForRequest(request);
      if (!account) return sendJson(response, 401, { error: "Sign in before starting a heist." });
      const data = await readBody(request);
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const player = createPlayer(account.displayName, true);
      player.accountId = account.id;
      const room = {
        code, phase: "lobby", round: 0, hostId: player.id, hostSeen: Date.now(), lastActivity: Date.now(),
        players: [player], stability: 6, score: 0, history: [], echoes: [],
        outcome: null, endsAt: 0, tutorialUsed: false, playerStats: {},
      };
      rooms.set(code, room);
      return sendJson(response, 200, { ...publicRoom(room, player.token), token: player.token });
    }
    if (url.pathname === "/api/join" && request.method === "POST") {
      const account = accountForRequest(request);
      if (!account) return sendJson(response, 401, { error: "Sign in before joining a heist." });
      const data = await readBody(request);
      const room = rooms.get(String(data.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
      if (!room) return sendJson(response, 404, { error: "Room not found. Check the four-letter code." });
      let player = room.players.find((item) => item.accountId === account.id);
      if (!player && data.token) {
        player = room.players.find((item) => item.token === data.token && !item.accountId);
        if (player) player.accountId = account.id;
      }
      if (!player) {
        if (room.phase !== "lobby") return sendJson(response, 403, { error: "This heist has started. Ask for the next room or replay." });
        if (room.players.length >= 8) return sendJson(response, 403, { error: "This crew is full (8 max)." });
        player = createPlayer(account.displayName);
        player.accountId = account.id;
        room.players.push(player);
      }
      touch(room, player);
      return sendJson(response, 200, { ...publicRoom(room, player.token), token: player.token });
    }
    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4})$/);
    if (match) {
      const account = accountForRequest(request);
      if (!account) return sendJson(response, 401, { error: "Sign in before returning to your heist." });
      const room = rooms.get(match[1]);
      if (!room) return sendJson(response, 404, { error: "Room expired." });
      if (request.method === "GET") {
        let player = room.players.find((item) => item.accountId === account.id);
        if (!player) {
          const legacyToken = url.searchParams.get("token");
          player = room.players.find((item) => item.token === legacyToken && !item.accountId);
          if (player) player.accountId = account.id;
        }
        if (!player) return sendJson(response, 403, { error: "You are not a member of this room. Join from the lobby." });
        touch(room, player);
        return sendJson(response, 200, publicRoom(room, player.token));
      }
      if (request.method === "POST") {
        const data = await readBody(request);
        let player = room.players.find((item) => item.accountId === account.id);
        if (!player) {
          player = room.players.find((item) => item.token === data.token && !item.accountId);
          if (player) player.accountId = account.id;
        }
        if (!player) return sendJson(response, 403, { error: "You are not a member of this room." });
        touch(room, player);
        if (player.lastAction && Date.now() - player.lastAction < 140) return sendJson(response, 429, { error: "Your last move is still landing." });
        player.lastAction = Date.now();
        if (data.action === "start" && room.phase === "lobby" && player.id === room.hostId) {
          if (room.players.length < 2) return sendJson(response, 409, { error: "Invite at least one more chrononaut before starting." });
          if (!room.tutorialUsed) {
            room.phase = "tutorial";
            room.endsAt = Date.now() + 20000;
            room.players.forEach((item) => { item.tutorialDone = false; });
          } else beginGame(room);
        } else if (data.action === "tutorialDone" && room.phase === "tutorial") {
          player.tutorialDone = true;
          if (room.players.every((item) => item.tutorialDone)) beginGame(room);
        } else if (data.action === "plan" && room.phase === "planning" && !player.locked) {
          const verb = String(data.verb || "").toUpperCase();
          const era = String(data.era || "").toUpperCase();
          const target = data.target === null ? null : Number(data.target);
          if (!verbs.includes(verb) || !eras.includes(era)) return sendJson(response, 400, { error: "Choose a move and a time slice." });
          if (verb === "LIFT" && (!Number.isInteger(target) || !room.cores.some((core) => core.id === target))) return sendJson(response, 400, { error: "Choose a core to lift." });
          if (verb !== "LIFT" && target !== null) return sendJson(response, 400, { error: "That move does not need a core target." });
          player.move = { verb, era, target, auto: false };
        } else if (data.action === "lock" && room.phase === "planning" && player.move) {
          player.locked = true;
          if (room.players.every((item) => item.locked)) resolve(room);
        } else if (data.action === "unlock" && room.phase === "planning") {
          player.locked = false;
        } else if (data.action === "replay" && room.phase === "results") {
          resetForReplay(room);
        } else {
          return sendJson(response, 409, { error: "That move is not available right now." });
        }
        return sendJson(response, 200, publicRoom(room, player.token));
      }
    }
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    sendJson(response, 400, { error: error instanceof SyntaxError ? "Invalid JSON." : "Invalid request." });
  }
}
const server = http.createServer(handleRequest);

function maintainRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    tick(room);
    const host = room.players.find((player) => player.id === room.hostId);
    if (!host || now - host.seen > 90000) {
      const next = room.players.filter((player) => now - player.seen < 90000).sort((a, b) => a.seen - b.seen)[0];
      if (next) { room.hostId = next.id; room.hostSeen = now; }
    }
    const lastActivity = room.lastActivity || Math.max(0, ...room.players.map((player) => player.seen || 0));
    if (now - lastActivity > 30 * 60 * 1000) rooms.delete(code);
  }
}

export { createPlayer, beginGame, beginLoop, resolve, finishGame, publicRoom, maintainRooms, rooms, users, handleRequest };
if (process.env.LOOPLINE_TEST !== "1" && process.env.VERCEL !== "1") {
  setInterval(maintainRooms, 500);
  const port = Number(process.env.PORT || 3001);
  server.listen(port, "0.0.0.0", () => console.log(`LOOPLINE online at http://localhost:${port}`));
}


