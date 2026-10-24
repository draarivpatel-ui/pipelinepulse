/*
 * PipelinePulse savings bench. Deterministic rules that turn the measured
 * history into concrete proposals. Every rule returns a quantified estimate
 * with its assumptions attached, or nothing when the signal is not there.
 * Nothing here changes the workflow; it only proposes.
 *
 * No dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  function globToRegExp(pattern) {
    var escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    return new RegExp('^' + escaped + '$');
  }

  function pathsChanged(changedPaths, patterns) {
    if (!changedPaths || changedPaths.length === 0) return true; // no data, assume relevant
    var regexes = patterns.map(globToRegExp);
    return changedPaths.some(function (p) {
      return regexes.some(function (re) { return re.test(p); });
    });
  }

  function runsPerMonth(opts) {
    return Math.max(0, opts.runsPerDay) * Math.max(0, opts.daysPerMonth);
  }

  function blendedRate(cost) {
    if (!cost.totalMinutes) return 0;
    return cost.perRun / cost.totalMinutes;
  }

  function jobRate(cost, id) {
    var row = cost.byJob[id];
    if (!row || !row.minutes) return blendedRate(cost);
    return row.cost / row.minutes;
  }

  function minutesText(x) { return Math.round(x * 10) / 10; } // formatting helper for detail copy

  /*
   * Rule 1: cache misses. Each miss pays restore plus rebuild work that a hit
   * would have avoided. The saved seconds observed on hits estimate that cost.
   */
  function cacheRule(cache, cost, opts) {
    if (!cache || cache.events === 0 || cache.runs === 0) return null;
    if (cache.medianSavedSeconds === null) return null;
    var missesPerRun = cache.misses / cache.runs;
    var minutesPerRun = missesPerRun * cache.medianSavedSeconds / 60;
    var rpm = runsPerMonth(opts);
    // price at the runner kinds that actually carry the cache steps
    var cacheUnits = cost.units.filter(function (u) { return cache.jobsWithCache.indexOf(u.jobId) !== -1; });
    var rate = 0;
    if (cacheUnits.length > 0) {
      var minutes = cacheUnits.reduce(function (acc, u) { return acc + u.billable; }, 0);
      var spent = cacheUnits.reduce(function (acc, u) { return acc + u.cost; }, 0);
      rate = minutes > 0 ? spent / minutes : 0;
    }
    var hitsPct = Math.round(cache.hitRate * 1000) / 10;
    return {
      id: 'cache',
      title: 'Recover the ' + cache.misses + ' cache misses',
      kind: 'cost',
      minutesPerRun: minutesPerRun,
      costPerRun: minutesPerRun * rate,
      monthlyMinutes: minutesPerRun * rpm,
      monthlyCost: minutesPerRun * rpm * rate,
      detail: 'Cache hit rate is ' + hitsPct + ' percent over ' + cache.runs + ' runs. Each miss pays about ' + minutesText(cache.medianSavedSeconds / 60) + ' minutes of restore and rebuild work that a hit avoids. Cutting misses to zero would save ' + Math.round(minutesPerRun * 100) / 100 + ' minutes per run.',
      assumptions: [
        'Saved seconds observed on hits estimate what a miss pays',
        'Misses are treated as fully avoidable; a realistic fix recovers only part of this',
        'Priced at the average rate of the runners that carry the cache steps'
      ]
    };
  }

  /*
   * Rule 2: split the slowest matrix combination. Wall clock falls, runner
   * spend rises slightly, so both sides of the trade are stated.
   */
  function matrixSplitRule(model, unitStats, critical, opts) {
    var rpm = runsPerMonth(opts);
    var out = [];
    model.order.forEach(function (id) {
      var job = model.jobs[id];
      if (!job.matrix || job.matrix.combos.length < 2) return;
      var combos = Object.keys(unitStats.jobs[id].combos || {}).map(function (label) {
        return { label: label, p50: unitStats.jobs[id].combos[label].p50, p90: unitStats.jobs[id].combos[label].p90, n: unitStats.jobs[id].combos[label].n };
      });
      if (combos.length < 2) return;
      var sortedP50 = combos.map(function (c) { return c.p50; }).sort(function (a, b) { return a - b; });
      // baseline is the median of the other combinations, so a two combination
      // matrix compares its slowest side against its fast side directly
      var others = sortedP50.slice(0, -1);
      var median = (root.PP.stats ? root.PP.stats(others) : null);
      if (!median) return;
      var slowest = combos.reduce(function (a, b) { return b.p50 > a.p50 ? b : a; }, combos[0]);
      if (slowest.n < 3 || median.p50 <= 0) return;
      var ratio = slowest.p50 / median.p50;
      if (ratio < 1.4) return;
      var shardOverhead = 0.5;
      var newSlowest = slowest.p50 / 2 + shardOverhead;
      var wallSaved = slowest.p50 - newSlowest;
      var onCritical = critical.path.indexOf(id) !== -1;
      if (!onCritical) wallSaved = 0;
      var overheadMinutesPerRun = shardOverhead;
      var rate = blendedRate(opts.cost);
      var comboRate = opts.cost.units.filter(function (u) { return u.jobId === id; }).map(function (u) { return u.rate; })[0] || rate;
      out.push({
        id: 'split-' + id,
        title: 'Split the slowest matrix combination of ' + id,
        kind: 'wall',
        minutesPerRun: wallSaved,
        costPerRun: -overheadMinutesPerRun * comboRate,
        monthlyMinutes: wallSaved * rpm,
        monthlyCost: wallSaved * rpm * comboRate - overheadMinutesPerRun * rpm * comboRate,
        costNote: 'splitting adds about ' + Math.round(overheadMinutesPerRun * rpm) + ' billable minutes per month of extra shard overhead',
        detail: 'Combination "' + slowest.label + '" takes ' + Math.round(slowest.p50 * 10) / 10 + ' minutes at the median while the job median across combinations is ' + Math.round(median.p50 * 10) / 10 + ' minutes, a ' + Math.round(ratio * 100) / 100 + ' times spread. Sharding it in two should bring the combination to about ' + Math.round(newSlowest * 10) / 10 + ' minutes' + (onCritical ? ', and this job sits on the critical path.' : '. This job is off the critical path, so the wall clock barely moves; the win here is faster feedback for the combination itself.'),
        assumptions: [
          'Two equal shards of the slowest combination',
          'Each shard pays ' + shardOverhead + ' minutes of extra setup',
          onCritical ? 'The job is on the critical path, so wall savings apply' : 'The job is off the critical path, so no wall saving is claimed'
        ]
      });
    });
    return out.length ? out : null;
  }

  /*
   * Rule 3: path filters. Runs whose changed paths never touch the watched
   * patterns of a job let that job skip entirely. Only the job's own billable
   * minutes are counted, never downstream savings, so this stays conservative.
   */
  function pathFilterRule(model, history, watchPatterns, cost, opts) {
    if (!watchPatterns) return null;
    var runs = history && history.runs ? history.runs : [];
    if (runs.length === 0) return null;
    var rpm = runsPerMonth(opts);
    var rate = blendedRate(cost);
    var out = [];
    model.order.forEach(function (id) {
      var patterns = watchPatterns[id];
      if (!patterns || patterns.length === 0) return;
      var skipped = 0;
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        if (!run.jobs || !run.jobs[id]) continue; // job did not run, nothing to skip
        if (!pathsChanged(run.changedPaths, patterns)) skipped++;
      }
      if (skipped === 0) return;
      var jobMinutes = cost.byJob[id] ? cost.byJob[id].minutes : 0;
      var jobCost = cost.byJob[id] ? cost.byJob[id].cost : 0;
      if (jobMinutes <= 0) return;
      var minutesPerRun = skipped * jobMinutes / runs.length;
      out.push({
        id: 'paths-' + id,
        title: 'Skip ' + id + ' when watched paths are untouched',
        kind: 'cost',
        minutesPerRun: minutesPerRun,
        costPerRun: skipped * jobCost / runs.length,
        monthlyMinutes: minutesPerRun * rpm,
        monthlyCost: skipped * jobCost / runs.length * rpm,
        detail: skipped + ' of ' + runs.length + ' runs changed no path matching ' + patterns.join(', ') + ' yet ' + id + ' still ran, about ' + jobMinutes + ' billable minutes each time. A paths filter would skip those.',
        assumptions: [
          'Watch patterns are proposed from observed history, not present in the workflow',
          'The job is assumed fully skippable when no watched path changed',
          'Downstream jobs saved by this skip are not counted, so the estimate is conservative'
        ]
      });
    });
    return out.length ? out : null;
  }

  /*
   * Rule 4: fail fast on matrices that keep spending after a sibling fails.
   * Only proposed when the job has not already enabled fail-fast.
   */
  function failFastRule(model, history, cost, opts) {
    var runs = history && history.runs ? history.runs : [];
    if (runs.length === 0) return null;
    var rpm = runsPerMonth(opts);
    var rate = blendedRate(cost);
    var out = [];
    model.order.forEach(function (id) {
      var job = model.jobs[id];
      if (!job.matrix || job.matrix.combos.length < 2) return;
      if (job.failFast) return; // GitHub Actions default behaviour already cancels siblings
      var failedRuns = 0;
      var wasteSum = 0;
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        var recs = run.jobs ? run.jobs[id] : null;
        if (!recs) continue;
        var failMin = null;
        var otherMax = [];
        var seenCombos = {};
        for (var a = 0; a < recs.length; a++) {
          var rec = recs[a];
          if (rec.s === 'failure' || rec.s === 'cancelled') {
            if (failMin === null || rec.m < failMin) failMin = rec.m;
          }
          if (seenCombos[rec.c === undefined ? '' : rec.c] === undefined) {
            seenCombos[rec.c === undefined ? '' : rec.c] = rec.m;
          } else if (rec.m > seenCombos[rec.c === undefined ? '' : rec.c]) {
            seenCombos[rec.c === undefined ? '' : rec.c] = rec.m;
          }
        }
        if (failMin === null) continue;
        failedRuns++;
        Object.keys(seenCombos).forEach(function (c) {
          if (c !== '' && seenCombos[c] > failMin) wasteSum += seenCombos[c] - failMin;
        });
      }
      if (failedRuns === 0) return;
      var wastePerFailedRun = wasteSum / failedRuns;
      var failureRate = failedRuns / runs.length;
      var minutesPerRun = wastePerFailedRun * failureRate;
      var rate2 = jobRate(cost, id);
      out.push({
        id: 'failfast-' + id,
        title: 'Fail fast the ' + id + ' matrix',
        kind: 'cost',
        minutesPerRun: minutesPerRun,
        costPerRun: minutesPerRun * rate2,
        monthlyMinutes: minutesPerRun * rpm,
        monthlyCost: minutesPerRun * rpm * rate2,
        detail: id + ' runs with fail-fast off. Across ' + failedRuns + ' failed runs, sibling combinations kept running about ' + Math.round(wastePerFailedRun * 10) / 10 + ' minutes past the first failure on average. Fail-fast would cancel them while the failing combination retries.',
        assumptions: [
          'Sibling combinations abandon the moment the first combination fails',
          'The failing combination still uses its retry attempts, so flaky recoveries survive',
          'Billable minutes saved are priced at the run blended average rate'
        ]
      });
    });
    return out.length ? out : null;
  }

  /*
   * Rule 5: timeout caps for hung tails. A cap at 1.6 times the median kills
   * a hang early; the retry, if the history shows one, lands near the median.
   */
  function timeoutRule(model, unitStats, history, cost, opts) {
    var runs = history && history.runs ? history.runs : [];
    if (runs.length === 0) return null;
    var rpm = runsPerMonth(opts);
    var rate = blendedRate(cost);
    var out = [];
    model.order.forEach(function (id) {
      var job = model.jobs[id];
      if (job.matrix) return; // per combo hangs are handled by fail-fast and splitting
      var st = unitStats.jobs[id];
      if (!st || st.n < 4) return;
      var cap = Math.ceil(st.p50 * 1.6);
      var netSum = 0;
      var events = 0;
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        var recs = run.jobs ? run.jobs[id] : null;
        if (!recs) continue;
        for (var a = 0; a < recs.length; a++) {
          var rec = recs[a];
          if (rec.m <= cap) continue;
          events++;
          var retried = recs.some(function (s) { return (s.a || 1) > (rec.a || 1) && s.s === 'success'; });
          var net = retried ? rec.m - cap - st.p50 : rec.m - cap;
          if (net > 0) netSum += net;
        }
      }
      if (events === 0) return;
      var minutesPerRun = netSum / runs.length;
      var rate3 = jobRate(cost, id);
      if (minutesPerRun <= 0) return;
      out.push({
        id: 'timeout-' + id,
        title: 'Cap ' + id + ' with timeout-minutes: ' + cap,
        kind: 'both',
        minutesPerRun: minutesPerRun,
        costPerRun: minutesPerRun * rate3,
        monthlyMinutes: minutesPerRun * rpm,
        monthlyCost: minutesPerRun * rpm * rate3,
        detail: id + ' shows a hung tail: ' + events + ' attempt' + (events === 1 ? '' : 's') + ' ran past ' + cap + ' minutes, more than 1.6 times the ' + Math.round(st.p50 * 10) / 10 + ' minute median. A timeout would cut the hang and a retry would land near the median.',
        assumptions: [
          'Attempts past the cap are hung, not legitimately long',
          'A timed out attempt reruns once and lands near the median, which the history supports',
          'Cap proposed at 1.6 times the median duration'
        ]
      });
    });
    return out.length ? out : null;
  }

  /*
   * Build the bench. Returns a sorted list of suggestions, most valuable first,
   * plus the assumptions that hold across all of them.
   */
  function buildBench(input) {
    var opts = input.opts;
    var suggestions = [];
    var c = cacheRule(input.cache, input.cost, opts);
    if (c) suggestions.push(c);
    var split = matrixSplitRule(input.model, input.unitStats, input.critical, { runsPerDay: opts.runsPerDay, daysPerMonth: opts.daysPerMonth, cost: input.cost });
    if (split) suggestions = suggestions.concat(split);
    var pf = pathFilterRule(input.model, input.history, input.watchPatterns, input.cost, opts);
    if (pf) suggestions = suggestions.concat(pf);
    var ff = failFastRule(input.model, input.history, input.cost, opts);
    if (ff) suggestions = suggestions.concat(ff);
    var to = timeoutRule(input.model, input.unitStats, input.history, input.cost, opts);
    if (to) suggestions = suggestions.concat(to);

    suggestions.sort(function (a, b) { return b.monthlyCost - a.monthlyCost; });

    var totalMonthly = suggestions.reduce(function (acc, s) { return acc + Math.max(0, s.monthlyCost); }, 0);
    var totalMonthlyMinutes = suggestions.reduce(function (acc, s) { return acc + Math.max(0, s.monthlyMinutes); }, 0);

    return {
      suggestions: suggestions,
      totalMonthlyCost: totalMonthly,
      totalMonthlyMinutes: totalMonthlyMinutes,
      globalAssumptions: [
        'Monthly figures multiply per run estimates by the editable runs per day and days per month',
        'Every number on this bench is an estimate derived from synthetic fixture history, not a measurement of your pipeline',
        'Rules never stack cleanly; taken together they overlap, so the total is an upper bound'
      ]
    };
  }

  var api = { globToRegExp: globToRegExp, pathsChanged: pathsChanged, buildBench: buildBench, cacheRule: cacheRule, matrixSplitRule: matrixSplitRule, pathFilterRule: pathFilterRule, failFastRule: failFastRule, timeoutRule: timeoutRule, blendedRate: blendedRate, minutesText: minutesText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.globToRegExp = globToRegExp;
  root.PP.pathsChanged = pathsChanged;
  root.PP.buildBench = buildBench;
  root.PP.cacheRule = cacheRule;
  root.PP.matrixSplitRule = matrixSplitRule;
  root.PP.pathFilterRule = pathFilterRule;
  root.PP.failFastRule = failFastRule;
  root.PP.timeoutRule = timeoutRule;
  root.PP.blendedRate = blendedRate;
  root.PP.minutesText = minutesText;
})();
