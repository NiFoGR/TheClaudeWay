// Thompson sampling maths for outreach experiments: Beta posteriors, random draws, and "chance of being the best".
// Pure functions; pass a random number generator to make them repeatable in tests.

/** Small, fast, seedable RNG (mulberry32). */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) draw (Marsaglia–Tsang). */
function gamma(shape, rng) {
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) draw. */
export function beta(a, b, rng = Math.random) {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

/** Pick the index whose Beta(alpha, beta) draw is highest. arms: [{alpha, beta}] */
export function thompsonPick(arms, rng = Math.random) {
  let best = -1;
  let bestDraw = -1;
  arms.forEach((arm, i) => {
    const d = beta(arm.alpha, arm.beta, rng);
    if (d > bestDraw) {
      bestDraw = d;
      best = i;
    }
  });
  return best;
}

/** Chance each arm is the best, by Monte Carlo. Returns an array of probabilities summing to 1. */
export function probBest(arms, draws = 4000, rng = Math.random) {
  const wins = arms.map(() => 0);
  if (!arms.length) return wins;
  for (let k = 0; k < draws; k++) wins[thompsonPick(arms, rng)]++;
  return wins.map((w) => w / draws);
}

/** 90% credible interval of a Beta(a, b), approximated by sampling. */
export function interval(a, b, rng = Math.random, draws = 2000) {
  const xs = Array.from({ length: draws }, () => beta(a, b, rng)).sort((x, y) => x - y);
  return [xs[Math.floor(draws * 0.05)], xs[Math.floor(draws * 0.95)]];
}
