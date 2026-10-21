// Pruebas de la lógica activa de la sesión (sin navegador).
//   node tests/test_sesion_logica.mjs
// Comprueba lavo-sesion.js (navegar conserva, F5 reinicia, pestañas
// sincronizadas, una versión inválida no reemplaza a la válida) y que
// generate.js mande la lógica activa al backend como base de cada cambio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { generateProgram, planearInstruccion } from '../assets/js/ladder/generate.js';

const CODIGO = fs.readFileSync(new URL('../assets/js/lavo-sesion.js', import.meta.url), 'utf8');
let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok++; console.log('  ✓ ' + msg); };
const titulo = (t) => console.log('\n== ' + t);

// ── Navegador simulado ──────────────────────────────────────────
class Storage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const local = new Storage();               // localStorage es del origen: lo comparten las pestañas
const canales = new Set();
class FakeChannel {
  constructor() { canales.add(this); this.onmessage = null; }
  postMessage(data) {
    for (const c of canales) if (c !== this && c.onmessage) c.onmessage({ data: JSON.parse(JSON.stringify(data)) });
  }
}

/** Carga una página: `tab` es el sessionStorage de la pestaña, `tipo` el de navegación. */
function pagina(tab, tipo = 'navigate', search = '') {
  const win = {
    sessionStorage: tab, localStorage: local, BroadcastChannel: FakeChannel,
    performance: { getEntriesByType: () => [{ type: tipo }] },
    location: { search }, addEventListener() {}, console, JSON, Date, Math, URLSearchParams,
  };
  vm.runInNewContext(CODIGO, win);
  return win.LavoSesion;
}

const prog = (name, engine, extra = {}) => ({
  metadata: { name, engine_config: { name, device: 'banda', outputs: [], band: { enable: true, engine } } },
  rungs: [{ id: 1, network: [] }], symbol_table: {}, ...extra,
});

// ─────────────────────────────────────────────────────────────────
titulo('1. Generar una lógica desde cero');
const tab1 = new Storage();
let S = pagina(tab1);
check(!S.tieneLogica() && S.contexto() === null, 'sesión nueva: sin lógica ni contexto');
let plan = planearInstruccion('Cuando el sensor 1 detecte una pieza, detén la banda 3 s', S);
check(plan.accion === 'generar' && plan.tipo === 'nueva' && plan.context === null, 'primera instrucción = lógica nueva');
S.aplicar(prog('S1 pausa 3 s', { eventos: ['S1'] }), { instruccion: 'Cuando el sensor 1 detecte una pieza, detén la banda 3 s', tipo: 'nueva' });
check(S.tieneLogica() && S.device() === 'banda' && S.rev() === 1, 'queda como lógica activa (banda, rev 1)');

// ─────────────────────────────────────────────────────────────────
titulo('2. Regresar al Main y agregar una condición');
S = pagina(tab1, 'navigate');                         // ladder.html -> index.html
check(S.tieneLogica() && S.nombre() === 'S1 pausa 3 s', 'al volver al Main la lógica sigue activa');
plan = planearInstruccion('Ahora agrega que, después de arrancar, avance 5 segundos y vuelva a detenerse', S);
check(plan.accion === 'generar' && plan.tipo === 'modificacion', 'la instrucción se trata como modificación');
check(plan.context.programa_anterior.metadata.engine_config.band.engine.eventos[0] === 'S1',
  'el contexto lleva el JSON completo vigente');
check(plan.context.historial[0].startsWith('Cuando el sensor 1'), 'y las instrucciones aplicadas');
check(!('rungs' in plan.context.programa_anterior), 'sin los rungs: solo lo que usa el backend (menos tokens)');

// El backend recibe la lógica activa y el equipo de la lógica (no se vuelve a preguntar).
let enviado = null;
const respuestaBackend = (logic) => { globalThis.fetch = async (_u, o) => { enviado = JSON.parse(o.body); return { ok: true, json: async () => ({ status: 'ok', logic, device: 'banda' }) }; }; };
const bandaV7 = (eventos, segundos) => ({
  name: 'Banda', device: 'banda', outputs: [],
  band: { enable: true, direction: 'derecha', freq_hz: 30, engine: { version: 7, motor: { arranque: 'I1' }, ...(segundos ? { timers: [{ id: 'T1', tipo: 'TON', entrada: 'BANDA_CORRIENDO', segundos }] } : {}), eventos } },
});
respuestaBackend(bandaV7([{ cuando: 'S1' }], 5));
let out = await generateProgram('Ahora agrega que avance 5 segundos', null, { context: plan.context });
check(enviado.contexto.programa_anterior.metadata.engine_config.band, 'POST /generar-logica con la lógica activa');
check(enviado.device === 'banda', 'equipo tomado de la lógica activa');
S.aplicar(out.program, { instruccion: 'Ahora agrega que avance 5 segundos', tipo: 'modificacion', device: out.device });
check(S.instrucciones().length === 2 && S.rev() === 2, 'versión 2 con dos instrucciones');

// ─────────────────────────────────────────────────────────────────
titulo('3. Modificar un temporizador sin perder las demás funciones');
plan = planearInstruccion('Cambia el último tiempo de 5 a 8 segundos', S);
check(plan.accion === 'generar' && plan.tipo === 'modificacion', '"cambia el último tiempo" edita la lógica');
respuestaBackend(bandaV7([{ cuando: 'S1' }], 8));
out = await generateProgram('Cambia el último tiempo de 5 a 8 segundos', null, { context: plan.context });
check(enviado.device === 'banda', 'no pregunta maletín/banda: "tiempo" no nombra equipo');
check(enviado.contexto.programa_anterior.metadata.engine_config.band.engine.timers[0].segundos === 5,
  'el backend recibió la versión con 5 s para cambiarla');
S.aplicar(out.program, { instruccion: 'Cambia el último tiempo de 5 a 8 segundos', tipo: 'modificacion' });
const eng = () => S.programa().metadata.engine_config.band.engine;
check(eng().timers[0].segundos === 8 && eng().eventos.length === 1, 'timer en 8 s y S1 conservado');

// ─────────────────────────────────────────────────────────────────
titulo('4. Incorporar un segundo sensor a la secuencia existente');
plan = planearInstruccion('Agrega que el sensor 2 detenga la banda 4 segundos y después continúe', S);
respuestaBackend(bandaV7([{ cuando: 'S1' }, { cuando: 'S2' }], 8));
out = await generateProgram('Agrega que el sensor 2 detenga la banda 4 segundos', null, { context: plan.context });
S.aplicar(out.program, { instruccion: 'Agrega que el sensor 2 detenga la banda 4 segundos', tipo: 'modificacion' });
check(eng().eventos.map(e => e.cuando).join() === 'S1,S2' && eng().timers[0].segundos === 8, 'S1, S2 y el timer conviven');
check(enviado.contexto.historial.length === 3, 'el backend recibió las tres instrucciones previas');

// ─────────────────────────────────────────────────────────────────
titulo('5 y 6. Eliminar una etapa / corregir: siguen siendo ediciones');
for (const t of ['Elimina la pausa del sensor 2', 'Corrige el temporizador, debe ser de 6 s', 'Elimina el último paro',
                 'Cambia el sensor 1 por el sensor 2', 'Agrega un contador', 'Ahora agrega otra secuencia']) {
  check(planearInstruccion(t, S).accion === 'generar' && planearInstruccion(t, S).tipo === 'modificacion', `"${t}" edita`);
}
check(planearInstruccion('Explícame por qué no funciona', S).accion === 'explicar', '"Explícame por qué no funciona" no regenera');
check(planearInstruccion('Muéstrame el JSON', S).accion === 'mostrar', '"Muéstrame el JSON" no regenera');
check(planearInstruccion('¿Por qué no se detiene? corrígelo', S).accion === 'generar', 'explicar + corregir = edición');
check(planearInstruccion('Crea una lógica nueva desde cero: semáforo', S).accion === 'confirmar_reemplazo',
  'lógica nueva explícita pide confirmación');
check(planearInstruccion('En el maletín prende la verde con I1', S).motivo === 'equipo',
  'el otro equipo también pide confirmación');

// ─────────────────────────────────────────────────────────────────
titulo('7. Navegar entre Main y Ladder conservando el JSON');
const antes = JSON.stringify(S.activa());
S = pagina(tab1, 'navigate');                         // Main -> Ladder
check(JSON.stringify(S.activa()) === antes, 'Ladder ve exactamente la misma lógica');
S = pagina(tab1, 'back_forward');                     // Atrás
check(JSON.stringify(S.activa()) === antes, 'con "Atrás" también');

// ─────────────────────────────────────────────────────────────────
titulo('8. Varias modificaciones consecutivas');
for (let i = 1; i <= 5; i++) {
  S.aplicar(prog('v' + i, { eventos: ['S1', 'S2'], n: i }), { instruccion: `cambio ${i}`, tipo: 'modificacion' });
}
check(S.instrucciones().length === 9 && S.rev() === 9, 'nueve instrucciones acumuladas, rev 9');
check(S.contexto().historial.at(-1) === 'cambio 5', 'el contexto parte de la más reciente');
S = pagina(tab1);
check(S.nombre() === 'v5', 'otra pantalla ve la última versión');

// ─────────────────────────────────────────────────────────────────
titulo('9. Un JSON inválido no reemplaza la última versión válida');
const valida = JSON.stringify(S.activa());
globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', logic: { name: 'roto', outputs: [{ output: 'Q99', logic: { mode: 'directo', source: 'I1' } }] } }) });
let fallo = null;
try { await generateProgram('Agrega una salida', null, { context: S.contexto(), device: 'maletin' }); } catch (e) { fallo = e; }
check(fallo && Array.isArray(fallo.logicErrors), 'el front rechaza el JSON inválido');
check(JSON.stringify(S.activa()) === valida, 'la lógica activa no cambió');
assert.throws(() => S.aplicar({ metadata: {} }, { instruccion: 'x' }));
check(JSON.stringify(S.activa()) === valida, 'aplicar algo que no es programa tampoco la toca');

// ─────────────────────────────────────────────────────────────────
titulo('Pestañas: el editor abierto desde el copiloto comparte la sesión');
const tabCopiloto = tab1;
const Copiloto = pagina(tabCopiloto);
Copiloto.prepararHandoff();
const Editor = pagina(new Storage(), 'navigate', '?handoff=1&from=chat');   // pestaña sin sessionStorage copiado
check(Editor.nombre() === 'v5' && local.getItem('lv_handoff_sesion') === null, 'el editor adopta la sesión y consume el handoff');
let recibido = null;
Copiloto.suscribir((st, origen) => { recibido = { st, origen }; });
Editor.aplicar(prog('desde editor', { eventos: ['S1'] }), { instruccion: 'cambio en el editor', tipo: 'modificacion' });
check(recibido?.origen === 'otra_pestana' && Copiloto.nombre() === 'desde editor', 'el copiloto recibe el cambio del editor');
check(Copiloto.instrucciones().at(-1) === 'cambio en el editor', 'con su instrucción');

// ─────────────────────────────────────────────────────────────────
titulo('10. Refresh (F5) empieza una sesión nueva');
local.setItem('lv_copilot_mode', 'disenador');
let llamadasRed = 0;
globalThis.fetch = async () => { llamadasRed++; return { ok: true, json: async () => ({}) }; };
S = pagina(tabCopiloto, 'reload');
check(!S.tieneLogica() && S.instrucciones().length === 0 && S.contexto() === null, 'sin lógica ni historial');
check(tabCopiloto.getItem('lavo_sesion_logica') === null, 'la lógica temporal se borró de la pestaña');
check(planearInstruccion('Agrega un contador', S).tipo === 'nueva', 'la siguiente instrucción empieza de cero');
S = pagina(tabCopiloto, 'navigate');
check(!S.tieneLogica(), 'y no reaparece al navegar después del F5');
local.setItem('lv_handoff_sesion', JSON.stringify({ ts: Date.now(), estado: Copiloto.activa() }));
S = pagina(new Storage(), 'reload', '?handoff=1&from=chat');
check(!S.tieneLogica(), 'F5 en el editor tampoco restaura el handoff');

// ─────────────────────────────────────────────────────────────────
titulo('11. Las memorias validadas siguen intactas después del Refresh');
check(llamadasRed === 0, 'recargar no llama al backend (la memoria validada vive allá y no se toca)');
check(local.getItem('lv_copilot_mode') === 'disenador', 'tampoco borra otras preferencias guardadas');
const otraSesionNueva = pagina(tabCopiloto, 'reload');
otraSesionNueva.reiniciar();
check(llamadasRed === 0, 'reiniciar la sesión solo limpia el estado temporal del navegador');

console.log(`\nTODAS LAS PRUEBAS DE LA SESIÓN PASARON (${ok} comprobaciones).`);
