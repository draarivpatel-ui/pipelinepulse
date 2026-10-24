'use strict';

/*
 * Node side wiring smoke test for the PipelinePulse studio.
 * Loads the real index.html into a minimal DOM stub, runs the nine shipped
 * scripts in order the way a browser would (including the canvas graph with a
 * stubbed 2d context and a pumped requestAnimationFrame clock), and proves the
 * main init path plus the fixture, edit, parse error, and selection flows
 * execute without throwing. This is not part of npm test; run it with
 * `node scripts/dom-smoke.js`. It is a wiring check, not a browser.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

/* ---------- minimal DOM stub ---------- */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:@][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let a;
  while ((a = re.exec(s)) !== null) {
    attrs[a[1]] = a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
  }
  return attrs;
}

function make2dContext() {
  const props = {};
  const ctx = {};
  ['font', 'textAlign', 'textBaseline', 'fillStyle', 'strokeStyle', 'lineWidth', 'shadowBlur', 'shadowColor'].forEach(function (p) {
    Object.defineProperty(ctx, p, {
      get: function () { return props[p]; },
      set: function (v) { props[p] = v; }
    });
  });
  ['clearRect', 'fillText', 'strokeText', 'measureText', 'beginPath', 'moveTo', 'lineTo', 'bezierCurveTo',
    'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'closePath', 'fill', 'stroke',
    'clip', 'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform', 'resetTransform',
    'fillRect', 'strokeRect', 'clearStroke'].forEach(function (m) {
    if (m === 'measureText') { ctx[m] = function () { return { width: 10 }; }; return; }
    ctx[m] = function () {};
  });
  return ctx;
}

function makeEl(tag, attrs) {
  attrs = attrs || {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    listeners: {},
    attrs: {},
    dataset: {},
    value: '',
    name: '',
    type: '',
    hidden: false,
    disabled: false,
    checked: false,
    offsetWidth: 100,
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 1000,
    clientHeight: 500,
    style: {},
    title: '',
    _text: ''
  };
  el.id = attrs.id || '';
  const classSet = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  Object.defineProperty(el, 'className', {
    get: function () { return Array.from(classSet).join(' '); },
    set: function (v) {
      classSet.clear();
      String(v).split(/\s+/).filter(Boolean).forEach(function (c) { classSet.add(c); });
    }
  });
  el.classList = {
    add: function (c) { classSet.add(c); },
    remove: function (c) { classSet.delete(c); },
    toggle: function (c, force) {
      const want = force === undefined ? !classSet.has(c) : !!force;
      if (want) classSet.add(c); else classSet.delete(c);
    },
    contains: function (c) { return classSet.has(c); }
  };
  for (const k of Object.keys(attrs)) {
    el.attrs[k] = attrs[k];
    if (tag === 'input' && k === 'value') el.value = attrs[k];
    if (k === 'name') el.name = attrs[k];
    if (k === 'type') el.type = attrs[k];
    if (k === 'checked') el.checked = true;
    if (k === 'disabled') el.disabled = true;
    if (k === 'hidden') el.hidden = true;
  }

  el.getAttribute = function (k) { return k in el.attrs ? el.attrs[k] : null; };
  el.setAttribute = function (k, v) {
    el.attrs[k] = String(v);
    if (k === 'id') el.id = String(v);
    if (k === 'class') el.className = String(v);
  };
  el.removeAttribute = function (k) { delete el.attrs[k]; };

  el.appendChild = function (child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = el;
    el.children.push(child);
    return child;
  };
  el.removeChild = function (child) {
    const i = el.children.indexOf(child);
    if (i !== -1) el.children.splice(i, 1);
    child.parent = null;
    return child;
  };
  Object.defineProperty(el, 'firstChild', { get: function () { return el.children[0] || null; } });
  Object.defineProperty(el, 'textContent', {
    get: function () {
      if (el.children.length) return el.children.map(function (c) { return c.textContent; }).join('');
      return el._text;
    },
    set: function (v) { el._text = String(v); el.children = []; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el.textContent; },
    set: function (v) { el._text = String(v); el.children = []; }
  });

  el.addEventListener = function (t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.removeEventListener = function () {};
  el.dispatch = function (t, ev) { (el.listeners[t] || []).slice().forEach(function (fn) { fn(ev || {}); }); };
  el.focus = function () {};
  el.scrollIntoView = function () {};
  el.getContext = function () { if (!el._ctx) el._ctx = make2dContext(); return el._ctx; };
  el.getBoundingClientRect = function () { return { left: 0, top: 0, width: 1000, height: 500 }; };

  function matches(node, sel) {
    // supports: #id, .class, tag, compound forms, [attr="x"], and a trailing :checked
    let checked = false;
    if (sel.endsWith(':checked')) { checked = true; sel = sel.slice(0, -':checked'.length); }
    const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][\w-]+)*)(?:\[([a-zA-Z-]+)(?:="([^"]*)")?\])?$/);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    const rest = m[2] || '';
    for (const idWant of (rest.match(/#([\w-]+)/g) || []).map(function (s) { return s.slice(1); })) {
      if (node.id !== idWant) return false;
    }
    for (const cWant of (rest.match(/\.([\w-]+)/g) || []).map(function (s) { return s.slice(1); })) {
      if (!node.classList.contains(cWant)) return false;
    }
    if (m[3] !== undefined) {
      const v = m[4] === undefined ? '' : m[4];
      if ((node.attrs[m[3]] || '') !== v) return false;
    }
    if (checked && !node.checked) return false;
    return true;
  }
  function walk(node, out) {
    node.children.forEach(function (c) { out.push(c); walk(c, out); });
    return out;
  }
  el.matches = function (sel) { return matches(el, sel); };
  el.querySelectorAll = function (sel) { return walk(el, []).filter(function (c) { return matches(c, sel); }); };
  el.querySelector = function (sel) { return el.querySelectorAll(sel)[0] || null; };
  return el;
}

/* parse the shipped markup so the harness runs against the real ids and classes */
const registry = {};
const all = [];
{
  const body = makeEl('body');
  const stack = [body];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = m[4] === '/' || VOID_TAGS.has(tag);
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = makeEl(tag, parseAttrs(m[3] || ''));
    stack[stack.length - 1].appendChild(el);
    all.push(el);
    if (el.id) {
      assert.ok(!registry[el.id], 'no duplicate id in index.html: ' + el.id);
      registry[el.id] = el;
    }
    if (tag === 'textarea') {
      const rest = html.slice(tagRe.lastIndex);
      const end = rest.search(/<\/textarea\s*>/i);
      if (end !== -1) { el.value = rest.slice(0, end); tagRe.lastIndex += end; }
    }
    if (!selfClosed) stack.push(el);
  }
  assert.ok(Object.keys(registry).length > 25, 'the harness parsed the real markup: ' + Object.keys(registry).length + ' id bearing elements');
}

const documentStub = {
  readyState: 'complete',
  hidden: false,
  getElementById: function (id) { return registry[id] || null; },
  createElement: function (tag) { return makeEl(tag); },
  createTextNode: function (t) { const n = makeEl('#text'); n._text = String(t); n.textContent = String(t); return n; },
  querySelector: function (sel) {
    for (const el of all) if (el.matches(sel)) return el;
    return null;
  },
  querySelectorAll: function (sel) { return all.filter(function (el) { return el.matches(sel); }); },
  addEventListener: function () {}
};

/* rAF clock: queued callbacks run only when the harness pumps frames */
let rafQueue = [];
let rafOpen = true;
global.requestAnimationFrame = function (cb) {
  if (rafOpen) rafQueue.push(cb);
  return rafQueue.length;
};
function pump(frames) {
  let now = 0;
  for (let i = 0; i < frames && rafQueue.length; i++) {
    const batch = rafQueue.splice(0);
    now += 16.7;
    batch.forEach(function (cb) { cb(now); });
  }
  rafQueue.length = 0;
}

global.window = globalThis;
global.document = documentStub;

/* static wiring proof: every id app.js asks for by name must exist in the HTML */
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const wanted = new Set();
for (const m of appSource.matchAll(/byId\('([^']+)'\)/g)) wanted.add(m[1]);
const missing = Array.from(wanted).filter(function (id) { return !registry[id]; });
assert.deepStrictEqual(missing, [], 'every id referenced by app.js exists in the HTML');

/* run the shipped scripts in order, like the browser would */
require('../js/yaml.js');
require('../js/model.js');
require('../js/duration.js');
require('../js/cost.js');
require('../js/failures.js');
require('../js/savings.js');
require('../js/fixtures.js');
require('../js/graph.js');
new Function('document', appSource + '\n//# sourceURL=pipelinepulse.app.js')(documentStub);

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  let checks = 0;
  function ok(cond, msg) { checks += 1; assert.ok(cond, msg); }

  const fixtureCount = globalThis.PP.FIXTURES.length;
  const order0 = globalThis.PP.FIXTURES[0].model ? null : null; // model is parsed by the app

  /* the studio opened with fixture 0 fully rendered */
  ok(registry['fixture-select'].children.length === fixtureCount, 'the fixture select holds every fixture');
  ok(/min/.test(registry['ro-wall'].textContent), 'the wall clock readout is populated, got ' + registry['ro-wall'].textContent);
  ok(registry['ro-critical'].textContent.length > 0 && registry['ro-critical'].textContent !== 'measuring', 'the critical path readout is populated');
  ok(/\$/.test(registry['ro-cost'].textContent), 'the cost per run readout is populated');
  ok(registry['status-text'].textContent.indexOf('parsed ') === 0, 'the parse status reports a parse, got ' + registry['status-text'].textContent);
  ok(registry['parse-errors'].children.length === 0, 'no parse errors for the shipped fixture');
  ok((registry['map-canvas'].getAttribute('aria-label') || '').indexOf('Pipeline graph') === 0, 'the canvas carries its graph summary');
  ok(registry['duration-body'].children.length > 0, 'the duration table has rows');
  ok(registry['cost-body'].children.length > 0, 'the cost table has rows');
  ok(registry['job-list'].children.length > 0, 'the job chip list rendered');
  ok(registry['duration-foot'].textContent.indexOf('critical path') !== -1, 'the duration footnote names the critical path');
  ok(registry['savings-total'].textContent.length > 0, 'the savings total line is populated');

  /* the pulse animates without throwing */
  pump(90);
  ok(true, 'ninety animation frames drew without throwing');
  rafOpen = false;

  /* fixture swap re-renders everything */
  registry['fixture-select'].value = '1';
  registry['fixture-select'].dispatch('change', {});
  ok(/parsed \d+ jobs?/.test(registry['status-text'].textContent), 'the second fixture parsed, got ' + registry['status-text'].textContent);
  const chips1 = registry['job-list'].children.length;
  ok(chips1 > 0, 'the second fixture rendered job chips');

  /* job selection through the keyboard path list */
  registry['job-list'].children[0].children[0].dispatch('click', {});
  ok(registry['job-detail'].children.length > 1, 'selecting a chip fills the job detail');
  ok(registry['job-list'].children[0].children[0].getAttribute('aria-pressed') === 'true', 'the selected chip flips aria pressed');
  registry['job-list'].children[0].children[0].dispatch('click', {});
  ok(registry['job-list'].children[0].children[0].getAttribute('aria-pressed') === 'false', 'clicking again clears the selection');

  /* a pasted valid workflow without history moves the failure bench to its empty state */
  registry['workflow-text'].value = globalThis.PP.FIXTURES[1].yaml;
  registry['workflow-text'].dispatch('input', {});
  await sleep(400);
  ok(!registry['failures-empty'].classList.contains('is-hidden'), 'a workflow without history shows the failures empty state');
  ok(registry['fail-clusters-wrap'].classList.contains('is-hidden'), 'the cluster table hides without history');
  ok(registry['ro-failure'].textContent === 'no history', 'the failure readout reports no history');

  /* a parse error keeps the last valid model and names the line */
  registry['workflow-text'].value = 'jobs:\n  build:\n    runs-on: [ubuntu-latest\n';
  registry['workflow-text'].dispatch('input', {});
  await sleep(400);
  ok(registry['status-dot'].classList.contains('is-error'), 'the status dot flags the parse error');
  ok(registry['parse-errors'].children.length > 0, 'the parse error list rendered');
  ok(registry['status-text'].textContent.indexOf('did not parse') !== -1, 'the status announces the failure');
  ok(registry['duration-body'].children.length > 0, 'the last valid model still drives the tables');

  console.log('dom smoke: ' + checks + ' checks passed across init, animation, fixtures, selection, edit, and parse errors');
}

main().then(function () { process.exit(0); }, function (err) { console.error(err); process.exit(1); });
