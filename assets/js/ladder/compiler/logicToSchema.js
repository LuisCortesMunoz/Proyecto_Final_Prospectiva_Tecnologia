/**
 * logicToSchema.js — Compilador DETERMINISTA: lógica booleana → schema ladder.
 *
 * Arquitectura B: la IA emite LÓGICA (ecuaciones/patrones); este código (sin
 * IA) calcula la GEOMETRÍA (network/row/span) que entiende el renderer.
 *
 * Sintaxis de ecuación por rung:   COIL = expr
 *     *  &   → serie (AND)
 *     +  |   → paralelo (OR)
 *     !  ~  /→ contacto NC (negado), como prefijo de un operando
 *     ( )    → agrupación
 *     operando → id de símbolo (BTN_VERDE) o dirección (Q10, %I1, I0.0)
 *
 * Que la bobina aparezca como operando dentro de su propia ecuación es la
 * auto-retención (enclavamiento), resuelta de forma estructural.
 *
 * Alcance del esqueleto: AND de factores en el nivel superior; cada factor es
 * un literal o un grupo OR; cada alternativa del OR es un literal o una serie
 * (AND) de literales. Anidamientos más profundos generan un aviso y se
 * aproximan. Cubre los casos del maletín (arranque/paro, enclavamiento…).
 */
import { patterns } from './patterns.js';

let _uid = 0;
function eid() { return 'b' + Date.now().toString(36) + (_uid++).toString(36) + Math.random().toString(36).slice(2, 4); }

// ── Tokenizer ──────────────────────────────────────────────────
function tokenize(src) {
  const tokens = [];
  const re = /\s*([A-Za-z_%][\w.%]*|[()*+&|!~/])/g;
  let m;
  while ((m = re.exec(src)) !== null) tokens.push(m[1]);
  return tokens;
}

// ── Parser recursivo (precedencia: + < * < ! ) ─────────────────
function parseExpr(tokens, ctx) {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseOr() {
    let node = parseAnd();
    const terms = [node];
    while (peek() === '+' || peek() === '|') { next(); terms.push(parseAnd()); }
    return terms.length === 1 ? node : { type: 'or', terms };
  }
  function parseAnd() {
    let node = parseUnary();
    const terms = [node];
    while (peek() === '*' || peek() === '&') { next(); terms.push(parseUnary()); }
    return terms.length === 1 ? node : { type: 'and', terms };
  }
  function parseUnary() {
    if (peek() === '!' || peek() === '~' || peek() === '/') {
      next();
      const a = parseAtom();
      if (a.type === 'lit') a.neg = !a.neg;
      else ctx.warnings.push('Negación de un grupo no soportada (esqueleto); se ignoró el "!".');
      return a;
    }
    return parseAtom();
  }
  function parseAtom() {
    const t = peek();
    if (t === '(') { next(); const e = parseOr(); if (peek() === ')') next(); return e; }
    if (t === undefined) return { type: 'lit', name: '?', neg: false };
    next();
    return { type: 'lit', name: t, neg: false };
  }
  return parseOr();
}

// Aplana un nodo a una serie de literales (una alternativa de un OR).
function toSeries(node, ctx) {
  if (node.type === 'lit') return [node];
  if (node.type === 'and') {
    const out = [];
    for (const t of node.terms) {
      if (t.type === 'lit') out.push(t);
      else { ctx.warnings.push('Anidamiento dentro de una rama aproximado.'); out.push(...toSeries(t, ctx)); }
    }
    return out;
  }
  if (node.type === 'or') {
    ctx.warnings.push('OR anidado dentro de una rama no soportado; se tomó la primera alternativa.');
    return toSeries(node.terms[0], ctx);
  }
  return [node];
}

function mkContact(lit, col, ctx) {
  const address = ctx.resolveAddr(lit.name);
  ctx.useAddr(address);
  return { id: eid(), type: lit.neg ? 'contact_nc' : 'contact_no', address, pos: { col } };
}

// Convierte el AST de contactos en filas (network) sin la bobina.
function layout(ast, ctx) {
  const factors = ast.type === 'and' ? ast.terms : [ast];
  const row0 = [];
  const branches = [];
  let col = 0;

  for (const f of factors) {
    if (f.type === 'or') {
      const alts = f.terms.map(t => toSeries(t, ctx));
      const w = Math.max(...alts.map(a => a.length), 1);
      let repIdx = 0;
      alts.forEach((a, k) => { if (a.length > alts[repIdx].length) repIdx = k; });
      alts.forEach((a, k) => {
        if (k === repIdx) {
          a.forEach((lit, j) => row0.push(mkContact(lit, col + j, ctx)));
        } else {
          const els = a.map((lit, j) => mkContact(lit, col + j, ctx));
          branches.push({ span: { from: col, to: col + w - 1 }, elements: els });
        }
      });
      col += w;
    } else {
      const ser = toSeries(f, ctx);
      ser.forEach((lit, j) => row0.push(mkContact(lit, col + j, ctx)));
      col += Math.max(ser.length, 1);
    }
  }
  return { row0, branches, width: col };
}

// Compila un rung tipo ecuación: { coil, expr, comment, coilType? }
export function compileEquation(rungSpec, idx, ctx) {
  let ast;
  try { ast = parseExpr(tokenize(rungSpec.expr || ''), ctx); }
  catch { ctx.warnings.push(`Rung ${idx + 1}: no se pudo parsear "${rungSpec.expr}".`); ast = { type: 'lit', name: rungSpec.expr || '?', neg: false }; }

  const { row0, branches, width } = layout(ast, ctx);

  const coilType = rungSpec.coilType || 'output';
  const coilAddr = ctx.resolveAddr(rungSpec.coil);
  ctx.useAddr(coilAddr);
  row0.push({
    id: eid(),
    type: coilType === 'set' ? 'coil_s' : coilType === 'reset' ? 'coil_r' : 'coil',
    address: coilAddr,
    pos: { col: width },
    coil_type: coilType,
  });

  const network = [{ row: 0, elements: row0 }];
  branches.forEach((b, k) => network.push({ row: k + 1, span: b.span, elements: b.elements }));
  return { id: idx + 1, enabled: true, comment: rungSpec.comment || '', network };
}

// ── Símbolos y direcciones ─────────────────────────────────────
function buildSymbols(logic, profile) {
  const map = {};
  if (profile) {
    for (const io of [...(profile.inputs || []), ...(profile.outputs || [])]) {
      map[io.id] = { addr: io.addr, type: io.kind === 'analog' ? 'INT' : 'BOOL', comment: io.label || '', symbol: io.id };
    }
  }
  if (logic.symbols) {
    for (const [k, v] of Object.entries(logic.symbols)) {
      map[k] = { addr: v.addr || k, type: v.type || 'BOOL', comment: v.comment || v.label || '', symbol: k };
    }
  }
  return map;
}

function guessType(a) { const s = String(a).toUpperCase(); return (s.startsWith('MW') || s.startsWith('%R') || s.startsWith('AI') || s.startsWith('%AI')) ? 'INT' : 'BOOL'; }
function guessModbus(a) {
  const s = String(a).toUpperCase();
  if (s.startsWith('%I') || /^I\d/.test(s) || s.startsWith('I0')) return { fn: 'read_coil', address: null };
  if (s.startsWith('%Q') || /^Q\d/.test(s) || s.startsWith('Q0')) return { fn: 'write_coil', address: null };
  if (s.startsWith('MW') || s.startsWith('%R') || s.startsWith('AI') || s.startsWith('%AI')) return { fn: 'holding_reg', address: null };
  return { fn: 'internal', address: null };
}
function symbolEntryFor(addr, symbols) {
  let found = null;
  for (const s of Object.values(symbols)) if (s.addr === addr) { found = s; break; }
  return {
    symbol: found ? found.symbol : String(addr).replace(/[%.]/g, '_'),
    type: found ? found.type : guessType(addr),
    modbus: guessModbus(addr),
    comment: found ? found.comment : '',
  };
}

// ── Entrada principal ──────────────────────────────────────────
export function compileLogicToSchema(logic, profile) {
  const warnings = [];
  const used = new Map();
  const symbols = buildSymbols(logic || {}, profile);

  const ctx = {
    warnings,
    resolveAddr(name) { if (name == null) return ''; const s = symbols[name]; return s ? s.addr : name; },
    useAddr(addr) { if (addr && !used.has(addr)) used.set(addr, symbolEntryFor(addr, symbols)); },
  };

  const rungs = [];
  const helpers = { compileEquation, mkRungId: () => rungs.length + 1 };
  for (const [i, rs] of (logic.rungs || []).entries()) {
    if (rs.pattern) {
      const fn = patterns[rs.pattern];
      if (!fn) { warnings.push(`Patrón "${rs.pattern}" no soportado (esqueleto). Disponibles: ${Object.keys(patterns).join(', ')}.`); continue; }
      const built = fn(rs, ctx, helpers);
      (Array.isArray(built) ? built : [built]).forEach(r => { r.id = rungs.length + 1; rungs.push(r); });
    } else if (rs.expr && rs.coil) {
      rungs.push(compileEquation(rs, rungs.length, ctx));
    } else {
      warnings.push(`Rung ${i + 1} ignorado: falta 'expr'+'coil' o 'pattern'.`);
    }
  }

  const symbol_table = {};
  for (const [addr, entry] of used) symbol_table[addr] = entry;

  const program = {
    metadata: {
      project_id: 'logic_' + Date.now().toString(36),
      name: (logic && logic.name) || 'Programa (lógica booleana)',
      version: '1.0.0',
      plc_target: (profile && profile.plc && profile.plc.modbus)
        ? { ip: profile.plc.modbus.ip || '192.168.1.100', port: profile.plc.modbus.port || 502, unit_id: 1 }
        : { ip: '192.168.1.100', port: 502, unit_id: 1 },
      scan_time_ms: 100,
      _engine: 'B',
      _warnings: warnings,
    },
    symbol_table,
    rungs,
    execution_state: { mode: 'run', rung_states: {}, forced_outputs: {} },
  };
  return { program, warnings };
}
