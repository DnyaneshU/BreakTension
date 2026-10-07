import { randomBytes } from 'node:crypto';
import { pickTask } from './tasks.js';

/** How long a scanned QR stays valid. Long enough to walk outside. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;

const SYSTEM_CLOCK = { now: () => Date.now() };

/**
 * The break session state machine.
 *
 *   idle ──markDue()──▶ due ──claim(token)──▶ pending ──pass()──▶ verified
 *                                              │  ▲
 *                                              └──┘ fail() allows retakes
 *
 * This object is the only authority on whether a break has been earned. The
 * phone cannot unlock anything; it can only submit a photo against a token
 * that this session minted. `pass()` refuses to run from `due`, so a forged
 * unlock cannot skip the capture step.
 */
export class Session {
  constructor({ clock = SYSTEM_CLOCK, rng = Math.random } = {}) {
    this.clock = clock;
    this.rng = rng;

    this.state = 'idle';
    this.token = null;
    this.task = null;
    this.attempts = 0;
    this.lastReason = null;
    this.breakDurationMs = null;

    this.tokenIssuedAt = null;
    this.dueAt = null;
    this.lastTaskId = null;
  }

  /** The break timer has elapsed: mint a token and assign a task. */
  markDue() {
    this.state = 'due';
    this.token = randomBytes(16).toString('hex');
    this.tokenIssuedAt = this.clock.now();
    this.dueAt = this.clock.now();
    this.task = pickTask({ rng: this.rng, excludeId: this.lastTaskId });
    this.attempts = 0;
    this.lastReason = null;
    this.breakDurationMs = null;

    return { token: this.token, task: this.task };
  }

  /** Does this token match, and is it still alive? */
  isTokenValid(token) {
    if (!this.token || !token) return false;
    if (token !== this.token) return false;
    if (this.clock.now() - this.tokenIssuedAt > TOKEN_TTL_MS) return false;
    return true;
  }

  /**
   * The phone has opened the capture page with a token. Moves `due` →
   * `pending`. Idempotent, so a page reload mid-break is harmless.
   */
  claim(token) {
    if (!this.isTokenValid(token)) return false;
    if (this.state !== 'due' && this.state !== 'pending') return false;

    this.state = 'pending';
    return true;
  }

  /** Gemma rejected the photo. Stay pending so the user can retake. */
  fail(reason) {
    this.attempts += 1;
    this.lastReason = reason ?? 'Verification failed.';
    return this.state;
  }

  /**
   * Gemma accepted the photo. Burns the token so the same scan cannot be
   * replayed, and records how long the break actually took.
   */
  pass() {
    if (this.state !== 'pending') {
      throw new Error(`cannot pass from state "${this.state}" — must be pending`);
    }

    this.state = 'verified';
    this.breakDurationMs = this.clock.now() - this.dueAt;
    this.token = null; // single-use
    this.lastTaskId = this.task?.id ?? null;
    return this.breakDurationMs;
  }

  /** Back to work. Starts the next cycle clean. */
  reset() {
    this.state = 'idle';
    this.token = null;
    this.task = null;
    this.attempts = 0;
    this.lastReason = null;
    this.breakDurationMs = null;
    this.tokenIssuedAt = null;
    this.dueAt = null;
  }

  /** Serializable view for the extension and the capture page. */
  toJSON() {
    return {
      state: this.state,
      task: this.task ? { id: this.task.id, text: this.task.text } : null,
      attempts: this.attempts,
      lastReason: this.lastReason,
      breakDurationMs: this.breakDurationMs,
    };
  }
}
