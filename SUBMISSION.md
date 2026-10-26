# LOOPLINE — HAI submission notes

**One-line pitch:** A co-op time heist where your crew’s failed plans return as ghosts, and private clues have to be spoken aloud to steal a vault across three timelines.

**Players:** 2–8, on separate phones or browsers.

**What makes it social:** Each player receives a different memory, so the route is only solvable when the crew shares information. Everyone locks a move and time slice; the server resolves the timeline together. Old actions echo into later rounds, turning yesterday’s plan into today’s obstacle or tool.

**What makes runs vary:** Procedurally generated cores, safe time slices, private memories, bonus goals, and round rules. The third loop raises the stakes and doubles score.

**Technical design:** Three.js space-vault backdrop, mobile-first HTML/CSS interface, server-authoritative Node.js game engine, 900 ms phase/state polling, four-character invite rooms, reconnect tokens, host reassignment, AFK resolution, and room expiry. For Vercel, an API function persists and serializes room updates through Upstash Redis.

**Run:** `npm start` from this directory, then open `http://localhost:3001`.
