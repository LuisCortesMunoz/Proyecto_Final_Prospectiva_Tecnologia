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
// Representación Ladder del programa maestro ST de la banda
// (ladder_maestro_banda.csp). No es una traducción literal del ST: para la
// configuración pedida dibuja las condiciones que el ST evalúa y lo que
// activa, con los bloques de Cscape (MOV, MUL, DIV, TON, CTU, CMP).
//
//   Entradas: I1 arranque (NA) · I3 paro (NC) · S1 = I4 (NC) · S2 = I5 (NC)
//   Torreta:  Q3 verde · Q4 amarilla · Q5 roja (máscaras %R40/%R41/%R24/%R34)
//   Plumas:   P1 Q8 sube / Q6 baja · P2 Q9 sube (provisional) / Q7 baja
//   VFD:      %R500 = 18 dir 1 · 34 dir 2 · 1 paro · %R504 = FreqRequest × 100
//   Triggers: %R5 NewCfgFlag · %R6 ResetCmd (por cambio de valor)
const BAND_DIR_CANON = {
  derecha: 'derecha', right: 'derecha', der: 'derecha', cw: 'derecha', '1': 'derecha',
  izquierda: 'izquierda', left: 'izquierda', izq: 'izquierda', ccw: 'izquierda', '2': 'izquierda',
};

function bandDir(d) { return BAND_DIR_CANON[String(d ?? 'derecha').toLowerCase()] || 'derecha'; }

// Códigos de acción de sensor del ST (S1_Action/S2_Action). Los nombres
// obsoletos se traducen igual que en plc_banda.py.
const BAND_ACCION = {
  nada: 0, paro_presencia: 1, paro_mientras_detecta: 1, paro_temporizado: 2,
  paro_presencia_torreta: 3, paro_mientras_detecta_torreta: 3, paro_temporizado_torreta: 4,
  paro_enclavado: 2, contar: 0, contar_y_parar: 0,
};
function bandAccion(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 4) return n;
  return BAND_ACCION[String(v).toLowerCase()] ?? null;
}
const BAND_PLUMA = { stop: 0, parar: 0, paro: 0, subir: 1, arriba: 1, up: 1, bajar: 2, abajo: 2, down: 2 };
function bandPluma(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (n === 0 || n === 1 || n === 2) return n;
  return BAND_PLUMA[String(v).toLowerCase()] ?? null;
}
const TORRETA_NOMBRE = ['apagada', 'verde', 'amarilla', 'verde + amarilla', 'roja',
  'verde + roja', 'amarilla + roja', 'verde + amarilla + roja'];

// Símbolos de la banda. Solo se inyectan cuando el programa trae el bloque
// "band": el etiquetado de los programas del maletín no cambia.
function bandSymbols(symbols) {
  const put = (addr, symbol, comment, type = 'BOOL', fn = 'internal') => {
    symbols[addr] = { addr, symbol, type, comment, modbus: { fn, address: null } };
  };
  put('I1', 'BTN_START', 'I1 (NA): arranque de la banda', 'BOOL', 'read_coil');
  put('I3', 'BTN_STOP', 'I3 (NC): paro general prioritario', 'BOOL', 'read_coil');
  put('I4', 'S1', 'Sensor S1 de la banda (I4, NC)', 'BOOL', 'read_coil');
  put('I5', 'S2', 'Sensor S2 de la banda (I5, NC)', 'BOOL', 'read_coil');
  put('Q3', 'LAMP_VERDE', 'Torreta verde (Q3)', 'BOOL', 'write_coil');
  put('Q4', 'LAMP_AMARILLA', 'Torreta amarilla (Q4)', 'BOOL', 'write_coil');
  put('Q5', 'LAMP_ROJA', 'Torreta roja (Q5)', 'BOOL', 'write_coil');
  put('Q8', 'P1_SUBE', 'Pluma 1 sube (Q8)', 'BOOL', 'write_coil');
  put('Q6', 'P1_BAJA', 'Pluma 1 baja (Q6)', 'BOOL', 'write_coil');
  put('Q9', 'P2_SUBE', 'Pluma 2 sube (Q9, provisional en el ST)', 'BOOL', 'write_coil');
  put('Q7', 'P2_BAJA', 'Pluma 2 baja (Q7)', 'BOOL', 'write_coil');
  put('BandEnable', 'BandEnable', 'Banda habilitada por I1 (espejo %R1 BandEnable_Reg)');
  put('CfgValid', 'CfgValid', 'Configuración válida (§3): DirCmd 1/2, FreqRequest 1..327, acciones y máscaras en rango');
  put('CfgReady', 'CfgReady', 'Configuración lista (espejo %R7 CfgReady_Reg)');
  put('BandRunning', 'BandRunning', 'Banda en marcha (espejo %R3 BandStatus)');
  put('S1_StopLatch', 'S1_StopLatch', 'Paro por S1 activo');
  put('S2_StopLatch', 'S2_StopLatch', 'Paro por S2 activo');
  put('S1_CountDone', 'S1_CountDone', 'Objetivo de conteo de S1 alcanzado (espejo %R27)');
  put('S2_CountDone', 'S2_CountDone', 'Objetivo de conteo de S2 alcanzado (espejo %R37)');
  put('%R5', 'NewCfgFlag', 'Nueva configuración desde el backend (cambio de valor)', 'INT', 'holding_reg');
  put('%R6', 'ResetCmd', 'Reset del VFD desde el backend (cambio de valor)', 'INT', 'holding_reg');
  put('%R506', 'VFD_ResetReg', 'Reset del VFD: 2 durante 2 s', 'INT', 'holding_reg');
  put('%R506.DN', 'ResetDone', 'Secuencia de reset del VFD terminada');
  put('%R504', 'VFD_FreqCalc', 'Consigna al VFD = FreqRequest × 100', 'INT', 'holding_reg');
  put('%R500', 'VFD_Control', 'Comando al VFD: 18 dir 1 · 34 dir 2 · 1 paro', 'INT', 'holding_reg');
  put('%R8', 'VFD_SpeedDisp', 'Velocidad real en Hz = VFD_SpeedRaw (%R502) ÷ 100', 'INT', 'holding_reg');
  put('%R25', 'S1_CountAccum', 'Piezas detectadas por S1', 'INT', 'holding_reg');
  put('%R26', 'S1_TimerAccum', 'Segundos del paro temporizado de S1', 'INT', 'holding_reg');
  put('%R26.DN', 'S1_TimerDone', 'Tiempo de paro de S1 cumplido');
  put('%R35', 'S2_CountAccum', 'Piezas detectadas por S2', 'INT', 'holding_reg');
  put('%R36', 'S2_TimerAccum', 'Segundos del paro temporizado de S2', 'INT', 'holding_reg');
  put('%R36.DN', 'S2_TimerDone', 'Tiempo de paro de S2 cumplido');
  put('%R60', 'Pluma1Cmd', 'Comando pluma 1: 0 stop · 1 subir · 2 bajar', 'INT', 'holding_reg');
  put('%R61', 'Pluma2Cmd', 'Comando pluma 2: 0 stop · 1 subir · 2 bajar', 'INT', 'holding_reg');
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

// Contactos de la banda: no/nc/flanco positivo (pe)/flanco negativo (ne) y
// comparador CMP (=) para los comandos de pluma.
const BAND_CONTACT = { no: 'contact_no', nc: 'contact_nc', pe: 'contact_pos_edge', ne: 'contact_neg_edge' };
function bandEl(spec, col, ctx) {
  const address = ctx.resolveAddr(spec.a);
  ctx.useAddr(address);
  if (spec.t === 'cmp') {
    return { id: eid(), type: 'block_cmp', address, pos: { col },
             params: { op: 'EQ', value: spec.v, band: { title: 'CMP', sub: `= ${spec.v}` } } };
  }
  return { id: eid(), type: BAND_CONTACT[spec.t], address, pos: { col } };
}

// Rung en serie: contactos en la fila principal, terminal al final y, si hace
// falta, contactos en paralelo con uno de la fila principal.
function bandRungSerie(comment, contacts, mkTerminal, ctx, ramas = []) {
  const row0 = contacts.map((c, i) => bandEl(c, i, ctx));
  row0.push(mkTerminal(contacts.length));
  const network = [{ row: 0, elements: row0 }];
  ramas.forEach((r, k) => network.push({
    row: k + 1, span: { from: r.col, to: r.col }, elements: [bandEl(r.c, r.col, ctx)],
  }));
  return { id: ctx.nextId(), enabled: true, comment, network };
}

// Terminal del rung: bobina (normal/S/R) o bloque. params.band marca los
// bloques de la banda para que el renderer muestre su título y parámetro.
function bandOut(type, addr, ctx, params) {
  ctx.useAddr(addr);
  return (col) => {
    const el = { id: eid(), type, address: addr, pos: { col } };
    if (type.startsWith('coil')) el.coil_type = type === 'coil_s' ? 'set' : type === 'coil_r' ? 'reset' : 'output';
    if (params) el.params = params;
    return el;
  };
}

function compileBand(band, ctx, hints) {
  const rungs = [];
  const dir     = bandDir(band.direction);
  const dirN    = dir === 'izquierda' ? 2 : 1;
  const cmd     = dirN === 2 ? 34 : 18;
  const freq    = num(band.freq_hz);
  const waitS1  = num(band.wait_s1_s);
  const waitS2  = num(band.wait_s2_s);
  const retS1   = num(band.retrigger_s1_s);
  const retS2   = num(band.retrigger_s2_s);

  const usaS1 = waitS1 != null && waitS1 > 0;
  const usaS2 = waitS2 != null && waitS2 > 0;
  const retrigS1 = usaS1 && retS1 != null && retS1 > 0;
  const retrigS2 = usaS2 && retS2 != null && retS2 > 0;

  // Cada sensor tal como lo carga el backend (plc_banda._accion_de_sensor):
  // sin acción, un tiempo de espera implica paro temporizado y un conteo solo
  // habilita el sensor.
  const sensor = (n) => {
    const wait = num(band[`wait_s${n}_s`]);
    const hayConteo = band[`count_s${n}`] != null;
    let acc = bandAccion(band[`s${n}_action`]);
    if (acc == null && wait != null) acc = 2;
    if (acc == null && hayConteo) acc = 0;
    return {
      n, acc, on: acc != null, wait,
      count: num(band[`count_s${n}`]) || 0,
      mask: num(band[`torreta_s${n}`]) || 0,
      io: n === 1 ? 'I4' : 'I5',
      cnt: n === 1 ? '%R25' : '%R35',
      tmr: n === 1 ? '%R26' : '%R36',
      doneReg: n === 1 ? '%R27' : '%R37',
      maskReg: n === 1 ? '%R24' : '%R34',
      latch: `S${n}_StopLatch`,
      done: `S${n}_CountDone`,
    };
  };
  const S = [sensor(1), sensor(2)];
  const torRun  = num(band.torreta_run) || 0;
  const torIdle = num(band.torreta_idle) || 0;

  // 1) Reconfiguración / reset del VFD (§6, §7, §8). La secuencia no avanza
  //    con el paro I3 presionado.
  rungs.push(bandRungSerie(
    'Reconfiguración: NewCfgFlag (%R5) o ResetCmd (%R6) cambian de valor → reset del VFD 2 s (%R506 = 2) · borra BandEnable, conteos y esperas',
    [{ t: 'pe', a: '%R5' }, { t: 'no', a: 'I3' }],
    bandOut('block_ton', '%R506', ctx, { preset_ms: 2000, band: { title: 'TON' } }), ctx,
    [{ col: 0, c: { t: 'pe', a: '%R6' } }]));

  // 2) Configuración lista (§3 CfgValid + §8 estado 4).
  const cfgTxt = `DirCmd (%R2) = ${dirN}`
    + (freq != null ? ` y FreqRequest (%R4) = ${freq} Hz` : ' y FreqRequest (%R4) en 1..327 Hz');
  rungs.push(bandRungSerie(
    `Configuración lista: ${cfgTxt} (CfgValid) y reset terminado → CfgReady (%R7 = 1)`,
    [{ t: 'no', a: 'CfgValid' }, { t: 'no', a: '%R506.DN' }],
    bandOut('coil', 'CfgReady', ctx), ctx));

  // 3) Consigna de frecuencia al VFD (§8 estado 4 y §9).
  rungs.push(bandRungSerie(
    freq != null
      ? `Consigna al VFD: FreqRequest (%R4 = ${freq} Hz) × 100 → %R504 = ${freq * 100}`
      : 'Consigna al VFD: FreqRequest (%R4) × 100 → %R504 (frecuencia sin cambio)',
    [{ t: 'no', a: 'CfgReady' }],
    bandOut('block_add', '%R504', ctx, { band: { title: 'MUL', sub: freq != null ? `${freq}×100` : '×100' } }), ctx));

  // 4) Arranque por flanco de I1 (§5).
  rungs.push(bandRungSerie(
    'Arranque: flanco de I1 con la configuración lista y sin paro I3 → BandEnable (espejo %R1)',
    [{ t: 'pe', a: 'I1' }, { t: 'no', a: 'CfgReady' }, { t: 'no', a: 'I3' }],
    bandOut('coil_s', 'BandEnable', ctx), ctx));

  // 5) Paro: I3 (§4), nueva configuración (§6) o reset (§7).
  rungs.push(bandRungSerie(
    'Paro: I3 presionado (NC abierto), nueva configuración o reset → quita BandEnable',
    [{ t: 'nc', a: 'I3' }],
    bandOut('coil_r', 'BandEnable', ctx), ctx,
    [{ col: 0, c: { t: 'pe', a: '%R5' } }, { col: 0, c: { t: 'pe', a: '%R6' } }]));

  // 6) Sensores S1 / S2 (§11–§14). Detección = flanco de bajada de la entrada NC.
  const ACC_TXT = {
    0: 'solo cuenta, no detiene la banda',
    1: 'detiene mientras detecta',
    2: 'detiene un tiempo',
    3: 'detiene mientras detecta + torreta',
    4: 'detiene un tiempo + torreta',
  };
  for (const s of S) {
    if (!s.on) continue;
    const Sn = `S${s.n}`;
    rungs.push(bandRungSerie(
      `${Sn} (${s.io}, NC) detecta pieza → cuenta (${s.cnt})`
        + (s.count > 0 ? ` · objetivo ${s.count} piezas` : ' · actúa en cada detección')
        + ` · ${ACC_TXT[s.acc]}`,
      [{ t: 'ne', a: s.io }, { t: 'no', a: 'BandEnable' }, { t: 'no', a: 'I3' }],
      bandOut('block_ctu', s.cnt, ctx, { preset: s.count, band: { title: 'CTU' } }), ctx));
    if (s.acc === 0) continue;

    const torTxt = s.acc >= 3 ? ` y enciende su máscara de torreta: ${TORRETA_NOMBRE[s.mask] || s.mask} (${s.maskReg})` : '';
    rungs.push(bandRungSerie(
      (s.count > 0 ? `${Sn} llega a ${s.count} piezas (espejo ${s.doneReg})` : `${Sn} detecta`)
        + ` → detiene la banda (${s.latch})${torTxt}`,
      [s.count > 0 ? { t: 'pe', a: s.done } : { t: 'ne', a: s.io }, { t: 'no', a: 'BandEnable' }],
      bandOut('coil_s', s.latch, ctx), ctx));

    if (s.acc === 1 || s.acc === 3) {
      rungs.push(bandRungSerie(
        `${Sn} deja de detectar (la pieza sale) → la banda continúa`,
        [{ t: 'no', a: s.io }],
        bandOut('coil_r', s.latch, ctx), ctx));
    } else {
      const w = s.wait || 0;
      rungs.push(bandRungSerie(
        `Paro temporizado de ${Sn}: ${w} s (${s.tmr} = segundos transcurridos)`,
        [{ t: 'no', a: s.latch }],
        bandOut('block_ton', s.tmr, ctx, { preset_ms: w * 1000, band: { title: 'TON' } }), ctx));
      rungs.push(bandRungSerie(
        `Pasan ${w} s → la banda continúa`,
        [{ t: 'no', a: `${s.tmr}.DN` }],
        bandOut('coil_r', s.latch, ctx), ctx));
    }
  }

  // 7) Marcha y comando al VFD (§16) · velocidad real (§10).
  const paroSensor = S.filter(s => s.on && s.acc > 0).map(s => ({ t: 'nc', a: s.latch }));
  rungs.push(bandRungSerie(
    `Banda en marcha: habilitada, configuración lista, sin paro I3${paroSensor.length ? ' ni paro por sensor' : ''} → BandRunning (BandStatus %R3 = ${dirN})`,
    [{ t: 'no', a: 'BandEnable' }, { t: 'no', a: 'CfgReady' }, { t: 'no', a: 'I3' }, ...paroSensor],
    bandOut('coil', 'BandRunning', ctx), ctx));
  rungs.push(bandRungSerie(
    `VFD Dirección ${dirN}${freq != null ? ` a ${freq} Hz` : ''}: MOV ${cmd} → %R500 (VFD_Control)`,
    [{ t: 'no', a: 'BandRunning' }],
    bandOut('block_mov', '%R500', ctx, { band: { title: 'MOV', sub: `IN ${cmd}` } }), ctx));
  rungs.push(bandRungSerie(
    'Sin marcha: MOV 1 → %R500 (VFD en paro)',
    [{ t: 'nc', a: 'BandRunning' }],
    bandOut('block_mov', '%R500', ctx, { band: { title: 'MOV', sub: 'IN 1' } }), ctx));
  rungs.push(bandRungSerie(
    'Velocidad real: VFD_SpeedRaw (%R502) ÷ 100 → %R8 (VFD_SpeedDisp)',
    [],
    bandOut('block_add', '%R8', ctx, { band: { title: 'DIV', sub: '÷100' } }), ctx));

  // 8) Torreta (§15). Prioridad S2 → S1 → RUN → IDLE: una fuente de mayor
  //    prioridad activa bloquea a las de menor aunque no encienda este color.
  const eventos = S.filter(s => s.on && s.acc >= 3).sort((a, b) => b.n - a.n);
  const LAMPARAS = [
    ['Q3', 'green', 1, 'verde'],
    ['Q4', 'yellow', 2, 'amarilla'],
    ['Q5', 'red', 4, 'roja'],
  ];
  for (const [q, lampColor, bit, nombre] of LAMPARAS) {
    const alts = [], fuentes = [], previas = [];
    for (const s of eventos) {
      if (s.mask & bit) {
        alts.push([...previas, s.latch].join(' * '));
        fuentes.push(`evento S${s.n} (${s.maskReg})`);
      }
      previas.push('!' + s.latch);
    }
    if (torRun & bit)  { alts.push([...previas, 'BandRunning'].join(' * '));  fuentes.push('banda corriendo (%R40)'); }
    if (torIdle & bit) { alts.push([...previas, '!BandRunning'].join(' * ')); fuentes.push('banda detenida (%R41)'); }
    if (!alts.length) continue;
    rungs.push(bandRung(`I3 * (${alts.join(' + ')})`,
      bandOut('coil', q, ctx, { lamp_color: lampColor }),
      `Torreta ${nombre} (${q}): ${fuentes.join(' · ')} — sin paro I3 · prioridad S2 → S1 → RUN → IDLE`, ctx));
  }

  // 9) Plumas (§17): el comando llega por %R60/%R61 y el ST activa la salida.
  const PLUMAS = [[1, '%R60', 'Q8', 'Q6'], [2, '%R61', 'Q9', 'Q7']];
  const PCMD = { 0: 'stop', 1: 'subir', 2: 'bajar' };
  for (const [n, reg, qSube, qBaja] of PLUMAS) {
    const c = bandPluma(band[`pluma${n}`]);
    if (c == null) continue;
    const conf = ` · comando configurado: ${PCMD[c]}`;
    rungs.push(bandRungSerie(
      `Pluma ${n} sube: Pluma${n}Cmd (${reg}) = 1 y sin paro I3 → ${qSube}${n === 2 ? ' (provisional)' : ''}${c === 1 ? conf : ''}`,
      [{ t: 'cmp', a: reg, v: 1 }, { t: 'no', a: 'I3' }],
      bandOut('coil', qSube, ctx), ctx));
    rungs.push(bandRungSerie(
      `Pluma ${n} baja: Pluma${n}Cmd (${reg}) = 2 y sin paro I3 → ${qBaja}`
        + (c === 2 ? conf : c === 0 ? `${conf} (${qSube} y ${qBaja} apagadas)` : ''),
      [{ t: 'cmp', a: reg, v: 2 }, { t: 'no', a: 'I3' }],
      bandOut('coil', qBaja, ctx), ctx));
  }

  // Lámparas de la torreta que la instrucción nombra explícitamente. Es solo
  // presentación para el panel visual; los rungs de arriba no dependen de esto.
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
  // Las señales de la banda llegan ya etiquetadas en `symbols` (bandSymbols).
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
  if (bandOn) bandSymbols(symbols);

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
      // Sin IP inventada: si el perfil no trae una real, se deja vacia y el
      // editor usa la que el usuario ya eligio (recordada en el navegador).
      plc_target: (profile && profile.plc && profile.plc.modbus)
        ? { ip: profile.plc.modbus.ip || '', port: profile.plc.modbus.port || 502, unit_id: profile.plc.modbus.unit_id || 1 }
        : { ip: '', port: 502, unit_id: 1 },
      scan_time_ms: 100,
      _warnings: warnings,
    },
    symbol_table,
    rungs,
    execution_state: { mode: 'run', rung_states: {}, forced_outputs: {} },
  };
  return { program, warnings };
}
