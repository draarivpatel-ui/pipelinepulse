'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseYaml, ParseError } = require('../js/yaml.js');

function parseOrThrow(text) {
  return parseYaml(text);
}

function parseErrorOf(text) {
  try {
    parseYaml(text);
  } catch (e) {
    assert.ok(e instanceof ParseError, 'expected a ParseError, got ' + (e && e.name));
    return e;
  }
  assert.fail('expected the parser to throw for: ' + text.slice(0, 60));
}

test('parses a small job map with nested mappings and sequences', () => {
  const doc = parseOrThrow([
    'name: demo',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: checkout',
    '        run: git checkout',
    '      - name: build',
    '        run: make all'
  ].join('\n'));
  assert.equal(doc.name, 'demo');
  assert.equal(doc.jobs.build['runs-on'], 'ubuntu-latest');
  assert.equal(doc.jobs.build.steps.length, 2);
  assert.equal(doc.jobs.build.steps[1].run, 'make all');
});

test('parses scalar types: integer, float, boolean, null, tilde, negative', () => {
  const doc = parseOrThrow([
    'a: 4',
    'b: 0.5',
    'c: true',
    'd: false',
    'e: null',
    'f: ~',
    'g: -3',
    'h: 2.5e3'
  ].join('\n'));
  assert.equal(doc.a, 4);
  assert.equal(doc.b, 0.5);
  assert.equal(doc.c, true);
  assert.equal(doc.d, false);
  assert.equal(doc.e, null);
  assert.equal(doc.f, null);
  assert.equal(doc.g, -3);
  assert.equal(doc.h, 2500);
});

test('plain strings keep colons and spaces, keys stop at the first colon', () => {
  const doc = parseOrThrow('run: npm test -- --reporter=tap:spec');
  assert.equal(doc.run, 'npm test -- --reporter=tap:spec');
});

test('single quoted strings keep their content and doubled quotes escape', () => {
  const doc = parseOrThrow("msg: 'it''s alive: yes'");
  assert.equal(doc.msg, "it's alive: yes");
});

test('double quoted strings process the documented escapes', () => {
  const doc = parseOrThrow('msg: "line one\\nline two \\"q\\" \\\\"');
  assert.equal(doc.msg, 'line one\nline two "q" \\');
});

test('parses inline arrays including numbers, quotes and nesting', () => {
  const doc = parseOrThrow('m: [18, 20]\nn: ["a, b", c]\no: [[1, 2], [3, 4]]\nempty: []');
  assert.deepEqual(doc.m, [18, 20]);
  assert.deepEqual(doc.n, ['a, b', 'c']);
  assert.deepEqual(doc.o, [[1, 2], [3, 4]]);
  assert.deepEqual(doc.empty, []);
});

test('parses block sequences at a deeper indent than their key', () => {
  const doc = parseOrThrow('needs:\n  - build\n  - lint');
  assert.deepEqual(doc.needs, ['build', 'lint']);
});

test('parses block sequences at the same indent as their key', () => {
  const doc = parseOrThrow('needs:\n- build\n- lint');
  assert.deepEqual(doc.needs, ['build', 'lint']);
});

test('parses mapping items inside sequences with continued keys', () => {
  const doc = parseOrThrow([
    'steps:',
    '- name: one',
    '  run: echo one',
    '- name: two',
    '  run: echo two'
  ].join('\n'));
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0].name, 'one');
  assert.equal(doc.steps[1].run, 'echo two');
  assert.equal(doc.steps[1].name, 'two');
});

test('supports an empty value that becomes a block below and null when nothing follows', () => {
  const doc = parseOrThrow('outer:\n  inner: 1\nnothing:');
  assert.deepEqual(doc.outer, { inner: 1 });
  assert.equal(doc.nothing, null);
});

test('strips full line and trailing comments outside quotes', () => {
  const doc = parseOrThrow([
    '# a comment',
    'kept: value # trailing comment',
    'quoted: "keep # this" # but not this'
  ].join('\n'));
  assert.equal(doc.kept, 'value');
  assert.equal(doc.quoted, 'keep # this');
});

test('accepts document markers and windows line endings', () => {
  const doc = parseYaml('---\r\nname: ok\r\njobs:\r\n');
  assert.equal(doc.name, 'ok');
  assert.equal(doc.jobs, null);
});

test('rejects tabs used for indentation and names the line', () => {
  const e = parseErrorOf('jobs:\n\tbuild: {}');
  assert.equal(e.line, 2);
  assert.match(e.message, /tabs are not allowed/);
});

test('rejects a mapping entry without a colon', () => {
  const e = parseErrorOf('jobs:\n  build\n');
  assert.equal(e.line, 2);
  assert.match(e.message, /key: value/);
});

test('rejects duplicate keys and points at the first definition', () => {
  const e = parseErrorOf('a: 1\nb: 2\na: 3');
  assert.equal(e.line, 3);
  assert.match(e.message, /duplicate key "a"/);
  assert.match(e.message, /line 1/);
});

test('rejects unclosed quoted strings', () => {
  parseErrorOf('name: "unterminated');
  parseErrorOf("name: 'unterminated");
});

test('rejects unclosed inline arrays with the opening line number', () => {
  const e = parseErrorOf('list: [1, 2\nother: 3');
  assert.equal(e.line, 1);
  assert.match(e.message, /unclosed inline array/);
});

test('rejects an empty document with a recovery hint', () => {
  const e = parseErrorOf('\n\n# only comments\n');
  assert.equal(e.line, 1);
  assert.match(e.message, /empty document/);
});

test('rejects block scalars, flow mappings, anchors and aliases with clear messages', () => {
  assert.match(parseErrorOf('script: |\n  echo hi').message, /block scalars/);
  assert.match(parseErrorOf('env: { FOO: bar }').message, /flow mappings/);
  assert.match(parseErrorOf('a: &anchor 1\nb: *anchor').message, /anchors and aliases/);
});

test('rejects stray indentation under a completed scalar value', () => {
  const e = parseErrorOf('name: demo\n  oops: 1');
  assert.equal(e.line, 2);
  assert.match(e.message, /unexpected indentation/);
});

test('rejects misaligned keys inside a mapping and shows both indents', () => {
  const e = parseErrorOf([
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: a',
    '        run: x',
    '   lint:',
    '    runs-on: ubuntu-latest'
  ].join('\n'));
  assert.equal(e.line, 7);
  assert.match(e.message, /continues at 2 spaces but this line has 3/);
});

test('rejects unexpected text after an inline array', () => {
  parseErrorOf('list: [1, 2] extra');
});

test('rejects empty elements inside inline arrays', () => {
  parseErrorOf('list: [1, , 3]');
});

test('parses a github actions shaped workflow end to end', () => {
  const doc = parseOrThrow([
    'name: ci',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    'jobs:',
    '  build:',
    '    needs: changes',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix:',
    '        node: [18, 20]',
    '    steps:',
    '      - name: build',
    '        run: npm run build',
    '  test:',
    '    needs: [build, lint]',
    '    runs-on: [ubuntu-latest]',
    '    steps:',
    '      - name: test',
    '        run: npm test'
  ].join('\n'));
  assert.deepEqual(doc.on.push.branches, ['main']);
  assert.deepEqual(doc.on['pull_request'], null);
  assert.equal(doc.jobs.build.needs, 'changes');
  assert.deepEqual(doc.jobs.test.needs, ['build', 'lint']);
  assert.deepEqual(doc.jobs.build.strategy.matrix.node, [18, 20]);
  assert.deepEqual(doc.jobs.test['runs-on'], ['ubuntu-latest']);
});
