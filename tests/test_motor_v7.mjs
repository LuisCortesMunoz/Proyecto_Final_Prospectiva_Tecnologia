// Pruebas del frontend para el motor LAVO v7 (sin navegador).
//   node tests/test_motor_v7.mjs
// Comprueba, para los escenarios del backend (test_lavo_v7.py):
//   validación del JSON (recursos físicos), descripción legible, compilación
//   a Ladder (rungs que representan lo que ejecuta el ST v7) y que el schema
//   resultante pase normalizeAndValidate. También el flujo de confirmación.
import assert from 'node:assert/strict';
import { compileLogicToSchema } from '../assets/js/ladder/compiler/logicToSchema.js';
import { validateLogicJson, normalizeAndValidate } from '../assets/js/ladder/validate.js';
import { describeBand, canonicalBand } from '../assets/js/ladder/equipment.js';
import { confirmarAlternativa } from '../assets/js/ladder/generate.js';

let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok++; };
const banda = (engine, mover = false, freq = 30) => ({
  name: 'prueba', device: 'banda', outputs: [],
  band: { enable: mover, ...(mover ? { direction: 'derecha', freq_hz: freq } : {}), engine: { version: 7, ...engine } },
});
const compilar = (logic) => {
  const lv = validateLogicJson(logic, null);
  assert.ok(lv.ok, 'validación: ' + lv.errors.join(' | '));
  const { program, warnings } = compileLogicToSchema({ ...logic, band: canonicalBand(logic.band) }, null);
  const nv = normalizeAndValidate(program);
  return { program: nv.program, warnings, rungs: nv.program.rungs, desc: describeBand(logic.band) };
};
const rung = (rungs, re) => rungs.find(r => re.test(r.comment));
const tipos = (r) => r.network.flatMap(f => f.elements.map(e => `${e.type}:${e.address}`));

const ESCENARIOS = {
  '1 arranque/paro': banda({ motor: { arranque: 'I1', paro: 'I2' } }, true),
  '1c biestable con I1': banda({
    condiciones: [{ id: 'C1', op: 'AND', entradas: ['I1'], flanco: 'subida' },
      { id: 'C2', op: 'AND', entradas: ['C1', 'NOT M1'] }, { id: 'C3', op: 'AND', entradas: ['C1', 'M1'] }],
    memorias: [{ id: 'M1', set: 'C2', reset: 'C3' }], motor: { arranque: 'M1', modo: 'mientras' } }, true),
  '2 reset de contador': banda({ contadores: [{ id: 'CT1', entrada: 'S1', reset: 'I2', preset: 3 }], salidas: { Q5: 'CT1' } }),
  '3 torreta Q3-Q4-Q5': banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', pasos: [
    { salidas: ['Q3'], segundos: 2 }, { salidas: ['Q4'], segundos: 3 }, { salidas: ['Q5'], segundos: 4 }] }] }),
  '4 torreta cíclica': banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', paro: 'I2', modo: 'infinita', pasos: [
    { salidas: ['verde'], segundos: 1 }, { salidas: ['amarilla'], segundos: 1 }, { salidas: ['roja', 'verde'], segundos: 1 }] }] }),
  '6 banda 5/3 x3': banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', modo: 'repetir', repeticiones: 3, pasos: [
    { motor: ['marcha'], segundos: 5 }, { motor: ['paro'], segundos: 3 }] }], salidas: { Q4: 'SQ1_FIN' } }, true),
  '7 contador sube/baja': banda({ contadores: [{ id: 'CT1', entrada: 'S1', descuenta: 'S2', preset: 2, modo: 'nivel' }], salidas: { Q4: 'CT1' } }),
  '8 timer apaga': banda({ memorias: [{ id: 'M1', set: 'I1', reset: 'T1' }],
    timers: [{ id: 'T1', tipo: 'TON', entrada: 'M1', segundos: 4 }], salidas: { Q3: 'M1' } }),
  '9 AND/OR/XOR': banda({ condiciones: [{ id: 'C1', op: 'AND', entradas: ['I1', 'S1'] },
    { id: 'C2', op: 'OR', entradas: ['I2', 'S2'] }, { id: 'C3', op: 'XOR', entradas: ['I1', 'S2'] },
    { id: 'C4', op: 'NAND', entradas: ['I1', 'S1'] }, { id: 'C5', op: 'NOR', entradas: ['I1', 'S1'] }],
  salidas: { Q4: 'C1', Q5: 'C2', Q3: 'C3', Q8: 'C4', Q6: 'C5' } }),
  '10 ramas': banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', pasos: [
    { salidas: ['Q3'], segundos: 3, alternativa: { senal: 'S1', ir_a: 3 } },
    { salidas: ['Q4'], avanza: 'flanco', senal: 'S2' }, { salidas: ['Q5'], segundos: 1 }] }] }),
  '11 torreta + banda': banda({ secuencias: [
    { id: 'SQ1', inicio: 'I1', paro: 'I2', modo: 'infinita', pasos: [{ motor: ['marcha'], segundos: 4 }, { motor: ['paro'], segundos: 2 }] },
    { id: 'SQ2', inicio: 'I1', paro: 'I2', modo: 'infinita', pasos: [{ salidas: ['Q3'], segundos: 1 }, { salidas: ['Q4'], segundos: 1 }] }],
  salidas: { Q5: 'BANDA_DETENIDA' } }, true),
  '18 timers especiales': banda({ timers: [{ id: 'T1', tipo: 'INTERMITENTE', entrada: 'APP1', segundos: 0.5, segundos_off: 0.3 },
    { id: 'T2', tipo: 'TONR', entrada: 'I1', reset: 'I2', segundos: 2 }], salidas: { Q4: 'T1', Q5: 'T2' } }),
};

for (const [nombre, logic] of Object.entries(ESCENARIOS)) {
  const r = compilar(logic);
  check(r.rungs.length > 0, `${nombre}: produce rungs`);
  check(r.desc.length > 1 && r.desc[0].startsWith('Motor LAVO v7'), `${nombre}: descripción v7`);
  check(!r.warnings.some(w => /no se pudo|no produjo/.test(w)), `${nombre}: sin avisos de compilación (${r.warnings})`);
}

// Representación fiel de la lógica.
let r = compilar(ESCENARIOS['9 AND/OR/XOR']).rungs;
const and = rung(r, /^C1 =/), or = rung(r, /^C2 =/), xor = rung(r, /^C3 =/), nand = rung(r, /^C4 =/), nor = rung(r, /^C5 =/);
check(and.network.length === 1 && tipos(and).filter(t => t.startsWith('contact_no')).length === 2, 'AND = dos contactos en serie');
check(or.network.length === 2, 'OR = dos ramas en paralelo');
check(xor.network.length === 2 && tipos(xor).filter(t => t.startsWith('contact_nc')).length === 2, 'XOR = A·/B + /A·B');
check(nand.network.length === 2 && tipos(nand).filter(t => t.startsWith('contact_nc')).length === 2, 'NAND = /A + /B (De Morgan)');
check(nor.network.length === 1 && tipos(nor).filter(t => t.startsWith('contact_nc')).length === 2, 'NOR = /A · /B');
check(tipos(and).includes('contact_no:I4'), 'S1 se dibuja como su entrada física I4');

r = compilar(ESCENARIOS['1 arranque/paro']).rungs;
const vfd = rung(r, /^VFD:/);
check(tipos(vfd).includes('contact_nc:I3'), 'el paro de emergencia I3 va en serie con el VFD');
check(tipos(rung(r, /^Marcha enclavada/)).includes('contact_pos_edge:I1'), 'marcha enclavada por flanco de I1');

r = compilar(ESCENARIOS['11 torreta + banda']).rungs;
const q3 = rung(r, /^Q3 /);
check(q3 && tipos(q3).includes('contact_no:SQ2_PASO1'), 'Q3 se enciende en SQ2 paso 1');
const q5 = rung(r, /^Q5 /);
check(q5 && tipos(q5).includes('contact_no:BANDA_DETENIDA'), 'Q5 sigue su lógica (no la usa ninguna secuencia)');
check(tipos(rung(r, /^VFD:/)).includes('contact_no:SQ1_PASO1') && tipos(rung(r, /^VFD:/)).includes('contact_nc:SQ1_PASO2'),
  'el VFD marcha en SQ1 paso 1 y el paso 2 (paro) lo bloquea');
const mixto = compilar(banda({ salidas: { Q3: 'I1' }, secuencias: [{ id: 'SQ1', inicio: 'S1', pasos: [{ salidas: ['Q3'], segundos: 1 }] }] })).rungs;
check(tipos(rung(mixto, /^Q3 /)).includes('contact_nc:SQ1_ACTIVA'), 'secuencia exclusiva: la lógica de Q3 solo actúa si SQ1 no está activa');

r = compilar(ESCENARIOS['10 ramas']).rungs;
check(rung(r, /rama — si S1/), 'la rama alternativa tiene su propio rung');

// Lo que el PLC no puede hacer no se dibuja.
for (const [logic, txt] of [
  [banda({ salidas: { Q10: 'I1' } }), 'Q10'],
  [banda({ salidas: { Q4: 'I7' } }), 'I7'],
  [banda({ motor: { arranque: 'I3' } }, true), 'I3'],
  [banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', pasos: [{ salidas: ['Q8', 'Q9'], segundos: 1 }] }] }), 'pluma 1'],
  [banda({ opciones: { luces_paro: ['Q6'] } }), 'lámpara']]) {
  const lv = validateLogicJson(logic, null);
  check(!lv.ok && lv.errors.some(e => e.includes(txt)), `rechaza lógica imposible: ${txt}`);
}

// Confirmación de una alternativa: la marca llega al engine (lo que manda el panel).
const alt = banda({ salidas: { Q3: 'I1' } });
alt.requiere_confirmacion = true; alt.confirmado = false;
alt.band.engine.requiere_confirmacion = true; alt.band.engine.confirmado = false;
const prog = compileLogicToSchema(alt, null).program;
confirmarAlternativa(prog);
check(prog.metadata.engine_config.confirmado === true && prog.metadata.engine_config.band.engine.confirmado === true,
  'aceptar la alternativa marca confirmado en el programa y en band.engine');
check(canonicalBand(prog.metadata.engine_config.band).engine.confirmado === true, 'canonicalBand conserva la marca');

// Contrato de generateProgram con el backend (fetch simulado).
const { generateProgram } = await import('../assets/js/ladder/generate.js');
const respuestaBackend = (cuerpo) => { globalThis.fetch = async () => ({ ok: true, json: async () => cuerpo }); };
const logicAlt = { ...banda({ secuencias: [{ id: 'SQ1', inicio: 'I1', pasos: [{ salidas: ['Q3'], segundos: 2 }] }] }),
  requiere_confirmacion: true, confirmado: false };
logicAlt.band.engine.requiere_confirmacion = true; logicAlt.band.engine.confirmado = false;
respuestaBackend({ status: 'needs_confirmation', device: 'banda', logic: logicAlt, warnings: [],
  questions: [{ id: 'confirmar_alternativa', pregunta: '¿Usar esta alternativa?', opciones: ['Usar la alternativa', 'Cancelar'] }],
  analysis: { compatibilidad: { compatibilidad: 'parcial', modificado: ['Q10 no existe: se usa Q3'] } } });
let out = await generateProgram('enciende Q10 2 s con I1', null, { device: 'banda' });
check(out.needsConfirmation && out.program.rungs.length > 0, 'needs_confirmation: se compila para revisarla');
check(out.confirmation.compatibilidad.modificado[0].includes('Q10'), 'trae la explicación de lo modificado');
check(out.program.metadata.engine_config.band.engine.confirmado === false, 'sin aceptar sigue sin confirmar');
respuestaBackend({ status: 'not_supported', device: 'banda', logic: {}, warnings: ['sin alternativa segura'],
  analysis: { compatibilidad: { compatibilidad: 'ninguna', no_soportado: ['I7 no existe'] } } });
out = await generateProgram('usa la entrada I7', null, { device: 'banda' });
check(out.notSupported && !out.program && out.analysis.compatibilidad.no_soportado[0] === 'I7 no existe',
  'not_supported: no hay programa, solo la explicación');
respuestaBackend({ status: 'ok', device: 'banda', logic: banda({ salidas: { Q3: 'I1' } }), warnings: [] });
out = await generateProgram('verde con I1', null, { device: 'banda' });
check(!out.needsConfirmation && !out.notSupported && out.program.rungs.length === 1, 'ok: flujo normal sin confirmación extra');

console.log(`TODAS LAS PRUEBAS DEL FRONTEND v7 PASARON (${ok} comprobaciones).`);
