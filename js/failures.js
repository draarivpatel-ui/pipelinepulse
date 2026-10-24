/*
 * PipelinePulse failure analyzer. Deterministic clustering of a run history:
 * error signatures are normalized so that changing line numbers, durations and
 * hashes collapse into one template, failures group by that template, retry
 * recoveries separate flaky clusters from hard ones, and failed attempts are
 * ranked by the billable minutes they burned.
 *
 * No dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  var HEX_RE = /\b[0-9a-f]{7,40}\b/g;
  var NUM_RE = /\d+(?:\.\d+)?/g;

  function normalizeSignature(message) {
    var s = String(message === null || message === undefined || message === '' ? 'unknown failure' : message).toLowerCase();
    s = s.replace(HEX_RE, '#hash');
    s = s.replace(NUM_RE, '#');
    s = s.replace(/[\s]+/g, ' ').trim();
    s = s.replace(/[.,;:]+$/, '');
    if (s.length > 160) s = s.slice(0, 160);
    return s;
  }

  /*
   * Cluster failure attempts across the whole history.
   * A cluster key is job id and normalized signature, so one flaky test
   * clusters across every matrix combination it times out on; the cluster
   * records which combinations it appeared on.
   * A failed run counts as retried pass when a later attempt of the same
   * combo succeeded inside the same run; otherwise it is a hard failure.
   */
  function clusterFailures(history) {
    var clusters = {};
    var runs = history && history.runs ? history.runs : [];

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var jobIds = Object.keys(run.jobs || {});
      for (var j = 0; j < jobIds.length; j++) {
        var jobId = jobIds[j];
        var recs = run.jobs[jobId];
        var failures = [];
        var successes = [];
        for (var a = 0; a < recs.length; a++) {
          var rec = recs[a];
          if (rec.s === 'failure' || rec.s === 'cancelled') failures.push(rec);
          else if (rec.s === 'success') successes.push(rec);
        }
        for (var f = 0; f < failures.length; f++) {
          var rec2 = failures[f];
          var combo = rec2.c === undefined ? null : rec2.c;
          var sig = normalizeSignature(rec2.msg);
          var key = jobId + '::' + sig;
          if (!clusters[key]) {
            clusters[key] = {
              jobId: jobId,
              signature: sig,
              sample: rec2.msg,
              combos: {},
              count: 0,
              minutes: 0,
              runIds: [],
              retriedPass: 0,
              hard: 0
            };
          }
          var cl = clusters[key];
          cl.count++;
          var comboName = combo === null ? 'single' : combo;
          cl.combos[comboName] = (cl.combos[comboName] || 0) + 1;
          var billable = root.PP.billableMinutes ? root.PP.billableMinutes(rec2.m) : Math.ceil(rec2.m);
          cl.minutes += billable;
          if (cl.runIds.indexOf(run.id) === -1) cl.runIds.push(run.id);
          var recovered = successes.some(function (s) {
            var sameCombo = s.c === undefined ? combo === null : s.c === combo;
            return (s.a || 1) > (rec2.a || 1) && sameCombo && s.s === 'success';
          });
          if (recovered) cl.retriedPass++;
          else cl.hard++;
        }
      }
    }

    var list = Object.keys(clusters).map(function (k) { return clusters[k]; });
    list.forEach(function (cl) {
      cl.total = cl.retriedPass + cl.hard;
      cl.flakiness = cl.total > 0 ? cl.retriedPass / cl.total : 0;
      cl.comboList = Object.keys(cl.combos);
    });
    list.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return (a.jobId + a.signature) < (b.jobId + b.signature) ? -1 : 1;
    });
    return list;
  }

  // Per job flakiness: the strongest retried pass signal among its clusters.
  function jobFlakiness(clusters) {
    var out = {};
    clusters.forEach(function (cl) {
      if (cl.retriedPass <= 0) return;
      var cur = out[cl.jobId];
      if (!cur || cl.flakiness > cur.score || (cl.flakiness === cur.score && cl.count > cur.count)) {
        out[cl.jobId] = { jobId: cl.jobId, score: cl.flakiness, retriedPass: cl.retriedPass, hard: cl.hard, count: cl.count, signature: cl.signature };
      }
    });
    return out;
  }

  // Failed attempts ranked by billable minutes burned, per job.
  function expensiveFailingJobs(history) {
    var byJob = {};
    var runs = history && history.runs ? history.runs : [];
    var total = 0;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var jobIds = Object.keys(run.jobs || {});
      for (var j = 0; j < jobIds.length; j++) {
        var jobId = jobIds[j];
        var recs = run.jobs[jobId];
        for (var a = 0; a < recs.length; a++) {
          var rec = recs[a];
          if (rec.s !== 'failure' && rec.s !== 'cancelled') continue;
          var billable = root.PP.billableMinutes ? root.PP.billableMinutes(rec.m) : Math.ceil(rec.m);
          if (!byJob[jobId]) byJob[jobId] = { jobId: jobId, minutes: 0, failures: 0, runs: [] };
          byJob[jobId].minutes += billable;
          byJob[jobId].failures++;
          if (byJob[jobId].runs.indexOf(run.id) === -1) byJob[jobId].runs.push(run.id);
          total += billable;
        }
      }
    }
    var list = Object.keys(byJob).map(function (k) { return byJob[k]; });
    list.forEach(function (row) { row.share = total > 0 ? row.minutes / total : 0; });
    list.sort(function (a, b) {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return a.jobId < b.jobId ? -1 : 1;
    });
    return { jobs: list, totalMinutes: total };
  }

  // Failure rate per job: share of runs where the job had at least one failure.
  function jobFailureRates(history) {
    var out = {};
    var runs = history && history.runs ? history.runs : [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var jobIds = Object.keys(run.jobs || {});
      for (var j = 0; j < jobIds.length; j++) {
        var jobId = jobIds[j];
        if (!out[jobId]) out[jobId] = { jobId: jobId, runs: 0, failedRuns: 0 };
        out[jobId].runs++;
        var recs = run.jobs[jobId];
        for (var a = 0; a < recs.length; a++) {
          if (recs[a].s === 'failure' || recs[a].s === 'cancelled') {
            out[jobId].failedRuns++;
            break;
          }
        }
      }
    }
    Object.keys(out).forEach(function (k) {
      out[k].rate = out[k].runs > 0 ? out[k].failedRuns / out[k].runs : 0;
    });
    return out;
  }

  var api = { normalizeSignature: normalizeSignature, clusterFailures: clusterFailures, jobFlakiness: jobFlakiness, expensiveFailingJobs: expensiveFailingJobs, jobFailureRates: jobFailureRates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.normalizeSignature = normalizeSignature;
  root.PP.clusterFailures = clusterFailures;
  root.PP.jobFlakiness = jobFlakiness;
  root.PP.expensiveFailingJobs = expensiveFailingJobs;
  root.PP.jobFailureRates = jobFailureRates;
})();
