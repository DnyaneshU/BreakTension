/**
 * The reward loop.
 *
 * Entirely local. There is no server, no leaderboard and no other users, so
 * nothing here can be gamed against anyone but yourself — which is the point.
 * A score you can trivially cheat is worthless as a deterrent, so this does
 * not pretend to be tamper-proof.
 *
 * What it is actually for: making the streak visible enough that spending a
 * skip feels like it costs something. That is what turns the two-step skip
 * confirmation into a real decision rather than a nuisance dialog. The
 * original design had strangers awarding points; see the README for why that
 * was cut and why a private streak does the same job here.
 */

export const POINTS_PER_BREAK = 10;
export const STREAK_BONUS = 2;
export const STREAK_BONUS_CAP = 5; // bonus stops growing after this many
export const SKIP_PENALTY = 5;

export const LEVELS = [
  { at: 0, name: 'Indoor Cat' },
  { at: 50, name: 'Window Watcher' },
  { at: 150, name: 'Doorstep Regular' },
  { at: 350, name: 'Grass Toucher' },
  { at: 700, name: 'Outside Enjoyer' },
  { at: 1200, name: 'Touch Grass Enthusiast' },
];

export function levelFor(points) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].at) index = i;
  }
  return { ...LEVELS[index], index };
}

/** A verified break: points, plus a bounded bonus for keeping a streak. */
export function creditBreak(state = {}, date = new Date()) {
  const streak = (state.streak ?? 0) + 1;

  // The bonus rewards consecutive breaks but is capped, so a long streak
  // cannot inflate a single break into hundreds of points.
  const bonusSteps = Math.min(Math.max(streak - 1, 0), STREAK_BONUS_CAP);
  const earned = POINTS_PER_BREAK + STREAK_BONUS * bonusSteps;

  return {
    ...state,
    points: (state.points ?? 0) + earned,
    streak,
    bestStreak: Math.max(state.bestStreak ?? 0, streak),
    totalBreaks: (state.totalBreaks ?? 0) + 1,
    lastBreakAt: date.getTime(),
    lastEarned: earned,
  };
}

/**
 * A skip. Costs points and, more importantly, the streak.
 *
 * Points are floored at zero: a new user who skips twice should not be told
 * they owe something, which reads as punishment rather than feedback.
 */
export function penaliseSkip(state = {}, date = new Date()) {
  return {
    ...state,
    points: Math.max(0, (state.points ?? 0) - SKIP_PENALTY),
    streak: 0,
    totalSkips: (state.totalSkips ?? 0) + 1,
    lastSkipAt: date.getTime(),
    lastEarned: 0,
  };
}

/** Everything the popup and lock screen need to render the score. */
export function summarise(state = {}) {
  const points = state.points ?? 0;
  const level = levelFor(points);
  const nextLevel = LEVELS[level.index + 1] ?? null;

  return {
    points,
    streak: state.streak ?? 0,
    bestStreak: state.bestStreak ?? 0,
    totalBreaks: state.totalBreaks ?? 0,
    totalSkips: state.totalSkips ?? 0,
    level,
    nextLevel,
    toNext: nextLevel ? nextLevel.at - points : null,
  };
}
