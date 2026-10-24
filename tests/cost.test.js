'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../js/yaml.js');
require('../js/model.js');
require('../js/duration.js');
require('../js/cost.js');
require('../js/fixtures.js');
const PP = globalThis.PP;

const SERVICE = PP.FIXTURES[0];
const model = PP.buildModel(SERVICE.yaml, PP).model;
const stats = PP.unitStatistics(model, SERVICE.history);
const RATES = { linux: 0.008, windows: 0.016, macos: 0.08, 'self-hosted': 0 };

test('runner labels map onto the rate table kinds', () => {
  assert.equal(PP.kindOf('ubuntu-latest'), 'linux');
  assert.equal(PP.kindOf('ubuntu-24.04-arm'), 'linux');
  assert.equal(PP.kindOf('windows-latest'), 'windows');
  assert.equal(PP.kindOf('macos-14'), 'macos');
  assert.equal(PP.kindOf('self-hosted'), 'self-hosted');
  assert.equal(PP.kindOf(undefined), 'linux');
});

test('billable minutes round up to whole minutes per unit', () => {
  assert.equal(PP.billableMinutes(0.4), 1);
  assert.equal(PP.billableMinutes(3.25), 4);
  assert.equal(PP.billableMinutes(12.6), 13);
  assert.equal(PP.billableMinutes(0), 0);
});

test('runCost prices each matrix combination at its runner rate', () => {
  const cost = PP.runCost(model, stats, RATES, 0.5);
  const build18 = cost.units.filter(function (u) { return u.key === 'build#0' || (u.jobId === 'build' && u.comboIndex === 0); })[0];
  assert.equal(build18.kind, 'linux');
  assert.equal(build18.billable, Math.ceil(stats.units['build#0'].p50));
  assert.ok(Math.abs(build18.cost - build18.billable * 0.008) < 1e-12);
  const e2e = cost.units.filter(function (u) { return u.jobId === 'e2e'; })[0];
  assert.equal(e2e.kind, 'macos');
  assert.equal(e2e.billable, 13);
  assert.ok(Math.abs(e2e.cost - 13 * 0.08) < 1e-9, 'e2e bills at the macos rate, got ' + e2e.cost);
});

test('per run cost is the sum of units and job totals add up', () => {
  const cost = PP.runCost(model, stats, RATES, 0.5);
  const sumUnits = cost.units.reduce(function (a, u) { return a + u.cost; }, 0);
  const sumJobs = model.order.reduce(function (a, id) { return a + cost.byJob[id].cost; }, 0);
  assert.ok(Math.abs(cost.perRun - sumUnits) < 1e-9);
  assert.ok(Math.abs(cost.perRun - sumJobs) < 1e-9);
  assert.ok(cost.perRun > 1.2 && cost.perRun < 1.6, 'service ci run around 1.42 dollars, got ' + cost.perRun);
  assert.ok(cost.totalMinutes > 50 && cost.totalMinutes < 70, 'about 60 billable minutes per run, got ' + cost.totalMinutes);
});

test('p90 pricing bounds the p50 pricing from above', () => {
  const cost = PP.runCost(model, stats, RATES, 0.5);
  assert.ok(cost.perRunP90 >= cost.perRun);
  assert.ok(cost.totalMinutesP90 >= cost.totalMinutes);
});

test('edited rates flow straight into the numbers', () => {
  const edited = { linux: 0.008, windows: 0.016, macos: 0.16, 'self-hosted': 0 };
  const cost = PP.runCost(model, stats, edited, 0.5);
  const base = PP.runCost(model, stats, RATES, 0.5);
  const e2eEdited = cost.units.filter(function (u) { return u.jobId === 'e2e'; })[0].cost;
  assert.ok(Math.abs(e2eEdited - 26 * 0.08) < 1e-9);
  assert.ok(cost.perRun > base.perRun);
  const free = PP.runCost(model, stats, { linux: 0, windows: 0, macos: 0, 'self-hosted': 0 }, 0.5);
  assert.equal(free.perRun, 0);
});

test('monthly projection multiplies the editable cadence', () => {
  const m = PP.monthly(1.5, 24, 30);
  assert.equal(m.runs, 720);
  assert.ok(Math.abs(m.cost - 1080) < 1e-9);
  const m2 = PP.monthly(0.42, 10, 20);
  assert.equal(m2.runs, 200);
  assert.ok(Math.abs(m2.cost - 84) < 1e-9);
});

test('cache accounting reads hits and misses from the history', () => {
  const cache = PP.cacheStats(model, SERVICE.history);
  assert.equal(cache.events, 32);
  assert.equal(cache.hits + cache.misses, cache.events);
  assert.ok(Math.abs(cache.hitRate - 23 / 32) < 1e-9, 'hit rate 23 of 32, got ' + cache.hitRate);
  assert.ok(Math.abs(cache.missesPerRun - 9 / 16) < 1e-9);
  assert.ok(cache.medianSavedSeconds > 100 && cache.medianSavedSeconds < 150);
  assert.deepEqual(cache.jobsWithCache, ['build']);
});

test('cache accounting is empty for histories without cache records', () => {
  const cache = PP.cacheStats(model, PP.FIXTURES[1].history);
  assert.equal(cache.events, 0);
  assert.equal(cache.hitRate, null);
});
