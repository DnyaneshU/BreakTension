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
