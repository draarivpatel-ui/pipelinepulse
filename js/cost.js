/*
 * PipelinePulse cost model. Runner minutes priced from an editable rate table,
 * billed per unit the way per job billing works: whole minutes, rounded up,
 * per matrix combination. Monthly projections scale an editable run cadence.
 * Includes cache hit accounting from the run history.
 *
 * Deterministic. No dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  // Public hosted runner list prices at the time of writing. Editable in the UI.
  var DEFAULT_RATES = { linux: 0.008, windows: 0.016, macos: 0.08, 'self-hosted': 0 };

  function kindOf(runnerLabel) {
    var label = String(runnerLabel || 'ubuntu-latest').toLowerCase();
    if (label.indexOf('self-hosted') !== -1) return 'self-hosted';
    if (label.indexOf('windows') === 0 || label.indexOf('windows') !== -1) return 'windows';
    if (label.indexOf('macos') === 0 || label.indexOf('macos') !== -1) return 'macos';
    return 'linux';
  }

  // GitHub Actions hosted runners bill whole minutes per job, rounded up.
  function billableMinutes(minutes) {
    return Math.ceil(Math.max(0, minutes));
  }

  function unitRate(unit, rates) {
    return rates[kindOf(unit.runner)];
  }

  /*
   * Cost per run from a simulation. Uses billable minutes per unit at p50.
   * Returns per unit rows, per job totals, and the run total. Also returns a
   * p90 variant computed from unit p90 durations as an upper bound.
   */
  function runCost(model, unitStats, rates, bootstrap) {
    bootstrap = typeof bootstrap === 'number' ? bootstrap : 0.5;
    var unitsOut = [];
    var byJob = {};
    var total = 0;
    var totalP90 = 0;
    var totalMinutes = 0;
    var totalMinutesP90 = 0;

    model.order.forEach(function (id) {
      var job = model.jobs[id];
      var ju = (root.PP.units ? root.PP.units(job) : units(job));
      var jobMinutes = 0;
      var jobMinutesP90 = 0;
      var jobCost = 0;
      var jobCostP90 = 0;
      for (var u = 0; u < ju.length; u++) {
        var unit = ju[u];
        var key = (root.PP.unitKey ? root.PP.unitKey(unit) : unitKey(unit));
        var st = unitStats.units[key] || { p50: 0, p90: 0, estimated: true, n: 0 };
        // history minutes already include checkout and runner setup, so the
        // simulation bootstrap is scheduling granularity only, never billed
        var billP50 = billableMinutes(st.p50);
        var billP90 = billableMinutes(st.p90);
        var rate = unitRate(unit, rates);
        var cost = billP50 * rate;
        var costP90 = billP90 * rate;
        unitsOut.push({
          jobId: id,
          comboIndex: unit.comboIndex,
          label: unit.label,
          runner: unit.runner,
          kind: kindOf(unit.runner),
          p50: st.p50,
          p90: st.p90,
          billable: billP50,
          billableP90: billP90,
          rate: rate,
          cost: cost,
          estimated: st.estimated
        });
        jobMinutes += billP50;
        jobMinutesP90 += billP90;
        jobCost += cost;
        jobCostP90 += costP90;
      }
      byJob[id] = { minutes: jobMinutes, minutesP90: jobMinutesP90, cost: jobCost, costP90: jobCostP90 };
      total += jobCost;
      totalP90 += jobCostP90;
      totalMinutes += jobMinutes;
      totalMinutesP90 += jobMinutesP90;
    });

    return { units: unitsOut, byJob: byJob, perRun: total, perRunP90: totalP90, totalMinutes: totalMinutes, totalMinutesP90: totalMinutesP90 };
  }

  function monthly(costPerRun, runsPerDay, daysPerMonth) {
    var runs = Math.max(0, runsPerDay) * Math.max(0, daysPerMonth);
    return { runs: runs, cost: costPerRun * runs };
  }

  /*
   * Cache accounting from history attempts that carry cache records.
   * A record looks like { h: true, r: restoreSeconds, sv: savedSeconds } on a
   * hit or { h: false } on a miss. The saved seconds observed on hits are the
   * estimate of what a miss would have paid.
   */
  function cacheStats(model, history) {
    var hits = 0;
    var misses = 0;
    var saved = [];
    var restore = [];
    var runsWithCache = 0;
    var jobsWithCache = {};
    var runs = history && history.runs ? history.runs : [];

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var hadCache = false;
      Object.keys(run.jobs || {}).forEach(function (jobId) {
        var recs = run.jobs[jobId];
        for (var a = 0; a < recs.length; a++) {
          var rec = recs[a];
          if (rec.cache) {
            hadCache = true;
            jobsWithCache[jobId] = true;
            if (rec.cache.h) {
              hits++;
              if (typeof rec.cache.sv === 'number') saved.push(rec.cache.sv);
              if (typeof rec.cache.r === 'number') restore.push(rec.cache.r);
            } else {
              misses++;
            }
          }
        }
      });
      if (hadCache) runsWithCache++;
    }

    var savedStats = saved.length ? (root.PP.stats ? root.PP.stats(saved) : null) : null;
    var restoreStats = restore.length ? (root.PP.stats ? root.PP.stats(restore) : null) : null;
    var total = hits + misses;
    return {
      hits: hits,
      misses: misses,
      events: total,
      hitRate: total ? hits / total : null,
      medianSavedSeconds: savedStats ? savedStats.p50 : null,
      medianRestoreSeconds: restoreStats ? restoreStats.p50 : null,
      runsWithCache: runsWithCache,
      jobsWithCache: Object.keys(jobsWithCache),
      runs: runs.length,
      missesPerRun: runs.length ? misses / runs.length : 0
    };
  }

  var api = { DEFAULT_RATES: DEFAULT_RATES, kindOf: kindOf, billableMinutes: billableMinutes, unitRate: unitRate, runCost: runCost, monthly: monthly, cacheStats: cacheStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.DEFAULT_RATES = DEFAULT_RATES;
  root.PP.kindOf = kindOf;
  root.PP.billableMinutes = billableMinutes;
  root.PP.unitRate = unitRate;
  root.PP.runCost = runCost;
  root.PP.monthly = monthly;
  root.PP.cacheStats = cacheStats;
})();
