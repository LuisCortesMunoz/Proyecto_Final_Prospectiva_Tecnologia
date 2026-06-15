/**
 * validate.js — normalizeAndValidate(): frontera única de robustez.
 *
 * Corre en AMBAS arquitecturas (Motor A y Motor B) antes de aplicar el
 * programa al editor. Normaliza (ids únicos, columnas, symbol_table) y valida
 * (reglas de schema.js). Devuelve { program, ok, warnings, repairs } para que
 * el panel de chat muestre métricas comparables entre motores.
 */
import { validateProgram, compactColumns } from './schema.js';

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
