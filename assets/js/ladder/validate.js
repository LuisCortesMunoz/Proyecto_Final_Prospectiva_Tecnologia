/**
 * validate.js — Validación en dos etapas de la arquitectura única.
 *
 *  1. validateLogicJson(logic, profile): valida el JSON LÓGICO SIMPLE que
 *     devuelve la IA ANTES de compilar (reglas mínimas del contrato, ver
 *     CONTRACT.md). Si falla, NO se renderiza lógica falsa.
 *  2. normalizeAndValidate(program): tras compilar a geometría, normaliza
 *     (ids únicos, columnas, symbol_table) y valida (reglas de schema.js).
 */
import { validateProgram, compactColumns } from './schema.js';

// Vocabulario FIJO del motor del maletín (espejo de la clase XL4 en Python y
// del validador del backend). La IA no puede salirse de aquí.
const ENGINE_INPUTS  = new Set(['NINGUNA', 'I1', 'I2', 'I3', 'I4', 'I7']);
const ENGINE_OUTPUTS = new Set(['Q10', 'Q11', 'Q12', 'VERDE', 'AMARILLA', 'ROJA']);
const ENGINE_MODES   = new Set(['off', 'directo', 'enclavado', 'combinacional']);
const TIMER_TYPES    = new Set(['on_delay', 'pulse']);
const COUNTER_TYPES  = new Set(['up', 'up_held']);
const SEQ_MODES      = new Set(['once', 'loop']);
const SEQ_MAX_STEPS  = 8;
// Banda transportadora: espejo de BAND_DIR y _validar_banda en plc_maestro.py.
const BAND_DIRS      = new Set(['derecha', 'right', 'der', 'cw', 'izquierda', 'left', 'izq', 'ccw']);

const esEntrada = (n) => n == null || ENGINE_INPUTS.has(String(n).toUpperCase());
const canonOut  = (s) => {
  const u = String(s).toUpperCase();
  if (u === 'Q10' || u === 'VERDE') return 'Q10';
  if (u === 'Q11' || u === 'AMARILLA') return 'Q11';
  if (u === 'Q12' || u === 'ROJA') return 'Q12';
  return u;
};

function rangoEntero(v, low, high, tag, campo, errors) {
  const n = Number(v);
  if (!Number.isInteger(n)) { errors.push(`${tag}: ${campo}="${v}" no es entero.`); return; }
  if (n < low || n > high) errors.push(`${tag}: ${campo}=${n} fuera de [${low}, ${high}].`);
}

/**
 * Valida el JSON dual engine-config contra el hardware fijo del maletín.
 * Devuelve { ok, errors, warnings }. `errors` bloquea el render.
 * (El `profile` solo aporta etiquetas; la verdad es el vocabulario del motor.)
 */
export function validateLogicJson(logic, /* profile */ _profile) {
  const errors = [];
  const warnings = Array.isArray(logic?.warnings) ? [...logic.warnings] : [];

  if (!logic || typeof logic !== 'object') {
    return { ok: false, errors: ['El JSON lógico está vacío o no es un objeto.'], warnings };
  }
  const outputs = Array.isArray(logic.outputs) ? logic.outputs : [];
  const seq = logic.sequence;
  const band = logic.band;
  // Una config válida necesita al menos salidas, una secuencia O la banda.
  if (outputs.length === 0 && !seq && !band) {
    return { ok: false, errors: ['Falta "outputs" o está vacío: debe haber al menos una salida (o una "sequence", o un bloque "band").'], warnings };
  }

  const vistos = new Set();
  for (const [i, o] of outputs.entries()) {
    const tag = `salida ${i + 1} (${o?.output ?? '?'})`;
    if (!o || typeof o !== 'object') { errors.push(`${tag}: no es un objeto.`); continue; }

    if (!ENGINE_OUTPUTS.has(String(o.output).toUpperCase())) {
      errors.push(`${tag}: salida inválida. Usa Q10, Q11 o Q12.`);
    } else {
      const c = canonOut(o.output);
      if (vistos.has(c)) errors.push(`${tag}: salida repetida.`);
      vistos.add(c);
    }

    const lg = o.logic || { mode: 'off' };
    const mode = String(lg.mode || 'off').toLowerCase();
    if (!ENGINE_MODES.has(mode)) errors.push(`${tag}: mode "${mode}" no soportado.`);

    if (mode === 'directo') {
      if (!lg.source) errors.push(`${tag}: "directo" requiere "source".`);
      for (const c of ['source', 'enable']) if (!esEntrada(lg[c])) errors.push(`${tag}: ${c}="${lg[c]}" no es entrada válida.`);
    } else if (mode === 'enclavado') {
      if (!lg.start) errors.push(`${tag}: "enclavado" requiere "start".`);
      for (const c of ['start', 'stop', 'enable']) if (!esEntrada(lg[c])) errors.push(`${tag}: ${c}="${lg[c]}" no es entrada válida.`);
    } else if (mode === 'combinacional') {
      if (!lg.a || !lg.b) errors.push(`${tag}: "combinacional" requiere "a" y "b".`);
      for (const c of ['a', 'b', 'stop']) if (!esEntrada(lg[c])) errors.push(`${tag}: ${c}="${lg[c]}" no es entrada válida.`);
      const op = String(lg.op || 'OR').toUpperCase();
      if (op !== 'OR' && op !== 'AND') errors.push(`${tag}: op="${op}" debe ser OR o AND.`);
      if (op === 'AND' && lg.enable) errors.push(`${tag}: en AND no se permite "enable".`);
    }

    if (o.timer) {
      if (!TIMER_TYPES.has(String(o.timer.type).toLowerCase())) errors.push(`${tag}: timer.type debe ser on_delay o pulse.`);
      else rangoEntero(o.timer.preset_s, o.timer.type === 'on_delay' ? 0 : 1, 32767, tag, 'timer.preset_s', errors);
    }
    if (o.counter) {
      if (!COUNTER_TYPES.has(String(o.counter.type).toLowerCase())) errors.push(`${tag}: counter.type debe ser up o up_held.`);
      else {
        rangoEntero(o.counter.preset, o.counter.type === 'up' ? 0 : 1, 32767, tag, 'counter.preset', errors);
        if (!esEntrada(o.counter.reset_input)) errors.push(`${tag}: counter.reset_input="${o.counter.reset_input}" inválido.`);
      }
    }
  }

  if (seq != null) validarSecuencia(seq, errors);
  if (band != null) validarBanda(band, errors);

  // I3/I4 son los sensores S1/S2 de la banda. Mezclarlas con la lógica del
  // maletín mientras la banda está activa deja el estado NA/NC ambiguo
  // (mismo criterio que validar_config en plc_maestro.py).
  if (bandaActiva(band)) {
    if (seq) errors.push('No se puede activar la banda y el secuenciador a la vez (la torreta sobreescribe Q10/Q11/Q12).');
    for (const [i, o] of outputs.entries()) {
      const lg = o?.logic || {};
      const usadas = ['source', 'start', 'stop', 'a', 'b', 'enable']
        .map(c => lg[c]).filter(Boolean).map(v => String(v).toUpperCase());
      if (usadas.includes('I3') || usadas.includes('I4')) {
        errors.push(`salida ${i + 1} (${o?.output ?? '?'}): I3/I4 están reservadas como sensores S1/S2 de la banda.`);
      }
    }
  }

  const gStop = logic.system?.global_stop;
  if (!esEntrada(gStop)) errors.push(`system.global_stop="${gStop}" no es entrada válida.`);

  return { ok: errors.length === 0, errors, warnings };
}

/** ¿El bloque "band" pide arrancar la banda? (espejo de _banda_activa). */
export function bandaActiva(band) {
  return !!band && typeof band === 'object' && (band.enable === undefined || !!band.enable);
}

// Valida el bloque "band" (banda transportadora + VFD). Espejo de
// _validar_banda en plc_maestro.py: mismos campos y mismos rangos.
function validarBanda(band, errors) {
  if (typeof band !== 'object') { errors.push('"band" no es un objeto.'); return; }
  if (band.freq_hz != null) rangoEntero(band.freq_hz, 0, 32767, 'band', 'freq_hz', errors);
  for (const c of ['wait_s1_s', 'wait_s2_s', 'retrigger_s1_s', 'retrigger_s2_s']) {
    if (band[c] != null) rangoEntero(band[c], 0, 32767, 'band', c, errors);
  }
  if (band.direction != null && !BAND_DIRS.has(String(band.direction).toLowerCase())) {
    errors.push(`band.direction="${band.direction}" debe ser "derecha" o "izquierda".`);
  }
}

// Valida el bloque "sequence" (secuenciador de pasos). Espejo del validador
// del backend (_validar_secuencia_cfg / _validar_secuencia).
function validarSecuencia(seq, errors) {
  if (typeof seq !== 'object') { errors.push('"sequence" no es un objeto.'); return; }
  if (!seq.start || !esEntrada(seq.start)) errors.push(`sequence.start="${seq.start}" debe ser una entrada válida (I1..I7).`);
  if (!SEQ_MODES.has(String(seq.mode || 'once').toLowerCase())) errors.push(`sequence.mode="${seq.mode}" debe ser "once" o "loop".`);
  if (seq.reset != null && !esEntrada(seq.reset)) errors.push(`sequence.reset="${seq.reset}" no es una entrada válida.`);
  const steps = seq.steps;
  if (!Array.isArray(steps) || steps.length === 0) { errors.push('sequence.steps debe ser una lista con al menos un paso.'); return; }
  if (steps.length > SEQ_MAX_STEPS) errors.push(`sequence.steps no puede tener más de ${SEQ_MAX_STEPS} pasos.`);
  steps.forEach((st, i) => {
    const tag = `sequence paso ${i + 1}`;
    if (!st || typeof st !== 'object') { errors.push(`${tag}: no es un objeto.`); return; }
    if (!Array.isArray(st.outputs) || st.outputs.length === 0) errors.push(`${tag}: "outputs" debe listar al menos una salida.`);
    else for (const o of st.outputs) if (!ENGINE_OUTPUTS.has(String(o).toUpperCase())) errors.push(`${tag}: salida "${o}" inválida. Usa Q10, Q11 o Q12.`);
    rangoEntero(st.duration_s, 1, 32767, tag, 'duration_s', errors);
  });
}

export function normalizeAndValidate(programIn) {
  const program = JSON.parse(JSON.stringify(programIn || {}));
  const repairs = [];

  if (!program.metadata) {
    program.metadata = { name: 'Programa', plc_target: { ip: '192.168.1.100', port: 502, unit_id: 1 }, scan_time_ms: 100 };
    repairs.push('metadata faltante creada');
  }
  if (!program.symbol_table) { program.symbol_table = {}; repairs.push('symbol_table faltante creada'); }
  if (!Array.isArray(program.rungs)) { program.rungs = []; repairs.push('rungs faltante creado'); }
  if (!program.execution_state) program.execution_state = { mode: 'run', rung_states: {}, forced_outputs: {} };

  const seenIds = new Set();
  for (const rung of program.rungs) {
    if (!Array.isArray(rung.network) || rung.network.length === 0) {
      rung.network = [{ row: 0, elements: [] }];
      repairs.push(`rung ${rung.id}: network vacío reparado`);
    }
    rung.network.forEach((row, i) => { row.row = i; if (!Array.isArray(row.elements)) row.elements = []; });

    for (const row of rung.network) {
      for (const el of row.elements) {
        if (!el.id || seenIds.has(el.id)) { el.id = 'n' + Math.random().toString(36).slice(2, 8); repairs.push('id de elemento duplicado/ausente regenerado'); }
        seenIds.add(el.id);
        if (!el.pos || typeof el.pos.col !== 'number') { el.pos = { col: 0 }; repairs.push('pos.col faltante reparado'); }
        if (el.address && !program.symbol_table[el.address]) {
          program.symbol_table[el.address] = {
            symbol: String(el.address).replace(/[%.]/g, '_'),
            type: 'BOOL',
            modbus: { fn: 'internal', address: null },
            comment: '',
          };
          repairs.push(`dirección "${el.address}" agregada a symbol_table`);
        }
      }
    }
    try { compactColumns(rung); } catch { /* defensivo */ }
  }

  const warnings = validateProgram(program);   // reglas de schema.js
  return { program, ok: warnings.length === 0, warnings, repairs };
}
