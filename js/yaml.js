/*
 * PipelinePulse YAML subset parser. Hand written, zero dependencies.
 *
 * Supported subset:
 * - block mappings with keys of the form "key: value"
 * - block sequences with "- " items, at a deeper indent or at the same indent as their key
 * - mapping items inside sequences ("step:" style)
 * - inline arrays [a, b] with one or more nesting levels, including nested arrays
 * - scalars: plain strings, "double quoted", 'single quoted', integers, floats, true, false, null, ~
 * - comments starting with # outside quotes
 * - optional document markers --- and ...
 *
 * Not supported and reported with a clear error rather than guessed:
 * - tabs in indentation, inconsistent indentation, duplicate keys, unclosed quotes or arrays
 * - block scalars | and >, anchors & and aliases *, flow mappings { }, merge keys <<
 *
 * Every failure throws a ParseError carrying the 1-based line number and a recovery hint.
 */
(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : {};
  root.PP = root.PP || {};

  function ParseError(line, message) {
    this.name = 'ParseError';
    this.line = line;
    this.message = 'Line ' + line + ': ' + message;
  }
  ParseError.prototype = Object.create(Error.prototype);
  ParseError.prototype.constructor = ParseError;

  var NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  var MAX_DEPTH = 64;

  function isPlainBoolean(token) {
    return token === 'true' || token === 'false';
  }

  function stripComment(text, lineNo) {
    var inSingle = false;
    var inDouble = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '#' && !inSingle && !inDouble) {
        return text.slice(0, i).trim();
      }
    }
    return text.trim();
  }

  function unquoteDouble(body) {
    // single pass so that an escaped backslash is never mistaken for an escape prefix
    return body.replace(/\\(.)/g, function (all, c) {
      if (c === 'n') return '\n';
      if (c === 't') return '\t';
      if (c === '"' || c === '\\' || c === "'") return c;
      return all;
    });
  }

  function unquote(token, lineNo) {
    if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
      return unquoteDouble(token.slice(1, -1));
    }
    if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
      return token.slice(1, -1).replace(/''/g, "'");
    }
    if (token[0] === '"' || token[0] === "'") {
      throw new ParseError(lineNo, 'unclosed quoted string: ' + token + ' never closes its ' + token[0] + ' quote');
    }
    return token;
  }

  function parseScalar(token, lineNo) {
    token = token.trim();
    if (token === '') return null;
    if (token[0] === '"' || token[0] === "'") return unquote(token, lineNo);
    if (token === 'null' || token === '~' || token === 'Null' || token === 'NULL') return null;
    if (isPlainBoolean(token)) return token === 'true';
    if (NUMBER_RE.test(token)) return Number(token);
    if (token[0] === '*' || token[0] === '&' || token === '<<') {
      throw new ParseError(lineNo, 'anchors and aliases (' + token[0] + ' name) are outside this subset; repeat the value instead');
    }
    return token;
  }

  // Inline array parser over characters. Returns the parsed array.
  function parseInlineArray(text, lineNo) {
    var pos = 0;
    var depth = 0;
    var startDepthLine = lineNo;

    function skipSpace() {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
    }

    function parseElement() {
      skipSpace();
      if (pos >= text.length) throw new ParseError(startDepthLine, 'unclosed inline array; add the closing bracket ]');
      var ch = text[pos];
      if (ch === ',') throw new ParseError(lineNo, 'empty element inside an inline array; remove the extra comma');
      if (ch === ']') throw new ParseError(lineNo, 'empty element inside an inline array; remove the extra comma');
      if (ch === '[') {
        pos++;
        depth++;
        var arr = [];
        skipSpace();
        if (pos < text.length && text[pos] === ']') { pos++; depth--; return arr; }
        while (true) {
          arr.push(parseElement());
          skipSpace();
          if (pos >= text.length) throw new ParseError(startDepthLine, 'unclosed inline array; add the closing bracket ]');
          if (text[pos] === ',') { pos++; continue; }
          if (text[pos] === ']') { pos++; depth--; return arr; }
          throw new ParseError(lineNo, 'expected , or ] inside an inline array near "' + text.slice(pos, pos + 12) + '"');
        }
      }
      if (ch === '{') {
        throw new ParseError(lineNo, 'flow mappings { key: value } are outside this subset; use a block mapping');
      }
      if (ch === '"' || ch === "'") {
        var quote = ch;
        var start = pos;
        pos++;
        while (pos < text.length) {
          if (quote === '"' && text[pos] === '\\') { pos += 2; continue; }
          if (text[pos] === quote) break;
          pos++;
        }
        if (pos >= text.length) throw new ParseError(lineNo, 'unclosed quoted string starting with ' + quote);
        pos++;
        return unquote(text.slice(start, pos), lineNo);
      }
      var begin = pos;
      while (pos < text.length && text[pos] !== ',' && text[pos] !== ']') pos++;
      var raw = text.slice(begin, pos).trim();
      if (raw === '') throw new ParseError(lineNo, 'empty element inside an inline array; remove the extra comma');
      return parseScalar(raw, lineNo);
    }

    var result = parseElement();
    skipSpace();
    if (pos < text.length) {
      throw new ParseError(lineNo, 'unexpected text after the inline array: "' + text.slice(pos) + '"');
    }
    return result;
  }

  // Parse a value that sits on one line: inline array, scalar, or a rejected block scalar.
  function parseInlineValue(text, lineNo) {
    if (text === '') return null;
    if (text[0] === '[') return parseInlineArray(text, lineNo);
    if (text[0] === '{') {
      throw new ParseError(lineNo, 'flow mappings { key: value } are outside this subset; use a block mapping');
    }
    if (text[0] === '|' || text[0] === '>') {
      throw new ParseError(lineNo, 'block scalars (| and >) are outside this subset; keep the value on one line');
    }
    return parseScalar(text, lineNo);
  }

  // Match "key: rest" allowing quoted keys. Returns { key, rest } or null.
  function matchKey(text) {
    var m = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:#\s][^:]*?)):(?:[ \t]+(.*))?$/.exec(text);
    if (!m) return null;
    var key;
    if (m[1] !== undefined) key = unquote('"' + m[1] + '"', 0);
    else if (m[2] !== undefined) key = m[2].replace(/''/g, "'");
    else key = m[3].trim();
    return { key: key, rest: m[4] === undefined ? '' : m[4].trim() };
  }

  function parse(text) {
    if (typeof text !== 'string') {
      throw new ParseError(1, 'input must be a string');
    }
    var rawLines = text.split(/\r\n?|\n/);
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var no = i + 1;
      var raw = rawLines[i];
      var match = /^ */.exec(raw);
      var indent = match ? match[0].length : 0;
      var afterIndent = raw.slice(indent);
      if (afterIndent[0] === '\t') {
        throw new ParseError(no, 'tabs are not allowed for indentation; use spaces');
      }
      var content = stripComment(afterIndent, no);
      if (content === '') continue;
      if (content === '---' || content === '...') continue;
      lines.push({ no: no, indent: indent, text: content });
    }
    if (lines.length === 0) {
      throw new ParseError(1, 'empty document; expected at least one mapping key such as "jobs:"');
    }

    var pos = { i: 0 };
    var value = parseBlock(lines, pos, lines[0].indent, 0);
    if (pos.i < lines.length) {
      var stray = lines[pos.i];
      throw new ParseError(stray.no, 'unexpected indentation; this line does not line up with any open block (expected ' + lines[0].indent + ' spaces)');
    }
    return value;
  }

  // Dispatch to a mapping or a sequence depending on the first line at this indent.
  function parseBlock(lines, pos, indent, depth) {
    if (depth > MAX_DEPTH) {
      throw new ParseError(lines[pos.i].no, 'nesting is deeper than ' + MAX_DEPTH + ' levels; this does not look like a workflow file');
    }
    if (lines[pos.i].text[0] === '-' && (lines[pos.i].text === '-' || lines[pos.i].text.slice(0, 2) === '- ')) {
      return parseSequence(lines, pos, indent, depth);
    }
    return parseMapping(lines, pos, indent, depth);
  }

  function parseMapping(lines, pos, indent, depth) {
    var map = {};
    var seen = {};
    while (pos.i < lines.length) {
      var line = lines[pos.i];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new ParseError(line.no, 'unexpected indent; this mapping continues at ' + indent + ' spaces but this line has ' + line.indent + ', so it does not line up with the key above it');
      }
      var m = matchKey(line.text);
      if (!m) {
        throw new ParseError(line.no, 'expected "key: value" but found "' + line.text + '"; a mapping entry needs a colon after its key');
      }
      if (Object.prototype.hasOwnProperty.call(seen, m.key)) {
        throw new ParseError(line.no, 'duplicate key "' + m.key + '"; first defined on line ' + seen[m.key]);
      }
      seen[m.key] = line.no;
      pos.i++;
      if (m.rest === '') {
        if (pos.i < lines.length && lines[pos.i].indent > indent) {
          map[m.key] = parseBlock(lines, pos, lines[pos.i].indent, depth + 1);
        } else if (pos.i < lines.length && lines[pos.i].indent === indent &&
                   lines[pos.i].text[0] === '-' && (lines[pos.i].text === '-' || lines[pos.i].text.slice(0, 2) === '- ')) {
          // sequence written at the same indent as its key
          map[m.key] = parseSequence(lines, pos, indent, depth + 1);
        } else {
          map[m.key] = null;
        }
      } else {
        map[m.key] = parseInlineValue(m.rest, line.no);
        if (pos.i < lines.length && lines[pos.i].indent > indent) {
          throw new ParseError(lines[pos.i].no, 'unexpected indentation; the value of "' + m.key + '" is already complete on line ' + line.no);
        }
      }
    }
    return map;
  }

  function parseSequence(lines, pos, indent, depth) {
    var items = [];
    while (pos.i < lines.length) {
      var line = lines[pos.i];
      if (line.indent !== indent) break;
      var isItem = line.text === '-' || line.text.slice(0, 2) === '- ';
      if (!isItem) break;
      if (line.text === '-') {
        pos.i++;
        if (pos.i < lines.length && lines[pos.i].indent > indent) {
          items.push(parseBlock(lines, pos, lines[pos.i].indent, depth + 1));
        } else {
          items.push(null);
        }
        continue;
      }
      var itemText = line.text.slice(2);
      var trimmed = itemText.trim();
      if (trimmed === '') {
        // "- " with trailing spaces
        pos.i++;
        if (pos.i < lines.length && lines[pos.i].indent > indent) {
          items.push(parseBlock(lines, pos, lines[pos.i].indent, depth + 1));
        } else {
          items.push(null);
        }
        continue;
      }
      var km = matchKey(trimmed);
      if (km) {
        // mapping item: rewrite the line in place with the key column as its indent
        var offset = line.text.indexOf(trimmed[0] === '"' || trimmed[0] === "'" ? trimmed : trimmed.split(':')[0]);
        if (offset < 0) offset = 2;
        lines[pos.i] = { no: line.no, indent: indent + offset, text: trimmed };
        items.push(parseMapping(lines, pos, indent + offset, depth + 1));
      } else {
        items.push(parseInlineValue(trimmed, line.no));
        pos.i++;
      }
    }
    return items;
  }

  var api = { parseYaml: parse, ParseError: ParseError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.PP) {
    root.PP.parseYaml = parse;
    root.PP.ParseError = ParseError;
  }
})();
