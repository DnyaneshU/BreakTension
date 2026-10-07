# BreakTension

**My browser won't work until I go outside, and a model running on my own laptop checks that I really did.**

Built for the Hacktoberfest 2026 Open-Source AI Challenge, Week 1 — *Touch Grass*.

---

## The problem with break reminders

Every break reminder I have ever installed failed the same way. It appears, I
click it away without reading it, and I keep sitting. The reminder was never
the missing piece. I knew I should get up. What I lacked was a reason I
couldn't dismiss in a quarter of a second.

So BreakTension removes the dismiss button.

After 35 minutes of active browsing, every tab goes dark. There is no
"later", no X in the corner, no Escape key. There is a task — *touch a leaf
and show two fingers* — and a QR code. You scan it, you walk outside, you take
the photo. Gemma, running locally through Ollama, decides whether you actually
went outside or just leaned toward the window. If it passes, your browser comes
back.

## How it works

```
┌─ Chrome Extension (MV3) ──────────┐
│  service worker: activity timer   │
│  content script: lock overlay+QR  │
└──────────┬────────────────────────┘
           │ https://localhost:8787 (HTTP + SSE)
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
      │ https://192.168.0.111:8787/capture?t=<token>
┌─────┴──────────┐
│  Phone browser │  live camera only
└────────────────┘
```

Everything in that diagram runs on one laptop and one phone on the same
Wi-Fi. There is no server in a datacenter, no account, no API key, and no
internet connection required at any point.

**The trust boundary matters.** The extension never unlocks because the phone
asked it to. The phone can only submit a photo against a single-use token the
server minted. Only the server — which holds the session and called Gemma —
can emit the unlock event. A forged message from a web page cannot skip the
capture step, and there is a test asserting exactly that.

## Why open innovation matters here

This is not a project where an open model was the cheaper option. It is one
where a closed model would have been the wrong thing to build.

**1. The data is the most invasive imaginable for this use case.** To verify a
break, the system needs photographs of your hands, your street, your garden,
your building — taken at intervals that reveal precisely when you are away
from your desk. Shipping that to someone else's server, continuously, all day,
would be indefensible. Running Gemma locally isn't a privacy feature bolted on
afterwards; it is the only version of this idea I was willing to run on my own
machine.

**2. It works where "go outside" actually takes you.** The point is to leave.
Basements, trails, parks with no signal, the dead patch behind my building. A
cloud round-trip fails exactly where the product is supposed to succeed. Local
inference means the verification happens on the laptop that is already sitting
on my desk, over my own Wi-Fi.

**3. Zero marginal cost makes the design possible.** At roughly 15 breaks a
day, a paid vision API would make this an expensive habit — and I would have
built in a cheaper, weaker check to compensate. Because inference is free, I
could afford to ask the model **four separate questions per photo** instead of
one. That turned out to be the difference between catching the central cheat
and missing it entirely (see below). An open model didn't just save money; it
bought a better anti-cheat design.

**4. The judge is editable text.** Every prompt is in
[`server/gemma.js`](server/gemma.js). Too strict? Edit it. Want a different
model? `BT_MODEL=llava:13b npm run server`. Think my glass detection is wrong?
The prompt, the thresholds, and the failing fixture are all right there in the
repo. None of that is possible against an endpoint you can only send requests to.

## The finding that changed the design

I assumed the hard part would be getting Gemma to recognise "outdoors". It
wasn't. The hard part was a prompt engineering failure I only caught because
I tested the attack instead of the happy path.

**The attack:** lean over, photograph the garden through the window, never
leave the chair. If that works, BreakTension is just a slow dismissible
reminder with extra steps.

My first prompt asked Gemma all six questions at once — is it outdoors, is it
through glass, is it a screen, was the task done, how confident are you, and
why. It read nicely. It also **detected the window photo 0 times out of 5.**

Asking the same model the same question *alone*, in one short sentence:

```
Where is the camera standing: outdoors in the open air, or indoors
looking out through a window? Look for a window frame, glazing bars,
or reflections on glass.
```

**3 out of 3 detections, with 0 false positives** on two genuine outdoor
photos. The model could always see the window frame. My long prompt was
drowning the signal.

So the verifier now asks four short questions in sequence — outdoors? through
glass? a screen? task done? — short-circuiting on the first failure, which
also makes the common rejection the fast one. The regression test asserts that
each prompt stays under 420 characters, because the thing that broke it was
length.

| | long combined prompt | four short prompts |
|---|---|---|
| Window photo detected | 0 / 5 | **3 / 3** |
| False positives on real outdoor photos | — | **0 / 3** |
| Time per judgement | 45s+ (timed out) | 8-24s, depending on how many stages run |

There was a second measurement in the same vein. `gemma4:e4b` supports a
thinking mode, and leaving it on cost **~24 seconds per judgement versus ~3
seconds off**, with no improvement in accuracy. When someone is standing in a
car park waiting to be let back into their browser, that is not a tuning
detail. Every request sends `think: false`.

## The escape hatches

A tool that locks your browser at the wrong moment gets uninstalled, and an
uninstalled tool prevents exactly zero minutes of sitting. So there has to be
a way out. But every way out is also a way to cheat, which means the design
question is not *whether* to have them but how to keep them from becoming a
dismiss button:

| Hatch | Limit | Why that limit |
|---|---|---|
| **Snooze** | 5 min, once per break | Long enough to finish a thought, too short to be useful as an escape |
| **Emergency skip** | 2 per day | Counted per local day and reset at midnight, so a bad afternoon doesn't become a bad week |
| **In a meeting** | 1 hour, self-expiring | See below |
| **Quiet hours** | configurable | 3am must never demand you go outside |

They appear on the lock screen itself, not only in the toolbar popup. The
person who genuinely cannot step outside right now is looking at the overlay;
sending them hunting through a menu is how this gets uninstalled.

None of them credits a break. A snooze or skip drops the server session, so
the token behind the QR immediately returns 410 — a hatch cannot be used to
bank a replayable unlock.

### What the spec asked for and didn't get

The spec called for detecting video calls from "active mic/camera capture
state, not hostname sniffing." **That turned out not to be implementable.**
No Manifest V3 API exposes a page holding a microphone or camera stream;
`chrome.tabCapture` reports only tabs captured *by an extension*, not a page
running its own call. Hostname sniffing was rejected in the spec and still
is — it misses self-hosted and less common tools.

So the shipped version is a manual toggle, which is honest and has no false
positives. Its real weakness is obvious: flip it, forget about it, and the
product goes quiet forever. That is answered with a **one-hour expiry** rather
than left standing.

## Honest limitations

I would rather state these than have you find them.

- **This is friction, not attestation.** A determined person can stand on a
  balcony, or photograph a convincing print. The goal was never unbeatable
  verification — it was to make cheating cost more than complying. One click
  became: pick up your phone, scan, walk to a door, perform a specific random
  gesture, and pass four checks.
- **Gemma is the single point of judgement.** It is a 6.6 GB open-weight model,
  not an oracle. It will sometimes reject a legitimate photo. That is why
  failures always explain themselves and retakes are unlimited.
- **The fixtures are synthetic.** The images in `test/fixtures/` are generated
  gradients, good enough to prove the model discriminates outdoor from indoor
  from through-glass. They are not photographs. One of them now trips the
  "photo of a screen" check *correctly*, because it genuinely is a flat
  computer-generated image.
- **Self-signed certificate.** `getUserMedia` requires a secure context, so
  the phone cannot open its camera over plain HTTP on the LAN. Your phone will
  show a certificate warning once, which you accept on your own device.
- **Peer review is not built.** An earlier design had strangers cross-checking
  each other's photos. I cut it deliberately — see below.

## What I cut, and why

The original concept had a social layer: after unlocking, you review two other
people's photos, and several "fake" votes against yours cost you a strike.

I built the local version instead, for reasons that held up under testing:

- A peer sees the **same single photo with less context** than the model, and
  their verdict arrives hours later. It cannot gate an unlock — only assign
  retroactive strikes, long after the cheater is back at their desk.
- The cheat it was meant to catch is the window photo, and that is now caught
  **locally, before you get back in** — not hours later by a stranger.
- It would mean uploading photographs of users' hands, homes and streets to a
  server, to catch something the local model already checks. That trade is bad
  on the merits, and it would have cost this project the only argument that
  makes it worth building.

Local hardening was both the achievable option and the better one.

## Setup

**Prerequisites:** [Ollama](https://ollama.com), Node 20+, and a phone on the
same Wi-Fi as your laptop.

```bash
# 1. Get the model (6.6 GB, runs on CPU, no GPU needed)
ollama pull gemma4:e4b

# 2. Start the verifier
npm run server
```

You should see:

```
  BreakTension server
  ├─ laptop : https://localhost:8787
  └─ phone  : https://192.168.0.111:8787
```

**3. Load the extension.** Open `chrome://extensions`, enable Developer mode,
click *Load unpacked*, and select the `extension/` folder.

**4. Try it without waiting 35 minutes.** Click the BreakTension icon →
*Take a break now*.

### Useful commands

```bash
npm test                                      # 137 tests, no framework
node scripts/verify-image.js photo.jpg        # judge any photo from the CLI
node scripts/verify-image.js --list-tasks     # see the task pool
BT_MODEL=llava:13b npm run server             # swap the model
BT_PORT=9000 npm run server                   # change the port
```

The CLI is the quickest way to see the model's reasoning:

```
$ node scripts/verify-image.js test/fixtures/through-window.png --task horizon-peace
through-window.png (85 KB)
task: Frame the horizon and make a peace sign
FAIL 23.7s (failed at: glass)
  outdoor=y glass=n screen=n task=n
  The image has a distinct frame and the view suggests looking through a
  window. Go all the way outside.
```

Note what happened there: the model agreed the scene *was* outdoors
(`outdoor=y`) and then caught that the camera wasn't (`glass`). That is the
window cheat being rejected, and it is the check the whole design turns on.

## Project layout

```
server/
  gemma.js      the judge: prompts, JSON contract, fail-closed error handling
  session.js    break state machine, single-use expiring tokens
  tasks.js      the gesture task pool
  net.js        picks the LAN interface a phone can actually reach
  certs.js      self-signed cert so the phone camera will open
  index.js      HTTPS server, SSE hub
  public/
    capture.html  the phone page — live camera only, no file input
extension/
  timer.js      activity accounting (pure, unit-tested)
  background.js MV3 service worker
  content.js    the lock overlay
  qr.js         QR rendering
scripts/
  verify-image.js   CLI harness
docs/superpowers/specs/
  2026-10-07-breaktension-design.md   the phase-by-phase spec
```

## Design notes worth stealing

A few things that are not obvious and cost me time to find:

- **`net.js` exists because this laptop lies.** It reports a WSL virtual
  adapter at `192.168.192.1` alongside real Wi-Fi at `192.168.0.111`. Taking
  the first interface encodes an unreachable address into the QR code and
  fails *silently* — the phone just spins. Virtual adapters are now ranked
  below real ones.
- **I wrote a QR encoder from scratch, then deleted it.** It produced a matrix
  that passed every structural check I could think of — right dimensions,
  finder patterns in all three corners — and decoded to an empty string in
  OpenCV. It would have died live in the demo. `test/qr.test.js` now renders
  the real output and decodes it with a real decoder on every test run.
- **MV3 service workers die after ~30 seconds idle.** No timer state can live
  in a closure. Everything is written to `chrome.storage` each tick, and
  `chrome.alarms` — not `setTimeout` — is what survives the teardown. There is
  a test that fails on any `setTimeout` longer than 5 seconds in the worker.
- **Everything fails closed.** Unreachable model, timeout, malformed JSON, a
  missing field — all reject. Failing open would quietly turn this back into a
  dismissible reminder, which is the one thing it must never be.
- **The capture page has no file input.** Not hidden, not discouraged —
  absent. A gallery photo is structurally impossible, not merely against the
  rules.

## License

MIT. Bundles [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(MIT) so the lock screen works with no network.
