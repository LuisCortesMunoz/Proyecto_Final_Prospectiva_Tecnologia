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
  const expr = exprFromLogic(o.logic, out);

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

// ── Secuenciador de pasos (semáforo) → rungs + datos de simulación ──
// La capa "sequence" del engine-config no se puede expresar con la lógica por
// salida (una salida no dispara a otra). Aquí se dibuja como rungs reales
// [PASOk]──(Qx) y se emiten los datos que el simulador usa para avanzar los
// pasos en el tiempo (metadata._sequence_sim). El motor del PLC (Texto
// Estructurado) hace lo mismo de forma autónoma.
function compileSequence(seq, ctx) {
  const rungs = [];
  const startAddr = ctx.resolveAddr(seq.start);
  ctx.useAddr(startAddr);
  const runAddr = 'SEQ_RUN';
  ctx.useAddr(runAddr);
  const mode = String(seq.mode || 'once').toLowerCase();

  // Rung informativo: arranque de la secuencia.
  rungs.push({
    id: ctx.nextId(), enabled: true,
    comment: `Secuencia: arranca con ${seq.start} (${mode === 'loop' ? 'cíclica' : 'una vez'})`,
    network: [{ row: 0, elements: [
      { id: eid(), type: 'contact_no', address: startAddr, pos: { col: 0 } },
      { id: eid(), type: 'coil', address: runAddr, pos: { col: 1 }, coil_type: 'output' },
    ]}],
  });

  const simSteps = [];
  (seq.steps || []).forEach((st, k) => {
    const stepAddr = `PASO${k + 1}`;
    ctx.useAddr(stepAddr);
    const outAddrs = (st.outputs || []).map(o => ctx.resolveAddr(o));
    outAddrs.forEach(a => ctx.useAddr(a));
    const dur = Number(st.duration_s || 0);
    const etiqueta = (st.outputs || []).join(', ');
    // Un rung por salida del paso: [PASOk]──(Qx)
    outAddrs.forEach((a) => {
      rungs.push({
        id: ctx.nextId(), enabled: true,
        comment: `Paso ${k + 1}: ${etiqueta} durante ${dur} s`,
        network: [{ row: 0, elements: [
          { id: eid(), type: 'contact_no', address: stepAddr, pos: { col: 0 } },
          { id: eid(), type: 'coil', address: a, pos: { col: 1 }, coil_type: 'output' },
        ]}],
      });
    });
    simSteps.push({ stepAddr, outAddrs, durationMs: dur * 1000 });
  });

  return { rungs, sim: { startAddr, runAddr, mode, steps: simSteps } };
}

// ── Banda transportadora + VFD (bloque "band") → rungs + vista ──
// Espejo de la sección §12 del Ladder maestro y del bloque "band" que ya
// acepta plc_maestro.py. No inventa lógica: dibuja la que el PLC ejecuta.
//
//   S1 = I3 (NC)   S2 = I4 (NC)   torreta = Q10 verde / Q11 amarilla / Q12 roja
//   VFD: %R00500 → 18 derecha · 34 izquierda · 1 paro
//
// Etiquetas amigables para el symbol_table del dibujo.
const BAND_SYMBOLS = {
  BANDA_ON:     { symbol: 'BANDA_ON',      comment: 'Banda habilitada (SysMode=2)' },
  BANDA_RUN:    { symbol: 'BANDA_RUN',     comment: 'Banda en marcha' },
  S1_ESPERA:    { symbol: 'S1_ESPERA',     comment: 'Espera por S1: banda detenida' },
  S2_ESPERA:    { symbol: 'S2_ESPERA',     comment: 'Espera por S2: banda detenida' },
  S1_RETRIG:    { symbol: 'S1_RETRIG',     comment: 'Anti-retrigger de S1' },
  S2_RETRIG:    { symbol: 'S2_RETRIG',     comment: 'Anti-retrigger de S2' },
  VFD_MARCHA:   { symbol: 'VFD_MARCHA',    comment: 'Comando de marcha al VFD (%R00500)' },
};

const BAND_DIR_CANON = {
  derecha: 'derecha', right: 'derecha', der: 'derecha', cw: 'derecha',
  izquierda: 'izquierda', left: 'izquierda', izq: 'izquierda', ccw: 'izquierda',
};

function bandDir(d) { return BAND_DIR_CANON[String(d ?? 'derecha').toLowerCase()] || 'derecha'; }

// I3/I4 son entradas normales del maletín; solo con la banda activa pasan a
// mostrarse como los sensores S1/S2. Se inyecta en el mapa de símbolos para
// no alterar el etiquetado de los programas que no usan la banda.
function bandSensorSymbols(symbols) {
  symbols.I3 = { addr: 'I3', symbol: 'S1', type: 'BOOL', comment: 'Sensor S1 de la banda (NC)', modbus: { fn: 'read_coil', address: null } };
  symbols.I4 = { addr: 'I4', symbol: 'S2', type: 'BOOL', comment: 'Sensor S2 de la banda (NC)', modbus: { fn: 'read_coil', address: null } };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Construye un rung a partir de una expresión y un elemento terminal.
function bandRung(expr, mkTerminal, comment, ctx) {
  const ast = parseExpr(tokenize(expr), ctx);
  const { row0, branches, width } = layout(ast, ctx);
  row0.push(mkTerminal(width));
  const network = [{ row: 0, elements: row0 }];
  branches.forEach((b, k) => network.push({ row: k + 1, span: b.span, elements: b.elements }));
  return { id: ctx.nextId(), enabled: true, comment, network };
}

function coilAt(addr, ctx) {
  ctx.useAddr(addr);
  return (col) => ({ id: eid(), type: 'coil', address: addr, pos: { col }, coil_type: 'output' });
}
function tonAt(addr, seconds, ctx) {
  ctx.useAddr(addr);
  return (col) => ({ id: eid(), type: 'block_ton', address: addr, pos: { col }, params: { preset_ms: seconds * 1000 } });
}
function tofAt(addr, seconds, ctx) {
  ctx.useAddr(addr);
  return (col) => ({ id: eid(), type: 'block_tof', address: addr, pos: { col }, params: { preset_ms: seconds * 1000 } });
}

function compileBand(band, ctx, hints) {
  const rungs = [];
  const dir     = bandDir(band.direction);
  const freq    = num(band.freq_hz);
  const waitS1  = num(band.wait_s1_s);
  const waitS2  = num(band.wait_s2_s);
  const retS1   = num(band.retrigger_s1_s);
  const retS2   = num(band.retrigger_s2_s);

  const usaS1 = waitS1 != null && waitS1 > 0;
  const usaS2 = waitS2 != null && waitS2 > 0;
  const retrigS1 = usaS1 && retS1 != null && retS1 > 0;
  const retrigS2 = usaS2 && retS2 != null && retS2 > 0;

  ['BANDA_ON', 'BANDA_RUN'].forEach(a => ctx.useAddr(a));

  // 1) Espera por sensor: S1/S2 son NC, por eso el contacto es cerrado.
  if (usaS1) {
    rungs.push(bandRung('!I3', tonAt('S1_ESPERA', waitS1, ctx),
      `S1 detecta pieza → la banda se detiene ${waitS1} s`, ctx));
  }
  if (usaS2) {
    rungs.push(bandRung('!I4', tonAt('S2_ESPERA', waitS2, ctx),
      `S2 detecta pieza → la banda se detiene ${waitS2} s`, ctx));
  }

  // 2) Anti-retrigger: bloquea una nueva detección mientras la pieza sale.
  if (retrigS1) {
    rungs.push(bandRung('S1_ESPERA', tofAt('S1_RETRIG', retS1, ctx),
      `Anti-retrigger de S1: ${retS1} s tras el rearranque`, ctx));
  }
  if (retrigS2) {
    rungs.push(bandRung('S2_ESPERA', tofAt('S2_RETRIG', retS2, ctx),
      `Anti-retrigger de S2: ${retS2} s tras el rearranque`, ctx));
  }

  // 3) Marcha efectiva de la banda.
  let exprRun = 'BANDA_ON';
  if (usaS1) exprRun += ' * !S1_ESPERA';
  if (usaS2) exprRun += ' * !S2_ESPERA';
  rungs.push(bandRung(exprRun, coilAt('BANDA_RUN', ctx),
    'Banda en marcha: habilitada y sin espera de sensor', ctx));

  // 4) Comando al VFD. En el PLC es una escritura a %R00500; en ladder se
  //    dibuja como la bobina de marcha, con el detalle en el comentario.
  const cmd = dir === 'izquierda' ? 34 : 18;
  rungs.push(bandRung('BANDA_RUN', coilAt('VFD_MARCHA', ctx),
    `VFD: marcha hacia la ${dir} (%R00500 = ${cmd})`
    + (freq != null ? ` · ${freq} Hz` : ''), ctx));

  // 5) Torreta (§12.7). Verde = corriendo · Amarilla = anti-retrigger ·
  //    Roja = detenida esperando en un sensor.
  const retTerms  = [retrigS1 && 'S1_RETRIG', retrigS2 && 'S2_RETRIG'].filter(Boolean);
  const waitTerms = [usaS1 && 'S1_ESPERA', usaS2 && 'S2_ESPERA'].filter(Boolean);

  let exprVerde = 'BANDA_RUN';
  retTerms.forEach(t => { exprVerde += ` * !${t}`; });
  rungs.push(bandRung(exprVerde, coilAt('Q10', ctx), 'Torreta verde: banda corriendo', ctx));

  if (retTerms.length) {
    rungs.push(bandRung(retTerms.join(' + '), coilAt('Q11', ctx),
      'Torreta amarilla: pieza saliendo del sensor', ctx));
  }
  if (waitTerms.length) {
    rungs.push(bandRung(waitTerms.join(' + '), coilAt('Q12', ctx),
      'Torreta roja: banda detenida esperando', ctx));
  }

  // Lámparas de la torreta que la instrucción nombra explícitamente. El PLC
  // (§12.7 del Ladder maestro) las gobierna solo con el estado de la banda,
  // por eso los rungs de arriba no cambian; esto es únicamente qué se dibuja
  // ENCENDIDO en el panel. Sin mención, la torreta queda en estado neutro.
  const lamps = (hints && hints.lamps) || {};

  // Datos para el panel visual (solo presentación; no altera el engine_config).
  const view = {
    enable: true,
    direction: dir,
    vfd_cmd: cmd,
    freq_hz: freq,
    wait_s1_s: usaS1 ? waitS1 : null,
    wait_s2_s: usaS2 ? waitS2 : null,
    retrigger_s1_s: retrigS1 ? retS1 : null,
    retrigger_s2_s: retrigS2 ? retS2 : null,
    // Qué componentes participan en ESTA instrucción (el panel dibuja solo estos)
    uses: {
      banda: true,
      vfd: true,
      freq: freq != null,
      s1: usaS1,
      s2: usaS2,
      torreta: true,
      verde: !!lamps.verde,
      amarilla: !!lamps.amarilla,
      roja: !!lamps.roja,
    },
  };

  return { rungs, view };
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
  const band  = BAND_SYMBOLS[addr];
  return {
    // Para las señales de la banda preferimos su etiqueta funcional (S1, S2…)
    symbol: band ? band.symbol : found ? found.symbol : String(addr).replace(/[%.]/g, '_'),
    type:   found ? found.type   : guessType(addr),
    modbus: found && found.modbus ? found.modbus : guessModbus(addr),
    comment: band ? band.comment : found ? found.comment : '',
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
export function compileLogicToSchema(logic, profile, opts = {}) {
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

  const bandCfg = logic?.band;
  const bandOn  = !!bandCfg && (bandCfg.enable === undefined || !!bandCfg.enable);
  if (bandOn) bandSensorSymbols(symbols);

  const rungs = [];
  for (const o of (logic?.outputs || [])) {
    if (!o || !o.output) continue;
    rungs.push(...compileOutput(o, ctx, gStop));
  }

  // Secuenciador de pasos (semáforo): se dibuja como rungs propios y emite los
  // datos que el simulador usa para avanzar los pasos en el tiempo.
  let sequenceSim = null;
  const seq = logic?.sequence;
  if (seq && Array.isArray(seq.steps) && seq.steps.length) {
    const { rungs: seqRungs, sim } = compileSequence(seq, ctx);
    rungs.push(...seqRungs);
    sequenceSim = sim;
  }

  // Banda transportadora + VFD: se dibuja como rungs propios y emite los datos
  // que el panel visual usa para representar los elementos físicos.
  let bandView = null;
  if (bandOn) {
    const { rungs: bandRungs, view } = compileBand(bandCfg, ctx, opts.bandHints);
    rungs.push(...bandRungs);
    bandView = view;
  }

  if (!rungs.length) warnings.push('El JSON engine-config no produjo ningún rung (sin "outputs", "sequence" ni "band").');

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
      // Datos para que el simulador anime la secuencia en el tiempo (null si no hay).
      _sequence_sim: sequenceSim,
      // Datos de PRESENTACIÓN de la banda para el panel visual (null si no hay).
      _band_view: bandView,
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
