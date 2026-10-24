'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../js/yaml.js');
require('../js/model.js');
require('../js/duration.js');
require('../js/cost.js');
require('../js/failures.js');
require('../js/savings.js');
require('../js/fixtures.js');
const PP = globalThis.PP;

const SERVICE = PP.FIXTURES[0];
const model = PP.buildModel(SERVICE.yaml, PP).model;
const stats = PP.unitStatistics(model, SERVICE.history);
const sim = PP.simulate(model, stats, { pool: 20, bootstrap: 0.5 });
const critical = PP.criticalPath(model, stats, 0.5);
const RATES = { linux: 0.008, windows: 0.016, macos: 0.08, 'self-hosted': 0 };
const cost = PP.runCost(model, stats, RATES, 0.5);
const OPTS = { runsPerDay: 24, daysPerMonth: 30, cost: cost };

function bench() {
  return PP.buildBench({
    model: model,
    history: SERVICE.history,
    unitStats: stats,
    simulation: sim,
    critical: critical,
    cost: cost,
    cache: PP.cacheStats(model, SERVICE.history),
    watchPatterns: SERVICE.watchPatterns,
    opts: OPTS
  });
}

test('path filters match glob patterns conservatively', () => {
  assert.equal(PP.pathsChanged(['src/a.ts', 'docs/b.md'], ['src/**']), true);
  assert.equal(PP.pathsChanged(['docs/b.md'], ['src/**']), false);
  assert.equal(PP.pathsChanged(['README.md'], ['docs/**', 'README.md']), true);
  assert.equal(PP.pathsChanged([], ['src/**']), true, 'no change data assumes the job is needed');
  assert.equal(PP.pathsChanged(['src/api/http.ts'], ['src/*.ts']), false, 'single star stays inside one segment');
  assert.equal(PP.pathsChanged(['src/http.ts'], ['src/*.ts']), true);
});

test('the bench produces suggestions for the synthetic service history', () => {
  const b = bench();
  assert.ok(b.suggestions.length >= 4, 'expected at least four rules to fire, got ' + b.suggestions.length);
  const ids = b.suggestions.map(function (s) { return s.id; });
  assert.ok(ids.indexOf('cache') !== -1, 'cache rule fires');
  assert.ok(ids.indexOf('split-build') !== -1, 'matrix split fires for the slow node 18 combination');
  assert.ok(ids.indexOf('paths-docs-deploy') !== -1, 'path filter fires for docs-deploy');
  assert.ok(ids.indexOf('failfast-unit') !== -1, 'fail fast fires for the unit matrix');
  assert.ok(ids.indexOf('timeout-integration') !== -1, 'timeout cap fires for the hung integration tail');
});

test('every suggestion labels itself as an estimate and carries assumptions', () => {
  const b = bench();
  b.suggestions.forEach(function (s) {
    assert.ok(s.assumptions.length >= 2, s.id + ' carries assumptions');
    assert.equal(typeof s.monthlyCost, 'number');
    assert.equal(typeof s.monthlyMinutes, 'number');
    assert.ok(s.title.length > 0 && s.detail.length > 0);
  });
});

test('quantified estimates match their underlying math', () => {
  const b = bench();
  const cache = b.suggestions.filter(function (s) { return s.id === 'cache'; })[0];
  assert.ok(Math.abs(cache.minutesPerRun - (9 / 16) * (126 / 60)) < 1e-9, 'misses per run times median saved minutes');
  const paths = b.suggestions.filter(function (s) { return s.id === 'paths-docs-deploy'; })[0];
  assert.ok(Math.abs(paths.minutesPerRun - 9 * cost.byJob['docs-deploy'].minutes / 16) < 1e-9, 'nine skippable runs times job minutes over sixteen runs');
  assert.ok(Math.abs(paths.monthlyCost - paths.minutesPerRun * 720 * (cost.byJob['docs-deploy'].cost / cost.byJob['docs-deploy'].minutes)) < 1e-6);
});

test('the matrix split proposal only claims wall savings on the critical path', () => {
  const b = bench();
  const split = b.suggestions.filter(function (s) { return s.id === 'split-build'; })[0];
  assert.ok(split, 'build is on the critical path');
  assert.ok(Math.abs(split.minutesPerRun - (stats.units['build#0'].p50 - stats.units['build#0'].p50 / 2 - 0.5)) < 1e-9);
  assert.ok(split.monthlyMinutes > 0);
  const offPath = { path: ['elsewhere'], jobMinutes: critical.jobMinutes };
  const none = PP.matrixSplitRule(model, stats, offPath, OPTS);
  const split2 = none.filter(function (s) { return s.id === 'split-build'; })[0];
  assert.equal(split2.minutesPerRun, 0, 'off the critical path the wall saving is honestly zero');
});

test('the fail fast rule never fires on a matrix that already fails fast', () => {
  const b = bench();
  const ids = b.suggestions.map(function (s) { return s.id; });
  assert.ok(ids.indexOf('failfast-build') === -1, 'build keeps the fail-fast default');
  assert.ok(ids.indexOf('failfast-unit') !== -1, 'unit runs with fail-fast off in the fixture');
});

test('totals are sums of positive suggestions and stated as an upper bound', () => {
  const b = bench();
  const positives = b.suggestions.map(function (s) { return Math.max(0, s.monthlyCost); });
  const sum = positives.reduce(function (a, x) { return a + x; }, 0);
  assert.ok(Math.abs(b.totalMonthlyCost - sum) < 1e-6);
  assert.ok(b.globalAssumptions.some(function (a) { return /upper bound/.test(a); }));
});

test('the bench stays quiet when history is missing', () => {
  const emptyStats = PP.unitStatistics(model, { runs: [] });
  const b = PP.buildBench({
    model: model,
    history: { runs: [] },
    unitStats: emptyStats,
    simulation: sim,
    critical: critical,
    cost: cost,
    cache: PP.cacheStats(model, { runs: [] }),
    watchPatterns: SERVICE.watchPatterns,
    opts: OPTS
  });
  assert.equal(b.suggestions.length, 0);
  assert.equal(b.totalMonthlyCost, 0);
});

test('glob compilation escapes regex metacharacters', () => {
  const re = PP.globToRegExp('src/(a)/**');
  assert.equal(re.test('src/(a)/b/c.ts'), true);
  assert.equal(re.test('src/a/b/c.ts'), false);
});
