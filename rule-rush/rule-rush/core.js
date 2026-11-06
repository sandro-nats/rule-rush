/*! Rule Rush core.
 *
 * Shared by the browser client and the Node verifier (UMD: no DOM, no I/O).
 * Everything in here is deterministic: same seed + same inputs => same score.
 * That property is what makes server-side replay verification possible.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RuleRushCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = Object.freeze({
    VERSION: 1,
    DURATION: 45000,          // ms per run
    FIELD: 1000,              // virtual square playfield, 1000 x 1000 units
    TARGET_R: 85,             // drawn radius of a target
    HIT_R: 106,               // tap tolerance (centre distance)
    PERFECT_R: 34,            // centre distance that counts as a precise tap
    MIN_SEP: 204,             // minimum distance between concurrently visible targets
    RULE_KINDS: Object.freeze(['color', 'shape', 'not_color', 'both', 'not_shape']),
    FIRST_SPAWN: 800,
    SEG_GAP: 700,             // quiet time after a rule change so the player can read it
    MIN_LIFE: 650,
    LIFE_START: 1700,
    LIFE_END: 1000,
    GAP_START: 1000,
    GAP_END: 520,
    GAP_JITTER: 300,
    GAP_MIN: 320,
    VALID_RATIO: 0.55,
    SCORE: Object.freeze({
      BASE: 100, SPEED: 100, PRECISION: 50, PERFECT: 50,
      COMBO_STEP: 0.1, COMBO_CAP: 10,
    }),
    // Difficulty tiers. A "mistake" is a tap on a wrong target or on empty space.
    // maxMistakes: 0 = unlimited; N = the run ends on the Nth mistake.
    TIERS: Object.freeze({
      easy:   Object.freeze({ lifeMul: 1.4, gapMul: 1.3, wrong: 100, empty: 10, emptyBreaksCombo: false, maxMistakes: 0 }),
      medium: Object.freeze({ lifeMul: 1.0, gapMul: 1.0, wrong: 150, empty: 25, emptyBreaksCombo: true,  maxMistakes: 0 }),
      hard:   Object.freeze({ lifeMul: 0.8, gapMul: 0.8, wrong: 150, empty: 25, emptyBreaksCombo: true,  maxMistakes: 1 }),
    }),
    DEFAULT_TIER: 'medium',
    ANTICHEAT: Object.freeze({
      MAX_TAPS: 400,
      MIN_TAP_GAP: 45,          // ms between two taps that is considered a burst
      TAP_BURST_REVIEW: 8,      // bursts above this => manual review flag
      MIN_REACTION: 100,        // ms; faster than this after spawn is not humanly possible
      MAX_FAST_REACTIONS: 2,    // tolerated flukes
      ROBOT_MIN_SAMPLES: 12,
      ROBOT_STDDEV: 12,         // ms; reaction times this uniform look scripted
      MIN_WALL_SLACK: 2000,     // a run cannot be submitted sooner than (its length - this) after it started
    }),
  });

  const COLORS = Object.freeze(['red', 'blue', 'green', 'yellow']);
  const SHAPES = Object.freeze(['circle', 'square', 'triangle']);

  /* ---------------- seeded RNG (xmur3-style hash + mulberry32) ---------------- */

  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function makeRng(seed) {
    let a = hashSeed(String(seed));
    return function rng() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const lerp = (a, b, p) => a + (b - a) * p;
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length);
  }

  /* ---------------- rules & schedule ---------------- */

  function ruleMatches(rule, color, shape) {
    switch (rule.kind) {
      case 'color': return color === rule.color;
      case 'shape': return shape === rule.shape;
      case 'not_color': return color !== rule.color;
      case 'not_shape': return shape !== rule.shape;
      case 'both': return color === rule.color && shape === rule.shape;
      default: return false;
    }
  }

  function ruleIndexAt(t) {
    const segLen = CONFIG.DURATION / CONFIG.RULE_KINDS.length;
    return Math.max(0, Math.min(CONFIG.RULE_KINDS.length - 1, Math.floor(t / segLen)));
  }

  function makeRules(rng) {
    const segLen = CONFIG.DURATION / CONFIG.RULE_KINDS.length;
    return CONFIG.RULE_KINDS.map((kind, i) => ({
      index: i,
      kind,
      color: COLORS[Math.floor(rng() * COLORS.length)],
      shape: SHAPES[Math.floor(rng() * SHAPES.length)],
      start: i * segLen,
      end: (i + 1) * segLen,
    }));
  }

  function pickAppearance(rule, wantValid, rng) {
    for (let i = 0; i < 80; i++) {
      let color = COLORS[Math.floor(rng() * COLORS.length)];
      let shape = SHAPES[Math.floor(rng() * SHAPES.length)];
      if (rule.kind === 'both' && !wantValid) {
        // near-miss traps: copy one attribute of the rule so the player has to check both
        const r = rng();
        if (r < 0.35) color = rule.color;
        else if (r < 0.7) shape = rule.shape;
      }
      if (ruleMatches(rule, color, shape) === wantValid) return { color, shape };
    }
    for (const color of COLORS) {
      for (const shape of SHAPES) {
        if (ruleMatches(rule, color, shape) === wantValid) return { color, shape };
      }
    }
    return { color: COLORS[0], shape: SHAPES[0] };
  }

  function buildSchedule(seed, tier) {
    tier = tier || CONFIG.DEFAULT_TIER;
    const TC = CONFIG.TIERS[tier];
    if (!TC) throw new Error('unknown tier: ' + tier);
    const rng = makeRng('rr' + CONFIG.VERSION + '|' + seed);
    const rules = makeRules(rng);
    const segLen = CONFIG.DURATION / rules.length;
    const margin = CONFIG.TARGET_R + 30;
    const span = CONFIG.FIELD - 2 * margin;
    const sep2 = CONFIG.MIN_SEP * CONFIG.MIN_SEP;
    const targets = [];
    let validCount = 0;
    let t = CONFIG.FIRST_SPAWN;

    while (t < CONFIG.DURATION - CONFIG.MIN_LIFE) {
      const rule = rules[Math.min(rules.length - 1, Math.floor(t / segLen))];
      const progress = t / CONFIG.DURATION;
      let life = Math.round(lerp(CONFIG.LIFE_START, CONFIG.LIFE_END, progress) * TC.lifeMul);
      life = Math.min(life, rule.end - t); // never outlive the current rule
      if (life < CONFIG.MIN_LIFE) {
        t = rule.end + CONFIG.SEG_GAP;
        continue;
      }

      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 14; attempt++) {
        x = margin + Math.floor(rng() * (span + 1));
        y = margin + Math.floor(rng() * (span + 1));
        let free = true;
        for (let j = 0; j < targets.length; j++) {
          const o = targets[j];
          if (o.end > t && o.t < t + life) {
            const dx = o.x - x;
            const dy = o.y - y;
            if (dx * dx + dy * dy < sep2) { free = false; break; }
          }
        }
        if (free) break;
      }

      const wantValid = rng() < CONFIG.VALID_RATIO;
      const look = pickAppearance(rule, wantValid, rng);
      targets.push({
        id: targets.length,
        t,
        life,
        end: t + life,
        x,
        y,
        color: look.color,
        shape: look.shape,
        valid: wantValid,
      });
      if (wantValid) validCount++;

      const gap = Math.round((lerp(CONFIG.GAP_START, CONFIG.GAP_END, progress) + (rng() - 0.5) * CONFIG.GAP_JITTER) * TC.gapMul);
      t += Math.max(CONFIG.GAP_MIN, gap);
    }

    return {
      seed: String(seed),
      tier,
      version: CONFIG.VERSION,
      duration: CONFIG.DURATION,
      rules,
      targets,
      validCount,
    };
  }

  /* ---------------- scoring engine (used live AND for server replay) ---------------- */

  class Engine {
    constructor(schedule, onEvent) {
      this.schedule = schedule;
      this.targets = schedule.targets;
      this.state = new Uint8Array(this.targets.length); // 0 pending, 1 hit, 2 expired
      this.order = this.targets
        .map((_, i) => i)
        .sort((a, b) => (this.targets[a].end - this.targets[b].end) || (a - b));
      this.ptr = 0;
      this.clock = 0;
      this.onEvent = onEvent || null;
      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.hits = 0;
      this.wrongs = 0;
      this.misses = 0;
      this.empties = 0;
      this.perfects = 0;
      this.taps = 0;
      this.reactions = [];
      this.tier = schedule.tier || CONFIG.DEFAULT_TIER;
      this.tc = CONFIG.TIERS[this.tier];
      this.mistakes = 0;
      this.ended = false;   // true once the tier's mistake limit is hit
      this.endedAt = -1;
    }

    /** Move time forward; valid targets that ran out are misses and break the combo. */
    advance(t) {
      if (t > this.clock) this.clock = t;
      if (this.ended) return;
      while (this.ptr < this.order.length) {
        const i = this.order[this.ptr];
        const tg = this.targets[i];
        if (tg.end > this.clock) break;
        this.ptr++;
        if (this.state[i] === 0) {
          this.state[i] = 2;
          if (tg.valid) {
            this.misses++;
            this.combo = 0;
            if (this.onEvent) this.onEvent({ type: 'miss', targetId: tg.id, t: tg.end, x: tg.x, y: tg.y });
          }
        }
      }
    }

    /** Register a tap. Time never goes backwards: a late-delivered tap is clamped to the clock. */
    tap(t, x, y) {
      if (t < this.clock) t = this.clock;
      if (this.ended) return { type: 'ended', t };
      this.advance(t);
      this.taps++;

      const S = CONFIG.SCORE;
      const TC = this.tc;
      const R2 = CONFIG.HIT_R * CONFIG.HIT_R;
      let best = -1;
      let bestD2 = R2 + 1;
      for (let i = 0; i < this.targets.length; i++) {
        const tg = this.targets[i];
        if (tg.t > t) break; // sorted by spawn time
        if (this.state[i] !== 0 || t >= tg.end) continue;
        const dx = tg.x - x;
        const dy = tg.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= R2 && d2 < bestD2) { best = i; bestD2 = d2; }
      }

      if (best < 0) {
        this.empties++;
        if (TC.emptyBreaksCombo) this.combo = 0;
        this.score -= TC.empty;
        const over = this.registerMistake(t);
        return { type: 'empty', t, x, y, delta: -TC.empty, targetId: -1, combo: this.combo, perfect: false, ended: over };
      }

      const tg = this.targets[best];
      this.state[best] = 1;

      if (!tg.valid) {
        this.wrongs++;
        this.combo = 0;
        this.score -= TC.wrong;
        const over = this.registerMistake(t);
        return { type: 'wrong', t, x, y, delta: -TC.wrong, targetId: best, combo: 0, perfect: false, ended: over };
      }

      const dist = Math.sqrt(bestD2);
      const elapsed = t - tg.t;
      const speed = 1 - elapsed / tg.life;
      const prec = 1 - dist / CONFIG.HIT_R;
      const perfect = dist <= CONFIG.PERFECT_R && elapsed <= tg.life * 0.6;
      const base = S.BASE + Math.round(S.SPEED * speed) + Math.round(S.PRECISION * prec) + (perfect ? S.PERFECT : 0);
      const mult = 1 + S.COMBO_STEP * Math.min(this.combo, S.COMBO_CAP);
      const pts = Math.round(base * mult);

      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.hits++;
      if (perfect) this.perfects++;
      this.score += pts;
      this.reactions.push(elapsed);
      return { type: 'hit', t, x, y, delta: pts, targetId: best, combo: this.combo, perfect, mult };
    }

    registerMistake(t) {
      this.mistakes++;
      if (this.tc.maxMistakes > 0 && this.mistakes >= this.tc.maxMistakes) {
        this.ended = true;
        this.endedAt = t;
      }
      return this.ended;
    }

    stats() {
      const r = this.reactions;
      return {
        tier: this.tier,
        ended: this.ended,
        endedAt: this.endedAt,
        mistakes: this.mistakes,
        score: Math.max(0, this.score),
        rawScore: this.score,
        hits: this.hits,
        wrongs: this.wrongs,
        misses: this.misses,
        empties: this.empties,
        perfects: this.perfects,
        maxCombo: this.maxCombo,
        taps: this.taps,
        accuracy: this.taps ? this.hits / this.taps : 0,
        avgReaction: r.length ? Math.round(mean(r)) : 0,
        validTargets: this.schedule.validCount,
      };
    }
  }

  /* ---------------- server-side verification ---------------- */

  /**
   * Replays a submitted run and decides whether it is plausible.
   *   inputs: [{ t, x, y }] — t in ms since run start, x/y in 0..1000 (all integers)
   *   opts:   { claimedScore?, wallClockMs? } — wallClockMs = server-measured time between
   *           handing out the seed and receiving the result.
   * Returns { ok, score, stats, flags }. Flags with severity 'reject' make ok=false;
   * 'review' flags are statistical hints for a human to look at before paying out a prize.
   */
  function verifyRun(seed, inputs, opts) {
    opts = opts || {};
    const tier = opts.tier || CONFIG.DEFAULT_TIER;
    const A = CONFIG.ANTICHEAT;
    const bad = (code) => ({ ok: false, score: 0, stats: null, flags: [{ code, severity: 'reject' }] });

    if (!CONFIG.TIERS[tier]) return bad('unknown_tier');
    if (!Array.isArray(inputs)) return bad('inputs_not_array');
    if (inputs.length > A.MAX_TAPS) return bad('too_many_inputs');

    let prev = 0;
    for (let i = 0; i < inputs.length; i++) {
      const p = inputs[i];
      if (!p || !Number.isInteger(p.t) || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return bad('malformed_input');
      if (p.t < 0 || p.t > CONFIG.DURATION) return bad('time_out_of_range');
      if (p.x < 0 || p.x > CONFIG.FIELD || p.y < 0 || p.y > CONFIG.FIELD) return bad('position_out_of_range');
      if (p.t < prev) return bad('time_not_monotonic');
      prev = p.t;
    }

    const schedule = buildSchedule(seed, tier);
    const engine = new Engine(schedule);
    let bursts = 0;
    let afterEnd = 0;
    let lastT = -Infinity;
    for (let i = 0; i < inputs.length; i++) {
      const p = inputs[i];
      if (p.t - lastT < A.MIN_TAP_GAP) bursts++;
      lastT = p.t;
      if (engine.tap(p.t, p.x, p.y).type === 'ended') afterEnd++;
    }
    engine.advance(CONFIG.DURATION + CONFIG.LIFE_START * 2);

    const stats = engine.stats();
    const flags = [];

    // A legitimate client stops sending as soon as the run is over.
    if (afterEnd > 0) flags.push({ code: 'inputs_after_end', severity: 'reject', detail: afterEnd });

    const fast = engine.reactions.filter((r) => r < A.MIN_REACTION).length;
    if (fast > A.MAX_FAST_REACTIONS) flags.push({ code: 'superhuman_reaction', severity: 'reject', detail: fast });

    if (engine.reactions.length >= A.ROBOT_MIN_SAMPLES && stddev(engine.reactions) < A.ROBOT_STDDEV) {
      flags.push({ code: 'robotic_consistency', severity: 'review', detail: Math.round(stddev(engine.reactions)) });
    }
    if (bursts > A.TAP_BURST_REVIEW) flags.push({ code: 'tap_burst', severity: 'review', detail: bursts });

    const runLength = engine.ended ? engine.endedAt : CONFIG.DURATION;
    const slack = Math.min(A.MIN_WALL_SLACK, runLength * 0.25);
    if (typeof opts.wallClockMs === 'number' && opts.wallClockMs < runLength - slack) {
      flags.push({ code: 'submitted_too_fast', severity: 'reject', detail: opts.wallClockMs });
    }
    if (opts.claimedScore !== undefined && opts.claimedScore !== stats.score) {
      flags.push({ code: 'score_mismatch', severity: 'reject', detail: { claimed: opts.claimedScore, replayed: stats.score } });
    }

    return {
      ok: !flags.some((f) => f.severity === 'reject'),
      score: stats.score,
      stats,
      flags,
    };
  }

  return {
    CONFIG, COLORS, SHAPES,
    hashSeed, makeRng,
    ruleMatches, ruleIndexAt,
    buildSchedule, Engine, verifyRun,
  };
}));
