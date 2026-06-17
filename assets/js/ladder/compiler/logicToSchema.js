/**
 * logicToSchema.js — Compilador DETERMINISTA: JSON lógico simple → schema ladder.
 *
 * Arquitectura ÚNICA del proyecto (ver CONTRACT.md): la IA emite el JSON
 * LÓGICO SIMPLE (outputs/timers/states/global_rules) y este código (sin IA)
 * calcula la GEOMETRÍA (network/row/span) que entiende el renderer.
 *
 * Cada salida tiene una expresión booleana `expr`:
 *     *  &   → serie (AND)
 *     +  |   → paralelo (OR)
 *     !  ~  /→ contacto NC (negado), como prefijo de un operando
 *     ( )    → agrupación
 *     operando → nombre lógico (I1, Q10, M1, T1.DN, BLINK_1S)
 *
 * Que la bobina aparezca como operando dentro de su propia expresión es la
 * auto-retención (enclavamiento), resuelta de forma estructural.
 *
 * Alcance: AND de factores en el nivel superior; cada factor es un literal o
 * un grupo OR; cada alternativa del OR es un literal o una serie (AND) de
 * literales. Anidamientos más profundos generan un aviso y se aproximan.
 * Cubre los casos del maletín (arranque/paro, enclavamiento, timers…).
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

// Compila un timer del contrato a un rung: [contacto(enable)] → bloque TON/TOF/OSC
function compileTimer(tm, idx, ctx) {
  const els = [];
  let col = 0;
  if (tm.enable) { els.push(mkContact({ name: tm.enable, neg: false }, col, ctx)); col++; }
  const type = tm.type === 'TOF' ? 'block_tof'
             : tm.type === 'OSCILLATOR' ? 'block_osc'
             : 'block_ton';
  const addr = ctx.resolveAddr(tm.id);
  ctx.useAddr(addr);
  els.push({ id: eid(), type, address: addr, pos: { col }, params: { preset_ms: tm.preset_ms ?? 1000 } });
  return { id: idx + 1, enabled: true, comment: tm.comment || `Timer ${tm.id}`, network: [{ row: 0, elements: els }] };
}

// ── Símbolos y direcciones ─────────────────────────────────────
// El programa usa NOMBRES LÓGICOS como dirección (I1, Q10, M1, T1, T1.DN),
// igual que el contrato. El símbolo/comentario amigable viene del perfil.
function normalizeLogical(addr) { return String(addr).replace(/^%/, ''); }

function modbusFor(io, key) {
  if (io.kind === 'analog') return { fn: 'holding_reg', address: null };
  // entrada (input) → read_coil ; salida (output) → write_coil
  if (io._dir === 'out') return { fn: 'write_coil', address: null };
  if (io._dir === 'in') return { fn: 'read_coil', address: null };
  return guessModbus(key);
}

function buildSymbols(logic, profile) {
  const map = {};
  if (profile) {
    for (const io of (profile.inputs || []))  { const k = normalizeLogical(io.addr); map[k] = { addr: k, symbol: io.id || k, type: io.kind === 'analog' ? 'INT' : 'BOOL', comment: io.label || '', modbus: modbusFor({ ...io, _dir: 'in' }, k) }; }
    for (const io of (profile.outputs || [])) { const k = normalizeLogical(io.addr); map[k] = { addr: k, symbol: io.id || k, type: 'BOOL', comment: io.label || '', modbus: modbusFor({ ...io, _dir: 'out' }, k) }; }
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
  const found = symbols[addr];
  return {
    symbol: found ? found.symbol : String(addr).replace(/[%.]/g, '_'),
    type:   found ? found.type   : guessType(addr),
    modbus: found && found.modbus ? found.modbus : guessModbus(addr),
    comment: found ? found.comment : '',
  };
}

// ¿La expresión ya referencia la variable de paro? (para no duplicarla)
function exprUsesVar(expr, name) {
  if (!name) return false;
  const re = new RegExp('(^|[^\\w.%])' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w.%]|$)');
  return re.test(String(expr || ''));
}

// ── Entrada principal: JSON LÓGICO SIMPLE → schema ladder ──────
// Contrato: { name, outputs:[{coil,expr,mode,comment}], timers:[...],
//             states:[...], global_rules:{global_stop, stop_priority} }
export function compileLogicToSchema(logic, profile) {
  const warnings = [];
  const used = new Map();
  const symbols = buildSymbols(logic || {}, profile);

  const ctx = {
    warnings,
    resolveAddr(name) { if (name == null) return ''; const n = String(name).trim(); const s = symbols[n]; return s ? s.addr : n; },
    useAddr(addr) { if (addr && !used.has(addr)) used.set(addr, symbolEntryFor(addr, symbols)); },
  };

  const rungs = [];
  const helpers = { compileEquation, mkRungId: () => rungs.length + 1 };
  const gStop = logic?.global_rules?.global_stop;
  const stopPriority = logic?.global_rules?.stop_priority !== false; // por defecto el paro tiene prioridad

  // 1) Estados (latch) primero, para que M1 ya exista al compilar las salidas.
  for (const st of (logic?.states || [])) {
    if (st.type && st.type !== 'latch') { warnings.push(`Estado "${st.id}": tipo "${st.type}" no soportado; se usa latch.`); }
    const built = patterns.latch(
      { coil: st.id, start: st.set, stops: st.reset ? [st.reset] : [], comment: st.comment },
      ctx, helpers,
    );
    built.id = rungs.length + 1;
    rungs.push(built);
  }

  // 2) Timers → un rung con su bloque.
  for (const tm of (logic?.timers || [])) {
    rungs.push(compileTimer(tm, rungs.length, ctx));
  }

  // 3) Salidas → un rung por bobina. El paro global se aplica con prioridad.
  for (const out of (logic?.outputs || [])) {
    let expr = out.expr || '';
    if (gStop && stopPriority && !exprUsesVar(expr, gStop)) {
      expr = expr ? `(${expr}) * !${gStop}` : `!${gStop}`;
    }
    rungs.push(compileEquation({ coil: out.coil, expr, comment: out.comment || '', coilType: 'output' }, rungs.length, ctx));
  }

  if (!rungs.length) warnings.push('El JSON lógico no produjo ningún rung (sin outputs/timers/states).');

  const symbol_table = {};
  for (const [addr, entry] of used) symbol_table[addr] = entry;

  const program = {
    metadata: {
      project_id: 'logic_' + Date.now().toString(36),
      name: (logic && logic.name) || 'Programa lógico',
      version: '1.0.0',
      device_profile: (logic && logic.device_profile) || (profile && profile.id) || null,
      logic_type: (logic && logic.logic_type) || null,
      plc_target: (profile && profile.plc && profile.plc.modbus)
        ? { ip: profile.plc.modbus.ip || '192.168.1.100', port: profile.plc.modbus.port || 502, unit_id: profile.plc.modbus.unit_id || 1 }
        : { ip: '192.168.1.100', port: 502, unit_id: 1 },
      scan_time_ms: 100,
      _warnings: warnings,
    },
    symbol_table,
    rungs,
    execution_state: { mode: 'run', rung_states: {}, forced_outputs: {} },
  };
  return { program, warnings };
}
