/**
 * The escape hatches.
 *
 * A tool that locks your browser at the wrong moment gets uninstalled, and an
 * uninstalled tool prevents zero minutes of sitting. So there has to be a way
 * out. But every way out is also a way to cheat, so each one is deliberately
 * limited:
 *
 *   snooze   once per cycle, 5 minutes — long enough to finish a thought,
 *            too short to be a dismiss button
 *   skip     2 per day, counted and reset at midnight
 *   meeting  a manual toggle that expires on its own
 *   quiet    no breaks at night, and optionally at weekends
 *
 * No Chrome APIs here, so all of it is unit-tested directly.
 */

export const SNOOZE_MS = 5 * 60 * 1000;
export const SKIP_MS = 35 * 60 * 1000; // a skip stands down the rest of the cycle
export const MEETING_MS = 60 * 60 * 1000;
export const DAILY_SKIPS = 2;

/**
 * Why the meeting toggle expires.
 *
 * The honest objection to a manual switch is that someone flips it, forgets,
 * and the product quietly stops working. An expiry makes the worst case an
 * hour of not nagging rather than permanent silence.
 */

/** Local calendar day, so the skip budget resets at the user's midnight. */
export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function skipsLeft(state, date) {
  // A count from an earlier day is irrelevant, not carried forward.
  if (!state?.skipDay || state.skipDay !== dayKey(date)) return DAILY_SKIPS;
  return Math.max(0, DAILY_SKIPS - (state.skipCount ?? 0));
}

/** Spend one skip. Returns the state unchanged when the budget is gone. */
export function useSkip(state, date) {
  if (skipsLeft(state, date) <= 0) return state;

  const today = dayKey(date);
  const count = state?.skipDay === today ? (state.skipCount ?? 0) : 0;

  return {
    ...state,
    skipDay: today,
    skipCount: count + 1,
    skipUntil: date.getTime() + SKIP_MS,
  };
}

export const canSnooze = (state) => !state?.snoozedThisCycle;

export function useSnooze(state, date) {
  if (!canSnooze(state)) return state;
  return { ...state, snoozedThisCycle: true, snoozeUntil: date.getTime() + SNOOZE_MS };
}

export const meetingActive = (state, date) =>
  Boolean(state?.meetingUntil) && state.meetingUntil > date.getTime();

export const startMeeting = (state, date, ms = MEETING_MS) => ({
  ...state,
  meetingUntil: date.getTime() + ms,
});

export const endMeeting = (state) => ({ ...state, meetingUntil: null });

/** A verified break happened: clear the per-cycle flags. */
export const resetCycle = (state) => ({
  ...state,
  snoozedThisCycle: false,
  snoozeUntil: null,
  skipUntil: null,
});

/**
 * Should the break be held back right now, and why?
 *
 * Returns a short human reason, or null when a break may go ahead. The reason
 * is surfaced in the popup: a user who sees the timer sitting at zero with
 * nothing happening needs to know what is holding it.
 */
export function deferReason({ state = {}, date, settings = {} }) {
  const { quietStartHour = 22, quietEndHour = 7, workDaysOnly = false } = settings;
  const now = date.getTime();

  if (meetingActive(state, date)) return 'in a meeting';
  if (state.snoozeUntil > now) return 'snoozed';
  if (state.skipUntil > now) return 'skipped this one';

  const h = date.getHours();
  const inQuiet =
    quietStartHour > quietEndHour
      ? h >= quietStartHour || h < quietEndHour // window crosses midnight
      : h >= quietStartHour && h < quietEndHour;
  if (inQuiet) return 'quiet hours';

  if (workDaysOnly) {
    const day = date.getDay();
    if (day === 0 || day === 6) return 'weekend';
  }

  return null;
}

// ── skip confirmation ──────────────────────────────────────────────────────

/**
 * Skipping asks twice.
 *
 * The product's entire claim is that the break cannot be dismissed in a
 * quarter of a second. A one-click skip button quietly takes that away, so
 * the skip escalates: the first prompt asks, the second names the cost.
 *
 * This is friction on purpose. Someone who genuinely has to keep working
 * will click through both in five seconds. Someone reaching for it out of
 * habit gets two chances to notice they are doing that.
 */
export const SKIP_PROMPTS = [
  {
    question: 'Skip this break? You have been at the screen a while.',
    confirm: 'Yes, skip it',
    cancel: 'No, I will go outside',
    destructive: true,
  },
  {
    question: 'Are you really sure? This spends one of your 2 skips today, and your streak resets.',
    confirm: 'I am sure, skip it',
    cancel: 'Actually, no',
    destructive: true,
  },
];

export const nextConfirmStep = (step) => step + 1;
export const confirmComplete = (step) => step >= SKIP_PROMPTS.length;
