/*
 * PipelinePulse duration engine. Turns a synthetic run history into per job
 * statistics, then answers two different questions with two different methods:
 *
 * 1. Critical path: the longest chain of job medians through the needs graph.
 * 2. Wall clock: a discrete slot simulation with an editable runner pool, so
 *    queue time appears when a wave demands more runners than exist.
 *
 * Every number is deterministic. No dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  // Linear interpolation quantile on a sorted array. q in [0, 1].
  function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    var idx = q * (sorted.length - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    var frac = idx - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
  }

  function stats(values) {
    if (!values || values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < sorted.length; i++) sum += sorted[i];
    return {
      n: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9)
    };
  }

  // Fallback estimate when a job has no run history: a base bootstrap plus a
  // flat allowance per step. Labeled as an estimate everywhere it surfaces.
  function fallbackMinutes(job) {
    var base = 1.2;
    var perStep = 0.9;
    return base + perStep * Math.max(1, job.steps.length);
  }

  function attemptList(history, jobId, comboLabel) {
    var out = [];
    var runs = history && history.runs ? history.runs : [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var jobRec = run.jobs ? run.jobs[jobId] : null;
      if (!jobRec) continue;
      for (var a = 0; a < jobRec.length; a++) {
        var rec = jobRec[a];
        if (comboLabel !== null && rec.c !== comboLabel) continue;
        if (comboLabel === null && rec.c !== undefined) continue;
        out.push({
          runId: run.id,
          attempt: rec.a || 1,
          status: rec.s,
          minutes: rec.m,
          combo: rec.c === undefined ? null : rec.c,
          message: rec.msg || null,
          cache: rec.cache || null
        });
      }
    }
    return out;
  }

  /*
   * Per unit statistics. Returns a map keyed by unit key:
   * { p50, p90, mean, n, estimated } plus per job summaries.
   */
  function unitStatistics(model, history) {
    var out = { units: {}, jobs: {} };
    model.order.forEach(function (id) {
      var job = model.jobs[id];
      var jobUnits = (root.PP.units ? root.PP.units(job) : units(job));
      var jobDurations = [];
      var comboStats = null;
      var estimated = false;

      if (job.matrix) comboStats = {};

      for (var u = 0; u < jobUnits.length; u++) {
        var unit = jobUnits[u];
        var attempts = attemptList(history, id, unit.label);
        var durations = attempts.map(function (a) { return a.minutes; });
        var st;
        if (durations.length === 0) {
          st = null;
          estimated = true;
        } else {
          st = stats(durations);
          for (var d = 0; d < durations.length; d++) jobDurations.push(durations[d]);
        }
        var key = (root.PP.unitKey ? root.PP.unitKey(unit) : unitKey(unit));
        if (st === null) {
          var fb = fallbackMinutes(job);
          st = { n: 0, min: fb, max: fb, mean: fb, p50: fb, p75: fb, p90: fb };
        }
        out.units[key] = {
          jobId: id,
          comboIndex: unit.comboIndex,
          label: unit.label,
          runner: unit.runner,
          p50: st.p50,
          p90: st.p90,
          mean: st.mean,
          n: st.n,
          estimated: st.n === 0,
          attempts: attempts
        };
        if (comboStats) comboStats[unit.label] = { p50: st.p50, p90: st.p90, n: st.n };
      }

      var jobAll = jobDurations.length ? stats(jobDurations) : null;
      var fbJob = fallbackMinutes(job);
      out.jobs[id] = {
        jobId: id,
        p50: jobAll ? jobAll.p50 : fbJob,
        p90: jobAll ? jobAll.p90 : fbJob,
        mean: jobAll ? jobAll.mean : fbJob,
        n: jobDurations.length,
        estimated: estimated,
        combos: comboStats
      };
    });
    return out;
  }

  /*
   * Slot simulation. Waves run in topological order; within a wave every
   * matrix combo is an independent unit. Units are scheduled longest first on
   * the earliest free slot of a pool with opts.pool slots (default 20). Each
   * unit carries opts.bootstrap minutes of checkout and runner setup.
   */
  function simulate(model, unitStats, opts) {
    opts = opts || {};
    var pool = Math.max(1, Math.floor(opts.pool || 20));
    var bootstrap = typeof opts.bootstrap === 'number' ? opts.bootstrap : 0.5;

    var waves = [];
    var jobResults = {};
    var unitResults = [];
    var slotFree = [];
    for (var s = 0; s < pool; s++) slotFree.push(0);

    var maxWaveDemand = 0;

    for (var w = 0; w < model.waves.length; w++) {
      var waveJobs = model.waves[w];
      var ready = 0;
      for (var j = 0; j < waveJobs.length; j++) {
        var job = model.jobs[waveJobs[j]];
        for (var n = 0; n < job.needs.length; n++) {
          var dep = jobResults[job.needs[n]];
          if (dep && dep.finish > ready) ready = dep.finish;
        }
      }

      var unitsInWave = [];
      for (var j2 = 0; j2 < waveJobs.length; j2++) {
        var jid = waveJobs[j2];
        var ju = (root.PP.units ? root.PP.units(model.jobs[jid]) : units(model.jobs[jid]));
        for (var u = 0; u < ju.length; u++) {
          var unit = ju[u];
          var key = (root.PP.unitKey ? root.PP.unitKey(unit) : unitKey(unit));
          var st = unitStats.units[key] || { p50: fallbackMinutes(model.jobs[jid]), estimated: true, n: 0 };
          unitsInWave.push({ unit: unit, key: key, duration: st.p50 + bootstrap, p50: st.p50, estimated: st.estimated });
        }
      }

      // deterministic order: longest first, then job id, then combo index
      unitsInWave.sort(function (a, b) {
        if (b.duration !== a.duration) return b.duration - a.duration;
        if (a.unit.jobId !== b.unit.jobId) return a.unit.jobId < b.unit.jobId ? -1 : 1;
        var ca = a.unit.comboIndex === null ? -1 : a.unit.comboIndex;
        var cb = b.unit.comboIndex === null ? -1 : b.unit.comboIndex;
        return ca - cb;
      });

      if (unitsInWave.length > maxWaveDemand) maxWaveDemand = unitsInWave.length;

      for (var u2 = 0; u2 < unitsInWave.length; u2++) {
        var item = unitsInWave[u2];
        var slot = 0;
        for (var f = 1; f < slotFree.length; f++) {
          if (slotFree[f] < slotFree[slot]) slot = f;
        }
        var start = Math.max(ready, slotFree[slot]);
        var queue = start - ready;
        var finish = start + item.duration;
        slotFree[slot] = finish;
        item.start = start;
        item.queue = queue;
        item.finish = finish;
        unitResults.push({
          jobId: item.unit.jobId,
          comboIndex: item.unit.comboIndex,
          label: item.unit.label,
          key: item.key,
          runner: item.unit.runner,
          p50: item.p50,
          bootstrap: bootstrap,
          duration: item.duration,
          ready: ready,
          start: start,
          queue: queue,
          finish: finish,
          estimated: item.estimated
        });
      }

      for (var j3 = 0; j3 < waveJobs.length; j3++) {
        var jid2 = waveJobs[j3];
        // collect the units of this job that were scheduled in this wave
        var mine = [];
        for (var u3 = 0; u3 < unitResults.length; u3++) {
          var rr = unitResults[u3];
          if (rr.jobId === jid2 && rr.ready === ready) mine.push(rr);
        }
        var startMin = Infinity;
        var finishMax = 0;
        var queueMax = 0;
        for (var m = 0; m < mine.length; m++) {
          if (mine[m].start < startMin) startMin = mine[m].start;
          if (mine[m].finish > finishMax) finishMax = mine[m].finish;
          if (mine[m].queue > queueMax) queueMax = mine[m].queue;
        }
        jobResults[jid2] = {
          jobId: jid2,
          ready: ready,
          start: startMin,
          finish: finishMax,
          queue: queueMax,
          wall: finishMax - ready,
          units: mine
        };
      }

      waves.push({
        index: w,
        jobs: waveJobs.slice(),
        ready: ready,
        demand: unitsInWave.length,
        finish: (function () {
          var fin = 0;
          for (var j4 = 0; j4 < waveJobs.length; j4++) {
            if (jobResults[waveJobs[j4]].finish > fin) fin = jobResults[waveJobs[j4]].finish;
          }
          return fin;
        })()
      });
    }

    var wall = 0;
    model.order.forEach(function (id) {
      if (jobResults[id] && jobResults[id].finish > wall) wall = jobResults[id].finish;
    });

    var queuedUnits = unitResults.filter(function (r) { return r.queue > 1e-9; });

    return {
      pool: pool,
      bootstrap: bootstrap,
      wall: wall,
      waves: waves,
      jobs: jobResults,
      units: unitResults,
      maxWaveDemand: maxWaveDemand,
      queuedUnits: queuedUnits,
      queuedMinutes: queuedUnits.reduce(function (acc, r) { return acc + r.queue; }, 0)
    };
  }

  /*
   * Critical path over the needs graph using job medians (max combo p50,
   * plus the same bootstrap used by the simulation so the two agree).
   */
  function criticalPath(model, unitStats, bootstrap) {
    bootstrap = typeof bootstrap === 'number' ? bootstrap : 0.5;
    var dur = {};
    model.order.forEach(function (id) {
      var job = model.jobs[id];
      var ju = (root.PP.units ? root.PP.units(job) : units(job));
      var best = 0;
      for (var u = 0; u < ju.length; u++) {
        var key = (root.PP.unitKey ? root.PP.unitKey(ju[u]) : unitKey(ju[u]));
        var st = unitStats.units[key] || { p50: fallbackMinutes(job) };
        if (st.p50 > best) best = st.p50;
      }
      dur[id] = best + bootstrap;
    });

    var dist = {};
    var parent = {};
    model.order.forEach(function (id) { dist[id] = 0; parent[id] = null; });
    for (var w = 0; w < model.waves.length; w++) {
      var waveJobs = model.waves[w];
      for (var j = 0; j < waveJobs.length; j++) {
        var id = waveJobs[j];
        var incoming = 0;
        var best = null;
        for (var n = 0; n < model.jobs[id].needs.length; n++) {
          var dep = model.jobs[id].needs[n];
          if (dist[dep] > incoming) { incoming = dist[dep]; best = dep; }
        }
        dist[id] = incoming + dur[id];
        parent[id] = best;
      }
    }

    var tail = null;
    model.order.forEach(function (id) {
      if (tail === null || dist[id] > dist[tail]) tail = id;
    });
    var path = [];
    var cur = tail;
    while (cur) {
      path.unshift(cur);
      cur = parent[cur];
    }
    return { minutes: tail === null ? 0 : dist[tail], path: path, jobMinutes: dur };
  }

  // Wall clock share per job for the duration table.
  function jobShare(simulation, jobId) {
    if (!simulation.wall) return 0;
    return simulation.jobs[jobId].wall / simulation.wall;
  }

  var api = { quantile: quantile, stats: stats, fallbackMinutes: fallbackMinutes, attemptList: attemptList, unitStatistics: unitStatistics, simulate: simulate, criticalPath: criticalPath, jobShare: jobShare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.quantile = quantile;
  root.PP.stats = stats;
  root.PP.fallbackMinutes = fallbackMinutes;
  root.PP.attemptList = attemptList;
  root.PP.unitStatistics = unitStatistics;
  root.PP.simulate = simulate;
  root.PP.criticalPath = criticalPath;
  root.PP.jobShare = jobShare;
})();
