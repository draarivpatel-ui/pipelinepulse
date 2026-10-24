/*
 * PipelinePulse synthetic fixtures. Everything here is invented for this
 * studio: the workflows do not belong to any real repository and the run
 * histories were written by hand to exercise the analyzers deterministically.
 *
 * Attempt records use short keys to keep the data readable:
 *   a: attempt number, s: status, m: minutes, c: matrix combination label,
 *   msg: failure message, cache: { h: hit, r: restore seconds, sv: saved seconds }
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  function ok(m, extra) {
    var rec = { a: 1, s: 'success', m: m };
    if (extra) { for (var k in extra) rec[k] = extra[k]; }
    return rec;
  }
  function fail(m, msg, extra) {
    var rec = { a: 1, s: 'failure', m: m, msg: msg };
    if (extra) { for (var k in extra) rec[k] = extra[k]; }
    return rec;
  }
  function retry(m) { return { a: 2, s: 'success', m: m }; }
  function hit(r, sv) { return { h: true, r: r, sv: sv }; }
  var MISS = { h: false };

  var SIG_TIMEOUT = 'test timed out after 60000 ms at tests/unit/store.test.ts:88';
  var SIG_SELECTOR = 'TimeoutError: Waiting for selector .dashboard failed at tests/e2e/overview.spec.ts:41';
  var SIG_PORT = 'docker: Error response from daemon: driver failed programming external connectivity: bind for 0.0.0.0:5432 failed: port is already allocated';
  var SIG_OOM = 'Process completed with exit code 137: JavaScript heap out of memory at node_modules/typescript/lib/tsc.js:214';
  var SIG_TYPEERR = 'TypeError: Cannot read properties of undefined (reading id) at tests/unit/api.test.ts:52';
  var SIG_LINT = 'eslint: 12 problems (12 errors, 0 warnings) at src/api/http.ts:41:7';
  var SIG_HANG = 'integration suite hung waiting for the docker compose health check; cancelled by the operator';

  var SERVICE_CI_YAML = [
    '# PipelinePulse synthetic fixture. This workflow is invented for this studio',
    '# and does not belong to any real repository.',
    'name: service ci',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: detect changed paths',
    '        run: echo "paths=$(git diff --name-only origin/main)" >> "$GITHUB_OUTPUT"',
    '',
    '  build:',
    '    needs: changes',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix:',
    '        node: [18, 20]',
    '    steps:',
    '      - name: checkout',
    '        uses: actions/checkout@v4',
    '      - name: restore dependencies',
    '        uses: actions/cache@v4',
    '      - name: install',
    '        run: npm ci',
    '      - name: build',
    '        run: npm run build',
    '      - name: upload artifact',
    '        uses: actions/upload-artifact@v4',
    '',
    '  lint:',
    '    needs: changes',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: lint',
    '        run: npm run lint',
    '',
    '  unit:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        shard: [1, 2, 3, 4]',
    '    steps:',
    '      - name: run unit shards',
    '        run: npm test -- --shard=$MATRIX_SHARD',
    '',
    '  integration:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: boot compose',
    '        run: docker compose up -d --wait',
    '      - name: run integration suite',
    '        run: npm run test:integration',
    '',
    '  e2e:',
    '    needs: [build, lint]',
    '    runs-on: macos-latest',
    '    steps:',
    '      - name: run browser suite',
    '        run: npm run test:e2e',
    '',
    '  docs-deploy:',
    '    needs: build',
    '    if: github.ref == \'refs/heads/main\'',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: build docs site',
    '        run: npm run docs:build',
    '      - name: publish docs',
    '        run: npm run docs:publish'
  ].join('\n');

  function svcRun(id, changedPaths, jobs) {
    return { id: id, changedPaths: changedPaths, jobs: jobs };
  }

  function svcChanges() { return [ok(0.4)]; }

  function svcBuild(n18, n20) {
    return [n18, n20].map(function (x) { return Array.isArray(x) ? x : [x]; })
      .reduce(function (acc, arr) { return acc.concat(arr); }, []);
  }

  function svcUnit(s1, s2, s3, s4) {
    return [s1, s2, s3, s4].map(function (recs, i) {
      var withCombo = [];
      for (var r = 0; r < recs.length; r++) {
        var rec = {};
        for (var k in recs[r]) rec[k] = recs[r][k];
        rec.c = 'shard ' + (i + 1);
        withCombo.push(rec);
      }
      return withCombo;
    }).reduce(function (acc, arr) { return acc.concat(arr); }, []);
  }

  var SERVICE_CI_HISTORY = [
    svcRun(1041, ['src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.1, { c: 'node 18', cache: hit(9.1, 128) }), ok(5.3, { c: 'node 20', cache: hit(8.7, 121) })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.2)], [ok(3.0)], [ok(3.4)], [ok(3.1)]),
      integration: [ok(8.9)],
      e2e: [ok(12.4)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1042, ['docs/guide.md', 'src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.3, { c: 'node 18', cache: hit(9.4, 131) }), ok(5.2, { c: 'node 20', cache: hit(8.9, 119) })),
      lint: [ok(1.3)],
      unit: svcUnit([ok(3.1)], [ok(3.2)], [ok(3.3)], [ok(3.0)]),
      integration: [ok(9.1)],
      e2e: [ok(12.6)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1043, ['src/ui/app.tsx'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.0, { c: 'node 18', cache: MISS }), ok(5.1, { c: 'node 20', cache: hit(8.8, 125) })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.3)], [fail(2.9, SIG_TIMEOUT), retry(3.3)], [ok(3.4)], [ok(3.2)]),
      integration: [ok(8.8)],
      e2e: [fail(12.7, SIG_SELECTOR), retry(13.1)],
      'docs-deploy': [ok(3.2)]
    }),
    svcRun(1044, ['src/api/http.ts', 'docs/changelog.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.5, { c: 'node 18', cache: hit(9.6, 137) }), ok(5.4, { c: 'node 20', cache: hit(9.0, 123) })),
      lint: [ok(1.1)],
      unit: svcUnit([ok(3.4)], [ok(3.1)], [ok(3.2)], [ok(3.3)]),
      integration: [fail(8.7, SIG_PORT), retry(9.2)],
      e2e: [ok(12.2)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1045, ['src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild([fail(3.6, SIG_OOM, { c: 'node 18' }), Object.assign(retry(7.6), { c: 'node 18', cache: MISS })], ok(5.5, { c: 'node 20', cache: hit(9.2, 127) })),
      lint: [ok(1.3)],
      unit: svcUnit([ok(3.2)], [ok(3.3)], [ok(3.1)], [ok(3.4)]),
      integration: [ok(9.3)],
      e2e: [ok(12.8)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1046, ['.github/workflows/ci.yml'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.2, { c: 'node 18', cache: hit(9.0, 129) }), ok(5.0, { c: 'node 20', cache: MISS })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.1)], [ok(3.2)], [ok(3.0)], [ok(3.3)]),
      integration: [ok(8.9)],
      e2e: [ok(12.5)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1047, ['src/ui/app.tsx', 'README.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.4, { c: 'node 18', cache: hit(9.3, 133) }), ok(5.2, { c: 'node 20', cache: hit(8.6, 118) })),
      lint: [ok(1.4)],
      unit: svcUnit([ok(3.3)], [ok(3.1)], [fail(3.0, SIG_TIMEOUT), retry(3.5)], [ok(3.2)]),
      integration: [ok(9.0)],
      e2e: [ok(12.7)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1048, ['src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.6, { c: 'node 18', cache: MISS }), ok(5.3, { c: 'node 20', cache: hit(8.9, 124) })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.2)], [ok(3.4)], [ok(3.3)], [ok(3.1)]),
      integration: [fail(9.4, SIG_PORT), { a: 2, s: 'failure', m: 15.8, msg: SIG_PORT }],
      e2e: [ok(12.9)],
      'docs-deploy': [ok(3.2)]
    }),
    svcRun(1049, ['docs/guide.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(6.9, { c: 'node 18', cache: hit(8.8, 126) }), ok(4.9, { c: 'node 20', cache: hit(8.5, 115) })),
      lint: [ok(1.1)],
      unit: svcUnit([ok(3.0)], [ok(3.1)], [ok(3.2)], [ok(3.0)]),
      integration: [ok(8.7)],
      e2e: [ok(11.8)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1050, ['src/ui/app.tsx'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.7, { c: 'node 18', cache: hit(9.5, 130) }), ok(5.4, { c: 'node 20', cache: MISS })),
      lint: [ok(1.3)],
      unit: svcUnit([ok(3.3)], [ok(3.2)], [ok(3.4)], [ok(3.3)]),
      integration: [ok(9.1)],
      e2e: [fail(11.8, SIG_SELECTOR)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1051, ['src/api/http.ts', 'docs/faq.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.8, { c: 'node 18', cache: MISS }), ok(5.5, { c: 'node 20', cache: MISS })),
      lint: [ok(1.2)],
      unit: svcUnit([fail(3.1, SIG_TIMEOUT), retry(3.4)], [ok(3.2)], [ok(3.3)], [ok(3.1)]),
      integration: [ok(9.2)],
      e2e: [ok(13.0)],
      'docs-deploy': [ok(3.2)]
    }),
    svcRun(1052, ['src/ui/app.tsx', 'src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild(ok(8.2, { c: 'node 18', cache: hit(9.8, 138) }), ok(5.6, { c: 'node 20', cache: hit(9.1, 126) })),
      lint: [ok(1.4)],
      unit: svcUnit([ok(3.4)], [ok(3.3)], [ok(3.5)], [ok(3.2)]),
      integration: [ok(14.5)],
      e2e: [ok(13.1)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1053, ['docs/guide.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.0, { c: 'node 18', cache: hit(8.9, 128) }), ok(5.0, { c: 'node 20', cache: hit(8.6, 117) })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.1)], [ok(3.0)], [ok(3.3)], [ok(3.1)]),
      integration: [ok(8.8)],
      e2e: [ok(12.3)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1054, ['src/api/http.ts'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.3, { c: 'node 18', cache: MISS }), ok(5.1, { c: 'node 20', cache: hit(8.7, 122) })),
      lint: [fail(1.1, SIG_LINT), retry(1.3)],
      unit: svcUnit([ok(3.2)], [fail(1.3, SIG_TYPEERR), retry(3.3)], [ok(3.1)], [ok(3.3)]),
      integration: [ok(9.0)],
      e2e: [ok(12.6)],
      'docs-deploy': [ok(3.1)]
    }),
    svcRun(1055, ['src/ui/app.tsx'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.5, { c: 'node 18', cache: hit(9.4, 131) }), ok(5.2, { c: 'node 20', cache: hit(8.8, 120) })),
      lint: [ok(1.2)],
      unit: svcUnit([ok(3.3)], [ok(3.2)], [ok(3.4)], [fail(3.6, SIG_TIMEOUT), retry(3.6)]),
      integration: [fail(26.4, SIG_HANG), retry(9.1)],
      e2e: [fail(12.6, SIG_SELECTOR)],
      'docs-deploy': [ok(3.0)]
    }),
    svcRun(1056, ['src/api/http.ts', 'docs/changelog.md'], {
      changes: svcChanges(),
      build: svcBuild(ok(7.9, { c: 'node 18', cache: MISS }), ok(5.3, { c: 'node 20', cache: hit(8.9, 125) })),
      lint: [ok(1.3)],
      unit: svcUnit([ok(3.3)], [ok(3.2)], [ok(3.1)], [ok(3.2)]),
      integration: [fail(8.9, SIG_PORT), retry(9.4)],
      e2e: [ok(12.8)],
      'docs-deploy': [ok(3.1)]
    })
  ];

  var SERVICE_CI_WATCH = {
    build: ['src/**', 'package.json', 'package-lock.json'],
    lint: ['src/**', 'tests/**'],
    unit: ['src/**', 'tests/**'],
    integration: ['src/**'],
    e2e: ['src/**', 'tests/e2e/**'],
    'docs-deploy': ['docs/**', 'README.md']
  };

  var PAGES_BUILD_YAML = [
    '# PipelinePulse synthetic fixture. This workflow is invented for this studio',
    '# and does not belong to any real repository.',
    'name: docs pages build',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  build:',
    '    runs-on: windows-latest',
    '    steps:',
    '      - name: checkout',
    '        uses: actions/checkout@v4',
    '      - name: build site',
    '        run: npm run docs:build',
    '',
    '  sign:',
    '    needs: build',
    '    runs-on: windows-latest',
    '    steps:',
    '      - name: sign binaries',
    '        run: npm run sign',
    '',
    '  publish:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: publish site',
    '        run: npm run publish'
  ].join('\n');

  var PAGES_BUILD_HISTORY = [
    svcRun(2011, ['docs/'], {
      build: [ok(4.6)], sign: [ok(2.2)], publish: [ok(1.0)]
    }),
    svcRun(2012, ['docs/'], {
      build: [ok(4.4)], sign: [ok(2.1)], publish: [ok(0.9)]
    }),
    svcRun(2013, ['docs/'], {
      build: [ok(4.8)], sign: [fail(1.9, 'signtool error MSB3481: no certificate found matching thumbprint 3fa85f64a7c9d1e2b3f45a6b7c8d9e0f1a2b3c4d'), retry(2.3)], publish: [ok(1.1)]
    }),
    svcRun(2014, ['docs/'], {
      build: [ok(4.2)], sign: [ok(2.4)], publish: [ok(1.0)]
    }),
    svcRun(2015, ['docs/'], {
      build: [ok(4.5)], sign: [ok(2.2)], publish: [ok(0.9)]
    }),
    svcRun(2016, ['docs/'], {
      build: [ok(4.7)], sign: [ok(2.3)], publish: [ok(1.1)]
    })
  ];

  var FIXTURES = [
    {
      id: 'service-ci',
      label: 'Synthetic service ci: matrix build, macos e2e, 16 runs of history',
      note: 'Invented workflow and invented run history written for this studio. The e2e job deliberately sits on macos hosted runners to exercise the rate table.',
      yaml: SERVICE_CI_YAML,
      history: { runs: SERVICE_CI_HISTORY },
      watchPatterns: SERVICE_CI_WATCH
    },
    {
      id: 'pages-build',
      label: 'Synthetic docs pages build: windows runners, 6 runs of history',
      note: 'Invented workflow and invented run history written for this studio. Small enough to read the whole cost table at a glance.',
      yaml: PAGES_BUILD_YAML,
      history: { runs: PAGES_BUILD_HISTORY },
      watchPatterns: {}
    }
  ];

  var api = { FIXTURES: FIXTURES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PP.FIXTURES = FIXTURES;
})();
