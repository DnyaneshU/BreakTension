/**
 * The judge.
 *
 * Talks to Gemma through Ollama on localhost. Nothing leaves the machine —
 * that is the point of the project, not an optimization.
 *
 * Three things about this integration are easy to get wrong, each found by
 * measurement rather than reasoning:
 *
 *  1. SHORT PROMPTS. Asking about frames, bars, reflections, haze, bezels and
 *     lighting in one combined prompt detected the window fixture 0/5 times.
 *     One short question per call detects it 3/3, with 0/3 false positives on
 *     genuine outdoor photos. The model could always see the frame; the long
 *     prompt drowned the signal. Resist adding bullet points to these.
 *
 *  2. `think: false`. This model emits both `message.thinking` and
 *     `message.content`. Thinking mode cost ~24s per judgement versus ~3s
 *     without, for no gain in accuracy, and the reasoning text contains JSON
 *     fragments that produce plausible-but-wrong verdicts if parsed. We send
 *     `think: false` and read `content` only.
 *
 *  3. FAIL CLOSED, ALWAYS. An unreachable model, a timeout, malformed output
 *     or a missing field all reject. Failing open would quietly turn the
 *     product back into a dismissible reminder, which is the one thing it
 *     must never be.
 */

export const PASS = true;
export const FAIL = false;

const OLLAMA_URL = process.env.BT_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.BT_MODEL ?? 'gemma4:e4b';
const TIMEOUT_MS = Number(process.env.BT_TIMEOUT_MS ?? 60_000);

// ── parsing ────────────────────────────────────────────────────────────────

/** Booleans sometimes arrive as the strings "true"/"false". */
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null; // unknown — callers fail closed
}

/**
 * Pull the first balanced JSON object out of arbitrary model prose.
 *
 * The model wraps JSON in markdown fences, prefixes it with "Here is my
 * assessment:", or both. JSON.parse on the whole response fails for all of
 * those, so scan for a balanced object instead.
 */
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
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Read one boolean field from a stage response.
 *
 * `failValue` is what an unreadable or absent field means, and it differs per
 * stage: a missing `outdoor` is false (not outdoors), while a missing
 * `through_glass` is true (assume glass). Both directions reject.
 */
export function parseFlag(raw, field, { failValue = true } = {}) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  if (!obj) return { value: failValue, readable: false, evidence: null };

  const v = asBool(obj[field]);
  const evidence = typeof obj.evidence === 'string' && obj.evidence.trim() ? obj.evidence.trim() : null;

  return { value: v === null ? failValue : v, readable: v !== null, evidence };
}

/** Read the final task stage, which uses `reason` rather than `evidence`. */
export function parseTask(raw) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  if (!obj) {
    return { ok: FAIL, task_done: false, reason: 'Could not read the check result. Try again.' };
  }

  const done = asBool(obj.task_done);
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;

  return {
    ok: done === true,
    task_done: done ?? false,
    reason: reason ?? (done === true ? 'Task done.' : 'The task was not done. Check the instruction and retake.'),
  };
}

// ── prompts ────────────────────────────────────────────────────────────────
// One question each. See note 1 at the top of this file before editing.

export const buildOutdoorPrompt = () =>
  'Is this photo taken outdoors in the open air? Open sky, plants, ground or a street seen from outside all count. A room, desk, office or car interior does not. Reply with ONLY JSON: {"outdoor": true/false, "evidence": "one short sentence"}';

export const buildGlassPrompt = () =>
  'Where is the camera standing: outdoors in the open air, or indoors looking out through a window? Look for a window frame, glazing bars, or reflections on glass. Reply with ONLY JSON: {"through_glass": true/false, "evidence": "one short sentence"}';

export const buildScreenPrompt = () =>
  'Is this a photograph of a screen, monitor or printed picture, rather than a real scene? Look for a pixel grid, moire, scanlines or a bezel. Reply with ONLY JSON: {"screen_photo": true/false, "evidence": "one short sentence"}';

export const buildTaskPrompt = (task) =>
  `Look at this photo and judge one thing only.

Required: ${task?.check ?? 'the assigned task was performed'}

Answer:
- task_done: Is that requirement clearly met in this photo?
- reason: One short sentence to the person. If rejecting, say what is missing.

Reply with ONLY this JSON, no other text:
{"task_done": true/false, "reason": "..."}`;

// ── the stage pipeline ─────────────────────────────────────────────────────

/**
 * The authenticity gates, cheapest rejection first.
 *
 * `want` is the value that lets a photo through; `failValue` is what an
 * unreadable answer counts as. Declaring them as data rather than four
 * near-identical code blocks is what keeps the orchestration below honest:
 * every gate fails closed the same way, by construction.
 */
const GATES = [
  {
    stage: 'outdoor',
    field: 'outdoor',
    prompt: buildOutdoorPrompt,
    want: true,
    failValue: false,
    fallback: 'That does not look like it was taken outdoors.',
  },
  {
    stage: 'glass',
    field: 'through_glass',
    prompt: buildGlassPrompt,
    want: false,
    failValue: true,
    fallback: 'That looks like it was taken through a window. Go all the way outside.',
    // The window photo is the central cheat, so always say what to do next.
    suffix: 'Go all the way outside.',
  },
  {
    stage: 'screen',
    field: 'screen_photo',
    prompt: buildScreenPrompt,
    want: false,
    failValue: true,
    fallback: 'That looks like a photo of a screen.',
  },
];

/** A rejection shaped like every other verdict, so callers need no special case. */
function reject({ stage, reason, passed = {} }) {
  return {
    ok: FAIL,
    stage,
    outdoor: false,
    through_glass: true,
    screen_photo: true,
    task_done: false,
    ...passed,
    reason,
  };
}

/** One Ollama vision call. Returns `{ text }` or `{ error }` — never throws. */
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
        think: false, // see note 2 at the top of this file
        options: { num_predict: 160, temperature: 0 },
        messages: [{ role: 'user', content: prompt, images: [image] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        error:
          res.status === 404
            ? `Model "${model}" is not available. Run: ollama pull ${model}`
            : `Ollama returned status ${res.status}.`,
      };
    }

    const payload = await res.json();
    return { text: payload?.message?.content ?? '' }; // `content` only, never `thinking`
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
 * Runs the authenticity gates in order, short-circuiting on the first failure
 * so the common rejection is also the fast one, then checks the gesture.
 *
 * `stage` in the result names what failed: 'outdoor', 'glass', 'screen',
 * 'task', or 'complete'.
 */
export async function judgeStaged({
  imageB64,
  task,
  fetchImpl = fetch,
  model = MODEL,
  url = OLLAMA_URL,
  onProgress,
}) {
  // Ollama rejects the image if the data: URL prefix is left on.
  const image = String(imageB64 ?? '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
  if (!image) {
    return reject({ stage: 'outdoor', reason: 'No photo was received. Try again.' });
  }

  // Gates already cleared, so a later failure still reports what passed.
  const passed = {};

  for (const gate of GATES) {
    onProgress?.(gate.stage);

    const res = await askOllama({ prompt: gate.prompt(), image, fetchImpl, model, url });
    if (res.error) return reject({ stage: gate.stage, reason: res.error, passed });

    const flag = parseFlag(res.text, gate.field, { failValue: gate.failValue });

    if (flag.value !== gate.want) {
      let reason = gate.fallback;
      if (flag.evidence) {
        reason = gate.suffix ? `${flag.evidence} ${gate.suffix}` : flag.evidence;
      }
      return reject({ stage: gate.stage, reason, passed });
    }

    passed[gate.field] = flag.value;
  }

  onProgress?.('task');

  const res = await askOllama({ prompt: buildTaskPrompt(task), image, fetchImpl, model, url });
  if (res.error) return reject({ stage: 'task', reason: res.error, passed });

  const taskResult = parseTask(res.text);
  if (!taskResult.ok) return reject({ stage: 'task', reason: taskResult.reason, passed });

  return { ok: PASS, stage: 'complete', ...passed, task_done: true, reason: taskResult.reason };
}
