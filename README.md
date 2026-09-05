# Pocket Dealer

Two ways to run a Texas Hold'em night: virtual poker chips with real cards on
the table, or a complete card-dealing game on everyone's phone.

One person hosts, chooses a mode, reads out a six-character room code, and
everyone else joins from their own phone. The app tracks stacks, posts blinds,
runs the betting, builds side pots, and pays out.

Choose **Virtual chips** when the physical deck stays on the table; at showdown
the host selects each pot winner. Choose **Texas Hold'em** when the app should
deal private hole cards and the shared board, evaluate every hand, and award
main and side pots automatically.

---

## Play with your friends

### 1. Start it

```bash
npm install
```

```bash
npm run build && npm start
```

That serves everything — the app and the realtime connection — on
**one port, 8787**.

### 2. Let your friends reach it

**Same wifi?** Nothing else to do. Find your Mac's address:

```bash
ipconfig getifaddr en0
```

Give people `http://<that address>:8787`. Your Mac has to stay awake and the
app has to keep running.

**Not on the same wifi**, or you want it to just work? Put a tunnel in front:

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints a public `https://something.trycloudflare.com` address. That is the
link you send. It works from anywhere, and because it is HTTPS the "add to home
screen" step below works properly — some phone features, including keeping the
screen awake, only run on a secure connection.

> The free tunnel gets a new address every time you restart it. For a table
> that meets regularly, deploy instead (see below) and the link stops changing.

### 3. Everyone joins

One person taps **Host a game**, picks **Virtual chips** or **Texas Hold'em**,
then chooses blinds and a starting stack. They get a code like `NZ9-JBF`.
Everyone else opens the same link, taps **Join with code**, and types it. The
host can also tap **Share room code**, which sends a link that skips the typing.

Two players minimum, nine maximum. Then the host taps **Start game**.

### 4. Playing

Your phone shows the pot, everyone's stack, and whose turn it is. Buttons appear
**only when it is your turn** — Fold, Check/Call, and Bet/Raise with a slider.

In Virtual chips mode, everyone turns their cards over as usual and the **host**
taps the winner of each pot. Tap two names to split. In Texas Hold'em mode,
each player sees only their own hole cards while betting; the board appears as
the hand progresses and the server evaluates and awards every pot at showdown.

Between hands the host can **Adjust chips** for rebuys. Every rebuy is written
into the table log so nobody has to take anyone's word for it.

---

## Put it on your home screen

It is a web app, so there is no App Store and nothing to install — but it can
look and launch exactly like a native app.

**iPhone (Safari):** open the link → Share button → **Add to Home Screen**. You
get a spade icon on your home screen that opens full-screen with no browser
chrome.

**Android (Chrome):** open the link → menu → **Install app**.

This has to be done over HTTPS to work properly, which is another reason to use
the tunnel rather than a bare `http://192.168...` address.

The screen also stays awake during a hand, so your phone will not lock itself
between decisions.

---

## If someone's phone dies

Nothing is lost. Their seat, their stack and their place in the hand all stay
exactly where they were. They reopen the link and they are back in — the app
remembers who they are on that phone.

If a disconnected player is holding everyone up, the table gives them 45 seconds
and then checks for them if it is free, or folds them if it is not, and says so
in the log.

---

## Deploying it properly

Any host that runs Node and supports websockets works — Render, Railway, Fly.io.
Build command `npm run build`, start command `npm start`, and it reads `PORT`
from the environment. Nothing to configure and no database to set up.

Rooms live in memory and expire four hours after the last action, which is the
right lifetime for a poker night. Restarting the server clears every table.

---

## Development

```bash
npm run dev
```

Client on <http://localhost:5174> with hot reload, game server on 8787. Vite
proxies the websocket across, so you still only ever open one address. The dev
server binds to `0.0.0.0`, so you can point a real phone at
`http://<your-ip>:5174` and test on the actual device.

```bash
npm test
```

30 tests: the poker rules in `server/engine.test.ts`, and the multiplayer
contract — turn order, host permissions, double-tap rejection, reconnect — in
`server/server.test.ts`, which runs real clients against a real socket server.

### How it fits together

```
server/engine.ts   the poker. pure functions over a Room. no sockets.
server/rooms.ts    who is allowed to do what. room codes, hosts, timers.
server/index.ts    one http server: serves the built client, speaks websocket.
server/types.ts    the shared vocabulary. imported by both halves.
src/               the phone. renders whatever STATE it is sent.
design/            the original handoff and prototype, for reference.
```

The rule that holds it all together: **the client never computes anything about
money.** It sends "I want to fold" and renders whatever comes back. Stacks, the
pot, whose turn it is and who won are decided by the server and broadcast to
every phone. That is what stops the table from drifting out of sync, and what
means nobody can give themselves chips by editing their own screen.

Every action a phone sends carries the version of the table it was looking at.
If the table has moved on, the action is rejected instead of applied — so a
double-tap on a slow connection cannot fold the next player.

---

## What is not built

- **No hand history.** The log shows the recent action at the table and is gone
  when the room expires.
- **No accounts.** Identity is a random id stored on the phone. Clear your
  browser data and you are a new player.
- **The host is trusted.** They start hands, award pots and adjust chips —
  the same authority the person handling the chips has in real life. Every one
  of those actions is visible to everyone in the log.
