/**
 * Activity accounting, with no Chrome APIs so it can be unit-tested.
 *
 * The rule that matters: only *active* browsing counts. If you shut the
 * laptop and go to lunch, you should not be met by a lock screen demanding
 * you go outside — you just were. So idle time does not accrue, and a long
 * gap is treated as a break that already happened.
 */

export const DEFAULTS = {
  workMs: 35 * 60 * 1000,      // time at the desk before a break is due
  idleGraceMs: 90 * 1000,      // pauses shorter than this still count as work
  awayCreditsMs: 8 * 60 * 1000 // away longer than this and you already took a break
};

export class ActivityTimer {
  constructor({ now = () => Date.now(), config = {} } = {}) {
    this.now = now;
    this.config = { ...DEFAULTS, ...config };
    this.activeMs = 0;
    this.lastTick = null;
    this.state = 'idle'; // 'idle' | 'active'
  }

  /**
   * Called on any sign of activity, and periodically by an alarm.
   * Returns the accrued active milliseconds.
   */
  tick(stamp = this.now()) {
    if (this.lastTick === null) {
      this.lastTick = stamp;
      this.state = 'active';
      return this.activeMs;
    }

    const gap = stamp - this.lastTick;
    this.lastTick = stamp;

    if (gap < 0) return this.activeMs; // clock went backwards; ignore

    if (gap >= this.config.awayCreditsMs) {
      // Long absence: that was a real break. Start the next stretch clean.
      this.activeMs = 0;
      this.state = 'active';
      return this.activeMs;
    }

    if (gap <= this.config.idleGraceMs) {
      this.activeMs += gap;
    }
    // Gaps between grace and away-credit accrue nothing: short idle, no credit,
    // but not long enough to count as having gone outside either.

    this.state = 'active';
    return this.activeMs;
  }

  /** Has enough desk time accrued to demand a break? */
  isDue() {
    return this.activeMs >= this.config.workMs;
  }

  remainingMs() {
    return Math.max(0, this.config.workMs - this.activeMs);
  }

  /** A verified break happened. Reset the stretch. */
  creditBreak(stamp = this.now()) {
    this.activeMs = 0;
    this.lastTick = stamp;
  }

  /** Push the next prompt out by a snooze, without wiping accrued time. */
  snooze(ms) {
    this.activeMs = Math.max(0, this.config.workMs - ms);
  }

  toJSON() {
    return { activeMs: this.activeMs, remainingMs: this.remainingMs(), due: this.isDue(), state: this.state };
  }
}

/**
 * Is a break allowed right now?
 *
 * Locking someone's browser at 2am, or during a meeting, turns a useful tool
 * into one they uninstall. These are not edge cases; they are the difference
 * between a demo and something you keep running.
 */
export function breakAllowed({
  date,
  quietStartHour = 22,
  quietEndHour = 7,
  workDaysOnly = false,
  inCall = false,
} = {}) {
  if (inCall) return { allowed: false, why: 'in a call' };

  const h = date.getHours();
  const inQuiet =
    quietStartHour > quietEndHour
      ? h >= quietStartHour || h < quietEndHour // window crosses midnight
      : h >= quietStartHour && h < quietEndHour;

  if (inQuiet) return { allowed: false, why: 'quiet hours' };

  if (workDaysOnly) {
    const day = date.getDay();
    if (day === 0 || day === 6) return { allowed: false, why: 'weekend' };
  }

  return { allowed: true, why: null };
}
