// TeX math in posts ($…$ inline, $$…$$ display) rendered as MathML, which browsers lay out natively,
// so math needs no scripts, fonts or stylesheets. This covers the common subset: identifiers,
// numbers, operators, sub/superscripts, \frac, \sqrt (with an index), \text, \mathrm/\mathbf,
// \left/\right, Greek letters and the usual symbols. Every element name is fixed here and all text is
// escaped; anything outside the subset (or too large) returns null and is shown as code instead.

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MAX_TEX = 2000;
const MAX_DEPTH = 24;

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const OPERATORS = {
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝',
  ll: '≪', gg: '≫', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  wedge: '∧', vee: '∨', oplus: '⊕', otimes: '⊗', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', implies: '⟹', iff: '⟺', mapsto: '↦',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', infty: '∞', ldots: '…', cdots: '⋯',
  vdots: '⋮', ddots: '⋱', dots: '…', mid: '∣', parallel: '∥', perp: '⊥', angle: '∠', prime: '′',
  langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', vert: '|', Vert: '‖',
  '{': '{', '}': '}', '|': '‖', '%': '%', '$': '$', '#': '#', '&': '&', _: '_',
};
const FUNCTIONS = new Set(['log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'min', 'max', 'sup', 'inf', 'lim', 'det', 'deg', 'dim', 'gcd', 'mod', 'Pr', 'arg', 'ker']);
const SPACES = { ',': '0.1667em', ':': '0.2222em', ';': '0.2778em', '!': '-0.1667em', quad: '1em', qquad: '2em', ' ': '0.25em' };
const VARIANTS = { mathrm: 'normal', mathbf: 'bold', mathit: 'italic', mathsf: 'sans-serif', mathtt: 'monospace', mathbb: 'double-struck', mathcal: 'script', operatorname: 'normal' };

class MathError extends Error {}

function tokenize(tex) {
  const tokens = [];
  for (let i = 0; i < tex.length;) {
    const c = tex[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(i));
      if (!m) throw new MathError('dangling backslash');
      tokens.push({ cmd: m[1] });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(tex.slice(i));
      tokens.push({ num: m[0] });
      i += m[0].length;
    } else {
      const ch = String.fromCodePoint(tex.codePointAt(i));
      tokens.push({ ch });
      i += ch.length;
    }
  }
  return tokens;
}

// A script after a closing bracket belongs to the whole bracketed group: (k+1)^2 is the square of
// (k+1). Attached to the lone bracket, browsers lay it out as a script base and it drops below the line.
const OPENER = { ')': '(', ']': '[', '}': '{', '⟩': '⟨', '⌉': '⌈', '⌋': '⌊' };
const FENCE = /^<mo>([(\[{⟨⌈⌊)\]}⟩⌉⌋])<\/mo>$/;

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
    this.depth = 0;
  }

  peek() { return this.tokens[this.at]; }
  next() { return this.tokens[this.at++]; }

  // A row of atoms until `close` (a character) or the end.
  row(close) {
    if (++this.depth > MAX_DEPTH) throw new MathError('too deep');
    const items = [];
    const opens = []; // [bracket, index in items] of brackets not closed yet in this row
    for (;;) {
      const t = this.peek();
      if (!t) {
        if (close) throw new MathError('unclosed group');
        break;
      }
      if (close && t.ch === close) { this.next(); break; }
      if (t.ch === '}') throw new MathError('unbalanced brace');
      if (t.cmd === 'right') break;
      let base = this.atom();
      const fence = FENCE.exec(base)?.[1];
      if (fence && !OPENER[fence]) opens.push([fence, items.length]);
      else if (fence && opens.length && opens[opens.length - 1][0] === OPENER[fence]) {
        const [, start] = opens.pop();
        const next = this.peek()?.ch;
        if (next === '^' || next === '_' || next === "'") base = `<mrow>${items.splice(start).join('')}${base}</mrow>`;
      }
      items.push(this.scripted(base));
    }
    this.depth--;
    return items.length === 1 ? items[0] : `<mrow>${items.join('')}</mrow>`;
  }

  // An atom with any ^ and _ after it.
  scripted(base) {
    let sub = null, sup = null;
    for (;;) {
      const t = this.peek();
      if (t?.ch === '_' && sub === null) { this.next(); sub = this.argument(); }
      else if (t?.ch === '^' && sup === null) { this.next(); sup = this.argument(); }
      else if (t?.ch === "'" && sup === null) { this.next(); sup = '<mo>′</mo>'; }
      else break;
    }
    if (sub !== null && sup !== null) return `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sub !== null) return `<msub>${base}${sub}</msub>`;
    if (sup !== null) return `<msup>${base}${sup}</msup>`;
    return base;
  }

  // A {group} or a single atom, as the argument of a command or script.
  argument() {
    const t = this.peek();
    if (!t) throw new MathError('missing argument');
    if (t.ch === '{') { this.next(); return this.row('}'); }
    return this.atom();
  }

  rawGroup() {
    if (this.next()?.ch !== '{') throw new MathError('expected {');
    let text = '';
    for (let level = 1; ;) {
      const t = this.next();
      if (!t) throw new MathError('unclosed group');
      if (t.ch === '{') level++;
      if (t.ch === '}' && --level === 0) return text;
      text += t.cmd ? (t.cmd.length === 1 ? t.cmd : '\\' + t.cmd) : (t.num ?? t.ch);
    }
  }

  atom() {
    const t = this.next();
    if (!t) throw new MathError('missing atom');
    if (t.num) return `<mn>${t.num}</mn>`;
    if (t.ch) {
      if (t.ch === '{') return this.row('}');
      if (t.ch === '^' || t.ch === '_') throw new MathError('script without base');
      if (/\p{L}/u.test(t.ch)) return `<mi>${escapeHtml(t.ch)}</mi>`;
      return `<mo>${escapeHtml(t.ch === '-' ? '−' : t.ch)}</mo>`;
    }
    const cmd = t.cmd;
    if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') return `<mfrac>${this.argument()}${this.argument()}</mfrac>`;
    if (cmd === 'binom') return `<mrow><mo>(</mo><mfrac linethickness="0">${this.argument()}${this.argument()}</mfrac><mo>)</mo></mrow>`;
    if (cmd === 'sqrt') {
      if (this.peek()?.ch === '[') {
        this.next();
        const index = this.row(']');
        return `<mroot>${this.argument()}${index}</mroot>`;
      }
      return `<msqrt>${this.argument()}</msqrt>`;
    }
    if (cmd === 'text' || cmd === 'textrm' || cmd === 'mbox') return `<mtext>${escapeHtml(this.rawGroup())}</mtext>`;
    if (VARIANTS[cmd]) {
      const text = this.rawGroup();
      return `<mi mathvariant="${VARIANTS[cmd]}">${escapeHtml(text.replace(/\\/g, ''))}</mi>`;
    }
    if (cmd === 'left' || cmd === 'right' || cmd === 'big' || cmd === 'Big' || cmd === 'bigg' || cmd === 'Bigg') {
      const d = this.next();
      if (!d) throw new MathError('missing delimiter');
      if (d.ch === '.') return '';
      const symbol = d.ch ?? OPERATORS[d.cmd];
      if (!symbol) throw new MathError('unknown delimiter');
      const inner = cmd === 'left' ? this.row() : '';
      if (cmd === 'left') {
        if (this.next()?.cmd !== 'right') throw new MathError('\\left without \\right');
        const close = this.next();
        const closeSymbol = close?.ch === '.' ? '' : (close?.ch ?? OPERATORS[close?.cmd]);
        if (closeSymbol === undefined) throw new MathError('unknown delimiter');
        return `<mrow><mo>${escapeHtml(symbol)}</mo>${inner}${closeSymbol ? `<mo>${escapeHtml(closeSymbol)}</mo>` : ''}</mrow>`;
      }
      return `<mo>${escapeHtml(symbol)}</mo>`;
    }
    if (GREEK[cmd]) return `<mi>${GREEK[cmd]}</mi>`;
    if (FUNCTIONS.has(cmd)) return `<mi>${cmd}</mi>`;
    if (OPERATORS[cmd]) return `<mo>${escapeHtml(OPERATORS[cmd])}</mo>`;
    if (SPACES[cmd]) return `<mspace width="${SPACES[cmd]}"></mspace>`;
    if (cmd === '\\') return '<mspace linebreak="newline"></mspace>';
    if (cmd === 'displaystyle' || cmd === 'textstyle' || cmd === 'scriptstyle' || cmd === 'limits' || cmd === 'nolimits') return '';
    throw new MathError(`unsupported \\${cmd}`);
  }
}

export function texToMathml(tex, display = false) {
  if (typeof tex !== 'string' || !tex.trim() || tex.length > MAX_TEX) return null;
  try {
    const parser = new Parser(tokenize(tex));
    const body = parser.row();
    if (parser.at < parser.tokens.length) return null; // a stray \right
    return `<math${display ? ' display="block"' : ''}>${body}</math>`;
  } catch (error) {
    if (error instanceof MathError) return null;
    throw error;
  }
}
