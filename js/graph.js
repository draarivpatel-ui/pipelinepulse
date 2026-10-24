/*
 * PipelinePulse pipeline map. A layered canvas drawing of the job graph:
 * one column per topological wave, hairline dependency edges, and the critical
 * path carrying the signature pulse, a slow signal traveling the chain while
 * the page rests. The animation is the only motion on the page; it pauses off
 * screen, on hidden tabs, and under prefers-reduced-motion.
 *
 * Deterministic layout, one rAF clock, no dependencies.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  function cssColor(name, fallback) {
    if (typeof getComputedStyle === 'function') {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    }
    return fallback;
  }

  function monoFont() {
    return cssColor('--font-mono', 'monospace') || 'monospace';
  }

  function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function create(canvas, wrapper) {
    var ctx = canvas.getContext('2d');
    var model = null;
    var layout = null;
    var selected = null;
    var hovered = null;
    var onSelect = null;
    var running = false;
    var visible = true;
    var motionAllowed = !reducedMotion();
    var colors = {};
    var PULSE_PERIOD = 9; // seconds for one full traversal of the critical path

    function readColors() {
      colors = {
        ink: cssColor('--color-ink', '#e8ecef'),
        inkSoft: cssColor('--color-ink-soft', '#b9c2c8'),
        muted: cssColor('--color-muted', '#8b959c'),
        line: cssColor('--color-line', '#4a5257'),
        lineStrong: cssColor('--color-line-strong', '#7e878c'),
        surface: cssColor('--color-surface', '#2d3237'),
        surface2: cssColor('--color-surface-2', '#3a4046'),
        accent: cssColor('--color-accent', '#5fe0a0'),
        accentSoft: cssColor('--color-accent-soft', 'rgba(95, 224, 160, 0.13)')
      };
    }

    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').addEventListener) {
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) {
        motionAllowed = !e.matches;
        if (motionAllowed && visible) start();
        else stop();
        draw(0);
      });
    }

    function computeLayout() {
      if (!model) return;
      var NODE_W = 176;
      var NODE_H = 48;
      var COL_GAP = 72;
      var ROW_GAP = 14;
      var PAD_X = 20;
      var PAD_TOP = 36;
      var PAD_BOTTOM = 16;
      var cols = [];
      var maxRows = 1;
      for (var w = 0; w < model.waves.length; w++) {
        var col = { x: PAD_X + w * (NODE_W + COL_GAP), nodes: model.waves[w].slice() };
        if (col.nodes.length > maxRows) maxRows = col.nodes.length;
        cols.push(col);
      }
      var width = PAD_X + model.waves.length * NODE_W + Math.max(0, model.waves.length - 1) * COL_GAP + PAD_X;
      var height = PAD_TOP + maxRows * NODE_H + (maxRows - 1) * ROW_GAP + PAD_BOTTOM;

      var pos = {};
      for (var c = 0; c < cols.length; c++) {
        var colNodes = cols[c].nodes;
        var colH = colNodes.length * NODE_H + Math.max(0, colNodes.length - 1) * ROW_GAP;
        var startY = PAD_TOP + Math.max(0, (height - PAD_TOP - PAD_BOTTOM - colH) / 2);
        for (var n = 0; n < colNodes.length; n++) {
          pos[colNodes[n]] = { x: cols[c].x, y: startY + n * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H, col: c };
        }
      }

      var criticalSet = {};
      var criticalPairs = {};
      if (model.criticalPath) {
        model.criticalPath.path.forEach(function (id) { criticalSet[id] = true; });
        for (var p = 0; p < model.criticalPath.path.length - 1; p++) {
          criticalPairs[model.criticalPath.path[p] + '>' + model.criticalPath.path[p + 1]] = true;
        }
      }

      var edges = [];
      model.order.forEach(function (id) {
        model.jobs[id].needs.forEach(function (need) {
          edges.push({ from: need, to: id, critical: !!(criticalSet[need] && criticalSet[id] && criticalPairs[need + '>' + id]) });
        });
      });

      layout = { cols: cols, pos: pos, width: width, height: height, edges: edges, criticalSet: criticalSet, padTop: PAD_TOP };
    }

    function sizeCanvas() {
      if (!layout) return;
      var dpr = 1;
      if (typeof devicePixelRatio === 'number') dpr = Math.max(1, Math.min(2.5, devicePixelRatio));
      canvas.width = Math.round(layout.width * dpr);
      canvas.height = Math.round(layout.height * dpr);
      canvas.style.width = layout.width + 'px';
      canvas.style.height = layout.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    }

    function edgePath(a, b) {
      var x1 = a.x + a.w;
      var y1 = a.y + a.h / 2;
      var x2 = b.x;
      var y2 = b.y + b.h / 2;
      var mid = (x1 + x2) / 2;
      return [x1, y1, mid, y1, mid, y2, x2, y2];
    }

    function cubicPoint(p, t) {
      var x0 = p[0], y0 = p[1], x1 = p[2], y1 = p[3], x2 = p[4], y2 = p[5], x3 = p[6], y3 = p[7];
      var mt = 1 - t;
      var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
      return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
    }

    function draw(timeSeconds) {
      if (!ctx || !layout) return;
      ctx.clearRect(0, 0, layout.width, layout.height);

      ctx.font = '10px ' + monoFont();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      for (var c = 0; c < layout.cols.length; c++) {
        ctx.fillStyle = colors.muted;
        ctx.fillText('wave ' + (c + 1), layout.cols[c].x, layout.padTop - 16);
      }

      layout.edges.forEach(function (e) {
        var a = layout.pos[e.from];
        var b = layout.pos[e.to];
        if (!a || !b) return;
        var p = edgePath(a, b);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
        ctx.strokeStyle = e.critical ? colors.accent : colors.line;
        ctx.lineWidth = e.critical ? 1.5 : 1;
        ctx.stroke();
        var pt = cubicPoint(p, 0.9);
        var pt2 = cubicPoint(p, 0.945);
        var ang = Math.atan2(pt2.y - pt.y, pt2.x - pt.x);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x - Math.cos(ang - 0.42) * 6, pt.y - Math.sin(ang - 0.42) * 6);
        ctx.lineTo(pt.x - Math.cos(ang + 0.42) * 6, pt.y - Math.sin(ang + 0.42) * 6);
        ctx.closePath();
        ctx.fillStyle = e.critical ? colors.accent : colors.lineStrong;
        ctx.fill();
      });

      if (motionAllowed) {
        var critEdges = layout.edges.filter(function (e) { return e.critical; });
        if (critEdges.length > 0) {
          var cycle = (timeSeconds % PULSE_PERIOD) / PULSE_PERIOD;
          for (var d = 0; d < 2; d++) {
            var t = (cycle + d * 0.5) % 1;
            var idx = Math.min(critEdges.length - 1, Math.floor(t * critEdges.length));
            var local = t * critEdges.length - idx;
            var e2 = critEdges[idx];
            var path = edgePath(layout.pos[e2.from], layout.pos[e2.to]);
            var point = cubicPoint(path, local);
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
            ctx.fillStyle = colors.accent;
            ctx.fill();
          }
        }
      }

      model.order.forEach(function (id) {
        var r = layout.pos[id];
        if (!r) return;
        var isCritical = layout.criticalSet[id];
        var isSelected = selected === id;
        var isHover = hovered === id;
        var meta = model.meta[id] || {};

        roundRect(r.x, r.y, r.w, r.h, 3);
        ctx.fillStyle = isSelected ? colors.accentSoft : (isHover ? colors.surface2 : colors.surface);
        ctx.fill();
        ctx.strokeStyle = isSelected || isCritical ? colors.accent : colors.lineStrong;
        ctx.lineWidth = isSelected ? 1.5 : 1;
        ctx.stroke();

        if (isCritical && !isSelected) {
          ctx.fillStyle = colors.accent;
          ctx.fillRect(r.x, r.y + 8, 2, r.h - 16);
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isSelected ? colors.accent : colors.ink;
        ctx.font = '600 11.5px ' + monoFont();
        ctx.fillText(id, r.x + 10, r.y + 16);

        ctx.fillStyle = colors.muted;
        ctx.font = '10px ' + monoFont();
        ctx.fillText(meta.subText || '', r.x + 10, r.y + 32);

        if (meta.combos > 1) {
          ctx.textAlign = 'right';
          ctx.fillStyle = colors.inkSoft;
          ctx.font = '10px ' + monoFont();
          ctx.fillText(meta.combos + 'x', r.x + r.w - 10, r.y + 16);
        }
        ctx.textAlign = 'left';
      });
    }

    function start() {
      if (running || !motionAllowed) return;
      running = true;
      function frame(now) {
        if (!running) return;
        draw(now / 1000);
        root.requestAnimationFrame(frame);
      }
      root.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
    }

    function hitTest(evt) {
      var rect = canvas.getBoundingClientRect();
      var x = evt.clientX - rect.left;
      var y = evt.clientY - rect.top;
      for (var i = 0; i < model.order.length; i++) {
        var id = model.order[i];
        var r = layout.pos[id];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return id;
      }
      return null;
    }

    canvas.addEventListener('pointermove', function (evt) {
      if (!layout) return;
      var id = hitTest(evt);
      if (id !== hovered) {
        hovered = id;
        canvas.style.cursor = id ? 'pointer' : 'default';
        if (!motionAllowed) draw(0);
      }
    });

    canvas.addEventListener('pointerdown', function (evt) {
      if (!layout) return;
      var id = hitTest(evt);
      if (id && onSelect) onSelect(id);
    });

    canvas.addEventListener('pointerleave', function () {
      hovered = null;
      if (!motionAllowed) draw(0);
    });

    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && motionAllowed) start();
        else stop();
      }, { threshold: 0.02 }).observe(canvas);
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop();
        else if (visible && motionAllowed) start();
      });
    }

    if (typeof ResizeObserver === 'function' && wrapper) {
      new ResizeObserver(function () {
        readColors();
        sizeCanvas();
        draw(0);
      }).observe(wrapper);
    }

    return {
      setModel: function (m, meta) {
        model = m;
        model.meta = meta || {};
        readColors();
        computeLayout();
        sizeCanvas();
        draw(0);
        if (visible && motionAllowed) start();
      },
      setSelected: function (id) {
        selected = id;
        if (!motionAllowed) draw(0);
      },
      onSelect: function (fn) { onSelect = fn; },
      scrollToNode: function (id) {
        if (!layout || !layout.pos[id] || !wrapper) return;
        var r = layout.pos[id];
        if (r.x - 60 < wrapper.scrollLeft || r.x + r.w + 60 > wrapper.scrollLeft + wrapper.clientWidth) {
          wrapper.scrollLeft = Math.max(0, r.x - 60);
        }
      },
      drawStatic: function () { draw(0); }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create: create };
  root.PP.Graph = { create: create };
})();
