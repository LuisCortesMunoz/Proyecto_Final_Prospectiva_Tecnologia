/**
 * logicToSchema.js — Compilador DETERMINISTA: JSON dual engine-config → schema ladder.
 *
 * Arquitectura ÚNICA del proyecto: la IA emite el JSON DUAL del motor del
 * maletín (outputs[].logic/timer/counter + system + un `expr` legible). Python
 * (clase XL4) ejecuta la config sobre el PLC; este código (sin IA) deriva de
 * `logic` la GEOMETRÍA (network/row/span) que entiende el renderer. El JSON
 * dual completo se conserva en program.metadata.engine_config para reenviarlo
 * a Python tal cual.
 *
 * La vista de cada salida se dibuja a partir de su expresión booleana `expr`
 * (derivada de `logic` si falta):
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

// ── Engine-config → expr legible (espejo de _expr_de_logica en el backend) ──
// La IA da `expr` para mostrar, pero derivamos la geometría desde `logic`
// (fuente de verdad) para que el dibujo sea fiel al motor del PLC.
function exprFromLogic(lg, out) {
  const mode = String(lg?.mode || 'off').toLowerCase();
  if (mode === 'off') return '';
  if (mode === 'directo') {
    let e = String(lg.source || '');
    if (lg.enable) e += ` * ${lg.enable}`;
    return e;
  }
  if (mode === 'enclavado') {
    let e = `(${lg.start || ''} + ${out})`;
    if (lg.stop) e += ` * !${lg.stop}`;
    if (lg.enable) e += ` * ${lg.enable}`;
    return e;
  }
  if (mode === 'combinacional') {
    const op = String(lg.op || 'OR').toUpperCase() === 'OR' ? '+' : '*';
    let e = `${lg.a || ''} ${op} ${lg.b || ''}`;
    if (lg.latched) e = `(${e} + ${out})`;
    if (lg.stop) e = `(${e}) * !${lg.stop}`;
    return e;
  }
  return '';
}

// Bloque terminal (lado derecho del rung) para timer/contador del motor.
function timerEl(tm, addr, col) {
  const type = String(tm.type).toLowerCase() === 'on_delay' ? 'block_ton' : 'block_tof';
  return { id: eid(), type, address: addr, pos: { col }, params: { preset_ms: Number(tm.preset_s || 0) * 1000 } };
}
function counterEl(ct, addr, col) {
  return { id: eid(), type: 'block_ctu', address: addr, pos: { col }, params: { preset: Number(ct.preset || 0) } };
}

// Compila UNA salida del engine-config a uno o más rungs.
function compileOutput(o, ctx, gStop) {
  const out = o.output;
  const coilAddr = ctx.resolveAddr(out);
  const expr = (o.expr && String(o.expr).trim()) || exprFromLogic(o.logic, out);

  let ast = null;
  if (String(expr).trim()) {
    try { ast = parseExpr(tokenize(expr), ctx); }
    catch { ctx.warnings.push(`${out}: no se pudo parsear "${expr}".`); ast = { type: 'lit', name: out, neg: false }; }
  }
  // El paro global se añade como factor AND a nivel del AST (no como string),
  // para no anidar y romper las ramas OR (p. ej. el sello del enclavamiento).
  if (gStop && !(expr && exprUsesVar(expr, gStop))) {
    const stopLit = { type: 'lit', name: gStop, neg: true };
    if (!ast) ast = stopLit;
    else if (ast.type === 'and') ast.terms.push(stopLit);
    else ast = { type: 'and', terms: [ast, stopLit] };
  }

  let row0 = [], branches = [], width = 0;
  if (ast) ({ row0, branches, width } = layout(ast, ctx));

  ctx.useAddr(coilAddr);
  const tm = o.timer, ct = o.counter;
  const rungs = [];

  // Terminal: timer > contador > bobina. Si hay ambos, la bobina va aquí y el
  // contador se dibuja en un rung aparte (el motor los maneja independientes).
  let terminal;
  if (tm && !ct)       terminal = timerEl(tm, coilAddr, width);
  else if (ct && !tm)  terminal = counterEl(ct, coilAddr, width);
  else                 terminal = { id: eid(), type: 'coil', address: coilAddr, pos: { col: width }, coil_type: 'output' };
  row0.push(terminal);

  const network = [{ row: 0, elements: row0 }];
  branches.forEach((b, k) => network.push({ row: k + 1, span: b.span, elements: b.elements }));
  let comentario = o.comment || `${out}: ${o.logic?.mode || 'off'}`;
  if (tm) comentario += ` · timer ${tm.type} ${tm.preset_s}s`;
  if (ct && (!tm)) comentario += ` · contador ${ct.type} ${ct.preset}${ct.reset_input ? ` (reset ${ct.reset_input})` : ''}`;
  rungs.push({ id: ctx.nextId(), enabled: true, comment: comentario, network });

  if (tm && ct) {
    const drive = o.logic?.source || o.logic?.start || o.logic?.a || out;
    const els = [mkContact({ name: drive, neg: false }, 0, ctx), counterEl(ct, coilAddr, 1)];
    if (ct.reset_input) els.unshift(mkContact({ name: ct.reset_input, neg: true }, 0, ctx));
    els.forEach((e, c) => { e.pos.col = c; });
    rungs.push({ id: ctx.nextId(), enabled: true,
      comment: `${out}: contador ${ct.type} ${ct.preset}${ct.reset_input ? ` (reset ${ct.reset_input})` : ''}`,
      network: [{ row: 0, elements: els }] });
  }
  return rungs;
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

// ── Entrada principal: JSON DUAL engine-config → schema ladder ──
// Contrato: { name, device_profile, system:{enable,global_stop},
//             outputs:[{ output, logic:{mode,...}, timer, counter, expr, comment }] }
// Python lee output/logic/timer/counter/system; aquí dibujamos la vista ladder.
export function compileLogicToSchema(logic, profile) {
  const warnings = [];
  const used = new Map();
  const symbols = buildSymbols(logic || {}, profile);

  let _id = 0;
  const ctx = {
    warnings,
    resolveAddr(name) { if (name == null) return ''; const n = String(name).trim(); const s = symbols[n]; return s ? s.addr : n; },
    useAddr(addr) { if (addr && !used.has(addr)) used.set(addr, symbolEntryFor(addr, symbols)); },
    nextId() { return ++_id; },
  };

  const gStop = logic?.system?.global_stop || null;

  const rungs = [];
  for (const o of (logic?.outputs || [])) {
    if (!o || !o.output) continue;
    rungs.push(...compileOutput(o, ctx, gStop));
  }

  if (!rungs.length) warnings.push('El JSON engine-config no produjo ningún rung (sin "outputs").');

  const symbol_table = {};
  for (const [addr, entry] of used) symbol_table[addr] = entry;

  const program = {
    metadata: {
      project_id: 'logic_' + Date.now().toString(36),
      name: (logic && logic.name) || 'Programa maletín',
      version: '1.0.0',
      device_profile: (logic && logic.device_profile) || (profile && profile.id) || 'maletin_basico',
      // El JSON dual completo viaja en la metadata para enviarse a Python tal cual.
      engine_config: logic || null,
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
