/**
 * The shared desk-time budget.
 *
 * Sitting is sitting. Switching from Chrome to VS Code is not a break, so the
 * clients cannot each keep their own 35-minute timer — whichever one you
 * switched to would always be fresh and nothing would ever come due.
 *
 * So the budget lives here, on the server, and both clients report activity
 * into it. The server also survives either client restarting, which the
 * Chrome service worker does constantly.
 *
 * Only *wall clock* time accrues, once, no matter how many clients report in
 * the same minute: ten minutes of sitting is ten minutes, not twenty.
 */

const SYSTEM_CLOCK = { now: () => Date.now() };

export const CLIENT_DEFAULTS = {
  workMs: 35 * 60 * 1000,
  idleGraceMs: 90 * 1000, // pauses shorter than this still count as work
  awayCreditsMs: 8 * 60 * 1000, // away longer than this and a break already happened
  staleMs: 2 * 60 * 1000, // no check-in for this long and a client is gone
};

export class Clients {
  constructor({ clock = SYSTEM_CLOCK, ...config } = {}) {
    this.clock = clock;
    this.config = { ...CLIENT_DEFAULTS, ...config };

    this.activeMs = 0;
    this.lastTick = null;
    this.seen = {}; // client name -> timestamp of its last report
  }

  /**
   * A client says the user is active right now.
   *
   * `name` is 'browser', 'editor', or anything else a future client calls
   * itself; it is used for reporting, not for accounting.
   */
  report(name = 'unknown') {
    const now = this.clock.now();
    this.seen[name] = now;

    if (this.lastTick === null) {
      this.lastTick = now;
      return this.activeMs;
    }

    const gap = now - this.lastTick;

    // A clock that went backwards (NTP correction, sleep/wake) must not
    // subtract from the budget or jump it forward.
    if (gap < 0) return this.activeMs;

    this.lastTick = now;

    if (gap >= this.config.awayCreditsMs) {
      // Nobody reported for a long time: that was a real break.
      this.activeMs = 0;
      return this.activeMs;
    }

    if (gap <= this.config.idleGraceMs) {
      this.activeMs += gap;
    }
    // Gaps between grace and away-credit accrue nothing: idle at the desk is
    // not desk time, but it is not a walk outside either.

    return this.activeMs;
  }

  isDue() {
    return this.activeMs >= this.config.workMs;
  }

  remainingMs() {
    return Math.max(0, this.config.workMs - this.activeMs);
  }

  /** A verified break happened. Clears the budget for every client at once. */
  creditBreak() {
    this.activeMs = 0;
    this.lastTick = this.clock.now();
  }

  /** Push the next prompt out without discarding accrued time. */
  snooze(ms) {
    this.activeMs = Math.max(0, this.config.workMs - ms);
  }

  /** Every client that has ever reported, with its last check-in time. */
  connected() {
    return { ...this.seen };
  }

  /** Just the ones that have checked in recently enough to still be running. */
  activeClients() {
    const cutoff = this.clock.now() - this.config.staleMs;
    return Object.entries(this.seen)
      .filter(([, at]) => at >= cutoff)
      .map(([name]) => name)
      .sort();
  }

  toJSON() {
    return { activeMs: this.activeMs, lastTick: this.lastTick, seen: { ...this.seen } };
  }

  restore(state = {}) {
    this.activeMs = state.activeMs ?? 0;
    this.lastTick = state.lastTick ?? null;
    this.seen = { ...(state.seen ?? {}) };
  }
}
