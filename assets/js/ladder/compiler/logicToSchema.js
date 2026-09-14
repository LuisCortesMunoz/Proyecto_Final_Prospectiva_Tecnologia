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
// Representación Ladder CONCEPTUAL del programa maestro ST de la banda
// (ladder_maestro_banda.csp). No es una traducción literal del ST ni toca el
// Cscape: para la configuración pedida dibuja las condiciones que el ST
// evalúa y lo que activa, con los bloques de Cscape (MOV, MUL, TON, CTU, CMP).
// Las prioridades (paro > evento S2 > evento S1 > manual) las decide el PLC.
//
//   Entradas: I1 arranque (NA) · I2 paro auxiliar (NC) · I3 paro duro (NC)
//             S1 = I4 · S2 = I5 (activos en bajo)
//   Paros:    %R9 StopMode (0 I3 · 1 I2+I3 · 2 SW+I3 · 3 I2+SW+I3) · %R10 SoftStopCmd
//             I2 y software detienen la banda; I3 además cancela eventos y plumas
//   Eventos:  S1/S2 no dependen de BandEnable. %R16/%R17 BandMode: 0 el evento
//             puede pausar la banda · 1 solo evento. %R18/%R19 evento activo
//   Auto:     %R11 preset · %R12 acumulado · %R13 terminado · %R15 modo
//   Torreta:  Q3 verde · Q4 amarilla · Q5 roja (máscaras %R40/%R41/%R24/%R34,
//             %R50 = mientras I1 esté presionado)
//   Plumas:   P1 Q8 sube / Q9 baja · P2 Q6 sube / Q7 baja (mapeo físico confirmado)
//             manual %R60/%R61 · por evento %R28/%R29 (S1) y %R38/%R39 (S2)
//   VFD:      %R500 = 18 dir 1 · 34 dir 2 · 1 paro · %R504 = FreqRequest × 100
//   Triggers: %R6 ResetCmd y %R5 NewCfgFlag en cada configuración (cambio de valor)
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
// Pluma por evento de sensor: 0 nada · 1 subir · 2 bajar · 3 forzar stop.
const BAND_SENSOR_PLUMA = { nada: 0, ninguno: 0, subir: 1, arriba: 1, up: 1, bajar: 2, abajo: 2, down: 2,
  stop: 3, parar: 3, detener: 3, forzar_stop: 3 };
function bandSensorPluma(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if ([0, 1, 2, 3].includes(n)) return n;
  return BAND_SENSOR_PLUMA[String(v).toLowerCase()] ?? 0;
}
// Mapeo físico confirmado del ST (§17).
const PLUMA_Q = { 1: { sube: 'Q8', baja: 'Q9', reg: '%R60' }, 2: { sube: 'Q6', baja: 'Q7', reg: '%R61' } };
const STOP_MODE_TXT = ['I3', 'I2 + I3', 'software + I3', 'I2 + software + I3'];

// Símbolos de la banda. Solo se inyectan cuando el programa trae el bloque
// "band": el etiquetado de los programas del maletín no cambia.
function bandSymbols(symbols) {
  const put = (addr, symbol, comment, type = 'BOOL', fn = 'internal') => {
    symbols[addr] = { addr, symbol, type, comment, modbus: { fn, address: null } };
  };
  put('I1', 'BTN_START', 'I1 (NA): arranque de la banda (solo con movimiento configurado)', 'BOOL', 'read_coil');
  put('I2', 'BTN_AUX', 'I2 (NC): paro de banda si StopMode = 1 o 3', 'BOOL', 'read_coil');
  put('I3', 'BTN_STOP', 'I3 (NC): paro duro: banda, eventos, torreta y plumas', 'BOOL', 'read_coil');
  put('I4', 'S1', 'Sensor S1 de la banda (I4)', 'BOOL', 'read_coil');
  put('I5', 'S2', 'Sensor S2 de la banda (I5)', 'BOOL', 'read_coil');
  put('Q3', 'LAMP_VERDE', 'Torreta verde (Q3)', 'BOOL', 'write_coil');
  put('Q4', 'LAMP_AMARILLA', 'Torreta amarilla (Q4)', 'BOOL', 'write_coil');
  put('Q5', 'LAMP_ROJA', 'Torreta roja (Q5)', 'BOOL', 'write_coil');
  put('Q8', 'P1_SUBE', 'Pluma 1 sube (Q8)', 'BOOL', 'write_coil');
  put('Q9', 'P1_BAJA', 'Pluma 1 baja (Q9)', 'BOOL', 'write_coil');
  put('Q6', 'P2_SUBE', 'Pluma 2 sube (Q6)', 'BOOL', 'write_coil');
  put('Q7', 'P2_BAJA', 'Pluma 2 baja (Q7)', 'BOOL', 'write_coil');
  put('GenStop', 'GenStop', 'Paro de banda (§4): I3 siempre · I2 y/o software según StopMode (%R9)');
  put('BandEnable', 'BandEnable', 'Banda habilitada por I1 (espejo %R1 BandEnable_Reg)');
  put('CfgValid', 'CfgValid', 'Configuración válida (§3): con movimiento DirCmd 1/2 y FreqRequest 1..327; sin movimiento 0/0');
  put('CfgReady', 'CfgReady', 'Configuración lista (espejo %R7 CfgReady_Reg)');
  put('BandRunning', 'BandRunning', 'Banda en marcha (espejo %R3 BandStatus)');
  put('%R3', 'BandStatus', 'Estado de la banda: 0 detenida · 1 dir 1 · 2 dir 2', 'INT', 'holding_reg');
  put('%R10', 'SoftStopCmd', 'Paro software: 1 enclavado · 0 liberado', 'INT', 'holding_reg');
  put('%R12', 'AutoStopAccum', 'Segundos contados por el paro automático', 'INT', 'holding_reg');
  put('%R12.DN', 'AutoStopDone', 'Tiempo del paro automático cumplido (espejo %R13)');
  put('S1_EventActive', 'S1_EventActive', 'Evento de S1 en curso (espejo %R18)');
  put('S2_EventActive', 'S2_EventActive', 'Evento de S2 en curso (espejo %R19)');
  put('S1_StopLatch', 'S1_StopLatch', 'El evento de S1 pausa la banda (BandMode 0; BandEnable sigue activo)');
  put('S2_StopLatch', 'S2_StopLatch', 'El evento de S2 pausa la banda (BandMode 0; BandEnable sigue activo)');
  put('S1_CountDone', 'S1_CountDone', 'Objetivo de conteo de S1 alcanzado (espejo %R27)');
  put('S2_CountDone', 'S2_CountDone', 'Objetivo de conteo de S2 alcanzado (espejo %R37)');
  put('%R5', 'NewCfgFlag', 'Nueva configuración desde el backend (cambio de valor)', 'INT', 'holding_reg');
  put('%R6', 'ResetCmd', 'Reset desde el backend (cambio de valor)', 'INT', 'holding_reg');
  put('%R504', 'VFD_FreqCalc', 'Consigna al VFD = FreqRequest × 100', 'INT', 'holding_reg');
  put('%R500', 'VFD_Control', 'Comando al VFD: 18 dir 1 · 34 dir 2 · 1 paro', 'INT', 'holding_reg');
  put('%R8', 'VFD_SpeedDisp', 'Velocidad real en Hz = VFD_SpeedRaw (%R502) ÷ 100', 'INT', 'holding_reg');
  put('%R25', 'S1_CountAccum', 'Piezas detectadas por S1', 'INT', 'holding_reg');
  put('%R26', 'S1_TimerAccum', 'Segundos del evento temporizado de S1', 'INT', 'holding_reg');
  put('%R26.DN', 'S1_TimerDone', 'Tiempo del evento de S1 cumplido');
  put('%R35', 'S2_CountAccum', 'Piezas detectadas por S2', 'INT', 'holding_reg');
  put('%R36', 'S2_TimerAccum', 'Segundos del evento temporizado de S2', 'INT', 'holding_reg');
  put('%R36.DN', 'S2_TimerDone', 'Tiempo del evento de S2 cumplido');
  put('%R60', 'Pluma1Cmd', 'Comando manual pluma 1: 0 stop · 1 subir · 2 bajar', 'INT', 'holding_reg');
  put('%R61', 'Pluma2Cmd', 'Comando manual pluma 2: 0 stop · 1 subir · 2 bajar', 'INT', 'holding_reg');
  put('EffPluma1Cmd', 'EffPluma1Cmd', 'Comando efectivo de la pluma 1 (I3 > S2 > S1 > manual)', 'INT');
  put('EffPluma2Cmd', 'EffPluma2Cmd', 'Comando efectivo de la pluma 2 (I3 > S2 > S1 > manual)', 'INT');
}
// null/''/undefined = "no se pidió". Number(null) vale 0, y eso hacía que
// cada campo en null del JSON de la IA dibujara sensores de 0 s y "0 Hz".
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rung con alternativas en paralelo (OR). Cada alternativa es una serie de
// contactos o comparadores; la más larga va en la fila principal.
function bandRungOr(comment, alts, mkTerminal, ctx) {
  const orden = [...alts].sort((a, b) => b.length - a.length);
  const w = Math.max(orden[0].length, 1);
  const row0 = orden[0].map((c, i) => bandEl(c, i, ctx));
  row0.push(mkTerminal(w));
  const network = [{ row: 0, elements: row0 }];
  orden.slice(1).forEach((a, k) => network.push({
    row: k + 1, span: { from: 0, to: w - 1 }, elements: a.map((c, i) => bandEl(c, i, ctx)),
  }));
  return { id: ctx.nextId(), enabled: true, comment, network };
}

// Contactos de la banda: no/nc/flanco positivo (pe)/flanco negativo (ne) y
// comparador CMP (=) para los registros de comando.
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

function compileBand(band, ctx) {
  const rungs = [];
  const dir      = bandDir(band.direction);
  const dirN     = dir === 'izquierda' ? 2 : 1;
  const cmd      = dirN === 2 ? 34 : 18;
  const freq     = num(band.freq_hz);
  const stopMode = [1, 2, 3].includes(Number(band.stop_mode)) ? Number(band.stop_mode) : 0;
  const autoS    = num(band.auto_stop_s) || 0;
  let autoMode   = Number(band.auto_stop_mode);
  if (![1, 2].includes(autoMode)) autoMode = band.auto_stop_mode == null && autoS > 0 ? 1 : 0;
  if (!(autoS > 0)) autoMode = 0;
  const boton    = String(band.start_button || 'I1').toUpperCase();

  // Cada sensor tal como lo carga el backend (plc_banda._accion_de_sensor).
  // Un sensor es un EVENTO: no depende de BandEnable. Solo con BandMode 0 y
  // acción 1..4 el evento pausa la banda.
  const sensor = (n) => {
    const wait = num(band[`wait_s${n}_s`]);
    const plumas = [bandSensorPluma(band[`s${n}_pluma1`]), bandSensorPluma(band[`s${n}_pluma2`])];
    const mask = num(band[`torreta_s${n}`]) || 0;
    let acc = bandAccion(band[`s${n}_action`]);
    if (acc == null && wait != null) acc = 2;
    if (acc == null && (plumas.some(Boolean) || mask)) acc = 0;
    if (acc == null && band[`count_s${n}`] != null) acc = 0;
    const modo = Number(band[`s${n}_band_mode`]) === 1 ? 1 : 0;
    return {
      n, acc, on: acc != null, wait, plumas, mask, modo,
      temporizado: acc === 2 || acc === 4,
      pausa: acc != null && acc > 0 && modo === 0,
      count: num(band[`count_s${n}`]) || 0,
      io: n === 1 ? 'I4' : 'I5',
      cnt: n === 1 ? '%R25' : '%R35',
      tmr: n === 1 ? '%R26' : '%R36',
      evento: `S${n}_EventActive`,
      latch: `S${n}_StopLatch`,
      done: `S${n}_CountDone`,
    };
  };
  const S = [sensor(1), sensor(2)];
  const torRun  = num(band.torreta_run) || 0;
  const torIdle = num(band.torreta_idle) || 0;
  const torI1   = num(band.torreta_i1) || 0;

  // Representación COMPACTA: solo lo que pide la configuración. Lo que el ST
  // hace siempre (reset con ResetCmd/NewCfgFlag, CfgValid, velocidad real
  // %R8, MOV 1 a %R500 sin marcha) va resumido en los comentarios.
  // Sin movimiento (DirCmd = FreqRequest = 0) no hay paros de banda, arranque,
  // frecuencia ni MOV: los eventos, la torreta y las plumas funcionan igual.
  const mover = band.enable !== false;

  if (mover) {
    // 1) Paro de banda (§4): I3 siempre; I2 y el paro software según StopMode.
    const alts = [[{ t: 'nc', a: 'I3' }]];
    const fuentes = ['I3 (siempre)'];
    if (stopMode === 1 || stopMode === 3) { alts.push([{ t: 'nc', a: 'I2' }]); fuentes.push('I2'); }
    if (stopMode === 2 || stopMode === 3) { alts.push([{ t: 'cmp', a: '%R10', v: 1 }]); fuentes.push('paro software %R10'); }
    rungs.push(bandRungOr(
      `Paro de banda · StopMode ${stopMode} (${STOP_MODE_TXT[stopMode]}): ${fuentes.join(' · ')} → borra BandEnable y detiene el VFD · I3 además cancela eventos y plumas`,
      alts, bandOut('coil', 'GenStop', ctx), ctx));

    // 2) Arranque (§5): flanco del botón de inicio con la configuración lista.
    rungs.push(bandRungSerie(
      `Arranque: flanco de ${boton} con la configuración lista (CfgReady) y sin paro · se sostiene hasta un paro o una nueva configuración`,
      [{ t: 'pe', a: boton }, { t: 'nc', a: 'GenStop' }, { t: 'no', a: 'CfgReady' }],
      bandOut('coil', 'BandEnable', ctx), ctx,
      [{ col: 0, c: { t: 'no', a: 'BandEnable' } }]));
  }

  // 3) Frecuencia (§8/§9): solo si la instrucción la pide.
  if (mover && freq != null) {
    rungs.push(bandRungSerie(
      `Frecuencia: ${freq} Hz × 100 → %R504`,
      [{ t: 'no', a: 'CfgReady' }],
      bandOut('block_add', '%R504', ctx, { band: { title: 'MUL', sub: `${freq}×100` } }), ctx));
  }

  // 4) Eventos de sensores (§11–§14). Detección = flanco del sensor (o conteo
  //    alcanzado). El evento dura mientras detecta (acciones 0/1/3) o N s
  //    (acciones 2/4); I3 lo cancela.
  for (const s of S) {
    if (!s.on) continue;
    const Sn = `S${s.n}`;
    const soloCuenta = s.acc === 0 && !s.mask && !s.plumas.some(Boolean) && !s.count;
    if (s.count > 0 || soloCuenta) {
      rungs.push(bandRungSerie(
        s.count > 0 ? `${Sn} (${s.io}) cuenta detecciones: objetivo ${s.count}` : `${Sn} (${s.io}) cuenta detecciones`,
        [{ t: 'ne', a: s.io }, { t: 'nc', a: 'I3' }],
        bandOut('block_ctu', s.cnt, ctx, { preset: s.count, band: { title: 'CTU' } }), ctx));
    }
    if (soloCuenta) continue;

    const disparo = s.count > 0 ? { t: 'pe', a: s.done } : { t: 'ne', a: s.io };
    const cuando  = s.count > 0 ? `al llegar a ${s.count} detecciones` : 'detecta';
    const fin     = s.temporizado ? { t: 'nc', a: `${s.tmr}.DN` } : { t: 'nc', a: s.io };
    rungs.push(bandRungSerie(
      `${Sn} ${cuando} → evento ${s.temporizado ? `de ${s.wait || 0} s` : 'mientras detecta'}`
        + `${s.pausa ? ' · pausa la banda y continúa sola' : ' · no afecta la banda'}`,
      [disparo, { t: 'nc', a: 'I3' }, fin],
      bandOut('coil', s.evento, ctx), ctx,
      [{ col: 0, c: { t: 'no', a: s.evento } }]));
    if (s.temporizado) {
      rungs.push(bandRungSerie(
        `Duración del evento de ${Sn}: ${s.wait || 0} s`,
        [{ t: 'no', a: s.evento }],
        bandOut('block_ton', s.tmr, ctx, { preset_ms: (s.wait || 0) * 1000, band: { title: 'TON' } }), ctx));
    }
    if (s.pausa && mover) {
      rungs.push(bandRungSerie(
        `${Sn} en evento → pausa la banda (BandEnable sigue activo)`,
        [{ t: 'no', a: s.evento }],
        bandOut('coil', s.latch, ctx), ctx));
    }
    // Plumas del evento (§17): mientras dura el evento, con prioridad S2 > S1 > manual.
    s.plumas.forEach((c, k) => {
      if (!c) return;
      const p = PLUMA_Q[k + 1];
      if (c === 3) {
        rungs.push(bandRungSerie(
          `${Sn} en evento → fuerza STOP de la pluma ${k + 1} (${p.sube}/${p.baja} apagadas)`,
          [{ t: 'no', a: s.evento }],
          bandOut('block_mov', `EffPluma${k + 1}Cmd`, ctx, { band: { title: 'MOV', sub: 'IN 0' } }), ctx));
      } else {
        const q = c === 1 ? p.sube : p.baja;
        rungs.push(bandRungSerie(
          `${Sn} en evento → pluma ${k + 1} ${c === 1 ? 'sube' : 'baja'} (${q}) · al terminar vuelve al comando manual`,
          [{ t: 'no', a: s.evento }, { t: 'nc', a: 'I3' }],
          bandOut('coil', q, ctx), ctx));
      }
    });
  }

  // 5) Paro automático por tiempo (§14b): solo con movimiento.
  if (mover && autoMode > 0) {
    const pausas = autoMode === 1 ? S.filter(s => s.pausa).map(s => ({ t: 'nc', a: s.latch })) : [];
    rungs.push(bandRungSerie(
      `Paro automático: ${autoS} s ${autoMode === 1
        ? 'de movimiento real (una pausa por sensor detiene el conteo)'
        : 'desde START, aunque un sensor pause la banda'} → %R12`,
      [{ t: 'no', a: 'BandEnable' }, { t: 'nc', a: 'GenStop' }, ...pausas],
      bandOut('block_ton', '%R12', ctx, { preset_ms: autoS * 1000, band: { title: 'TON' } }), ctx));
    rungs.push(bandRungSerie(
      `Tiempo cumplido: detiene la banda (AutoStopDone %R13 = 1 · causa 4) · ${boton} repite la secuencia`,
      [{ t: 'no', a: '%R12.DN' }],
      bandOut('coil_r', 'BandEnable', ctx), ctx));
  }

  // 6) Marcha → VFD (§16): MOV 18/34 a %R500. Sin marcha el ST escribe 1.
  if (mover) {
    const paroSensor = S.filter(s => s.pausa).map(s => ({ t: 'nc', a: s.latch }));
    rungs.push(bandRungSerie(
      `Banda Dirección ${dirN} (${dir}): MOV ${cmd} → %R500${paroSensor.length ? ' · una pausa por sensor la detiene sin quitar BandEnable' : ''} · sin marcha el ST escribe 1`,
      [{ t: 'no', a: 'BandEnable' }, { t: 'nc', a: 'GenStop' }, ...paroSensor],
      bandOut('block_mov', '%R500', ctx, { band: { title: 'MOV', sub: `IN ${cmd}` } }), ctx));
  }

  // 7) Torreta (§15). Prioridad evento S2 → evento S1 → RUN → IDLE: una fuente
  //    de mayor prioridad activa bloquea a las de menor. La máscara de un
  //    sensor funciona con cualquier acción mientras dura su evento. Solo I3
  //    apaga la torreta.
  const eventos = S.filter(s => s.on && s.mask).sort((a, b) => b.n - a.n);
  const LAMPARAS = [
    ['Q3', 'green', 1, 'verde'],
    ['Q4', 'yellow', 2, 'amarilla'],
    ['Q5', 'red', 4, 'roja'],
  ];
  for (const [q, lampColor, bit, nombre] of LAMPARAS) {
    const alts = [], fuentes = [], previas = [];
    for (const s of eventos) {
      if (s.mask & bit) {
        alts.push([...previas, { t: 'no', a: s.evento }]);
        fuentes.push(`evento de S${s.n}`);
      }
      previas.push({ t: 'nc', a: s.evento });
    }
    if (torRun & bit)  { alts.push([...previas, { t: 'no', a: 'BandRunning' }]);  fuentes.push('banda corriendo'); }
    if (torIdle & bit) { alts.push([...previas, { t: 'cmp', a: '%R3', v: 0 }]); fuentes.push('banda detenida (BandStatus = 0)'); }
    // §15b: sigue a I1 (NA) mientras esté presionado, sin enclavar; I3 la apaga.
    if (torI1 & bit) { alts.push([{ t: 'no', a: 'I1' }, { t: 'nc', a: 'I3' }]); fuentes.push('mientras I1 esté presionado'); }
    if (!alts.length) continue;
    rungs.push(bandRungOr(`Torreta ${nombre} (${q}): ${fuentes.join(' · ')}`,
      alts, bandOut('coil', q, ctx, { lamp_color: lampColor }), ctx));
  }

  // 8) Plumas manuales (§17): solo el comando pedido (stop = salidas apagadas).
  for (const n of [1, 2]) {
    const c = bandPluma(band[`pluma${n}`]);
    if (c == null || c === 0) continue;
    const p = PLUMA_Q[n];
    const sube = c === 1;
    rungs.push(bandRungSerie(
      `Pluma ${n} manual ${sube ? 'sube' : 'baja'} → ${sube ? p.sube : p.baja} · prioridad: I3 > S2 > S1 > manual`,
      [{ t: 'cmp', a: p.reg, v: c }],
      bandOut('coil', sube ? p.sube : p.baja, ctx), ctx));
  }

  // Sin movimiento ni acciones (p. ej. "detén la banda"): el estado resultante.
  if (!rungs.length) {
    rungs.push(bandRungSerie(
      'Banda detenida: sin marcha el ST mantiene MOV 1 → %R500 (VFD en paro)',
      [],
      bandOut('block_mov', '%R500', ctx, { band: { title: 'MOV', sub: 'IN 1' } }), ctx));
  }

  const temporizada = (s) => s.on && s.temporizado ? s.wait : null;

  // Datos para el panel visual (solo presentación; no altera el engine_config).
  const view = {
    enable: true,
    mover,
    direction: dir,
    vfd_cmd: cmd,
    freq_hz: freq,
    start_button: boton,
    stop_mode: stopMode,
    auto_stop_mode: autoMode,
    auto_stop_s: autoMode ? autoS : null,
    wait_s1_s: temporizada(S[0]),
    wait_s2_s: temporizada(S[1]),
    // Qué componentes participan en ESTA instrucción (el panel dibuja solo estos)
    uses: {
      banda: true,
      vfd: mover,
      freq: freq != null,
      s1: S[0].on,
      s2: S[1].on,
      torreta: true,
      pluma1: band.pluma1 != null || S.some(s => s.on && s.plumas[0]),
      pluma2: band.pluma2 != null || S.some(s => s.on && s.plumas[1]),
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
  // Un bloque "band" siempre se dibuja: enable === false solo significa que
  // la instrucción no pide mover la banda (torreta, sensores o plumas).
  const bandOn  = !!bandCfg && typeof bandCfg === 'object';
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
    const { rungs: bandRungs, view } = compileBand(bandCfg, ctx);
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
