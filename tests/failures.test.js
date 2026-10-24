'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../js/yaml.js');
require('../js/model.js');
require('../js/duration.js');
require('../js/cost.js');
require('../js/failures.js');
require('../js/fixtures.js');
const PP = globalThis.PP;

const SERVICE = PP.FIXTURES[0];
const model = PP.buildModel(SERVICE.yaml, PP).model;
const clusters = PP.clusterFailures(SERVICE.history);

test('signatures strip numbers so line and duration churn collapse', () => {
  const a = PP.normalizeSignature('test timed out after 60000 ms at tests/unit/store.test.ts:88');
  const b = PP.normalizeSignature('test timed out after 30000 ms at tests/unit/store.test.ts:91');
  assert.equal(a, b);
  assert.equal(a, 'test timed out after # ms at tests/unit/store.test.ts:#');
});

test('signatures collapse hex hashes and are case insensitive', () => {
  const a = PP.normalizeSignature('Sha MISMATCH for commit 3fa85f64a7c9d1e2b3f45a6b7c8d9e0f1a2b3c4d');
  const b = PP.normalizeSignature('sha mismatch for commit deadbeefcafe0123456789abcdef0123456789');
  assert.equal(a, b);
  assert.match(a, /#hash/);
});

test('signatures are stable and never empty', () => {
  assert.equal(PP.normalizeSignature(null), 'unknown failure');
  assert.equal(PP.normalizeSignature(''), 'unknown failure');
  const long = PP.normalizeSignature('x'.repeat(400));
  assert.equal(long.length, 160);
});

test('failure attempts cluster by job, combination and signature', () => {
  const timeout = clusters.filter(function (c) { return c.jobId === 'unit' && c.signature.indexOf('timed out') !== -1; })[0];
  assert.ok(timeout, 'the unit timeout cluster exists');
  assert.equal(timeout.count, 4);
  assert.equal(timeout.retriedPass, 4);
  assert.equal(timeout.hard, 0);
  assert.equal(timeout.minutes, 14, 'ceil of 2.9, 3.0, 3.1 and 3.6');
  assert.deepEqual(timeout.runIds, [1043, 1047, 1051, 1055]);
});

test('retry recovery separates flaky clusters from hard ones', () => {
  const port = clusters.filter(function (c) { return c.jobId === 'integration' && c.signature.indexOf('port is already allocated') !== -1; })[0];
  assert.equal(port.count, 4);
  assert.equal(port.retriedPass, 2);
  assert.equal(port.hard, 2);
  assert.ok(Math.abs(port.flakiness - 0.5) < 1e-9);
  const hang = clusters.filter(function (c) { return c.jobId === 'integration' && c.signature.indexOf('hung') !== -1; })[0];
  assert.equal(hang.count, 1);
  assert.equal(hang.retriedPass, 1, 'the 26 minute hang recovered on retry in this history');
  assert.equal(hang.hard, 0);
  assert.equal(hang.minutes, 27, 'the 26.4 minute hang bills 27 minutes');
});

test('flakiness scores land between zero and one per job', () => {
  const flaky = PP.jobFlakiness(clusters);
  assert.ok(Math.abs(flaky.unit.score - 1) < 1e-9, 'unit retries always recover');
  assert.ok(Math.abs(flaky.e2e.score - 1 / 3) < 1e-9, 'one of three e2e failures recovered');
  assert.ok(Math.abs(flaky.integration.score - 1) < 1e-9, 'the hang cluster recovered, so integration scores one');
  assert.equal(flaky['docs-deploy'], undefined, 'docs-deploy never failed in the fixture');
  Object.keys(flaky).forEach(function (id) {
    assert.ok(flaky[id].score >= 0 && flaky[id].score <= 1);
  });
});

test('clusters record every matrix combination they appeared on', () => {
  const timeout = clusters.filter(function (c) { return c.jobId === 'unit' && c.signature.indexOf('timed out') !== -1; })[0];
  assert.deepEqual(timeout.comboList, ['shard 2', 'shard 3', 'shard 1', 'shard 4']);
  const typeErr = clusters.filter(function (c) { return c.jobId === 'unit' && c.signature.indexOf('cannot read properties') !== -1; })[0];
  assert.deepEqual(typeErr.comboList, ['shard 2']);
});

test('most expensive failing jobs rank by burned billable minutes', () => {
  const expensive = PP.expensiveFailingJobs(SERVICE.history);
  assert.ok(Math.abs(expensive.totalMinutes - 131) < 1e-9, 'integration 71, e2e 38, unit 16, build 4, lint 2, got ' + expensive.totalMinutes);
  assert.equal(expensive.jobs[0].jobId, 'integration');
  assert.equal(expensive.jobs[0].minutes, 71);
  assert.equal(expensive.jobs[0].failures, 5);
  assert.equal(expensive.jobs[1].jobId, 'e2e');
  assert.equal(expensive.jobs[1].minutes, 38);
  assert.ok(Math.abs(expensive.jobs[0].share - 71 / 131) < 1e-9);
});

test('failure rates count runs, not attempts', () => {
  const rates = PP.jobFailureRates(SERVICE.history);
  assert.ok(Math.abs(rates.integration.rate - 4 / 16) < 1e-9, 'integration failed in 4 of 16 runs');
  assert.ok(Math.abs(rates.e2e.rate - 3 / 16) < 1e-9, 'e2e failed in 3 of 16 runs even when a retry saved the run');
  assert.equal(rates['docs-deploy'].failedRuns, 0);
});

test('cancelled attempts cluster alongside failures', () => {
  const history = {
    runs: [
      { id: 1, changedPaths: ['src/x.ts'], jobs: { build: [{ a: 1, s: 'cancelled', m: 5.4, msg: 'The runner has received a shutdown signal' }] } },
      { id: 2, changedPaths: ['src/x.ts'], jobs: { build: [{ a: 1, s: 'cancelled', m: 4.2, msg: 'The runner has received a shutdown signal' }, { a: 2, s: 'success', m: 5.0 }] } }
    ]
  };
  const cl = PP.clusterFailures(history);
  assert.equal(cl.length, 1);
  assert.equal(cl[0].count, 2);
  assert.equal(cl[0].retriedPass, 1);
  assert.equal(cl[0].hard, 1);
  assert.equal(cl[0].minutes, 11, 'ceil of 5.4 and 4.2');
});

test('an empty history produces no clusters and no rates', () => {
  assert.deepEqual(PP.clusterFailures({ runs: [] }), []);
  assert.deepEqual(PP.expensiveFailingJobs({ runs: [] }).jobs, []);
  assert.deepEqual(PP.jobFailureRates({ runs: [] }), {});
});

test('one signature on two combinations stays one cluster with both combos', () => {
  const history = {
    runs: [
      { id: 1, changedPaths: [], jobs: { build: [{ a: 1, s: 'failure', m: 2.0, c: 'node 18', msg: 'boom at src/a.ts:1' }, { a: 1, s: 'failure', m: 3.0, c: 'node 20', msg: 'boom at src/a.ts:2' }] } }
    ]
  };
  const cl = PP.clusterFailures(history);
  assert.equal(cl.length, 1, 'the signature is shared, so the cluster is shared');
  assert.equal(cl[0].count, 2);
  assert.deepEqual(cl[0].comboList, ['node 18', 'node 20']);
});
