'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../js/yaml.js');
require('../js/model.js');
require('../js/duration.js');
require('../js/fixtures.js');
const PP = globalThis.PP;

const SERVICE = PP.FIXTURES[0];
const built = PP.buildModel(SERVICE.yaml, PP);
const model = built.model;
const stats = PP.unitStatistics(model, SERVICE.history);
const BOOT = 0.5;

test('buildModel parses the synthetic service ci fixture', () => {
  assert.equal(built.ok, true);
  assert.equal(built.model.name, 'service ci');
  assert.equal(model.order.length, 7);
  assert.deepEqual(model.order, ['changes', 'build', 'lint', 'unit', 'integration', 'e2e', 'docs-deploy']);
});

test('topological waves follow the needs graph', () => {
  assert.equal(model.waves.length, 3);
  assert.deepEqual(model.waves[0], ['changes']);
  assert.deepEqual(model.waves[1], ['build', 'lint']);
  assert.deepEqual(model.waves[2], ['unit', 'integration', 'e2e', 'docs-deploy']);
});

test('matrix expansion produces one unit per combination', () => {
  assert.equal(PP.units(model.jobs.build).length, 2);
  assert.equal(PP.units(model.jobs.unit).length, 4);
  assert.equal(PP.units(model.jobs.lint).length, 1);
  assert.equal(PP.allUnits(model).length, 11, '1 plus 2 plus 1 plus 4 plus 1 plus 1 plus 1');
});

test('combo labels list every axis value', () => {
  const unit = PP.units(model.jobs.build)[0];
  assert.equal(unit.label, 'node 18');
  assert.equal(PP.units(model.jobs.unit)[2].label, 'shard 3');
});

test('buildModel rejects unknown needs with the defined job list', () => {
  const r = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: ghost\n    steps:\n      - run: x\n', PP);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /needs "ghost"/);
  assert.match(r.errors[0].message, /a/);
});

test('buildModel detects dependency cycles', () => {
  const r = PP.buildModel([
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    needs: b',
    '    steps:',
    '      - run: x',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    needs: a',
    '    steps:',
    '      - run: y'
  ].join('\n'), PP);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /cycle/);
});

test('buildModel rejects a job that needs itself', () => {
  const r = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: a\n    steps:\n      - run: x\n', PP);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /needs itself/);
});

test('buildModel requires runs-on and steps in this subset', () => {
  const r1 = PP.buildModel('jobs:\n  a:\n    steps:\n      - run: x\n', PP);
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0].message, /runs-on is required/);
  const r2 = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n', PP);
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0].message, /steps is missing/);
});

test('buildModel rejects matrix.include and non array matrix axes', () => {
  const r1 = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [18, 20]\n        include: [x]\n    steps:\n      - run: x\n', PP);
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0].message, /include and .exclude are outside this subset/);
  const r2 = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: 18\n    steps:\n      - run: x\n', PP);
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0].message, /strategy\.matrix\.node must be an array/);
});

test('fail-fast parses and defaults to true', () => {
  assert.equal(model.jobs.unit.failFast, false);
  assert.equal(model.jobs.build.failFast, true);
});

test('quantile is linear interpolated and deterministic', () => {
  assert.equal(PP.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(PP.quantile([1, 2, 3, 4], 0), 1);
  assert.equal(PP.quantile([1, 2, 3, 4], 1), 4);
  assert.equal(PP.quantile([10], 0.9), 10);
});

test('unitStatistics pull medians from the synthetic history', () => {
  const build18 = stats.units['build#0'];
  const build20 = stats.units['build#1'];
  assert.equal(build18.label, 'node 18');
  assert.ok(build18.p50 > 7 && build18.p50 < 8, 'node 18 p50 around 7.4, got ' + build18.p50);
  assert.ok(build20.p50 > 4.9 && build20.p50 < 5.6, 'node 20 p50 around 5.2, got ' + build20.p50);
  assert.equal(stats.units['lint'].n > 0, true);
  assert.equal(stats.units['e2e'].runner, 'macos-latest');
});

test('attemptList keeps failed attempts for duration statistics', () => {
  const attempts = PP.attemptList(SERVICE.history, 'integration', null);
  const failed = attempts.filter(function (a) { return a.status === 'failure'; });
  assert.equal(failed.length, 5);
  assert.ok(attempts.some(function (a) { return a.minutes > 20; }), 'the 26 minute hang is in the list');
});

test('fallback estimate kicks in for jobs without history', () => {
  const tiny = PP.buildModel('jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n      - run: y\n', PP).model;
  const st = PP.unitStatistics(tiny, { runs: [] });
  assert.equal(st.units['a'].estimated, true);
  assert.ok(Math.abs(st.units['a'].p50 - 3.0) < 1e-9, 'base 1.2 plus 0.9 per step for 2 steps, got ' + st.units['a'].p50);
});

test('simulation with a large pool has no queue and matches the critical path', () => {
  const sim = PP.simulate(model, stats, { pool: 20, bootstrap: BOOT });
  assert.equal(sim.queuedUnits.length, 0);
  assert.ok(Math.abs(sim.wall - 21.9) < 0.2, 'wall around 21.9 minutes, got ' + sim.wall);
  const cp = PP.criticalPath(model, stats, BOOT);
  assert.deepEqual(cp.path, ['changes', 'build', 'e2e']);
  assert.ok(Math.abs(cp.minutes - sim.wall) < 0.2, 'critical path equals the simulated wall when nobody queues');
});

test('simulation shows queue time when the pool is small', () => {
  const sim = PP.simulate(model, stats, { pool: 1, bootstrap: BOOT });
  assert.ok(sim.queuedUnits.length > 0, 'units queue on one runner');
  assert.ok(sim.wall > 21.9, 'wall grows beyond the unqueued wall, got ' + sim.wall);
  const lint = sim.jobs.lint;
  assert.ok(lint.queue > 0, 'lint waits behind the build matrix');
  const sim2 = PP.simulate(model, stats, { pool: 2, bootstrap: BOOT });
  assert.ok(sim2.wall <= sim.wall, 'a bigger pool never makes the wall slower');
});

test('simulation is deterministic across runs', () => {
  const a = PP.simulate(model, stats, { pool: 3, bootstrap: BOOT });
  const b = PP.simulate(model, stats, { pool: 3, bootstrap: BOOT });
  assert.deepEqual(a.units.map(function (u) { return [u.key, u.start, u.finish]; }), b.units.map(function (u) { return [u.key, u.start, u.finish]; }));
  assert.equal(a.wall, b.wall);
});

test('critical path respects a longer parallel branch', () => {
  const r = PP.buildModel([
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: x',
    '  b:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: x',
    '  c:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: x'
  ].join('\n'), PP);
  const st = PP.unitStatistics(r.model, { runs: [] });
  const cp = PP.criticalPath(r.model, st, 0.5);
  assert.equal(cp.path.length, 2);
  assert.equal(cp.path[0], 'a');
  assert.ok(cp.path[1] === 'b' || cp.path[1] === 'c');
  assert.ok(Math.abs(cp.minutes - 5.2) < 1e-9, 'two estimated jobs of 2.1 plus 0.5 bootstrap each, got ' + cp.minutes);
});

test('jobShare computes the wall clock fraction of a job', () => {
  const sim = PP.simulate(model, stats, { pool: 20, bootstrap: BOOT });
  const e2eShare = PP.jobShare(sim, 'e2e');
  assert.ok(e2eShare > 0.5 && e2eShare < 0.7, 'e2e owns most of the wall clock, got ' + e2eShare);
  assert.ok(Math.abs(PP.jobShare(sim, 'changes')) < 0.05);
});
