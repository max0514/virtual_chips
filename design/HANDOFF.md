# Handoff: Pocket Dealer — Multiplayer Backend

## Overview
Pocket Dealer is a mobile web app that replaces physical poker chips for in-person Texas Hold'em. Cards stay on the physical table; the app is the dealer/banker: it tracks stacks, blinds, betting rounds, the pot (including side pots), and pays the winner.

A complete, fully playable **single-device** prototype already exists (see `Files`). It contains the entire game engine and every screen, working end to end. **The remaining work is the backend**: real rooms so each player joins from their own phone and all phones stay in sync.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly. The task is to **recreate these designs in the target codebase's environment** (React/Next.js, Vue, React Native, SwiftUI, etc.) using its established patterns and libraries. If no codebase exists yet, pick the most appropriate stack (recommendation below) and implement there.

The game logic inside `Virtual Dealer.dc.html` (the `Component` class) is, however, a **correct and directly portable reference implementation** — betting, min-raise, all-in, side-pot construction, blind rotation. Port it to the server rather than rewriting from scratch.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interactions. Recreate the UI pixel-accurately; exact tokens are listed under Design Tokens.

---

# Part 1 — What to build (backend)

## Goal
Replace the local `this.state` game in the prototype with an **authoritative server** game. Each player opens the app on their own phone, one hosts (gets a room code), the others join with that code. Every phone shows the same table state in real time, and each phone shows action buttons **only when it is that player's turn**.

## Recommended stack
- **Next.js (App Router) + TypeScript** for the client (the prototype is React-shaped already).
- **Realtime**: a single WebSocket server (Node + `ws` or Socket.IO). Rooms are small (2–9 players) and short-lived — an in-memory room map plus a periodic snapshot is sufficient; Redis only if you run more than one instance.
  - Serverless alternative: Supabase Realtime / Ably / Pusher with server-side "authoritative move" endpoints. Never let clients broadcast state directly.
- **Persistence**: optional. Rooms can be memory-only with a TTL. If you want reconnect-after-crash and hand history, store `rooms` and `hands` in Postgres (Supabase/Neon).
- **Auth**: none needed. Identity = a `playerId` (uuid) stored in the phone's `localStorage`, bound to a seat on join. This is what makes reconnect work.

## Authoritative-server rule (non-negotiable)
The client **never computes** stacks, pot, or whose turn it is. It sends intents (`FOLD`, `CHECK_CALL`, `RAISE`), the server validates against the current state, mutates, and broadcasts the new state. Clients render what they receive. This prevents desync and casual cheating (money is involved, even if it is friend money).

## Data model

```ts
type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

type Player = {
  id: string;          // uuid, stored in localStorage on the phone
  name: string;
  seat: number;        // 0..n-1, fixed for the session; seat order = table order
  stack: number;
  committed: number;   // chips put in on the CURRENT street
  total: number;       // chips put in during the WHOLE hand (drives side pots)
  folded: boolean;
  allIn: boolean;
  out: boolean;        // busted, no longer dealt in
  connected: boolean;  // socket presence, for the UI dot
};

type Pot = {
  amount: number;
  eligible: string[];  // playerIds who can win it
  winners: string[];   // set at award time
  awarded: boolean;
};

type Room = {
  code: string;              // 6 chars, e.g. "TBL742" — see Room codes
  hostId: string;
  status: 'lobby' | 'hand' | 'showdown' | 'handEnd' | 'gameOver';
  config: { smallBlind: number; bigBlind: number; startingStack: number; currency: 'chips'|'$'|'NT$' };
  players: Player[];
  dealerSeat: number;
  sbSeat: number; bbSeat: number;
  street: Street;
  handNo: number;
  currentBet: number;        // highest 'committed' this street
  minRaise: number;          // size of the last raise; next raise must be >= this
  actingSeat: number | null; // null when no one is to act
  actedSeats: number[];      // seats that have acted since the last raise
  pots: Pot[] | null;        // built at showdown
  lastAction?: { playerId: string; kind: string; amount?: number };
  version: number;           // increments on every mutation (see Ordering)
  updatedAt: string;
};
```

## Room codes
6 uppercase chars from an unambiguous alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no O/0/I/1). Collision-check against live rooms. Expire a room 4 hours after `updatedAt`. Display grouped as `TBL-742` style in the UI if you like, but treat the code as case-insensitive on input.

## Transport & message contract

Client → server:
```ts
{ t: 'CREATE_ROOM', name: string, config: RoomConfig, playerId: string }
{ t: 'JOIN_ROOM',   code: string, name: string, playerId: string }
{ t: 'REJOIN',      code: string, playerId: string }        // reconnect
{ t: 'LEAVE_ROOM',  code: string, playerId: string }
{ t: 'START_GAME',  code: string }                          // host only
{ t: 'ACTION',      code: string, handNo: number, version: number,
                    kind: 'FOLD' | 'CHECK_CALL' | 'RAISE', raiseTo?: number }
{ t: 'AWARD_POT',   code: string, potIndex: number, winnerIds: string[] } // host only
{ t: 'NEXT_HAND',   code: string }                          // host only
{ t: 'ADJUST_STACK', code: string, playerId: string, delta: number }      // host only, rebuy
```

Server → client:
```ts
{ t: 'STATE',  room: RoomView }        // full state, authoritative; client replaces local copy
{ t: 'ERROR',  code: 'ROOM_NOT_FOUND'|'ROOM_FULL'|'NAME_TAKEN'|'NOT_YOUR_TURN'
              |'ILLEGAL_RAISE'|'STALE_VERSION'|'NOT_HOST'|'GAME_ALREADY_STARTED', message: string }
{ t: 'PRESENCE', playerId: string, connected: boolean }
```

Send the **full state** on every change (a room is < 4 KB) — simplest and eliminates a whole class of bugs. Optimize to deltas only if profiling demands it.

## Ordering & idempotency
Every `ACTION` carries the `version` and `handNo` the client was rendering. Server rejects with `STALE_VERSION` if either has moved on. This makes double-taps and slow networks safe: the second tap is rejected rather than folding the next player.

## Server-side rules to implement
Port these from the prototype's `Component` class — the shapes match deliberately.

1. **Blinds** (`startHand`): post small and big blind from stacks; heads-up (2 players) the **dealer posts the small blind**; 3+ the seat after the dealer does. `currentBet = bigBlind`, `minRaise = bigBlind`. First to act pre-flop is the seat after the big blind (skipping folded/all-in/out); post-flop it's the first live seat after the dealer.
2. **Legal actions** for the acting player, where `toCall = currentBet - committed`:
   - `FOLD` always legal.
   - `CHECK_CALL`: check when `toCall === 0`; otherwise call `min(toCall, stack)` (a short call is an all-in).
   - `RAISE`: `raiseTo` must be `>= currentBet + minRaise` **or** exactly `committed + stack` (all-in under-raise is legal). Max is `committed + stack`. Round to the small-blind increment. On a full raise, set `minRaise = raiseTo - currentBet`, `currentBet = raiseTo`, and reset `actedSeats = [raiser]` — everyone owes another decision.
3. **Street completion**: the street ends when every live, non-all-in player has both acted since the last raise and matched `currentBet`. Then zero all `committed`, reset `currentBet = 0` and `minRaise = bigBlind`, clear `actedSeats`, advance the street.
4. **Everyone folded**: if only one live player remains at any point, award the entire pot immediately and go to `handEnd` — no showdown.
5. **All-in run-out**: if fewer than 2 players can still act, skip remaining betting and go straight to `showdown`.
6. **Side pots** (`buildPots`): take the distinct `total` values of everyone who put money in, ascending. For each level, the pot layer is the sum over players of `max(0, min(total, level) - previousLevel)`; eligible players are the un-folded players with `total >= level`. Merge adjacent layers that have identical eligibility. Auto-award any pot with exactly one eligible player (uncalled bet returned).
7. **Awarding**: the **host** taps the winner(s) of each pot (the app doesn't read cards — players compare hands physically). Split = `floor(amount / winners)` each, remainder chips to the winner closest to the left of the dealer (the prototype gives it to the first selected; the odd-chip rule is the correct fix). When all pots are awarded, move to `handEnd`.
8. **Next hand**: mark `stack === 0` players `out`, advance `dealerSeat` to the next non-out seat, deal again. If fewer than 2 remain, `gameOver`.
9. **Rebuys**: host-only `ADJUST_STACK` while in `lobby` or `handEnd` (never mid-hand). Clears `out` if the stack goes positive.

## Disconnects
Presence is cosmetic — a disconnected player keeps their seat and stack. If the acting player is disconnected, start a **45-second turn timer**; on expiry, auto-`CHECK` if free, otherwise auto-`FOLD`, and broadcast the reason so the table can see why. Show a grey dot next to disconnected players. `REJOIN` with the stored `playerId` restores the seat silently.

## Trust boundary
The host has extra powers (start, award pots, adjust stacks) — that mirrors the real-world dealer role and is correct here. Do enforce it server-side (`NOT_HOST`), and show every host banking action in the table's action log so it is visible to all players.

## Suggested build order
1. WebSocket server + room create/join/lobby, no game logic. Two phones see each other in a lobby.
2. Port the hand engine (`startHand`, action validation, `afterAction`, `buildPots`) to the server. Cover it with unit tests before touching the UI: heads-up blinds, min-raise re-raise, short-call all-in, three-way side pot, everyone-folds.
3. Wire the client screens to `STATE`; render actions only when `actingSeat === mySeat`.
4. Reconnect + turn timer.
5. Optional: hand history, rebuys, blind timer.

## Definition of done
Three phones join one room code; a hand plays out with a raise, a call, a fold, and an all-in that creates a side pot; the host awards both pots; chips reconcile (total chips in play is constant except for rebuys); one phone can background/kill the browser mid-hand and rejoin at the same seat.

---

# Part 2 — The design

## Screens / Views
All screens live inside a 390 × 780 phone frame (iPhone-class), single column, background `#FBFAF8`, 32 px corner radius. Content padding is 24 px horizontal unless noted. A 44 px status bar sits at the top: left = time, right = context label, `600 12px`, color `#B5AFA5`.

> The prototype also renders a **simulator bar above the phone** for switching between players on one device. It is a demo affordance only — **do not build it**. Delete it once real rooms exist.

### 1. Home
Purpose: choose to host or join.
Layout: vertically centered, 28 px horizontal padding, 40 px bottom padding.
- Spade glyph `♠`, `font-size: 40px`, line-height 1.
- Title "Pocket / Dealer", `800 32px/1.05`, `letter-spacing: -0.8px`, 18 px above / 8 px below.
- Subtitle "The chips live here. / The cards stay on the table.", `400 15px/1.5`, `#8A857C`, 36 px bottom margin.
- Button stack, `gap: 10px`: primary "Host a game" (56 px tall, radius 16, bg `#191919`, white, `600 16px`); secondary "Join with code" (same metrics, transparent, 1.5 px border `rgba(0,0,0,.18)`, text `#191919`).

### 2. Host setup
Purpose: name, blinds, starting stack, then create the room.
- Header row, `gap: 12px`: 38 × 38 back button (radius 12, 1 px border `rgba(0,0,0,.14)`, white) + "Host a game" `700 20px`.
- Sections `gap: 22px`. Each label: `600 11px`, uppercase, `letter-spacing: 1px`, `#8A857C`, 8 px above its control.
- Text input: full width, 14 px / 16 px padding, radius 14, 1 px border `rgba(0,0,0,.15)`, white, `500 16px`, no outline. Placeholder `#B5AFA5`.
- Blinds and stack are 4-up grids (`gap: 8px`) of 46 px chips, radius 12. Options: blinds 1/2, 2/5, 5/10, 10/25; stack 500, 1k, 2k, 5k. Unselected = white with 1.5 px `rgba(0,0,0,.14)`; selected = `#191919` bg, white text.
- "Create room" primary button pinned to bottom (`margin-top: auto`).

### 3. Join
Same header pattern. Room-code field: 18 px padding, radius 14, white, centered `700 26px`, `letter-spacing: 6px`. Name input as above. "Join table" primary at bottom. (Backend: validate the code on submit and surface `ROOM_NOT_FOUND` / `ROOM_FULL` / `NAME_TAKEN` inline under the field in `#B3402E`.)

### 4. Lobby
- Centered code block: label "ROOM CODE" (`600 11px`, uppercase, `letter-spacing: 1.5px`, `#8A857C`); code `800 34px`, `letter-spacing: 8px`; meta line "Blinds 5 / 10 · Stack 1,000" `400 13px` `#8A857C`.
- Player list card: white, radius 16, 1 px border `rgba(0,0,0,.1)`. Rows 13 px / 16 px padding, 1 px bottom divider `rgba(0,0,0,.06)`, `gap: 12px`: 36 px circular avatar (`#EAE6DE`, initial `700 14px`), name `600 15px` with a `500 11px` `#8A857C` tag ("Host"), right-aligned stack `600 14px` tabular-nums.
- Replace the prototype's "+ Simulate a player joining" dashed button with a **share affordance**: "Share room code" (same 48 px dashed style) triggering the Web Share API with the join URL.
- Bottom: helper "Need at least 2 players to start" (`500 12px`, `#8A857C`) + "Start game" primary at 0.35 opacity when fewer than 2 players. **Host-only** — other phones show "Waiting for host to start…".

### 5. Table (the main screen)
Top meta row (6 px / 22 px padding, space-between, all `600 11px`, `letter-spacing: 1px`): room code `#B5AFA5` · street pill ("PRE-FLOP", 5/12 px padding, radius 999, 1 px border `rgba(0,0,0,.14)`, `700 11px` uppercase `letter-spacing: 1.5px`) · "HAND 3" `#B5AFA5`.

Pot block, centered, 18 px top / 14 px bottom: "POT" label (`600 11px`, uppercase, `letter-spacing: 2px`, `#8A857C`); amount `800 42px/1.1`, `letter-spacing: -1px`, tabular-nums; "Blinds 5 / 10" `400 12px` `#8A857C`. Animate pot changes with a 200 ms count-up.

Seat list: 16 px side margins, white card, radius 16, 1 px border `rgba(0,0,0,.09)`. Rows 11 px / 14 px padding, `gap: 10px`, divider `rgba(0,0,0,.05)`:
- 26 px circular role badge, 1.5 px border, `700 9px`: "D" / "SB" / "BB"; empty roles keep the circle but border `rgba(0,0,0,.1)` and transparent text (keeps rows aligned).
- Name `600 14px`, suffixed "(you)" on your own row; a 6 px `#2E9E6B` dot with a 1.2 s pulse marks the acting player.
- Sub-line `500 12px` `#8A857C`: stack, or "Folded" / "All-in" / "Out".
- Right: chips committed this street, `700 14px` `#0E5A3C`, blank at zero.
- Acting row background `#F0F4EF`; folded/out rows `opacity: 0.35`.

Action bar, bottom-pinned, white, 1 px top border `rgba(0,0,0,.08)`, 16 px / 20 px / 22 px padding:
- Row: "YOUR STACK" label + `800 26px` amount; right "To call 40" `600 13px` `#8A857C`.
- **Your turn**: three buttons 54 px tall, radius 14, `gap: 8px`, `600 15px` — "Fold" (flex 1, transparent, 1.5 px `rgba(179,64,46,.45)`, text `#B3402E`), "Check"/"Call n"/"All-in n" (flex 1.25, transparent, 1.5 px `rgba(0,0,0,.2)`), "Bet"/"Raise" (flex 1.25, `#191919`, white).
- **Not your turn**: 52 px `#F2F0EB` panel, centered `600 14px` `#8A857C`, pulsing green dot: "Waiting for Sam…" / "You're all-in".
- **Folded**: same panel, "You folded this hand".
- **Raise sheet** (replaces the buttons): amount `800 32px` centered; range slider stepped by the small blind, min = `currentBet + minRaise`, max = your committed + stack, `accent-color: #191919`; 4-up preset grid (38 px, radius 10, white, 1 px `rgba(0,0,0,.16)`, `600 12px`): Min, ½ pot, Pot, All-in; then "Cancel" (flex 1, bordered) + "Raise to n" (flex 2, `#0E5A3C`, white), both 52 px.

### 6. Showdown (host phone)
Title "Showdown" `800 24px`; helper `400 13px/1.5` `#8A857C`: "Compare hands at the table, then tap the winner of each pot. Tap two names to split."
One card per pot: white, radius 16, 16 px padding, 1 px `rgba(0,0,0,.1)`. Header row: "MAIN POT" / "SIDE POT 1" (`600 12px`, uppercase, `letter-spacing: 1px`, `#8A857C`) + amount `800 22px`. Candidate pills (`gap: 8px`, wrap): 10 px / 16 px, radius 999, `600 13px`; unselected white with 1.5 px `rgba(0,0,0,.16)`, selected `#0E5A3C` bg + white. "Award pot" button 46 px, radius 12, `#0E5A3C`, 0.35 opacity until a selection exists. Awarded pots collapse to "→ Rosa & Leo" in `600 14px` `#0E5A3C`.
Non-host phones show the same pot amounts read-only with "Waiting for host to award…".

### 7. Hand result
Centered `♠` (30 px) + result line `800 22px/1.3` ("Rosa wins 480"). Then the standings card (same row anatomy as the lobby; tags "Busted" / "Dealer"; busted rows `opacity: 0.4`). "Next hand →" primary pinned to bottom (host-only; others see "Waiting for next hand…").

### 8. Game over
Centered: `♠` 40 px, `800 28px` "Ming wins it all", `400 14px` `#8A857C` "takes the whole table", "New game" button (54 px, 36 px horizontal padding, radius 16, `#191919`).

## Interactions & Behavior
- Navigation is a single `status`/screen switch — no routing needed beyond a `/join/:code` deep link for shared codes.
- Acting-player dot: `opacity` 1 → 0.3 → 1, 1.2 s, infinite.
- Action buttons appear **only** when `actingSeat === mySeat`; everyone else sees the waiting panel. Disable all buttons for 300 ms after a tap and until the next `STATE` arrives to prevent double actions.
- Raise slider snaps to small-blind increments; presets clamp into `[min, max]`.
- All amounts `font-variant-numeric: tabular-nums`.
- Errors: transient toast above the action bar, `#B3402E` text on white, 3 s.
- Mobile viewport: `viewport-fit=cover`, respect `env(safe-area-inset-bottom)` on the action bar. Prevent double-tap zoom. Consider a `wake lock` during a hand so screens don't sleep at the table.
- Haptic `navigator.vibrate(30)` when it becomes your turn (Android); a subtle sound is optional and should default off.

## State Management
Client state is thin: `{ playerId, roomCode, room: RoomView | null, pending: boolean, error }`. All game state comes from `STATE`. Derive per-render: `mySeat`, `isMyTurn`, `toCall`, `canCheck`, `raiseMin`, `raiseMax`, `potTotal`. Persist only `playerId` and the last `roomCode` in `localStorage` (for `REJOIN`). Never persist chip counts client-side.

## Design Tokens
Colors
- Page background `#EDEBE6`
- Surface / phone `#FBFAF8`; card `#FFFFFF`
- Ink `#191919`; secondary text `#8A857C`; tertiary / placeholder `#B5AFA5`; muted body `#5A554C`
- Accent green `#0E5A3C`; live-status green `#2E9E6B`; acting-row tint `#F0F4EF`
- Danger `#B3402E`
- Neutral fill `#F2F0EB`; avatar fill `#EAE6DE`
- Borders `rgba(0,0,0,.05)` / `.06` / `.09` / `.1` / `.14` / `.15` / `.16` / `.18` / `.2`

Typography — **Schibsted Grotesk** (Google Fonts), weights 400/500/600/700/800
- Display 32–42px / 800 / `letter-spacing: -0.5…-1px`
- Title 20–28px / 800
- Body 15px / 400 / 1.5
- Label 11px / 600 / uppercase / `letter-spacing: 1–2px`
- Button 15–16px / 600
- Numerals always tabular

Spacing: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 22 / 24 / 28 / 36 px
Radius: 10 (preset) / 12 (small button) / 14 (input, action button) / 16 (card, primary button) / 32 (phone) / 999 (pill)
Shadow: phone frame only — `0 24px 60px -30px rgba(0,0,0,.3)`

## Assets
None. The only graphic is the Unicode spade `♠` (U+2660). Font loads from Google Fonts. No icon library required; if you add icons, use a 1.5 px-stroke outline set at 20 px to match.

## Files
- `Virtual Dealer.dc.html` — the source prototype. Markup is the visual spec; the `Component` class is the portable game engine (`startHand`, `act`, `afterAction`, `buildPots`, `award`, `nextHand`).
- `PocketDealer.html` — self-contained build; open it in a browser to play the reference implementation end to end. **Start here** to understand the intended flow.
- `support.js` — prototype runtime only. Not part of the handoff; do not port.
