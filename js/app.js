/*
 * PipelinePulse application wiring. Owns the DOM: the editable source console,
 * the editable rate table and cadence, and the five telemetry panels. All
 * dynamic values are inserted with textContent, never markup, so the pasted
 * YAML stays inert data. The heavy lifting lives in the other modules.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  var PP = root.PP;

  function byId(id) { return document.getElementById(id); }

  var el = {};

  var state = {
    fixtureIndex: 0,
    model: null,
    warnings: [],
    history: null,
    watchPatterns: null,
    stats: null,
    sim: null,
    critical: null,
    cost: null,
    cache: null,
    clusters: [],
    flaky: {},
    expensive: null,
    bench: null,
    rates: null,
    opts: { pool: 20, bootstrap: 0.5, runsPerDay: 24, daysPerMonth: 30 },
    selected: null
  };

  var graph = null;
  var debounceTimer = 0;

  /* formatting */

  function fmtMinutes(x) {
    if (x === null || x === undefined || isNaN(x)) return 'no data';
    return (Math.round(x * 10) / 10) + ' min';
  }

  function fmtMoney(x) {
    if (x === null || x === undefined || isNaN(x)) return 'no data';
    var abs = Math.abs(x);
    var digits = abs > 0 && abs < 0.1 ? 4 : 2;
    var sign = x < 0 ? '-' : '';
    return sign + '$' + Math.abs(x).toFixed(digits);
  }

  function fmtPct(x, digits) {
    if (x === null || x === undefined || isNaN(x)) return 'no data';
    return (Math.round(x * 100 * Math.pow(10, digits || 1)) / Math.pow(10, digits || 1)) + '%';
  }

  function fmtSeconds(x) {
    if (x === null || x === undefined) return 'no data';
    return (Math.round(x * 10) / 10) + ' s';
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function text(node, value) {
    clear(node);
    node.appendChild(document.createTextNode(value));
  }

  /* read numeric control values safely */

  function numInput(id, fallback, min) {
    var v = parseFloat(el[id].value);
    if (isNaN(v)) return fallback;
    return Math.max(min === undefined ? 0 : min, v);
  }

  function readControls() {
    state.opts.pool = Math.max(1, Math.round(numInput('input-pool', 20, 1)));
    state.opts.runsPerDay = numInput('input-runs-day', 24, 0);
    state.opts.daysPerMonth = numInput('input-days-month', 30, 0);
    state.rates = {
      linux: numInput('input-rate-linux', 0.008, 0),
      windows: numInput('input-rate-windows', 0.016, 0),
      macos: numInput('input-rate-macos', 0.08, 0),
      'self-hosted': 0
    };
  }

  /* computation */

  function compute() {
    if (!state.model) return;
    readControls();
    var PPd = PP;
    state.stats = PPd.unitStatistics(state.model, state.history || { runs: [] });
    state.sim = PPd.simulate(state.model, state.stats, { pool: state.opts.pool, bootstrap: state.opts.bootstrap });
    state.critical = PPd.criticalPath(state.model, state.stats, state.opts.bootstrap);
    state.cost = PPd.runCost(state.model, state.stats, state.rates, state.opts.bootstrap);
    state.cache = PPd.cacheStats(state.model, state.history || { runs: [] });
    state.clusters = PPd.clusterFailures(state.history || { runs: [] });
    state.flaky = PPd.jobFlakiness(state.clusters);
    state.expensive = PPd.expensiveFailingJobs(state.history || { runs: [] });
    state.ratesHistory = PPd.jobFailureRates(state.history || { runs: [] });
    state.bench = PPd.buildBench({
      model: state.model,
      history: state.history || { runs: [] },
      unitStats: state.stats,
      simulation: state.sim,
      critical: state.critical,
      cost: state.cost,
      cache: state.cache,
      watchPatterns: state.watchPatterns,
      opts: { runsPerDay: state.opts.runsPerDay, daysPerMonth: state.opts.daysPerMonth, cost: state.cost }
    });
  }

  function hasHistory() {
    return state.history && state.history.runs && state.history.runs.length > 0;
  }

  function overallFailureRate() {
    if (!hasHistory()) return null;
    var runs = state.history.runs;
    var failed = 0;
    for (var i = 0; i < runs.length; i++) {
      var jobs = runs[i].jobs || {};
      var ids = Object.keys(jobs);
      for (var j = 0; j < ids.length; j++) {
        var recs = jobs[ids[j]];
        var bad = false;
        for (var a = 0; a < recs.length; a++) {
          if (recs[a].s === 'failure' || recs[a].s === 'cancelled') { bad = true; break; }
        }
        if (bad) { failed++; break; }
      }
    }
    return { failed: failed, total: runs.length, rate: failed / runs.length };
  }

  /* rendering */

  function bump(node) {
    node.classList.remove('is-bumping');
    // force a reflow so the transition restarts on rapid edits
    void node.offsetWidth;
    node.classList.add('is-bumping');
    root.setTimeout(function () { node.classList.remove('is-bumping'); }, 260);
  }

  function setReadout(id, subId, value, sub, accent) {
    var node = byId(id);
    text(node, value);
    node.classList.toggle('is-accent', !!accent);
    if (subId) text(byId(subId), sub || '');
    bump(node);
  }

  function renderReadout() {
    var failure = overallFailureRate();
    setReadout('ro-wall', 'ro-wall-sub', fmtMinutes(state.sim.wall),
      'pool of ' + state.opts.pool + ' runners, ' + (state.sim.queuedUnits.length === 0 ? 'no queueing' : state.sim.queuedUnits.length + ' units queued'));
    setReadout('ro-critical', 'ro-critical-sub', state.critical.path.join(' > '),
      fmtMinutes(state.critical.minutes) + ' end to end');
    setReadout('ro-cost', 'ro-cost-sub', fmtMoney(state.cost.perRun),
      'billable minutes, whole minutes per job');
    setReadout('ro-monthly', 'ro-monthly-sub', fmtMoney(PP.monthly(state.cost.perRun, state.opts.runsPerDay, state.opts.daysPerMonth).cost),
      Math.round(state.opts.runsPerDay * state.opts.daysPerMonth) + ' runs per month, p90 ' + fmtMoney(PP.monthly(state.cost.perRunP90, state.opts.runsPerDay, state.opts.daysPerMonth).cost));
    if (failure) {
      setReadout('ro-failure', 'ro-failure-sub', fmtPct(failure.rate),
        failure.failed + ' of ' + failure.total + ' fixture runs had a failure');
    } else {
      setReadout('ro-failure', 'ro-failure-sub', 'no history', 'paste a workflow with fixture history to measure');
    }
  }

  function renderMap() {
    var meta = {};
    state.model.order.forEach(function (id) {
      var st = state.stats.jobs[id];
      var job = state.model.jobs[id];
      meta[id] = {
        subText: fmtMinutes(st.p50) + (job.matrix ? ' worst combo' : ' on ' + PP.kindOf(job.runsOn[0])),
        combos: job.matrix ? job.matrix.combos.length : 0
      };
    });
    graph.setModel(state.model, meta);
    graph.setSelected(state.selected);

    var path = state.critical;
    canvasEl.setAttribute('aria-label',
      'Pipeline graph with ' + state.model.order.length + ' jobs in ' + state.model.waves.length +
      ' waves. Critical path: ' + path.path.join(', then ') + ', about ' + Math.round(path.minutes * 10) / 10 + ' minutes.');

    // job chips
    clear(jobListEl);
    state.model.order.forEach(function (id) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'job-chip';
      btn.setAttribute('aria-pressed', state.selected === id ? 'true' : 'false');
      var st = state.stats.jobs[id];
      text(btn, id + ' ' + fmtMinutes(st.p50));
      btn.addEventListener('click', function () { selectJob(id); });
      li.appendChild(btn);
      jobListEl.appendChild(li);
    });

    renderJobDetail();
  }

  function renderJobDetail() {
    clear(jobDetailEl);
    if (!state.selected || !state.model.jobs[state.selected]) {
      var hint = document.createElement('p');
      text(hint, 'Select a job in the map or the list to inspect its timing, queue and cost.');
      jobDetailEl.appendChild(hint);
      return;
    }
    var id = state.selected;
    var job = state.model.jobs[id];
    var st = state.stats.jobs[id];
    var simJob = state.sim.jobs[id];
    var costJob = state.cost.byJob[id];
    var rate = state.ratesHistory[id];

    var h = document.createElement('h3');
    text(h, id);
    jobDetailEl.appendChild(h);

    var dl = document.createElement('dl');
    dl.className = 'job-detail-grid';

    function addTerm(label, value) {
      var dt = document.createElement('dt');
      text(dt, label);
      var dd = document.createElement('dd');
      text(dd, value);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    addTerm('runs on', job.runsOn.join(', '));
    addTerm('needs', job.needs.length ? job.needs.join(', ') : 'nothing, entry job');
    if (job.matrix) {
      addTerm('matrix', job.matrix.combos.map(function (c) { return PP.comboLabel(c); }).join(' | '));
      addTerm('fail fast', job.failFast ? 'on' : 'off');
    }
    addTerm('median', fmtMinutes(st.p50) + (st.estimated ? ' estimated from step count' : ' over ' + st.n + ' attempts'));
    addTerm('p90', fmtMinutes(st.p90));
    addTerm('queue estimate', fmtMinutes(simJob.queue));
    addTerm('wall share', fmtPct(PP.jobShare(state.sim, id)));
    addTerm('billable', costJob.minutes + ' min, ' + fmtMoney(costJob.cost) + ' per run');
    if (rate) addTerm('failure rate', fmtPct(rate.rate) + ' of runs');

    jobDetailEl.appendChild(dl);

    var stepsTitle = document.createElement('p');
    stepsTitle.className = 'subhead';
    text(stepsTitle, job.steps.length + ' step' + (job.steps.length === 1 ? '' : 's'));
    jobDetailEl.appendChild(stepsTitle);
    var ul = document.createElement('ul');
    ul.className = 'step-list';
    job.steps.forEach(function (s) {
      var li = document.createElement('li');
      text(li, (s.name || s.uses || 'step') + (s.run ? ': ' + s.run : s.uses ? ': ' + s.uses : ''));
      ul.appendChild(li);
    });
    jobDetailEl.appendChild(ul);
  }

  function selectJob(id) {
    var wasSelected = state.selected === id;
    state.selected = wasSelected ? null : id;
    graph.setSelected(state.selected);
    if (!wasSelected) graph.scrollToNode(id);
    var chips = jobListEl.querySelectorAll('.job-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed', state.model.order[i] === state.selected ? 'true' : 'false');
    }
    renderJobDetail();
  }

  function tableRow(cells, opts) {
    var tr = document.createElement('tr');
    if (opts && opts.critical) tr.className = 'is-critical';
    cells.forEach(function (c) {
      var td = document.createElement('td');
      if (c.className) td.className = c.className;
      if (c.html) td.appendChild(c.html);
      else text(td, c.value === undefined ? '' : String(c.value));
      tr.appendChild(td);
    });
    return tr;
  }

  function renderDuration() {
    clear(durationBody);
    state.model.order.forEach(function (id) {
      var st = state.stats.jobs[id];
      var simJob = state.sim.jobs[id];
      var critical = state.critical.path.indexOf(id) !== -1;
      var nameTd = document.createElement('span');
      if (critical) {
        var mark = document.createElement('span');
        mark.className = 'critical-mark';
        mark.setAttribute('aria-hidden', 'true');
        nameTd.appendChild(mark);
      }
      nameTd.appendChild(document.createTextNode(id));
      durationBody.appendChild(tableRow([
        { html: nameTd },
        { value: fmtMinutes(st.p50), className: 'num' },
        { value: fmtMinutes(st.p90), className: 'num' },
        { value: fmtMinutes(simJob.queue), className: 'num' },
        { value: fmtMinutes(simJob.wall), className: 'num' },
        { value: fmtPct(PP.jobShare(state.sim, id)), className: 'num' }
      ], { critical: critical }));
    });
    text(durationFoot, 'Medians come from ' + (hasHistory() ? state.history.runs.length + ' synthetic fixture runs' : 'a step count estimate, no fixture history') +
      '. Queue estimates simulate ' + state.opts.pool + ' runners scheduled longest first, plus ' + state.opts.bootstrap + ' minutes of bootstrap per unit. A dot marks a job on the critical path: ' + state.critical.path.join(', ') + '.');
  }

  function renderCost() {
    clear(costBody);
    state.model.order.forEach(function (id) {
      var row = state.cost.byJob[id];
      var job = state.model.jobs[id];
      var kind = PP.kindOf(job.runsOn[0]);
      var unit = state.cost.units.filter(function (u) { return u.jobId === id; })[0];
      costBody.appendChild(tableRow([
        { value: id },
        { value: job.runsOn[0] + ' at ' + kind + ' rate' },
        { value: row.minutes + ' min', className: 'num' },
        { value: '$' + unit.rate.toFixed(4) + '/min', className: 'num' },
        { value: fmtMoney(row.cost), className: 'num' },
        { value: fmtPct(row.cost / state.cost.perRun), className: 'num' }
      ]));
    });

    var monthly = PP.monthly(state.cost.perRun, state.opts.runsPerDay, state.opts.daysPerMonth);
    var monthlyP90 = PP.monthly(state.cost.perRunP90, state.opts.runsPerDay, state.opts.daysPerMonth);
    text(costRunsMonth, String(Math.round(monthly.runs)));
    text(costMinutesMonth, Math.round(state.cost.totalMinutes * monthly.runs) + ' min');
    text(costMonthly, fmtMoney(monthly.cost));
    text(costMonthlyP90, fmtMoney(monthlyP90.cost));

    if (state.cache.events > 0) {
      cacheWrap.classList.remove('is-hidden');
      text(cacheHit, fmtPct(state.cache.hitRate));
      text(cacheMiss, (Math.round(state.cache.missesPerRun * 100) / 100) + ' per run');
      text(cacheSaved, fmtSeconds(state.cache.medianSavedSeconds));
      text(cacheExposure, fmtMinutes(state.cache.missesPerRun * state.cache.medianSavedSeconds / 60));
    } else {
      cacheWrap.classList.add('is-hidden');
    }

    text(costFoot, 'Billing assumption: whole minutes per job per matrix combination at the public hosted runner list prices, which the rate inputs override. The rate table and the cadence are editable.');
  }

  function renderFailures() {
    clear(failClustersBody);
    if (state.clusters.length === 0) {
      emptyFailures.classList.remove('is-hidden');
      failClustersWrap.classList.add('is-hidden');
      flakyBlock.classList.add('is-hidden');
      expensiveBlock.classList.add('is-hidden');
    } else {
      emptyFailures.classList.add('is-hidden');
      failClustersWrap.classList.remove('is-hidden');
      flakyBlock.classList.remove('is-hidden');
      expensiveBlock.classList.remove('is-hidden');
    }

    state.clusters.forEach(function (cl) {
      var sig = document.createElement('code');
      sig.className = 'sig';
      var sample = cl.sample.length > 90 ? cl.sample.slice(0, 90) + '...' : cl.sample;
      text(sig, sample);
      sig.title = cl.sample;
      failClustersBody.appendChild(tableRow([
        { value: cl.jobId },
        { html: sig, className: 'wrap' },
        { value: cl.count, className: 'num' },
        { value: cl.retriedPass, className: 'num' },
        { value: cl.hard, className: 'num' },
        { value: fmtPct(cl.flakiness, 0), className: 'num' },
        { value: cl.minutes + ' min', className: 'num' }
      ]));
    });
    text(failClustersFoot, 'Signature clusters collapse line numbers, durations and hashes, so one recurring error stays one row. Retried pass counts failures that a later attempt recovered in the same run.');

    // flaky bars
    clear(flakyList);
    var flakyIds = Object.keys(state.flaky);
    if (flakyIds.length === 0) {
      flakyBlock.classList.add('is-hidden');
    } else {
      flakyBlock.classList.remove('is-hidden');
      flakyIds.forEach(function (id) {
        var row = state.flaky[id];
        var li = document.createElement('li');
        li.className = 'flaky-row';
        var name = document.createElement('span');
        text(name, id);
        var track = document.createElement('span');
        track.className = 'flaky-track';
        var fill = document.createElement('span');
        fill.className = 'flaky-fill';
        fill.style.width = Math.round(row.score * 100) + '%';
        track.appendChild(fill);
        track.setAttribute('role', 'img');
        track.setAttribute('aria-label', 'flakiness ' + Math.round(row.score * 100) + ' percent');
        var val = document.createElement('span');
        val.className = 'flaky-value';
        text(val, fmtPct(row.score, 0) + ' flaky, ' + row.retriedPass + ' recovered of ' + row.count);
        li.appendChild(name);
        li.appendChild(track);
        li.appendChild(val);
        flakyList.appendChild(li);
      });
    }

    // expensive failing jobs
    clear(expensiveList);
    if (state.expensive.jobs.length === 0) {
      expensiveBlock.classList.add('is-hidden');
    } else {
      expensiveBlock.classList.remove('is-hidden');
      state.expensive.jobs.forEach(function (row, i) {
        var li = document.createElement('li');
        var rank = document.createElement('span');
        text(rank, (i + 1) + '.');
        var name = document.createElement('span');
        text(name, row.jobId);
        var min = document.createElement('span');
        min.className = 'exp-min';
        text(min, row.minutes + ' min burned, ' + row.failures + ' failed attempt' + (row.failures === 1 ? '' : 's') + ', ' + fmtPct(row.share) + ' of failure minutes');
        li.appendChild(rank);
        li.appendChild(name);
        li.appendChild(min);
        expensiveList.appendChild(li);
      });
    }
  }

  function renderSavings() {
    clear(savingsList);
    if (state.bench.suggestions.length === 0) {
      savingsEmpty.classList.remove('is-hidden');
      text(savingsTotalLine, '');
      return;
    }
    savingsEmpty.classList.add('is-hidden');

    state.bench.suggestions.forEach(function (s) {
      var box = document.createElement('article');
      box.className = 'suggestion';

      var head = document.createElement('div');
      head.className = 'suggestion-head';
      var h = document.createElement('h3');
      text(h, s.title);
      head.appendChild(h);

      var chip = document.createElement('span');
      chip.className = 'estimate-chip';
      text(chip, 'estimate: ' + fmtMoney(s.monthlyCost) + ' per month');
      head.appendChild(chip);

      if (s.kind === 'wall' || s.kind === 'both') {
        var chip2 = document.createElement('span');
        chip2.className = 'estimate-chip is-plain';
        text(chip2, fmtMinutes(s.minutesPerRun) + ' wall clock per run');
        head.appendChild(chip2);
      }
      if (s.costNote) {
        var chip3 = document.createElement('span');
        chip3.className = 'estimate-chip is-plain';
        text(chip3, s.costNote);
        head.appendChild(chip3);
      }

      box.appendChild(head);

      var p = document.createElement('p');
      text(p, s.detail);
      box.appendChild(p);

      var assumptionsTitle = document.createElement('p');
      assumptionsTitle.className = 'subhead';
      text(assumptionsTitle, 'Assumptions behind the estimate');
      box.appendChild(assumptionsTitle);
      var ul = document.createElement('ul');
      ul.className = 'assumptions';
      s.assumptions.forEach(function (a) {
        var li = document.createElement('li');
        text(li, a);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      savingsList.appendChild(box);
    });

    clear(savingsTotalLine);
    var t1 = document.createElement('span');
    text(t1, 'Added up, the bench claims at most');
    var strong = document.createElement('strong');
    text(strong, ' ' + fmtMoney(state.bench.totalMonthlyCost) + ' per month');
    var t2 = document.createElement('span');
    text(t2, ' and ' + Math.round(state.bench.totalMonthlyMinutes) + ' runner and wall clock minutes per month. The rules overlap, so treat the total as an upper bound, not a promise.');
    savingsTotalLine.appendChild(t1);
    savingsTotalLine.appendChild(strong);
    savingsTotalLine.appendChild(t2);
  }

  function renderParseState(result) {
    clear(errorList);
    clear(warningList);
    if (result && !result.ok) {
      statusDot.classList.add('is-error');
      text(statusText, 'the workflow did not parse; showing the last valid one');
      result.errors.forEach(function (e) {
        var li = document.createElement('li');
        if (e.line) {
          var line = document.createElement('span');
          line.className = 'err-line';
          text(line, 'line ' + e.line);
          li.appendChild(line);
        }
        li.appendChild(document.createTextNode(e.message));
        errorList.appendChild(li);
      });
    } else {
      statusDot.classList.remove('is-error');
      var n = state.model.order.length;
      var w = state.warnings.length;
      text(statusText, 'parsed ' + n + ' job' + (n === 1 ? '' : 's') + (w ? ', ' + w + ' tolerated key' + (w === 1 ? '' : 's') + ' ignored' : ', no warnings'));
      state.warnings.forEach(function (msg) {
        var li = document.createElement('li');
        text(li, msg);
        warningList.appendChild(li);
      });
    }
  }

  function renderAll() {
    renderReadout();
    renderMap();
    renderDuration();
    renderCost();
    renderFailures();
    renderSavings();
  }

  /* source handling */

  function applySource(yamlText, fixture) {
    var result = PP.buildModel(yamlText, PP);
    state.warnings = result.warnings || [];
    if (result.ok) {
      state.model = result.model;
      state.history = fixture ? fixture.history : null;
      state.watchPatterns = fixture ? fixture.watchPatterns : null;
      state.selected = null;
      compute();
      renderParseState(result);
      renderAll();
    } else {
      renderParseState(result);
    }
  }

  function loadFixture(index) {
    state.fixtureIndex = index;
    var fixture = PP.FIXTURES[index];
    el['workflow-text'].value = fixture.yaml;
    text(fixtureNote, fixture.note);
    applySource(fixture.yaml, fixture);
  }

  /* nav highlight */

  function wireNav() {
    var links = sectionNav.querySelectorAll('a');
    var map = {};
    links.forEach(function (a) {
      var sec = document.querySelector(a.getAttribute('href'));
      if (sec) map[sec.id] = a;
    });
    if (typeof IntersectionObserver === 'function') {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && map[entry.target.id]) {
            links.forEach(function (a) { a.classList.remove('is-active'); });
            map[entry.target.id].classList.add('is-active');
          }
        });
      }, { rootMargin: '-30% 0px -60% 0px' });
      Object.keys(map).forEach(function (id) { obs.observe(byId(id)); });
    }
  }

  function init() {
    ['fixture-select', 'workflow-text', 'input-pool', 'input-runs-day', 'input-days-month',
      'input-rate-linux', 'input-rate-windows', 'input-rate-macos'].forEach(function (id) {
      el[id] = byId(id);
    });

    canvasEl = byId('map-canvas');
    mapScrollEl = byId('map-scroll');
    jobListEl = byId('job-list');
    jobDetailEl = byId('job-detail');
    durationBody = byId('duration-body');
    durationFoot = byId('duration-foot');
    costBody = byId('cost-body');
    costRunsMonth = byId('cost-runs-month');
    costMinutesMonth = byId('cost-minutes-month');
    costMonthly = byId('cost-monthly');
    costMonthlyP90 = byId('cost-monthly-p90');
    costFoot = byId('cost-foot');
    cacheWrap = byId('cache-block');
    cacheHit = byId('cache-hit');
    cacheMiss = byId('cache-miss');
    cacheSaved = byId('cache-saved');
    cacheExposure = byId('cache-exposure');
    failClustersBody = byId('fail-clusters-body');
    failClustersWrap = byId('fail-clusters-wrap');
    failClustersFoot = byId('fail-clusters-foot');
    emptyFailures = byId('failures-empty');
    flakyBlock = byId('flaky-block');
    flakyList = byId('flaky-list');
    expensiveBlock = byId('expensive-block');
    expensiveList = byId('expensive-list');
    savingsList = byId('savings-list');
    savingsEmpty = byId('savings-empty');
    savingsTotalLine = byId('savings-total');
    errorList = byId('parse-errors');
    warningList = byId('parse-warnings');
    statusDot = byId('status-dot');
    statusText = byId('status-text');
    fixtureNote = byId('fixture-note');
    sectionNav = byId('section-nav');

    graph = PP.Graph.create(canvasEl, mapScrollEl);
    graph.onSelect(function (id) { selectJob(id); });

    PP.FIXTURES.forEach(function (f, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      text(opt, f.label);
      el['fixture-select'].appendChild(opt);
    });

    el['fixture-select'].addEventListener('change', function () {
      loadFixture(parseInt(el['fixture-select'].value, 10));
    });

    el['workflow-text'].addEventListener('input', function () {
      root.clearTimeout(debounceTimer);
      debounceTimer = root.setTimeout(function () {
        applySource(el['workflow-text'].value, null);
      }, 300);
    });

    ['input-pool', 'input-runs-day', 'input-days-month', 'input-rate-linux', 'input-rate-windows', 'input-rate-macos'].forEach(function (id) {
      el[id].addEventListener('input', function () {
        if (state.model) {
          compute();
          renderAll();
        }
      });
    });

    wireNav();
    loadFixture(0);
  }

  var canvasEl, mapScrollEl, jobListEl, jobDetailEl, durationBody, durationFoot,
    costBody, costRunsMonth, costMinutesMonth, costMonthly, costMonthlyP90, costFoot,
    cacheWrap, cacheHit, cacheMiss, cacheSaved, cacheExposure,
    failClustersBody, failClustersWrap, failClustersFoot, emptyFailures,
    flakyBlock, flakyList, expensiveBlock, expensiveList,
    savingsList, savingsEmpty, savingsTotalLine,
    errorList, warningList, statusDot, statusText, fixtureNote, sectionNav;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
