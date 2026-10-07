# BreakTension — Design Spec

**Date:** 2026-10-07
**Deadline:** 2026-10-11 (Hacktoberfest Open-Source AI Challenge, Week 1 — "Touch Grass")
**Status:** Approved for implementation

## One line

My browser won't work until I go outside, and a local open-weight model checks that I really did.

## The problem

Developers and students sit for hours without moving. Break reminders fail
because they are dismissible: one click and you are back in the chair. The
failure is not that people lack reminders — it is that the reminder costs
nothing to ignore.

BreakTension makes the cost real. At 35 minutes of active browsing, every tab
is covered. The only way through is a photo, taken outdoors on your phone,
of your hand performing a randomly assigned gesture — judged by Gemma running
locally on your own laptop.

## Why open innovation matters here

This section drives the DEV writeup, which is the most heavily weighted
judging criterion. The argument is not "open models are nice" but "this
project is only possible because the model is open":

1. **The data is the user's face, hands, home, and street.** A closed API
   would mean uploading continuous photographic evidence of where someone
   lives and when they are away from their desk. That is the single most
   invasive possible dataset for this use case. Local inference is not a
   cost optimization — it is the only ethically shippable design.
2. **It works with no internet.** The verification runs on a trail, in a
   park, in a basement flat with bad signal. A cloud-dependent version
   fails exactly where "go outside" takes you.
3. **It costs nothing per break.** 20+ verifications a day × every user
   would be prohibitive on a paid vision API. At zero marginal cost, the
   product can be aggressive about frequency.
4. **The judge is swappable and inspectable.** The prompt, the model, and
   the thresholds are all editable text. A user who finds it too strict
   edits the prompt. That is not possible against a closed endpoint.

## Scope decisions

**Peer review is cut from v1 and documented as future work.** It requires a
hosted multi-user backend, identity, photo storage, and moderation — plus
actual other users, without whom the queue is empty. It also directly
contradicts the privacy argument above. Design retained in Appendix A.

**Anti-cheat is friction, not attestation.** Gemma can be fooled by a
balcony or a convincing photo-of-a-photo. The honest claim, which the
writeup will make explicitly, is that this raises the cost of cheating
above the cost of complying. Unbeatable verification is not achievable
locally and is not the goal. The window-photo cheat specifically is
addressed by local hardening in Phase 4, not by peer review — see that
phase for the reasoning.

## Verified environment

Confirmed on this machine 2026-10-07, not assumed:

| Component | Version | Note |
|---|---|---|
| Ollama | 0.35.0 | already serving on `:11434` |
| Model | `gemma4:e4b` (6.6 GB) | **vision confirmed** by live image test |
| Node | v24.19.0 | npm 12.0.2 |
| Python | 3.13.3 | not required, available |
| LAN IP | `192.168.0.111` | phone reaches laptop over Wi-Fi |

**Critical API detail:** `gemma4:e4b` returns a `message.thinking` field
alongside `message.content`. Parsers must read `content` only. Ignoring this
breaks JSON extraction.

**Measured latency (Phase 1).** Thinking mode costs ~24s per judgement
versus ~3s with `think: false`, with no gain in accuracy; the full
six-field prompt exceeded a 45s timeout with thinking on. All requests
send `think: false`, `temperature: 0` and `num_predict: 200`. End-to-end
judgement on the fixtures is ~8s. Latency is a product requirement, not an
optimization — someone is standing outside waiting to be let back in.

Request shape (verified working):

```
POST http://localhost:11434/api/chat
{ "model":"gemma4:e4b", "stream":false,
  "messages":[{"role":"user","content":"<prompt>","images":["<base64, no data: prefix>"]}] }
```

## Architecture

Three local processes. No internet, no accounts, no external service.

```
┌─ Chrome Extension (MV3) ──────────┐
│  service worker: activity timer   │
│  content script: lock overlay+QR  │
└──────────┬────────────────────────┘
           │ localhost:8787 (HTTP + SSE)
┌──────────▼────────────────────────┐
│  Node verifier server             │
│   • /capture  → phone page        │
│   • /verify   → Gemma call        │
│   • /events   → SSE unlock push   │
└──────────┬────────────────────────┘
           │ localhost:11434
┌──────────▼────────────────────────┐
│  Ollama · gemma4:e4b (local)      │
└───────────────────────────────────┘
      ▲
      │ http://192.168.0.111:8787/capture?t=<token>
┌─────┴──────────┐
│  Phone browser │  getUserMedia, live camera only
└────────────────┘
```

**Why a local server rather than extension-only:** a phone cannot reach a
Chrome extension's pages, and MV3 service workers are terminated after ~30s
idle — unsuitable for holding a 35-minute timer or pending verification. The
server owns session state; the extension owns the lock.

**Trust boundary:** the extension never unlocks on the phone's word. Only the
server emits unlock events, and only after Gemma passes. Tokens are
single-use and expire.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/session.js` | session state machine, token mint/burn | — |
| `server/gemma.js` | Ollama client, prompt, JSON parse | Ollama |
| `server/tasks.js` | gesture task pool, random assignment | — |
| `server/index.js` | HTTP routes, SSE hub, static serving | all above |
| `server/public/capture.html` | phone camera UI | server |
| `extension/background.js` | activity timer, SSE client, lock orchestration | server |
| `extension/content.js` | full-page overlay, QR render | background |
| `extension/options.html` | interval, work hours, model config | — |

Each is independently testable. `session.js`, `tasks.js`, and `gemma.js`
have no DOM or Chrome dependency and are unit-tested directly.

## Phases

Sized against 4 remaining days, ordered so that a demo exists after Phase 3
and everything later is additive. Each phase ends in a working, committed,
verifiable state.

### Phase 1 — Verification core (local, headless)

**Goal:** prove the hard part works before any UI exists. Gemma correctly
distinguishes outdoor from indoor photos and detects assigned gestures.

Deliverables:
- Node project, no runtime dependencies beyond the standard library
- `server/gemma.js` — Ollama client; strict JSON contract; handles the
  `thinking` field; timeout and model-missing errors
- `server/tasks.js` — task pool (e.g. "touch a leaf and show 2 fingers"),
  deterministic under an injected RNG for tests
- `server/session.js` — state machine: `idle → due → pending → verified`,
  single-use tokens, expiry
- `scripts/verify-image.js` — CLI: judge any image file, print the verdict
- Test suite, run with `node --test`, no framework
- Fixture images: outdoor pass, indoor fail, window fail

Verification: unit tests green; CLI returns `outdoor: true` on a real
outdoor photo and `false` on an indoor one.

**Exit criteria:** `node --test` passes and the CLI gives correct verdicts on
all three fixtures.

### Phase 2 — Phone capture + LAN handoff

- `/capture?t=<token>` serves the camera page; token validated server-side
- `getUserMedia` with `facingMode: environment`, **live stream only** — no
  file input, so gallery photos are structurally impossible
- POST frame → `/verify` → Gemma → verdict returned with a human reason
- Retake loop on failure, showing Gemma's stated reason
- Server binds `0.0.0.0` so the phone reaches it; LAN IP auto-detected
- Self-signed HTTPS, because `getUserMedia` requires a secure context on
  a non-localhost origin (this is a known trap and is handled here)

**Exit criteria:** phone opens the page over Wi-Fi, captures, and receives a
correct verdict from Gemma.

### Phase 3 — Extension + lock (demoable end to end)

- MV3 extension; activity timer counting only active browsing
- At threshold: content script covers all tabs, shows task text + QR
- QR encodes the LAN capture URL with the session token
- SSE client in the service worker; unlock on server event
- Keep-alive strategy for the service worker (chrome.alarms, not setTimeout)
- Outdoor duration reported on unlock

**Exit criteria:** full loop with no manual steps — work 35 min (or trigger
manually), tabs lock, scan, go outside, photo, tabs unlock.

### Phase 4 — Escape hatches + strict mode

**Strict mode** addresses the window-photo cheat: leaning over and shooting
the garden through the glass without leaving the chair. This is the central
attack on the product — if it works, BreakTension is just a slow dismissible
reminder.

Peer review was considered as the defense and rejected. The reasoning, which
belongs in the writeup:

- Gemma already checks `through_glass` as a dedicated pass condition, and it
  detected the difference correctly in Phase 1 testing. Reflections, frames,
  blinds and sills are visually loud — this is one of the easier calls.
- A peer sees the *same single photo* with *less* context, and their verdict
  arrives hours later. It cannot gate an unlock, only assign retroactive
  strikes. The cheater is already back at their desk.
- It would mean uploading photos of the user's hands, street and home to a
  server, to catch something the local model checks. That trade is bad on
  the merits and destroys the privacy argument.

Local hardening is stronger *and* instant:

- **Two frames, a few seconds apart, from different angles.** A window shot
  cannot produce genuine parallax against a nearby frame; stepping outside
  and pivoting does. Gemma compares them for consistent scene geometry.
- **Random gesture assigned at lock time** (already built in Phase 1) means
  a stored photo cannot match.
- **Shadow and lighting coherence** — a hand lit by direct sun with a cast
  shadow is hard to fake through glass.

Escape hatches, so it is usable rather than a toy:

- Snooze 5 minutes, once per cycle
- 2 emergency skips per day, persisted
- Quiet hours / work-hours window, configurable
- Defer while a video call is active — detected via active mic/camera
  capture state, not by hostname sniffing
- Options page for all of the above

**Exit criteria:** each hatch demonstrably works and persists across a
browser restart.

### Phase 5 — Writeup + demo

Highest-weighted criterion, explicitly budgeted rather than left to the end:
- README: architecture diagram, setup, model swap instructions
- DEV post built on the four arguments above
- Demo recording of a real break, taken outside
- Honest limitations section, including defeatability

**Exit criteria:** post drafted with `#devchallenge` `#hf26challenge`, demo
recorded, repo public.

## Gemma JSON contract

```json
{
  "outdoor": true,
  "through_glass": false,
  "task_done": true,
  "screen_photo": false,
  "confidence": 0.0,
  "reason": "short human-readable explanation"
}
```

Pass requires `outdoor && task_done && !through_glass && !screen_photo`.
`reason` is surfaced verbatim to the user on failure so the retake is
actionable. Malformed output is treated as a failure with a retry, never as
a pass — failing closed matters because failing open defeats the product.

## Error handling

| Failure | Behavior |
|---|---|
| Ollama down | Lock screen states it plainly; offers a manual override that is logged as unverified rather than silently unlocking |
| Model not pulled | Setup instructions with the exact `ollama pull` command |
| Gemma malformed JSON | One retry, then fail closed with the reason shown |
| Inference timeout (>30s) | Fail closed, offer retake |
| Token expired | Phone page shows "expired, rescan" |
| Phone off Wi-Fi | Capture page unreachable; lock screen shows the URL as text to type |

## Testing

- `session.js`, `tasks.js`: pure unit tests, injected RNG and clock
- `gemma.js`: tested against recorded Ollama responses; one live
  integration test, skipped when Ollama is absent
- Fixtures: outdoor / indoor / through-window images
- Extension: manual checklist per phase; timer logic extracted into a
  pure module and unit-tested apart from Chrome APIs

TDD per `superpowers:test-driven-development` — tests precede implementation
for all non-UI modules.

## Appendix A — Peer review (deferred)

Retained for the writeup's future-work section. Design was: on unlock, review
two other users' photos (Legit/Fake, ~10s); your own photo is later reviewed
by several peers; a fake consensus yields a strike; strikes cost emergency
skips for several days.

Requires: hosted backend, identity, photo storage with retention policy,
moderation for abuse, and a user base. Deliberately out of v1 scope — both
for time and because shipping users' outdoor photos to a server contradicts
the privacy argument that makes the local-first version worth building.
