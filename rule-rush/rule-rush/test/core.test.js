'use strict';
// Run with: node test/core.test.js
const assert = require('assert');
const Core = require('../core.js');
const { CONFIG, buildSchedule, verifyRun, Engine, makeRng } = Core;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok    ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.error('  FAIL  ' + name + '\n' + ((e && e.stack) || e));
  }
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Scripted player: reacts `reaction` ms (+/- jitter) after each valid target spawns. */
function botRun(seed, o) {
  const sch = buildSchedule(seed, o.tier);
  const rng = makeRng('bot|' + (o.id || 'x'));
  const noise = o.noise === undefined ? 20 : o.noise;
  const inputs = [];
  for (const tg of sch.targets) {
    const rt = Math.round(o.reaction + (rng() - 0.5) * 2 * (o.jitter || 0));
    const t = tg.t + rt;
    if (t >= tg.end) continue;
    if (tg.valid || rng() < (o.wrongRate || 0)) {
      inputs.push({
        t,
        x: clamp(Math.round(tg.x + (rng() - 0.5) * 2 * noise), 0, CONFIG.FIELD),
        y: clamp(Math.round(tg.y + (rng() - 0.5) * 2 * noise), 0, CONFIG.FIELD),
      });
    }
  }
  return inputs.sort((a, b) => a.t - b.t);
}

console.log('Rule Rush core tests');

test('same seed gives an identical schedule; different seeds differ', () => {
  const a = buildSchedule('daily-2026-11-05');
  const b = buildSchedule('daily-2026-11-05');
  const c = buildSchedule('daily-2026-11-06');
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a.targets, c.targets);
});

test('schedule invariants hold across 200 seeds', () => {
  let pairs = 0;
  let tooClose = 0;
  for (let s = 0; s < 200; s++) {
    const sch = buildSchedule('inv-' + s);
    assert.strictEqual(sch.rules.length, 5);
    assert.ok(sch.validCount >= 15 && sch.validCount <= 50, 'valid count ' + sch.validCount);
    let prevT = -1;
    sch.targets.forEach((tg, i) => {
      assert.strictEqual(tg.id, i);
      assert.ok(tg.t >= prevT);
      prevT = tg.t;
      assert.ok(tg.life >= CONFIG.MIN_LIFE);
      assert.strictEqual(tg.end, tg.t + tg.life);
      const rule = sch.rules[Core.ruleIndexAt(tg.t)];
      assert.ok(tg.t >= rule.start && tg.end <= rule.end, 'target crosses a rule change');
      assert.strictEqual(tg.valid, Core.ruleMatches(rule, tg.color, tg.shape));
      const m = CONFIG.TARGET_R + 30;
      assert.ok(tg.x >= m && tg.x <= CONFIG.FIELD - m && tg.y >= m && tg.y <= CONFIG.FIELD - m);
    });
    for (let i = 0; i < sch.targets.length; i++) {
      for (let j = i + 1; j < sch.targets.length; j++) {
        const a = sch.targets[i];
        const b = sch.targets[j];
        if (a.end > b.t && b.end > a.t) {
          pairs++;
          if (Math.hypot(a.x - b.x, a.y - b.y) < CONFIG.MIN_SEP) tooClose++;
        }
      }
    }
  }
  assert.ok(tooClose / pairs < 0.01, 'overlap ratio ' + tooClose + '/' + pairs);
});

test('a human-like player verifies and scores well', () => {
  const inputs = botRun('daily-2026-11-05', { id: 'human', reaction: 380, jitter: 90, wrongRate: 0.08 });
  const r = verifyRun('daily-2026-11-05', inputs);
  assert.ok(r.ok, JSON.stringify(r.flags));
  assert.ok(r.score > 3000, 'score ' + r.score);
  console.log('        human-like bot: score ' + r.score + ', hits ' + r.stats.hits + '/' + r.stats.validTargets +
    ', best combo ' + r.stats.maxCombo + ', perfect ' + r.stats.perfects);
});

test('faster reactions score higher than slower ones', () => {
  const fast = verifyRun('s1', botRun('s1', { id: 'a', reaction: 250, jitter: 40 }));
  const slow = verifyRun('s1', botRun('s1', { id: 'a', reaction: 700, jitter: 40 }));
  assert.ok(fast.score > slow.score, fast.score + ' vs ' + slow.score);
});

test('random spamming scores far below a real player', () => {
  const rng = makeRng('spam');
  const inputs = [];
  for (let t = 500; t < CONFIG.DURATION; t += 120) {
    inputs.push({ t, x: Math.floor(rng() * 1001), y: Math.floor(rng() * 1001) });
  }
  const spam = verifyRun('s1', inputs);
  const human = verifyRun('s1', botRun('s1', { id: 'h', reaction: 400, jitter: 80 }));
  assert.ok(spam.score < human.score / 3, spam.score + ' vs ' + human.score);
});

test('superhuman reaction times are rejected', () => {
  const r = verifyRun('s1', botRun('s1', { id: 'fast', reaction: 30, jitter: 5, noise: 0 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.flags.some((f) => f.code === 'superhuman_reaction'));
});

test('metronome-like consistency is flagged for review (not rejected)', () => {
  const r = verifyRun('s1', botRun('s1', { id: 'robot', reaction: 300, jitter: 0, noise: 0 }));
  assert.ok(r.flags.some((f) => f.code === 'robotic_consistency'));
  assert.strictEqual(r.ok, true);
});

test('tampered or malformed submissions are rejected', () => {
  const good = botRun('s1', { id: 'g', reaction: 400, jitter: 80 });
  const real = verifyRun('s1', good);
  assert.ok(real.ok);

  let r = verifyRun('s1', good, { claimedScore: real.score + 1000 });
  assert.ok(!r.ok && r.flags.some((f) => f.code === 'score_mismatch'));

  r = verifyRun('s1', good, { wallClockMs: 12000 });
  assert.ok(!r.ok && r.flags.some((f) => f.code === 'submitted_too_fast'));

  r = verifyRun('s1', [{ t: 2000, x: 10, y: 10 }, { t: 1000, x: 10, y: 10 }]);
  assert.strictEqual(r.flags[0].code, 'time_not_monotonic');

  r = verifyRun('s1', [{ t: 1000, x: 5000, y: 10 }]);
  assert.strictEqual(r.flags[0].code, 'position_out_of_range');

  r = verifyRun('s1', [{ t: 1000.5, x: 10, y: 10 }]);
  assert.strictEqual(r.flags[0].code, 'malformed_input');

  r = verifyRun('s1', [{ t: CONFIG.DURATION + 1, x: 10, y: 10 }]);
  assert.strictEqual(r.flags[0].code, 'time_out_of_range');

  r = verifyRun('s1', 'nope');
  assert.strictEqual(r.flags[0].code, 'inputs_not_array');

  r = verifyRun('s1', new Array(CONFIG.ANTICHEAT.MAX_TAPS + 1).fill({ t: 1, x: 1, y: 1 }));
  assert.strictEqual(r.flags[0].code, 'too_many_inputs');
});

test('a run on a different seed does not replay to the same score', () => {
  const inputs = botRun('seed-A', { id: 'x', reaction: 380, jitter: 60 });
  const a = verifyRun('seed-A', inputs);
  const b = verifyRun('seed-B', inputs);
  assert.ok(a.score > b.score * 2, a.score + ' vs ' + b.score);
});

test('frame-stepped live engine (with clamped late taps) equals the server replay', () => {
  const seed = 'live-1';
  const plan = botRun(seed, { id: 'live', reaction: 420, jitter: 120, wrongRate: 0.15 });
  const live = new Engine(buildSchedule(seed));
  const recorded = [];
  let pi = 0;
  for (let now = 0; now <= CONFIG.DURATION; now += 16) {
    live.advance(now); // the render loop advances first...
    while (pi < plan.length && plan[pi].t <= now) { // ...taps then arrive with slightly older timestamps
      const ev = live.tap(plan[pi].t, plan[pi].x, plan[pi].y);
      recorded.push({ t: ev.t, x: plan[pi].x, y: plan[pi].y });
      pi++;
    }
  }
  live.advance(CONFIG.DURATION + CONFIG.LIFE_START);
  const replay = verifyRun(seed, recorded, { claimedScore: live.stats().score });
  assert.ok(replay.ok, JSON.stringify(replay.flags));
  assert.deepStrictEqual(replay.stats, live.stats());
});

/* ---------------- difficulty tiers ---------------- */

test('tiers change the pace: hard is faster than medium, easy is slower', () => {
  const easy = buildSchedule('tier-1', 'easy');
  const med = buildSchedule('tier-1', 'medium');
  const hard = buildSchedule('tier-1', 'hard');
  assert.ok(easy.targets.length < med.targets.length && med.targets.length < hard.targets.length,
    [easy, med, hard].map((s) => s.targets.length).join(' / '));
  const avgLife = (s) => s.targets.reduce((a, t) => a + t.life, 0) / s.targets.length;
  assert.ok(avgLife(easy) > avgLife(med) && avgLife(med) > avgLife(hard));
  assert.throws(() => buildSchedule('x', 'nightmare'));
  assert.strictEqual(verifyRun('x', [], { tier: 'nightmare' }).flags[0].code, 'unknown_tier');
});

test('tier invariants hold across seeds (targets never cross a rule change)', () => {
  for (const tier of Object.keys(CONFIG.TIERS)) {
    for (let s = 0; s < 60; s++) {
      const sch = buildSchedule('ti-' + s, tier);
      for (const tg of sch.targets) {
        const rule = sch.rules[Core.ruleIndexAt(tg.t)];
        assert.ok(tg.life >= CONFIG.MIN_LIFE && tg.t >= rule.start && tg.end <= rule.end, tier + ' seed ' + s);
      }
    }
  }
});

test('hard: the first mistake ends the run; later input is rejected', () => {
  const sch = buildSchedule('hard-1', 'hard');
  const first = sch.targets[0];
  const good = { t: first.t + 300, x: first.x, y: first.y };
  // an empty-space tap far from every active target
  const corner = { t: first.t + 900, x: first.x < 500 ? 990 : 10, y: first.y < 500 ? 990 : 10 };

  let r = verifyRun('hard-1', [good, corner], { tier: 'hard' });
  assert.ok(r.ok, JSON.stringify(r.flags));
  assert.strictEqual(r.stats.ended, true);
  assert.strictEqual(r.stats.endedAt, corner.t);

  const later = { t: corner.t + 400, x: first.x, y: first.y };
  r = verifyRun('hard-1', [good, corner, later], { tier: 'hard' });
  assert.ok(!r.ok && r.flags.some((f) => f.code === 'inputs_after_end'));

  // the same tap sequence does not end a medium run
  const m = verifyRun('hard-1', [corner], { tier: 'medium' });
  assert.strictEqual(m.stats.ended, false);
});

test('hard: a flawless run still scores and is not flagged', () => {
  const inputs = botRun('hard-2', { id: 'hp', tier: 'hard', reaction: 330, jitter: 70 });
  const r = verifyRun('hard-2', inputs, { tier: 'hard' });
  assert.ok(r.ok && !r.stats.ended, JSON.stringify(r.flags));
  assert.ok(r.score > 3000);
});

test('easy: empty taps cost little and do not break the combo', () => {
  const sch = buildSchedule('easy-1', 'easy');
  const a = sch.targets.find((t) => t.valid);
  const hit = { t: a.t + 400, x: a.x, y: a.y };
  const stray = { t: a.t + 700, x: a.x < 500 ? 990 : 10, y: a.y < 500 ? 990 : 10 };
  const e = new Engine(sch);
  e.tap(hit.t, hit.x, hit.y);
  const before = e.combo;
  e.tap(stray.t, stray.x, stray.y);
  assert.strictEqual(e.combo, before);
  const med = new Engine(buildSchedule('easy-1', 'medium'));
  assert.ok(CONFIG.TIERS.easy.empty < CONFIG.TIERS.medium.empty);
  assert.ok(med.tc.emptyBreaksCombo);
});

test('wall-clock minimum follows the real run length (early-ended hard runs may be quick)', () => {
  const sch = buildSchedule('hard-3', 'hard');
  const first = sch.targets[0];
  const corner = { t: first.t + 500, x: first.x < 500 ? 990 : 10, y: first.y < 500 ? 990 : 10 };
  assert.ok(verifyRun('hard-3', [corner], { tier: 'hard', wallClockMs: corner.t + 1500 }).ok);
  assert.ok(!verifyRun('hard-3', [corner], { tier: 'hard', wallClockMs: 100 }).ok);
});

console.log(process.exitCode ? '\nSome tests failed.' : '\nAll ' + passed + ' tests passed.');
