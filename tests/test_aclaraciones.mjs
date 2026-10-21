// Pruebas de las aclaraciones (sin navegador).
//   node tests/test_aclaraciones.mjs
// La instrucción del usuario no se toca: las opciones elegidas se guardan en
// la solicitud (lavo-sesion.js) y viajan aparte en `aclaraciones`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { generateProgram, decidirRespuesta, preguntasPendientes, claveAclaracion, frasesDeSolicitud }
  from '../assets/js/ladder/generate.js';

const CODIGO = fs.readFileSync(new URL('../assets/js/lavo-sesion.js', import.meta.url), 'utf8');
let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok++; console.log('  ✓ ' + msg); };
const titulo = (t) => console.log('\n== ' + t);

class Storage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const local = new Storage();
function pagina(tab, tipo = 'navigate') {
  const win = { sessionStorage: tab, localStorage: local, BroadcastChannel: undefined,
    performance: { getEntriesByType: () => [{ type: tipo }] }, location: { search: '' },
    addEventListener() {}, console, JSON, Date, Math, URLSearchParams };
  vm.runInNewContext(CODIGO, win);
  return win.LavoSesion;
}

// Backend simulado: responde la cola y guarda lo que recibió.
let enviados = [], cola = [];
globalThis.fetch = async (_u, o) => {
  enviados.push(JSON.parse(o.body));
  return { ok: true, json: async () => cola.shift() };
};
const pregunta = (campo, texto, opciones) => ({ status: 'needs_clarification', logic: {}, questions: [{ campo, pregunta: texto, opciones }] });
const banda = (freq, extra = {}) => {
  const logic = { name: 'Banda', device: 'banda', outputs: [],
    band: { enable: true, direction: 'derecha', freq_hz: freq, engine: { version: 7, motor: { arranque: 'I1' }, ...extra } } };
  return { status: 'ok', logic, device: 'banda' };
};

/** Lo que hace el chat al escribir una instrucción y al pulsar un chip. */
async function escribir(S, texto, respuesta, context = null) {
  cola.push(respuesta);
  const sol = S.iniciarSolicitud({ texto, tipo: context ? 'modificacion' : 'nueva', base: context });
  const out = await generateProgram(sol.texto, null, { context: sol.base, aclaraciones: sol.aclaraciones, device: 'banda' });
  if (out.needsClarification) S.actualizarSolicitud(sol.id, { preguntas: preguntasPendientes(out.questions, sol.aclaraciones) });
  else { S.aplicar(out.program, { instruccion: sol.texto, tipo: sol.tipo, aclaraciones: sol.aclaraciones }); S.actualizarSolicitud(sol.id, { estado: 'aplicada', revAplicada: S.rev() }); }
  return { sol: S.solicitud(), out };
}
async function enviar(S, sol, respuesta, reemplazaUltima = false) {
  cola.push(respuesta);
  const out = await generateProgram(sol.texto, null, { context: sol.base, aclaraciones: sol.aclaraciones, device: 'banda' });
  if (out.needsClarification) {
    S.actualizarSolicitud(sol.id, { preguntas: preguntasPendientes(out.questions, sol.aclaraciones), estado: 'pendiente' });
  } else {
    S.aplicar(out.program, { instruccion: sol.texto, tipo: sol.tipo, aclaraciones: sol.aclaraciones, reemplazaUltima });
    S.actualizarSolicitud(sol.id, { estado: 'aplicada', revAplicada: S.rev() });
  }
  return out;
}
const ultimo = () => enviados.at(-1);
const PREG_F = '¿A qué frecuencia deseas mover la banda?';
const OPC_F = ['10 Hz', '20 Hz', '30 Hz', '40 Hz'];

// ─────────────────────────────────────────────────────────────────
titulo('1. Movimiento sin frecuencia: se elige 20 Hz');
const tab = new Storage();
let S = pagina(tab);
const TEXTO = 'Mueve la banda hacia la derecha';
let { sol } = await escribir(S, TEXTO, pregunta('freq_hz', PREG_F, OPC_F));
check(sol.preguntas.length === 1 && claveAclaracion(sol.preguntas[0]) === 'freq_hz', 'queda pendiente la frecuencia');
let r = decidirRespuesta(S, sol.id, 'freq_hz', PREG_F, '20 Hz');
check(r.accion === 'enviar', 'con la única respuesta se envía');
check(r.sol.texto === TEXTO, 'la instrucción sigue siendo "Mueve la banda hacia la derecha"');
await enviar(S, r.sol, banda(20));
check(ultimo().texto === TEXTO, 'el backend recibe el texto original intacto');
check(ultimo().aclaraciones.freq_hz.respuesta === '20 Hz' && ultimo().aclaraciones.freq_hz.pregunta === PREG_F,
  'y la frecuencia aparte, con su pregunta');
check(S.programa().metadata.engine_config.band.freq_hz === 20, 'el JSON final lleva 20 Hz');
check(S.instrucciones().at(-1) === TEXTO, 'el historial visible guarda el texto original');
check(S.contexto().historial.at(-1) === TEXTO + ' [freq_hz: 20 Hz]', 'el modelo ve la aclaración como dato aparte');

// ─────────────────────────────────────────────────────────────────
titulo('4. Cambiar la respuesta ya aplicada (20 -> 30 Hz)');
const n = S.instrucciones().length;
r = decidirRespuesta(S, sol.id, 'freq_hz', PREG_F, '20 Hz');
check(r.accion === 'sin_cambio', 'la misma opción no reenvía nada');
r = decidirRespuesta(S, sol.id, 'freq_hz', PREG_F, '30 Hz');
check(r.accion === 'rehacer', 'otra opción rehace la misma instrucción');
await enviar(S, r.sol, banda(30), true);
check(ultimo().aclaraciones.freq_hz.respuesta === '30 Hz' && ultimo().contexto === null,
  'se rehace desde la misma base (lógica nueva: sin contexto)');
check(S.instrucciones().length === n && S.programa().metadata.engine_config.band.freq_hz === 30,
  'reemplaza la versión anterior en vez de sumar otra instrucción');

// ─────────────────────────────────────────────────────────────────
titulo('2. Falta el tiempo: 5 segundos');
({ sol } = await escribir(S, 'Cuando S1 detecte, espera y baja la pluma 1',
  pregunta('espera_s', '¿Cuántos segundos espera?', ['3 s', '5 s']), S.contexto()));
r = decidirRespuesta(S, sol.id, 'espera_s', '¿Cuántos segundos espera?', '5 s');
await enviar(S, r.sol, banda(30, { eventos: [{ cuando: 'S1', espera_s: 5, acciones: { pluma1: 'bajar' } }] }));
check(ultimo().texto === 'Cuando S1 detecte, espera y baja la pluma 1' && ultimo().aclaraciones.espera_s.respuesta === '5 s',
  'texto intacto y 5 s aparte');
check(S.programa().metadata.engine_config.band.engine.eventos[0].espera_s === 5, 'el JSON lleva 5 s');

// ─────────────────────────────────────────────────────────────────
titulo('3. Dos parámetros faltantes');
cola.push({ status: 'needs_clarification', logic: {}, questions: [
  { slot: 'output', pregunta: '¿Cuál salida?', opciones: ['Q10 (verde)', 'Q11 (amarilla)'] },
  { slot: 'input', pregunta: '¿Con qué entrada?', opciones: ['I1 (boton verde)', 'I2'] }] });
const T3 = 'Prende una lámpara';
sol = S.iniciarSolicitud({ texto: T3, tipo: 'nueva', base: null });
let out = await generateProgram(T3, null, { device: 'maletin' });
S.actualizarSolicitud(sol.id, { preguntas: out.questions });
r = decidirRespuesta(S, sol.id, 'output', '¿Cuál salida?', 'Q10 (verde)');
check(r.accion === 'esperar', 'con una de dos respuestas espera la otra');
r = decidirRespuesta(S, sol.id, 'output', '¿Cuál salida?', 'Q11 (amarilla)');
check(r.accion === 'esperar' && r.sol.aclaraciones.output.respuesta === 'Q11 (amarilla)', 'cambiar la primera actualiza solo ese parámetro');
r = decidirRespuesta(S, sol.id, 'input', '¿Con qué entrada?', 'I1 (boton verde)');
check(r.accion === 'enviar', 'con las dos se envía');
cola.push({ status: 'ok', device: 'maletin', logic: { name: 'm', outputs: [{ output: 'Q11', logic: { mode: 'directo', source: 'I1' } }] } });
await generateProgram(r.sol.texto, null, { aclaraciones: r.sol.aclaraciones, device: 'maletin' });
check(ultimo().texto === T3 && Object.keys(ultimo().aclaraciones).sort().join() === 'input,output', 'el backend recibe las dos');
check(frasesDeSolicitud(S, r.sol)[0] === T3 + ' [output: Q11 (amarilla); input: I1 (boton verde)]',
  'la memoria validada se guarda con las respuestas como datos');

// ─────────────────────────────────────────────────────────────────
titulo('Respuestas de solicitudes anteriores no se mezclan');
const vieja = sol.id;
sol = S.iniciarSolicitud({ texto: 'Otra instrucción', tipo: 'nueva', base: null });
check(Object.keys(sol.aclaraciones).length === 0, 'una instrucción nueva empieza sin respuestas');
check(decidirRespuesta(S, vieja, 'input', '', 'I2').accion === 'obsoleta', 'un chip de la instrucción anterior es obsoleto');
check(decidirRespuesta(S, sol.id, 'proceso', '', 'Describir la secuencia paso a paso').accion === 'abierta',
  '"Describir la secuencia" pide escribir (no se envía como valor)');

// ─────────────────────────────────────────────────────────────────
titulo('5. Aclaración de una instrucción que modifica la lógica (35 Hz)');
// Lógica activa a 20 Hz con una pausa por S1.
S.aplicar({ metadata: { name: 'base', engine_config: banda(20, { eventos: [{ cuando: 'S1' }] }).logic }, rungs: [] },
  { instruccion: 'Banda a 20 Hz con pausa en S1', tipo: 'nueva' });
const ctx = S.contexto();
({ sol } = await escribir(S, 'Ahora aumenta la velocidad',
  pregunta('frecuencia_hz', '¿A qué frecuencia deseas aumentar?', ['30 Hz', '35 Hz']), ctx));
check(sol.tipo === 'modificacion' && sol.base.programa_anterior.metadata.engine_config.band.freq_hz === 20,
  'la solicitud guarda la lógica activa como base');
r = decidirRespuesta(S, sol.id, 'freq_hz', '¿A qué frecuencia deseas aumentar?', '35 Hz');
await enviar(S, r.sol, banda(35, { eventos: [{ cuando: 'S1' }] }));
check(ultimo().texto === 'Ahora aumenta la velocidad', 'texto intacto');
check(ultimo().contexto.programa_anterior.metadata.engine_config.band.engine.eventos[0].cuando === 'S1',
  'el backend recibe la lógica activa como base');
check(ultimo().aclaraciones.freq_hz.respuesta === '35 Hz', 'y la frecuencia como parámetro de la modificación');
check(S.programa().metadata.engine_config.band.freq_hz === 35 && S.programa().metadata.engine_config.band.engine.eventos.length === 1,
  'queda a 35 Hz conservando lo anterior');

// ─────────────────────────────────────────────────────────────────
titulo('6. Navegar sin perder las aclaraciones pendientes');
({ sol } = await escribir(S, 'Mueve la banda a la izquierda', pregunta('freq_hz', PREG_F, OPC_F), S.contexto()));
S = pagina(tab, 'navigate');                     // Main -> Ladder
const pend = S.solicitud();
check(pend.id === sol.id && pend.estado === 'pendiente' && pend.preguntas.length === 1, 'la pregunta sigue pendiente en la otra pantalla');
r = decidirRespuesta(S, pend.id, 'freq_hz', PREG_F, '40 Hz');
check(r.accion === 'enviar' && r.sol.texto === 'Mueve la banda a la izquierda', 'y se puede responder ahí');

// ─────────────────────────────────────────────────────────────────
titulo('Equipo elegido con un botón, sin agregar texto');
enviados = [];
out = await generateProgram('Enciende la luz verde 3 segundos', null, {});
check(out.needsClarification && claveAclaracion(out.questions[0]) === 'equipo' && enviados.length === 0,
  'la pregunta de equipo es local');
cola.push(banda(30));
await generateProgram('Enciende la luz verde 3 segundos', null, { aclaraciones: { equipo: { respuesta: 'Banda transportadora' } } });
check(ultimo().device === 'banda' && ultimo().texto === 'Enciende la luz verde 3 segundos', 'equipo = banda, texto intacto');

// ─────────────────────────────────────────────────────────────────
titulo('10. Refresh limpia la solicitud temporal');
S = pagina(tab, 'reload');
check(S.solicitud() === null && !S.tieneLogica(), 'sin solicitud ni lógica tras F5');

console.log(`\nTODAS LAS PRUEBAS DE ACLARACIONES PASARON (${ok} comprobaciones).`);
