'use strict';
// Adblock Plus / EasyList compatible filter engine for PrivBrowse.

const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'co.jp', 'com.br', 'co.in', 'com.cn', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'co.kr',
]);

const TYPE_ALIASES = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  font: 'font', media: 'media', object: 'object', 'object-subrequest': 'object',
  subdocument: 'subdocument', frame: 'subdocument', xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest', ping: 'ping', beacon: 'ping', websocket: 'websocket', other: 'other',
};

const NOOP = new Set(['important', 'match-case', 'all']);

const UNSUPPORTED_COSMETIC = [
  '+js(', ':-abp-', ':has-text', ':contains', ':xpath', ':matches-', ':upward',
  ':remove(', ':style(', ':nth-ancestor', ':min-text-length', ':watch-attr',
  ':others', ':with(', ':not(:', '##^', 'script:inject',
];

const DOMAIN_RULE_RE = /^\|\|([a-z0-9][a-z0-9.\-]*)\^?$/;

function regDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  if (SECOND_LEVEL.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function* hostSuffixes(host) {
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) yield parts.slice(i).join('.');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(p) {
  let out = '';
  if (p.startsWith('||')) {
    out += '^[a-z][a-z0-9+.\\-]*://(?:[^/?#]*\\.)?';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    out += '^';
    p = p.slice(1);
  }
  let endAnchor = false;
  if (p.endsWith('|')) {
    endAnchor = true;
    p = p.slice(0, -1);
  }
  for (const ch of p) {
    if (ch === '*') out += '.*';
    else if (ch === '^') out += '(?:[^a-z0-9_\\-.%]|$)';
    else out += escapeRe(ch);
  }
  if (endAnchor) out += '$';
  return new RegExp(out);
}

// Longest alphanumeric token that must appear as a whole token in a matching URL.
function bestToken(pattern) {
  const anchoredLeft = pattern.startsWith('|');
  const anchoredRight = pattern.endsWith('|');
  const p = pattern.replace(/^\|+|\|+$/g, '');
  let best = null;
  for (const m of p.matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    const s = m.index;
    const e = s + t.length;
    if (t.length < 3) continue;
    const leftOk = (s > 0 && p[s - 1] !== '*') || (s === 0 && anchoredLeft);
    const rightOk = (e < p.length && p[e] !== '*') || (e === p.length && anchoredRight);
    if (leftOk && rightOk && (best === null || t.length > best.length)) best = t;
  }
  return best;
}

function inDomains(fp, list) {
  return list.some((d) => fp === d || fp.endsWith('.' + d));
}

function optionsMatch(r, rtype, third, fpHost) {
  if (r.third !== null && r.third !== third) return false;
  if (r.typesInc.size && !r.typesInc.has(rtype)) return false;
  if (r.typesExc.has(rtype)) return false;
  if (r.domInc.length || r.domExc.length) {
    const fp = fpHost || '';
    if (r.domExc.length && inDomains(fp, r.domExc)) return false;
    if (r.domInc.length && !inDomains(fp, r.domInc)) return false;
  }
  return true;
}

class RuleSet {
  constructor() {
    this.domainRules = new Map();
    this.tokenIndex = new Map();
    this.fallback = [];
    this.count = 0;
  }

  add(pattern, rule) {
    this.count++;
    const m = DOMAIN_RULE_RE.exec(pattern);
    if (m) {
      if (!this.domainRules.has(m[1])) this.domainRules.set(m[1], []);
      this.domainRules.get(m[1]).push(rule);
      return;
    }
    const token = bestToken(pattern);
    if (token) {
      if (!this.tokenIndex.has(token)) this.tokenIndex.set(token, []);
      this.tokenIndex.get(token).push(rule);
    } else {
      this.fallback.push(rule);
    }
  }

  matches(url, host, rtype, third, fpHost) {
    for (const s of hostSuffixes(host)) {
      const rs = this.domainRules.get(s);
      if (rs) for (const r of rs) if (optionsMatch(r, rtype, third, fpHost)) return true;
    }
    if (this.tokenIndex.size) {
      const toks = new Set(url.match(/[a-z0-9]+/g) || []);
      for (const t of toks) {
        const rs = this.tokenIndex.get(t);
        if (rs) {
          for (const r of rs) {
            if (optionsMatch(r, rtype, third, fpHost) && r.regex.test(url)) return true;
          }
        }
      }
    }
    for (const r of this.fallback) {
      if (optionsMatch(r, rtype, third, fpHost) && r.regex.test(url)) return true;
    }
    return false;
  }
}

class FilterEngine {
  constructor() {
    this.block = new RuleSet();
    this.allow = new RuleSet();
    this.genericCss = [];        // selectors hidden on every site
    this.domainCss = new Map();  // host -> [selectors]
    this.cssExceptions = new Set();
  }

  get ruleCount() {
    let n = this.block.count + this.allow.count + this.genericCss.length;
    for (const v of this.domainCss.values()) n += v.length;
    return n;
  }

  async loadLinesAsync(lines) {
    let n = 0;
    for (const raw of lines) {
      this.loadLine(raw);
      if (++n % 4000 === 0) await new Promise((r) => setImmediate(r));
    }
  }

  loadLine(raw) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') return;
    try {
      if (line.includes('#@#')) this.parseCosmeticException(line);
      else if (line.includes('##')) this.parseCosmetic(line);
      else if (line.includes('#?#') || line.includes('#$#') || line.includes('#%#')) return;
      else this.parseNetwork(line);
    } catch (e) { /* skip bad rule */ }
  }

  finalize() {
    if (this.cssExceptions.size) {
      this.genericCss = this.genericCss.filter((s) => !this.cssExceptions.has(s));
    }
    this.genericCss = Array.from(new Set(this.genericCss)).sort();
  }

  parseCosmetic(line) {
    const idx = line.indexOf('##');
    const domainsPart = line.slice(0, idx);
    const selector = line.slice(idx + 2).trim();
    if (!selector || UNSUPPORTED_COSMETIC.some((m) => selector.includes(m))) return;
    if (domainsPart) {
      const includes = domainsPart.split(',').map((d) => d.trim().toLowerCase())
        .filter((d) => d && !d.startsWith('~'));
      if (!includes.length) return;
      for (const d of includes) {
        if (!this.domainCss.has(d)) this.domainCss.set(d, []);
        this.domainCss.get(d).push(selector);
      }
    } else {
      this.genericCss.push(selector);
    }
  }

  parseCosmeticException(line) {
    const idx = line.indexOf('#@#');
    const domainsPart = line.slice(0, idx);
    const selector = line.slice(idx + 3).trim();
    if (!domainsPart && selector) this.cssExceptions.add(selector);
  }

  parseNetwork(line) {
    let exception = false;
    if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
    let pattern = line;
    let opts = '';
    if (line.includes('$')) {
      const i = line.lastIndexOf('$');
      const cand = line.slice(i + 1);
      const low = cand.toLowerCase();
      if (['removeparam', 'redirect', 'csp=', 'rewrite', 'replace='].some((m) => low.includes(m))) return;
      if (!cand.includes('/')) { pattern = line.slice(0, i); opts = low; }
    }
    pattern = pattern.trim().toLowerCase();
    if (!pattern) return;

    let third = null;
    const typesInc = new Set();
    const typesExc = new Set();
    const domInc = [];
    const domExc = [];
    if (opts) {
      for (let o of opts.split(',')) {
        o = o.trim();
        if (!o) continue;
        const neg = o.startsWith('~');
        const name = neg ? o.slice(1) : o;
        if (name === 'third-party' || name === '3p') third = !neg;
        else if (name === 'first-party' || name === '1p') third = neg;
        else if (name.startsWith('domain=')) {
          for (let d of name.slice(7).split('|')) {
            d = d.trim();
            if (!d) continue;
            if (d.startsWith('~')) domExc.push(d.slice(1)); else domInc.push(d);
          }
        } else if (TYPE_ALIASES[name]) {
          (neg ? typesExc : typesInc).add(TYPE_ALIASES[name]);
        } else if (NOOP.has(name)) {
          continue;
        } else {
          return; // unsupported option: skip whole rule
        }
      }
    }

    const target = exception ? this.allow : this.block;

    if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      let regex;
      try { regex = new RegExp(pattern.slice(1, -1)); } catch (e) { return; }
      target.fallback.push({ regex, third, typesInc, typesExc, domInc, domExc });
      target.count++;
      return;
    }
    if (pattern === '*' || pattern === '|' || pattern === '||' || pattern === '^') return;

    const regex = DOMAIN_RULE_RE.test(pattern) ? null : patternToRegex(pattern);
    target.add(pattern, { regex, third, typesInc, typesExc, domInc, domExc });
  }

  shouldBlock(url, host, rtype, third, fpHost) {
    url = url.slice(0, 2000).toLowerCase();
    host = host.toLowerCase();
    fpHost = (fpHost || '').toLowerCase();
    if (!this.block.matches(url, host, rtype, third, fpHost)) return false;
    if (this.allow.matches(url, host, rtype, third, fpHost)) return false;
    return true;
  }

  cosmeticFor(host) {
    host = host.toLowerCase();
    let out = [];
    for (const s of hostSuffixes(host)) {
      const v = this.domainCss.get(s);
      if (v) out = out.concat(v);
    }
    if (this.cssExceptions.size) out = out.filter((s) => !this.cssExceptions.has(s));
    return out;
  }
}

module.exports = { FilterEngine, regDomain, hostSuffixes };
