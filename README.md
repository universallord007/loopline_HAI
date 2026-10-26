# LOOPLINE

A mobile-first co-op time heist for 2–8 players. Share private timeline clues, coordinate one action per player, and use the crew’s past moves as ghosts in the next loop.

## Play locally

Requires Node.js 20 or newer. From this folder run `npm start`, then open `http://localhost:3001` on each device on the same network (use the host computer’s LAN address for phones). Local rooms are held in memory and disappear when the server stops.

Run the included simulation with `npm test`. It exercises full three-loop games with 2 and 8 players, idle-player resolution, host reassignment, token reconnection, room expiry, and final ratings.

## Deploy to Vercel

1. Import this folder as the project root in Vercel. Choose **Other** as the framework preset; there is no build command and the output is this folder.
2. In the Vercel project, add an **Upstash Redis** database from the Storage/Marketplace panel and connect it to this project. The integration injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; do not put secrets in source code.
3. Redeploy after connecting storage. The `api/[...path].mjs` function serializes room mutations through Redis so separate serverless instances share authoritative game state.

Vercel functions do not share durable in-memory state between instances, so a connected Redis store is required for online multiplayer. The local `npm start` server remains self-contained and needs no Redis. Rooms expire after they have been inactive; this game stores no accounts or long-term player profiles.

## Controls

Create a room and share its four-character code or invite link. Everyone completes a short, skippable briefing; the host starts the run. Read your private memory aloud, agree on actions, and lock one move in one time slice before the countdown ends.
