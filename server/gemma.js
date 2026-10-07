/**
 * The judge.
 *
 * Talks to Gemma through Ollama on localhost. Nothing leaves the machine —
 * that is the point of the project, not an optimization.
 *
 * Two things about this integration are easy to get wrong and are handled
 * here deliberately:
 *
 *  1. `gemma4:e4b` returns BOTH `message.thinking` and `message.content`.
 *     The reasoning text frequently contains JSON-ish fragments and stray
 *     booleans. Parsing it instead of `content` yields wrong verdicts that
 *     look plausible. We read `content` only.
 *
 *  2. Everything fails closed. An unreachable model, a timeout, or garbled
 *     output all produce a FAIL. Failing open would silently turn the whole
 *     product back into a dismissible reminder.
 */

export const PASS = true;
export const FAIL = false;

const OLLAMA_URL = process.env.BT_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.BT_MODEL ?? 'gemma4:e4b';
const TIMEOUT_MS = Number(process.env.BT_TIMEOUT_MS ?? 30_000);

/** Booleans sometimes arrive as the strings "true"/"false". */
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null; // unknown — caller decides, and callers fail closed
}

/** Pull the first balanced JSON object out of arbitrary model prose. */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Turn raw model text into a verdict.
 *
 * A photo passes only when it is outdoors, not through glass, not a picture
 * of a screen, and the assigned task was performed. Any field we cannot read
 * is treated as a failure.
 */
export function parseVerdict(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';

  if (!text) {
    return verdict({ ok: FAIL, reason: 'The model returned nothing. Try again.' });
  }

  const obj = extractJsonObject(text);
  if (!obj) {
    return verdict({
      ok: FAIL,
      reason: 'Could not read the model\'s answer. Try the photo again.',
      raw: text.slice(0, 300),
    });
  }

  const outdoor = asBool(obj.outdoor);
  const throughGlass = asBool(obj.through_glass);
  const taskDone = asBool(obj.task_done);
  const screenPhoto = asBool(obj.screen_photo);

  // Fail closed: a missing field is not a pass.
  const ok =
    outdoor === true &&
    taskDone === true &&
    throughGlass === false &&
    screenPhoto === false;

  const modelReason =
    typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;

  return verdict({
    ok,
    outdoor: outdoor ?? false,
    through_glass: throughGlass ?? true,
    task_done: taskDone ?? false,
    screen_photo: screenPhoto ?? true,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    reason: modelReason ?? defaultReason({ outdoor, throughGlass, taskDone, screenPhoto }),
  });
}

function defaultReason({ outdoor, throughGlass, taskDone, screenPhoto }) {
  if (outdoor === false) return 'That does not look like it was taken outdoors.';
  if (throughGlass === true) return 'That looks like it was taken through a window. Go all the way outside.';
  if (screenPhoto === true) return 'That looks like a photo of a screen.';
  if (taskDone === false) return 'The task was not done. Check the instruction and retake.';
  if (outdoor === null || taskDone === null) return 'The model\'s answer was incomplete. Try again.';
  return 'Verification failed.';
}

function verdict(fields) {
  return {
    ok: FAIL,
    outdoor: false,
    through_glass: true,
    task_done: false,
    screen_photo: true,
    confidence: null,
    reason: 'Verification failed.',
    ...fields,
    reason: typeof fields.reason === 'string' && fields.reason ? fields.reason : 'Verification failed.',
  };
}

/** The prompt. Edit it freely — that is the advantage of an open model. */
export function buildPrompt(task) {
  const check = task?.check ?? 'the assigned task was performed';

  return `You are verifying that someone actually went outside, away from their desk.

Look at this photo and judge it strictly but fairly.

The assigned task was: ${check}

Answer these questions:
- outdoor: Is this genuinely outdoors, under open sky? Natural daylight, sky, plants, ground, street or buildings seen from outside all count. An indoor room, desk, office or car interior does NOT count.
- through_glass: Was this taken through a window, windscreen or glass door? Look for reflections, frames, blinds or sills. Taking a photo of the outside from indoors does not count as going outside.
- screen_photo: Is this a photograph of a screen, monitor, phone or printed picture rather than a real scene? Look for pixel moire, screen glare, bezels or flat uniform lighting.
- task_done: Was the assigned task performed? (${check})
- confidence: Your confidence from 0.0 to 1.0.
- reason: One short sentence, addressed to the person, explaining your decision. If you are rejecting it, say exactly what to fix.

Reply with ONLY a JSON object, no other text:
{"outdoor": true/false, "through_glass": true/false, "screen_photo": true/false, "task_done": true/false, "confidence": 0.0, "reason": "..."}`;
}

/**
 * Ask Gemma to judge one photo.
 *
 * `fetchImpl` is injected so tests never touch the network.
 */
export async function judge({ imageB64, task, fetchImpl = fetch, model = MODEL, url = OLLAMA_URL }) {
  // Ollama wants bare base64; a data: URL prefix makes it reject the image.
  const image = String(imageB64 ?? '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');

  if (!image) {
    return verdict({ ok: FAIL, reason: 'No photo was received. Try again.' });
  }

  const body = {
    model,
    stream: false,
    // Thinking mode costs ~24s per judgement on this model versus ~3s without,
    // measured on the Phase 1 fixtures, with no gain in verdict quality. The
    // user is standing outside waiting to get back in, so latency is a feature.
    think: false,
    options: { num_predict: 200, temperature: 0 },
    messages: [{ role: 'user', content: buildPrompt(task), images: [image] }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetchImpl(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return verdict({
      ok: FAIL,
      reason: aborted
        ? 'The model took too long to answer. Try again.'
        : `Could not reach Ollama at ${url}. Is it running?`,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = res.status === 404 ? `Model "${model}" is not available.` : `status ${res.status}`;
    return verdict({
      ok: FAIL,
      reason: `Ollama could not judge the photo (${detail}). Run: ollama pull ${model}`,
    });
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return verdict({ ok: FAIL, reason: 'Ollama returned a response that could not be read.' });
  }

  // `content` only — never `thinking`. See the note at the top of this file.
  const content = payload?.message?.content ?? '';
  return parseVerdict(content);
}

// ───────────────────────────────────────────────────────────────────────────
// Two-stage judge
//
// Measured on the Phase 1 fixtures: asking all six questions in one prompt
// made Gemma answer `through_glass: false` on an image with an obvious
// window frame. Asking about glass ALONE got it right — and still correctly
// said `false` for a genuine outdoor photo. The model can see the frame; the
// combined prompt was diluting its attention across six questions.
//
// So we ask twice. Stage 1 is authenticity: are you actually outside, and is
// this a real scene? Stage 2 is the gesture. Stage 1 short-circuits, which
// also makes the common rejection the fast one.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stage 1a: glass.
 *
 * MEASURED: the long checklist prompt that asked about frames, bars,
 * reflections, haze, bezels and lighting all at once detected the window
 * fixture 0/5 times. This short, single-question prompt detects it 3/3 with
 * 0/3 false positives on two genuine outdoor photos. Brevity is the fix —
 * resist the urge to add bullet points here.
 */
export function buildGlassPrompt() {
  return 'Where is the camera standing: outdoors in the open air, or indoors looking out through a window? Look for a window frame, glazing bars, or reflections on glass. Reply with ONLY JSON: {"through_glass": true/false, "evidence": "one short sentence"}';
}

/** Stage 1b: is this a real scene, or a photo of a screen? */
export function buildScreenPrompt() {
  return 'Is this a photograph of a screen, monitor or printed picture, rather than a real scene? Look for a pixel grid, moire, scanlines or a bezel. Reply with ONLY JSON: {"screen_photo": true/false, "evidence": "one short sentence"}';
}

/** Stage 1c: is the camera outdoors at all? */
export function buildOutdoorPrompt() {
  return 'Is this photo taken outdoors in the open air? Open sky, plants, ground or a street seen from outside all count. A room, desk, office or car interior does not. Reply with ONLY JSON: {"outdoor": true/false, "evidence": "one short sentence"}';
}

/** Stage 2: was the assigned gesture performed? */
export function buildTaskPrompt(task) {
  const check = task?.check ?? 'the assigned task was performed';
  return `Look at this photo and judge one thing only.

Required: ${check}

Answer:
- task_done: Is that requirement clearly met in this photo?
- reason: One short sentence to the person. If rejecting, say what is missing.

Reply with ONLY this JSON, no other text:
{"task_done": true/false, "reason": "..."}`;
}

function stageVerdict(fields) {
  const reason =
    typeof fields.reason === 'string' && fields.reason.trim() ? fields.reason.trim() : 'Verification failed.';
  return { ok: FAIL, ...fields, reason };
}

/** Parse a single-field stage response. Unreadable or absent => fail closed. */
export function parseFlag(raw, field, { failValue = true } = {}) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  const evidence =
    obj && typeof obj.evidence === 'string' && obj.evidence.trim() ? obj.evidence.trim() : null;
  if (!obj) return { value: failValue, readable: false, evidence: null };
  const v = asBool(obj[field]);
  return { value: v === null ? failValue : v, readable: v !== null, evidence };
}

export function parseAuthenticity(raw) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  if (!obj) {
    return stageVerdict({
      ok: FAIL,
      outdoor: false,
      through_glass: true,
      screen_photo: true,
      reason: 'Could not read the check result. Take the photo again.',
    });
  }

  const outdoor = asBool(obj.outdoor);
  const glass = asBool(obj.through_glass);
  const screen = asBool(obj.screen_photo);

  const ok = outdoor === true && glass === false && screen === false;

  let reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;
  if (!ok && !reason) {
    if (glass === true) reason = 'That looks like it was taken through a window. Go all the way outside.';
    else if (screen === true) reason = 'That looks like a photo of a screen.';
    else if (outdoor === false) reason = 'That does not look like it was taken outdoors.';
    else reason = 'The check was incomplete. Take the photo again.';
  }

  return stageVerdict({
    ok,
    outdoor: outdoor ?? false,
    through_glass: glass ?? true,
    screen_photo: screen ?? true,
    reason: reason ?? 'Looks genuinely outdoors.',
  });
}

export function parseTask(raw) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  if (!obj) {
    return stageVerdict({ ok: FAIL, task_done: false, reason: 'Could not read the check result. Try again.' });
  }
  const done = asBool(obj.task_done);
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;

  return stageVerdict({
    ok: done === true,
    task_done: done ?? false,
    reason: reason ?? (done === true ? 'Task done.' : 'The task was not done. Check the instruction and retake.'),
  });
}

/** One Ollama vision call returning raw text, or null on any transport error. */
async function askOllama({ prompt, image, fetchImpl, model, url }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        options: { num_predict: 160, temperature: 0 },
        messages: [{ role: 'user', content: prompt, images: [image] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { error: res.status === 404 ? `Model "${model}" is not available. Run: ollama pull ${model}` : `Ollama returned status ${res.status}.` };
    }
    const payload = await res.json();
    // `content` only — never `thinking`.
    return { text: payload?.message?.content ?? '' };
  } catch (err) {
    return {
      error:
        err?.name === 'AbortError'
          ? 'The model took too long to answer. Try again.'
          : `Could not reach Ollama at ${url}. Is it running?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Judge a photo.
 *
 * Four short questions instead of one long prompt, because a long prompt
 * measurably loses the glass signal (0/5 vs 3/3 on the window fixture).
 * Checks run cheapest-rejection-first and short-circuit, so the common
 * failure is also the fast one.
 *
 * Returns a verdict whose `stage` names what failed: 'outdoor', 'glass',
 * 'screen', 'task', or 'complete'.
 */
export async function judgeStaged({ imageB64, task, fetchImpl = fetch, model = MODEL, url = OLLAMA_URL, onProgress }) {
  const image = String(imageB64 ?? '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
  if (!image) {
    return { ok: FAIL, stage: 'outdoor', outdoor: false, through_glass: true, screen_photo: true, task_done: false, reason: 'No photo was received. Try again.' };
  }

  const base = { outdoor: false, through_glass: true, screen_photo: true, task_done: false };
  const ask = (prompt) => askOllama({ prompt, image, fetchImpl, model, url });

  // 1. Outdoors at all?
  onProgress?.('outdoor');
  const r1 = await ask(buildOutdoorPrompt());
  if (r1.error) return { ok: FAIL, stage: 'outdoor', ...base, reason: r1.error };
  const outdoor = parseFlag(r1.text, 'outdoor', { failValue: false });
  if (outdoor.value !== true) {
    return { ok: FAIL, stage: 'outdoor', ...base,
      reason: outdoor.evidence ?? 'That does not look like it was taken outdoors.' };
  }

  // 2. Through a window? The central cheat.
  onProgress?.('glass');
  const r2 = await ask(buildGlassPrompt());
  if (r2.error) return { ok: FAIL, stage: 'glass', ...base, outdoor: true, reason: r2.error };
  const glass = parseFlag(r2.text, 'through_glass', { failValue: true });
  if (glass.value !== false) {
    return { ok: FAIL, stage: 'glass', ...base, outdoor: true,
      reason: glass.evidence
        ? `${glass.evidence} Go all the way outside.`
        : 'That looks like it was taken through a window. Go all the way outside.' };
  }

  // 3. Photo of a screen?
  onProgress?.('screen');
  const r3 = await ask(buildScreenPrompt());
  if (r3.error) return { ok: FAIL, stage: 'screen', ...base, outdoor: true, through_glass: false, reason: r3.error };
  const screen = parseFlag(r3.text, 'screen_photo', { failValue: true });
  if (screen.value !== false) {
    return { ok: FAIL, stage: 'screen', ...base, outdoor: true, through_glass: false,
      reason: screen.evidence ?? 'That looks like a photo of a screen.' };
  }

  // 4. Was the gesture performed?
  onProgress?.('task');
  const r4 = await ask(buildTaskPrompt(task));
  if (r4.error) {
    return { ok: FAIL, stage: 'task', ...base, outdoor: true, through_glass: false, screen_photo: false, reason: r4.error };
  }
  const t = parseTask(r4.text);
  const shared = { outdoor: true, through_glass: false, screen_photo: false };
  if (!t.ok) return { ok: FAIL, stage: 'task', ...shared, task_done: false, reason: t.reason };

  return { ok: PASS, stage: 'complete', ...shared, task_done: true, reason: t.reason };
}
