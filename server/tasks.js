/**
 * The task pool.
 *
 * A task has to be something you cannot do at your desk. That is the whole
 * mechanism: the photo has to be hard to fake from the chair you are trying
 * to leave. Each task pairs a plain instruction for the human with a `check`
 * clause written for the model, phrased so it can be answered from a single
 * frame.
 */
export const TASKS = [
  {
    id: 'leaf-two-fingers',
    text: 'Touch a leaf and show 2 fingers',
    check: 'a hand is touching a real plant or leaf AND exactly two fingers are extended',
  },
  {
    id: 'sky-thumbs-up',
    text: 'Point your palm at the open sky, thumb up',
    check: 'the open sky is visible above AND a hand shows a thumbs-up',
  },
  {
    id: 'ground-three-fingers',
    text: 'Put your hand on the ground and show 3 fingers',
    check: 'a hand is touching natural ground, grass, soil or pavement AND exactly three fingers are extended',
  },
  {
    id: 'tree-flat-palm',
    text: 'Press a flat palm against a tree or wall outside',
    check: 'a flat open palm is pressed against a tree trunk or an exterior wall',
  },
  {
    id: 'horizon-peace',
    text: 'Frame the horizon and make a peace sign',
    check: 'a distant horizon or open outdoor space is visible AND a hand makes a peace sign',
  },
  {
    id: 'shadow-four-fingers',
    text: 'Show your hand casting a shadow, 4 fingers out',
    check: 'a hand is visible with four fingers extended AND a cast shadow is visible, implying direct outdoor light',
  },
  {
    id: 'pick-up-something',
    text: 'Hold up a leaf, stone or stick you just found',
    check: 'a hand is holding a natural object such as a leaf, stone, pinecone or stick',
  },
  {
    id: 'fist-grass',
    text: 'Make a fist just above grass or soil',
    check: 'a closed fist is visible directly above grass, soil or other natural ground',
  },
];

/**
 * Pick a task at random.
 *
 * `rng` is injected so tests are deterministic. `excludeId` prevents handing
 * back the task the user just finished — repeating it would let someone reuse
 * a photo they already have.
 */
export function pickTask({ rng = Math.random, excludeId = null } = {}) {
  const pool = excludeId ? TASKS.filter((t) => t.id !== excludeId) : TASKS;
  const candidates = pool.length > 0 ? pool : TASKS;

  // Clamp: rng() can legitimately return values arbitrarily close to 1.
  const idx = Math.min(Math.floor(rng() * candidates.length), candidates.length - 1);
  return candidates[idx];
}
