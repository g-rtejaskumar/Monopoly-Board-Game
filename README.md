# BoardQuest 🎲

A modern **3D multiplayer property-trading board game** — create a private room, share the
code, and play with friends in the browser. Built with React, TypeScript, Three.js
(react-three-fiber) and Vite, with a server-authoritative WebSocket backend.

## Screens

- **Landing** — animated hero with a floating 3D board, Play With Friends / Create / Join flows
- **Lobby** — live room code sharing, real-time player slots, ready-up, practice rivals
- **Game board** — isometric 3D board with 40 classic-layout tiles, tumbling dice, hopping pawns,
  turn system, title-deed buy modal, trading/mortgages/auctions, surprise events, game log and table chat

## Architecture

**Server-authoritative multiplayer.** The browser never decides anything the server hasn't
confirmed:

```
Browser A ─┐                                         ┌─ snapshot + events ─→ Browser A
Browser B ─┼─ WebSocket (/boardquest-ws) ─→ server/ ─┤
Browser C ─┘   (Vite dev proxy)    rooms.ts + index.ts   room state in memory
```

- `src/net/protocol.ts` — shared message contract (versioned), imported by client and server
- `server/rooms.ts` — `RoomManager`: room lifecycle, seats, ready flags, turn order, **dice
  generation and validation**, movement, money, buy/event resolution, bot rivals, disconnect
  reaping (lobby: 30 s, mid-game: 120 s) and reconnect via a persisted `playerId`
- `server/index.ts` — `ws` server on **:8787**, accepts `/ws` and `/boardquest-ws`
- `src/net/NetClient.ts` — one WebSocket per tab, auto-hello handshake, reconnect with the
  persisted `playerId`
- `src/net/NetContext.tsx` — React context: room/game snapshots, actions, connection status
- `src/net/netBoardStore.ts` — maps server snapshots onto the 3D scene's store interface
  (dice toss + tile-by-tile pawn hops animate from server events, identical on every screen)
- Demo/practice mode is preserved: rooms without a live server connection fall back to the
  original local bot experience, and the lobby still offers "Add practice rival".

Room state lives **in memory** — a server restart clears rooms. No database is required for
this milestone.

## Run it

```bash
npm install
npm run dev      # starts the WS server (:8787) + Vite dev server (:5173) together
```

Open http://localhost:5173 — create a game (or add a practice rival in the lobby) and roll.

## Test real multiplayer with two browsers

1. `npm run dev`
2. Open http://localhost:5173 in **two different browsers** (or one normal + one incognito).
3. Browser A: **Play With Friends** → enter name → **Create Game** → you're the host.
4. Copy the room code (or the invite link) from the lobby.
5. Browser B: **Join Game** → enter name + code (or just open the invite link) → **Ready up**.
6. Host clicks **Start Game**. Both screens now show the same board, players and turn.
7. Only the active player's browser shows **Roll Dice**; the roll is generated on the server
   and both browsers animate the same dice and pawn hops.
8. Close and reopen a tab mid-game — it rejoins its seat automatically via the saved
   `playerId`.

## Tests

```bash
npm run test:protocol   # 20 checks: two WS clients against the live server
npm run test:e2e        # 11 checks: two real browsers (Playwright) through the actual UI
```

`test:e2e` starts its own stack, so run it directly:

```bash
npx tsx scripts/test-e2e.ts
```

## Build

```bash
npm run build
npm run preview
```

## Deploy BoardQuest

BoardQuest is two deployable pieces:

| Piece | What it is | Where it runs |
|---|---|---|
| **Frontend** | React 19 + Vite static site (the 3D game) | Vercel / Netlify / any static host |
| **Realtime server** | Node.js WebSocket server (`server/index.ts`, state in memory) | Any host that allows **long-lived WebSocket connections**: Railway, Render, Fly.io, a VPS, or Docker |

> ⚠️ **Vercel cannot host the realtime server.** It serves static files and serverless
> functions — neither supports persistent WebSocket connections. Deploy the server
> separately and point the frontend at it with `VITE_WS_URL`.

### Environment files

| File | Purpose | Commit to GitHub? |
| --- | --- | --- |
| `.env.example` | General configuration template | Yes |
| `.env.local.example` | Local development template | Yes |
| `.env.production.example` | Production frontend template | Yes |
| `.env.local` | Real local values | **No** |
| `.env.production` | Real production values | **No** |

The `*.example` files contain **placeholders only** — never put real credentials in
them (and note that `VITE_*` variables are public by design anyway).

#### Local development

Copy the example, then run the existing development commands:

```bash
cp .env.local.example .env.local
npm run dev
```

(`.env.local` is ignored by Git — the `*.local` rule in `.gitignore`.)

#### Vercel

Set this in **Project → Settings → Environment Variables**:

```env
VITE_WS_URL=wss://YOUR-RENDER-SERVICE.onrender.com/ws
```

`VITE_WS_URL` is a build-time variable — **redeploy Vercel after adding or
changing it**, otherwise nothing changes.

#### Render

Do **not** set `VITE_WS_URL` on Render — the backend doesn't read it.
Render automatically provides:

```env
PORT
```

and `server/index.ts` uses that value (`0.0.0.0` binding, fallback 8787 locally).

### Architecture: who deploys what

```
User browser
    |
    | HTTPS
    v
Vercel                       (React/Vite frontend — src/, public/, SPA routes)
    |
    | WSS using VITE_WS_URL  (build-time env var)
    v
Render Node service          (npm start → server/index.ts)
    |
    v
WebSocket rooms and game state  (server-authoritative, in memory)
```

| Concern | Vercel deploys | Render deploys |
|---|---|---|
| What | React/Vite frontend: `src/`, `public/`, Vite build output (`dist/`), static assets, SPA routes | Node WebSocket server: `server/index.ts`, room management, server-authoritative game state, all WS messages |
| Command | `npm run build` → publishes `dist/` | `npm start` (runs `tsx server/index.ts`) |

Both services may use the **same GitHub repository** — they simply run different
commands. No `frontend/` or `backend/` folder split is needed.

### Frontend (Vercel)

```
Framework:        Vite (auto-detected)
Root directory:   blank
Install command:  npm install
Build command:    npm run build
Output directory: dist
```

1. Push this repo to GitHub/GitLab.
2. In Vercel: **Add New → Project** → import the repo. Settings above are in
   `vercel.json`; Vercel detects Vite automatically.
3. **Set the environment variable** — Project → Settings → Environment Variables:
   ```
   VITE_WS_URL = wss://your-render-service.onrender.com/ws
   ```
   Use `wss://` (TLS) in production — browsers block insecure `ws://` from `https://` pages.
   **`VITE_WS_URL` is a build-time variable baked into the bundle: after changing it you
   MUST redeploy the frontend** (no redeploy = no effect). Do not deploy without it: the
   client would otherwise show a "Multiplayer is not configured" banner instead of connecting.
   `VITE_*` variables are public by design — never put secrets in them.
4. Deploy. Direct routes (`/`, `/lobby/ABC123`, `/play/ABC123`, `/join?join=CODE`) work
   after refresh thanks to the SPA rewrite in `vercel.json`.
5. To test the production bundle locally first: `npm run build && npm run preview`.

### Realtime server (Render)

```
Service type:     Web Service
Language:         Node
Root directory:   blank
Build command:    npm install && npm run build
Start command:    npm start
```

- **Render provides `PORT`** and the backend reads `process.env.PORT` (fallback 8787 for
  local dev) — never hardcode the port. The server binds `0.0.0.0` so it is externally
  reachable, logs the listening port on boot, and shuts down cleanly on SIGTERM.
- The public backend URL converts to a WebSocket URL by swapping scheme and appending the
  socket path:
  ```text
  Backend HTTPS URL:     https://your-service.onrender.com
  Frontend WebSocket URL: wss://your-service.onrender.com/ws
  ```
- Production uses `wss://` (Render terminates TLS at the edge).
- **Free/low tiers may sleep or restart** the service; a restart clears all rooms (state
  is in memory by design — no database required). Players can re-create a room in seconds,
  but mid-game state is not recoverable.
- The backend keeps **persistent WebSocket connections** open (30 s heartbeat); Render
  Web Services support this natively — no extra configuration.
- Connection test from any machine: `npx wscat -c wss://your-service.onrender.com/ws`,
  then send `{"t":"hello","name":"tester"}` — you should get a `you` reply with a playerId.

### Connect frontend ↔ backend

1. Deploy the Render service, note its public URL, e.g. `https://your-service.onrender.com`.
2. Set `VITE_WS_URL = wss://your-service.onrender.com/ws` in Vercel.
3. **Redeploy the frontend** (Vite bakes `VITE_WS_URL` in at build time).

### Testing checklist

**Local (dev):**

```bash
npm run dev          # server :8787 + client :5173 in one command
```

- Open `http://localhost:5173` in two windows → create a room in one, join with the code in the other.
- Verify: shared lobby, shared dice, turn gating, chat, trades, auctions.
- Or run the automated suites: `npm run test:protocol` (two scripted clients) and
  `npm run test:e2e` (two real browsers via Playwright).

**Deployed (two different computers):**

1. Computer A: open the Vercel URL → create a room → copy the invite link.
2. Computer B: open the invite link → join.
3. Check both browsers show the same lobby, then start and verify identical dice,
   cash, and property ownership; make a trade; run an auction; check chat.
4. Reconnection: refresh mid-game on one side — the seat should recover within seconds.

### Production behaviour notes

- The client shows explicit **Online Multiplayer** / **Practice / Demo Mode** badges so
  it is always clear which experience you are in.
- If the game server is unreachable in production, the client shows an error banner and
  **does not silently switch to offline bots**. Practice mode remains available as an
  explicit option from the home page.
- Rooms are in memory: a server restart clears them. There is intentionally no database.

### Health endpoint & uptime

The game server exposes two plain HTTP endpoints on the same port as WebSocket traffic:

| Endpoint | Response |
|---|---|
| `GET /health` | `{"ok":true,"service":"boardquest-server","status":"healthy","timestamp":"…"}` — HTTP 200 |
| `GET /` | `{"service":"boardquest-server","status":"running"}` |

Both are fast, unauthenticated, and expose **no** secrets, rooms, players or env vars.
Use `/health` for uptime monitoring — **never monitor `/ws` with an HTTP monitor**
(it is a WebSocket endpoint, not an HTTP route).

Run a full read-only production connectivity check (health + WebSocket handshake):

```bash
npm run check:prod
# override the target if needed:
BQ_PROD_URL=https://your-service.onrender.com npm run check:prod
```

This is a manually-run command: it never creates rooms or mutates production state,
and an unreachable server must never fail a frontend build.

### Deployment diagnostics & troubleshooting

#### Render (backend)

- **Service type:** Web Service · **Build command:** `npm install && npm run build` ·
  **Start command:** `npm start`
- **`PORT`:** Render injects it automatically; the server reads `process.env.PORT`
  (fallback 8787 locally) and binds `0.0.0.0`. Never hardcode a port.
- **WebSocket URL for the frontend:** `wss://<your-render-service>.onrender.com/ws` —
  path is exactly `/ws`.
- **Health endpoint:** `https://<your-render-service>.onrender.com/health`
- **Logs:** Render Dashboard → your service → **Logs** tab. On boot you should see
  `realtime server listening on ws://0.0.0.0:<PORT>/ws`. Shutdowns log
  `SIGTERM received — shutting down`.
- **Cold starts:** free tiers sleep after ~15 min idle; the first request then takes
  up to ~50 s (see UptimeRobot below to mitigate).

#### Vercel (frontend)

- Required environment variable (Project → Settings → Environment Variables):
  ```env
  VITE_WS_URL=wss://monopoly-board-game.onrender.com/ws
  ```
- Vite env variables are **build-time** values baked into the bundle — after any
  change you must **redeploy** Vercel for it to take effect.
- Never commit real `.env` files; only `*.example` templates belong in the repo.

#### Browser troubleshooting

| Symptom | Where to look |
|---|---|
| Nothing happens after "Connecting…" | Open **DevTools → Console** for errors, then **Network tab** → filter **WS** → check the `/ws` entry's status (should be `101 Switching Protocols`) |
| WebSocket shows as failed/pending | Confirm the URL is `wss://…/ws` (not `http://` or missing `/ws`) |
| **Mixed-content error** in console | The page is HTTPS but `VITE_WS_URL` uses `ws://` — fix it to `wss://` and redeploy |
| "Multiplayer is not configured" banner | `VITE_WS_URL` missing/invalid in the deployed build — set it in Vercel and **redeploy** |
| Works locally, fails deployed | Check Render **Logs** for boot lines and restarts; confirm the Render service is awake (cold start delay up to ~50 s on free plans) |
| Connection drops mid-game | The client auto-reconnects with its saved `playerId`; seats are held 60 s mid-game |

### Keep Render awake (UptimeRobot)

Render free services sleep when idle. A lightweight external pinger keeps the
service warm and reduces cold starts:

1. Open [UptimeRobot](https://uptimerobot.com).
2. Create a **new HTTP(s) monitor**.
3. Monitor type: **HTTP(s)**.
4. Friendly name: `BoardQuest Render Health`.
5. URL:
   ```text
   https://monopoly-board-game.onrender.com/health
   ```
6. Monitoring interval: **5 minutes**, or the closest available interval.
7. Expected status: **HTTP 200**.
8. Save the monitor.
9. Confirm the endpoint returns a healthy response.

Important caveats:

- UptimeRobot **may reduce** Render sleeping/cold starts — it does **not** guarantee
  100% uptime.
- Render may still restart or sleep due to plan limits, deployments, errors, or
  platform policies.
- Keep `/health` lightweight — do not add logic to it.
- Do **not** monitor `/ws` as an HTTP monitor. Use `/health` for UptimeRobot.

### Deployment verification checklist

## Backend verification

- [ ] GitHub repository is up to date
- [ ] Render service created
- [ ] Build command succeeds
- [ ] `npm start` succeeds
- [ ] Render assigns and server reads `PORT`
- [ ] Backend is publicly reachable
- [ ] WebSocket endpoint uses `/ws`
- [ ] Backend logs show the listening port

## Frontend verification

- [ ] Vercel project created
- [ ] `npm run build` succeeds
- [ ] Output directory is `dist`
- [ ] `VITE_WS_URL` is configured
- [ ] Frontend redeployed after setting the variable
- [ ] Direct routes work after refresh
- [ ] No production localhost URL exists

## Real multiplayer verification

- [ ] Two different computers open the Vercel URL
- [ ] Player A creates a room
- [ ] Player B joins the room
- [ ] Both players see the same room
- [ ] Dice rolls synchronize
- [ ] Movement synchronizes
- [ ] Cash updates synchronize
- [ ] Property ownership synchronizes
- [ ] Rent transfers synchronize
- [ ] Chat synchronizes
- [ ] Refresh/reconnect works
- [ ] Practice mode remains separate

## Status — multiplayer milestone 1 ✅

- Two+ players join the same room from different browsers ✅
- Unique player IDs + display names ✅
- Real-time lobby ✅
- Host-gated start ✅
- Shared turn & game state ✅
- Only the active player can roll; dice generated **and validated server-side** ✅
- Movement + money synchronized ✅
- Leave/reconnect without corrupting the room ✅
- Bot/demo mode preserved ✅

Next: rent & trading, win conditions, spectator mode, and persistent rooms (database).
