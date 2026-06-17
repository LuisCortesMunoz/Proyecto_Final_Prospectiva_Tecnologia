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

const OP = new Set(['(', ')', '*', '+', '&', '|', '!', '~', '/']);
const stripPct = (a) => String(a).replace(/^%/, '');

function tokensOf(expr) {
  const out = [];
  const re = /([A-Za-z_%][\w.%]*|[()*+&|!~/])/g;
  let m;
  while ((m = re.exec(String(expr || ''))) !== null) out.push(m[1]);
  return out;
}

function parensBalanced(expr) {
  let depth = 0;
  for (const ch of String(expr || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

/**
 * Valida el JSON lógico simple contra el contrato + el perfil del dispositivo.
 * Devuelve { ok, errors, warnings }. `errors` bloquea el render.
 */
export function validateLogicJson(logic, profile) {
  const errors = [];
  const warnings = Array.isArray(logic?.warnings) ? [...logic.warnings] : [];

  if (!logic || typeof logic !== 'object') {
    return { ok: false, errors: ['El JSON lógico está vacío o no es un objeto.'], warnings };
  }
  if (!Array.isArray(logic.outputs) || logic.outputs.length === 0) {
    errors.push('Falta "outputs" o está vacío: debe haber al menos una salida.');
  }

  // Conjuntos de nombres válidos (nombres lógicos del perfil + estados + timers)
  const profOutNames = new Set();   // bobinas válidas (salidas del perfil)
  const known = new Set();          // todo lo referenciable en una expr
  if (profile) {
    for (const io of (profile.inputs || []))  { known.add(stripPct(io.addr)); if (io.id) known.add(io.id); }
    for (const io of (profile.outputs || [])) { const n = stripPct(io.addr); known.add(n); profOutNames.add(n); if (io.id) { known.add(io.id); profOutNames.add(io.id); } }
  }
  for (const st of (logic.states || [])) if (st.id) known.add(st.id);
  for (const tm of (logic.timers || [])) if (tm.id) { known.add(tm.id); known.add(tm.id + '.DN'); }
  for (const out of (logic.outputs || [])) if (out.coil) known.add(out.coil); // una salida puede leer otra bobina

  const timerIds = new Set((logic.timers || []).map(t => t.id));

  const gStop = logic.global_rules?.global_stop;
  if (gStop && profile && !known.has(gStop)) errors.push(`global_stop "${gStop}" no existe en el perfil del dispositivo.`);

  for (const [i, out] of (logic.outputs || []).entries()) {
    const tag = `salida ${i + 1} (${out.coil || '?'})`;
    if (!out.coil) errors.push(`${tag}: falta "coil".`);
    else if (profile && !profOutNames.has(out.coil)) errors.push(`${tag}: la bobina "${out.coil}" no es una salida del perfil.`);
    if (out.expr == null || out.expr === '') { errors.push(`${tag}: falta "expr".`); continue; }
    if (!parensBalanced(out.expr)) errors.push(`${tag}: paréntesis sin balancear en "${out.expr}".`);

    for (const tk of tokensOf(out.expr)) {
      if (OP.has(tk)) continue;
      if (/\.DN$/.test(tk)) {
        const base = tk.replace(/\.DN$/, '');
        if (!timerIds.has(base)) errors.push(`${tag}: usa "${tk}" pero no existe el timer "${base}" en "timers".`);
        continue;
      }
      if (known.has(tk)) continue;
      if (/^M\d/.test(tk)) { errors.push(`${tag}: usa la memoria "${tk}" pero no está declarada en "states".`); continue; }
      if (profile) errors.push(`${tag}: variable "${tk}" no existe (ni entrada/salida del perfil, ni estado, ni timer).`);
    }
  }

  for (const tm of (logic.timers || [])) {
    if (!tm.id) errors.push('Un timer no tiene "id".');
    if (tm.enable && profile && !known.has(tm.enable)) errors.push(`Timer "${tm.id}": enable "${tm.enable}" no existe en el perfil.`);
  }
  for (const st of (logic.states || [])) {
    if (!st.id) errors.push('Un estado no tiene "id".');
    if (st.set && profile && !known.has(st.set)) errors.push(`Estado "${st.id}": set "${st.set}" no existe en el perfil.`);
    if (st.reset && profile && !known.has(st.reset)) errors.push(`Estado "${st.id}": reset "${st.reset}" no existe en el perfil.`);
  }

  return { ok: errors.length === 0, errors, warnings };
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
