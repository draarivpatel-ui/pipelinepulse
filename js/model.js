/*
 * PipelinePulse workflow model. Validates the parsed YAML against the
 * GitHub Actions style subset PipelinePulse understands, then derives the
 * dependency graph: topological waves, matrix expansion, and cycle detection.
 *
 * All functions are pure and deterministic. No dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  var JOB_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

  function err(message, line) {
    return { message: message, line: line === undefined ? null : line };
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function asStringList(v) {
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v.slice();
    return null;
  }

  function comboEntries(matrixMap) {
    var keys = Object.keys(matrixMap);
    var rows = [{}];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var values = matrixMap[key];
      var next = [];
      for (var r = 0; r < rows.length; r++) {
        for (var v = 0; v < values.length; v++) {
          var row = {};
          var name;
          for (name in rows[r]) row[name] = rows[r][name];
          row[key] = values[v];
          next.push(row);
        }
      }
      rows = next;
    }
    return rows;
  }

  function comboLabel(combo) {
    return Object.keys(combo).map(function (k) { return k + ' ' + String(combo[k]); }).join(', ');
  }

  /*
   * Build a model from YAML text.
   * Returns { ok: true, model, warnings } or { ok: false, errors, warnings }.
   * When ok is true, warnings may still be present (tolerated unknown keys).
   */
  function buildModel(text, PP) {
    var warnings = [];
    var errors = [];
    PP = PP || (typeof globalThis !== 'undefined' ? globalThis.PP : null);
    if (!PP || !PP.parseYaml) {
      throw new Error('PipelinePulse yaml parser not loaded');
    }

    var doc;
    try {
      doc = PP.parseYaml(text);
    } catch (e) {
      if (e && e.name === 'ParseError') {
        return { ok: false, errors: [err(e.message, e.line)], warnings: warnings };
      }
      throw e;
    }

    if (!isPlainObject(doc)) {
      return { ok: false, errors: [err('the document must be a mapping at the top level, for example starting with "name:"', null)], warnings: warnings };
    }

    var KNOWN_TOP = { name: true, on: true, env: true, permissions: true, concurrency: true, jobs: true, defaults: true, 'timeout-minutes': true };
    Object.keys(doc).forEach(function (k) {
      if (!KNOWN_TOP[k]) warnings.push('top level: ignored unsupported key "' + k + '"');
    });

    if (!isPlainObject(doc.jobs)) {
      errors.push(err('jobs: is missing or is not a mapping; define at least one job under "jobs:"', null));
      return { ok: false, errors: errors, warnings: warnings };
    }
    var jobIds = Object.keys(doc.jobs);
    if (jobIds.length === 0) {
      errors.push(err('jobs: is empty; define at least one job', null));
      return { ok: false, errors: errors, warnings: warnings };
    }

    var jobs = {};
    var order = [];
    for (var i = 0; i < jobIds.length; i++) {
      var id = jobIds[i];
      var body = doc.jobs[id];
      if (!JOB_ID_RE.test(id)) {
        errors.push(err('job id "' + id + '" uses characters outside this subset; use letters, digits, _ and - and start with a letter or _', null));
        continue;
      }
      if (!isPlainObject(body)) {
        errors.push(err('job ' + id + ': the job body must be a mapping with keys like runs-on and steps', null));
        continue;
      }
      var job = { id: id, needs: [], runsOn: null, steps: [], matrix: null, failFast: true, timeoutMinutes: null };
      var unknown = [];
      Object.keys(body).forEach(function (k) {
        if (k === 'needs' || k === 'runs-on' || k === 'steps' || k === 'strategy' || k === 'timeout-minutes') return;
        unknown.push(k);
      });
      if (unknown.length > 0) {
        warnings.push('job ' + id + ': ignored unsupported key' + (unknown.length > 1 ? 's' : '') + ' ' + unknown.map(function (k) { return '"' + k + '"'; }).join(', '));
      }

      // needs
      if (body.needs !== undefined && body.needs !== null) {
        var needs = asStringList(body.needs);
        if (!needs || needs.some(function (n) { return typeof n !== 'string'; })) {
          errors.push(err('job ' + id + ': needs must be a job id or a list of job ids', null));
        } else {
          job.needs = needs;
        }
      }

      // runs-on
      if (body['runs-on'] === undefined || body['runs-on'] === null) {
        errors.push(err('job ' + id + ': runs-on is required in this subset, for example runs-on: ubuntu-latest', null));
      } else {
        var runners = asStringList(body['runs-on']);
        if (!runners || runners.length === 0 || runners.some(function (r) { return typeof r !== 'string'; })) {
          errors.push(err('job ' + id + ': runs-on must be a label or a list of labels', null));
        } else {
          job.runsOn = runners;
        }
      }

      // timeout-minutes
      if (body['timeout-minutes'] !== undefined && body['timeout-minutes'] !== null) {
        if (typeof body['timeout-minutes'] !== 'number' || !(body['timeout-minutes'] > 0)) {
          errors.push(err('job ' + id + ': timeout-minutes must be a positive number', null));
        } else {
          job.timeoutMinutes = body['timeout-minutes'];
        }
      }

      // strategy
      if (body.strategy !== undefined && body.strategy !== null) {
        if (!isPlainObject(body.strategy)) {
          errors.push(err('job ' + id + ': strategy must be a mapping, usually with a matrix key', null));
        } else {
          var stUnknown = Object.keys(body.strategy).filter(function (k) { return k !== 'matrix' && k !== 'fail-fast'; });
          if (stUnknown.length > 0) {
            warnings.push('job ' + id + ': strategy ignored unsupported key' + (stUnknown.length > 1 ? 's' : '') + ' ' + stUnknown.map(function (k) { return '"' + k + '"'; }).join(', '));
          }
          if (body.strategy['fail-fast'] !== undefined && body.strategy['fail-fast'] !== null) {
            if (typeof body.strategy['fail-fast'] !== 'boolean') {
              errors.push(err('job ' + id + ': strategy.fail-fast must be true or false', null));
            } else {
              job.failFast = body.strategy['fail-fast'];
            }
          }
          var mx = body.strategy.matrix;
          if (mx !== undefined && mx !== null) {
            if (!isPlainObject(mx)) {
              errors.push(err('job ' + id + ': strategy.matrix must be a mapping of name to a list of values', null));
            } else if (mx.include !== undefined || mx.exclude !== undefined) {
              errors.push(err('job ' + id + ': strategy.matrix.include and .exclude are outside this subset; list every combination explicitly', null));
            } else {
              var bad = Object.keys(mx).filter(function (k) { return !Array.isArray(mx[k]); });
              if (bad.length > 0) {
                errors.push(err('job ' + id + ': strategy.matrix.' + bad[0] + ' must be an array, for example ' + bad[0] + ': [a, b]', null));
              } else if (Object.keys(mx).length === 0) {
                errors.push(err('job ' + id + ': strategy.matrix is empty; list at least one axis with values', null));
              } else {
                job.matrix = { axes: Object.keys(mx), combos: comboEntries(mx) };
              }
            }
          }
        }
      }

      // steps
      if (body.steps !== undefined && body.steps !== null) {
        if (!Array.isArray(body.steps)) {
          errors.push(err('job ' + id + ': steps must be a list; each item starts with "- name:"', null));
        } else {
          for (var s = 0; s < body.steps.length; s++) {
            var st = body.steps[s];
            if (!isPlainObject(st)) {
              errors.push(err('job ' + id + ': step ' + (s + 1) + ' must be a mapping with a run: or uses: key', null));
              continue;
            }
            var step = { name: typeof st.name === 'string' ? st.name : null, run: typeof st.run === 'string' ? st.run : null, uses: typeof st.uses === 'string' ? st.uses : null };
            if (step.run === null && step.uses === null) {
              errors.push(err('job ' + id + ': step ' + (s + 1) + (step.name ? ' ("' + step.name + '")' : '') + ' needs a run: or uses: key', null));
            }
            if (st['timeout-minutes'] !== undefined && st['timeout-minutes'] !== null && (typeof st['timeout-minutes'] !== 'number' || !(st['timeout-minutes'] > 0))) {
              errors.push(err('job ' + id + ': step ' + (s + 1) + ' timeout-minutes must be a positive number', null));
            }
            var stUnknown2 = Object.keys(st).filter(function (k) { return k !== 'name' && k !== 'run' && k !== 'uses' && k !== 'timeout-minutes'; });
            if (stUnknown2.length > 0) {
              warnings.push('job ' + id + ' step ' + (s + 1) + ': ignored unsupported key' + (stUnknown2.length > 1 ? 's' : '') + ' ' + stUnknown2.map(function (k) { return '"' + k + '"'; }).join(', '));
            }
            job.steps.push(step);
          }
        }
      } else {
        errors.push(err('job ' + id + ': steps is missing; this subset requires an explicit steps list', null));
      }

      jobs[id] = job;
      order.push(id);
    }

    if (errors.length > 0) {
      return { ok: false, errors: errors, warnings: warnings };
    }

    // unknown needs
    for (var j = 0; j < order.length; j++) {
      var job2 = jobs[order[j]];
      for (var n = 0; n < job2.needs.length; n++) {
        var dep = job2.needs[n];
        if (!jobs[dep]) {
          errors.push(err('job ' + job2.id + ' needs "' + dep + '" but no job with that id exists; defined jobs are ' + order.join(', '), null));
        }
      }
      if (job2.needs.indexOf(job2.id) !== -1) {
        errors.push(err('job ' + job2.id + ' needs itself; a job cannot depend on its own completion', null));
      }
    }
    if (errors.length > 0) {
      return { ok: false, errors: errors, warnings: warnings };
    }

    // topological waves, cycle detection
    var remaining = {};
    order.forEach(function (id) { remaining[id] = jobs[id].needs.filter(function (n) { return jobs[n]; }).length; });
    var waves = [];
    var placed = {};
    var guard = 0;
    while (Object.keys(remaining).length > 0 && guard <= order.length + 1) {
      guard++;
      var wave = order.filter(function (id) { return remaining[id] === 0 && !placed[id]; });
      if (wave.length === 0) {
        var stuck = Object.keys(remaining).join(', ');
        errors.push(err('dependency cycle detected between these jobs: ' + stuck + '; a needs chain must end at jobs that need nothing', null));
        return { ok: false, errors: errors, warnings: warnings };
      }
      wave.forEach(function (id) {
        placed[id] = true;
        delete remaining[id];
        order.forEach(function (other) {
          if (remaining[other] > 0 && jobs[other].needs.indexOf(id) !== -1) remaining[other]--;
        });
      });
      waves.push(wave);
    }

    var name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : null;

    return {
      ok: true,
      warnings: warnings,
      model: {
        name: name,
        jobs: jobs,
        order: order,
        waves: waves,
        sourceText: text
      }
    };
  }

  // Flatten a job into runner units (one per matrix combination).
  function units(job) {
    if (!job.matrix) {
      return [{ jobId: job.id, comboIndex: null, combo: null, label: null, runner: job.runsOn ? job.runsOn[0] : null }];
    }
    return job.matrix.combos.map(function (combo, index) {
      return { jobId: job.id, comboIndex: index, combo: combo, label: comboLabel(combo), runner: job.runsOn ? job.runsOn[0] : null };
    });
  }

  function allUnits(model) {
    var out = [];
    model.order.forEach(function (id) {
      out = out.concat(units(model.jobs[id]));
    });
    return out;
  }

  function unitKey(unit) {
    return unit.jobId + (unit.comboIndex === null ? '' : '#' + unit.comboIndex);
  }

  var api = { buildModel: buildModel, units: units, allUnits: allUnits, unitKey: unitKey, comboLabel: comboLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.buildModel = buildModel;
  root.PP.units = units;
  root.PP.allUnits = allUnits;
  root.PP.unitKey = unitKey;
  root.PP.comboLabel = comboLabel;
})();
