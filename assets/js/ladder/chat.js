/**
 * chat.js — Panel de asistente IA del editor ladder.
 *
 * Arquitectura única: el usuario describe el programa en lenguaje natural,
 * la IA devuelve el JSON lógico simple (ver CONTRACT.md), el front lo valida,
 * compila a geometría y lo aplica al editor vía window.LadderEditor.
 */
import { generateProgram, confirmarAlternativa } from './generate.js';
import { BACKEND_BASE_URL } from './config.js';
import { describeBand, detectEquipment } from './equipment.js';

const PROFILE_URL = 'assets/devices/maletin_basico.json';
let profile = null;

const $ = (id) => document.getElementById(id);
const bridge = () => window.LadderEditor;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Estado del chat ───────────────────────────────────────────
let _mid = 0;
let _historialChat = [];   // prompts del usuario para contexto conversacional
// Equipo elegido con la pregunta "¿maletín o banda?". Se usa solo cuando la
// instrucción vuelve a ser ambigua; si nombra un equipo, manda la instrucción.
let _equipoChat = null;
let _pendienteEquipo = null;  // instrucción que espera esa respuesta

const STAGE_LABELS = {
  fetching:   'Consultando al asistente IA...',
  validating: 'Validando lógica generada...',
  compiling:  'Compilando a diagrama Ladder...',
};

// ── Mensajes ──────────────────────────────────────────────────
function addMsg(role, text, opts = {}) {
  const wrap = $('chatMessages');
  const el = document.createElement('div');
  el.className = `cmsg ${role}`;
  el.id = 'cmsg-' + (_mid++);
  el.innerHTML = body(text, opts);
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  return { el, update(t, o = {}) { el.innerHTML = body(t, o); wrap.scrollTop = wrap.scrollHeight; } };
}

function body(text, opts) {
  if (opts.error) {
    let html = `<div class="cmsg-text err">${esc(text)}</div>`;
    if (opts.errors && opts.errors.length) html += listHtml('Errores de validación', opts.errors);
    return html;
  }
  let html = `<div class="cmsg-text">${esc(text)}</div>`;
  if (opts.clarify)  html += clarifyHtml(opts.clarify);
  if (opts.compat)   html += compatHtml(opts.compat);
  if (opts.altId)    html += altButtonsHtml(opts.altId);
  if (opts.logic)    html += logicSummaryHtml(opts.logic);
  if (opts.telemetry) html += telemetryHtml(opts.telemetry);
  if (opts.warnings && opts.warnings.length) html += listHtml(`${opts.warnings.length} aviso(s)`, opts.warnings);
  if (opts.ejemploId) html += feedbackHtml(opts.ejemploId);
  if (opts.guardarId) html += guardarHtml(opts.guardarId);
  return html;
}

function listHtml(summary, items) {
  return `<details class="cmsg-warn"><summary>${esc(summary)}</summary><ul>${items.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
}

function telemetryHtml(t) {
  const rows = Object.entries(t)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  return `<table class="cmsg-tel">${rows}</table>`;
}

// ── Panel "¿Qué entendió la IA?" ──────────────────────────────
const OUTPUT_NAMES = { Q10: 'Verde', Q11: 'Amarilla', Q12: 'Roja' };
const MODE_LABELS  = { directo: 'directo', enclavado: 'enclavado', combinacional: 'combinacional', off: 'apagado' };

// Lectura conceptual de la banda (capa B: contexto industrial). Va ANTES de la
// configuración porque explica POR QUÉ quedó así; no sustituye a describeBand,
// que sigue siendo lo que el PLC va a ejecutar. Si la IA no mandó capa
// semántica (instrucción específica de siempre), no se pinta nada.
function semanticaHtml(sem) {
  if (!sem || typeof sem !== 'object') return '';
  const L = [];
  const pr = sem.process_reference || {};
  if (pr.industry) L.push(`Industria de referencia: ${pr.industry}`);
  if (pr.reference) L.push(`Referencia conceptual: ${pr.reference} (no se copia el proceso real de esa empresa)`);
  if (Array.isArray(sem.archetypes) && sem.archetypes.length)
    L.push(`Arquetipos de proceso: ${sem.archetypes.join(', ')}`);
  for (const s of sem.supuestos || []) L.push(`Supuesto: ${s}`);
  for (const s of sem.unsupported_capability || []) L.push(`Fuera del alcance del hardware (se adaptó): ${s}`);
  for (const s of sem.parametros_faltantes || []) L.push(`Falta por definir: ${s.campo || s.pregunta || ''}`);
  for (const s of sem.conflictos || []) L.push(`Conflicto: ${s}`);
  if (!L.length) return '';
  const rows = L.map(t => `<tr><td>${esc(t)}</td></tr>`).join('');
  return `<details class="cmsg-logic" open><summary>Lectura del proceso (contexto industrial)</summary><table>${rows}</table></details>`;
}

function logicSummaryHtml(logic) {
  // Banda: resumen de la configuración canónica (lo que hará su PLC).
  if (logic?.band && typeof logic.band === 'object') {
    const rows = describeBand(logic.band).map(t => `<tr><td>${esc(t)}</td></tr>`).join('');
    return semanticaHtml(logic.semantica)
      + `<details class="cmsg-logic" open><summary>¿Qué entendió la IA? (banda)</summary><table>${rows}</table></details>`;
  }
  if (!logic || !Array.isArray(logic.outputs) || !logic.outputs.length) return '';
  const rows = logic.outputs.map(o => {
    const out  = String(o.output || '').toUpperCase();
    const name = OUTPUT_NAMES[out] || out;
    const lg   = o.logic || {};
    let detail = MODE_LABELS[lg.mode] || lg.mode || 'off';
    if (lg.mode === 'enclavado')
      detail = `enclavado · inicio ${lg.start || '?'}${lg.stop ? ` · paro ${lg.stop}` : ''}`;
    if (lg.mode === 'directo')
      detail = `directo · fuente ${lg.source || '?'}`;
    if (lg.mode === 'combinacional')
      detail = `combinacional ${lg.a || '?'} ${lg.op || 'OR'} ${lg.b || '?'}${lg.latched ? ' (retenido)' : ''}`;
    let extra = '';
    if (o.timer)   extra += ` · timer ${o.timer.type} ${o.timer.preset_s}s`;
    if (o.counter) extra += ` · contador ${o.counter.type} ${o.counter.preset}`;
    return `<tr><td class="cml-out">${esc(out)}</td><td class="cml-name">${esc(name)}</td><td>${esc(detail + extra)}</td></tr>`;
  }).join('');
  return `<details class="cmsg-logic" open><summary>¿Qué entendió la IA?</summary><table>${rows}</table></details>`;
}

// ── Motor v7: compatibilidad de la solicitud (punto 1) ─────────
// Que se conservo, modifico o simplifico y que no se puede hacer.
function compatHtml(c) {
  if (!c || typeof c !== 'object') return '';
  const filas = [];
  if (c.intencion) filas.push(['Intención', c.intencion]);
  for (const [k, t] of [['conservado', 'Se conserva'], ['modificado', 'Se modifica'],
                        ['simplificado', 'Se simplifica'], ['no_soportado', 'No es posible']]) {
    for (const x of c[k] || []) filas.push([t, x]);
  }
  if (!filas.length) return '';
  const rows = filas.map(([a, b]) => `<tr><td class="cml-out">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('');
  return `<details class="cmsg-logic" open><summary>Compatibilidad: ${esc(c.compatibilidad || '')}</summary><table>${rows}</table></details>`;
}

const ALT_BTN = 'margin:3px;padding:5px 12px;border-radius:12px;border:1px solid var(--border,#3a3a4a);cursor:pointer;';
function altButtonsHtml(altId) {
  return `<div class="cmsg-actions" data-alt-id="${esc(altId)}">
    <button type="button" class="alt-btn" data-accion="usar" style="${ALT_BTN}background:var(--accent,#2E7DE1);color:#fff;">Usar la alternativa</button>
    <button type="button" class="alt-btn" data-accion="cancelar" style="${ALT_BTN}background:transparent;color:inherit;">Cancelar</button>
  </div>`;
}
const _alternativas = new Map();

// ── Aclaración de prompts ambiguos (Fase 1 del agente) ────────
// El backend devolvió status:needs_clarification con preguntas. Se pintan
// como chips; al pulsar uno, su valor se agrega al input (ver el handler en
// DOMContentLoaded) para que el usuario reenvíe una instrucción completa.
function chipVal(opcion) {
  // "Q10 (verde)" -> "Q10"
  return String(opcion).split(' (')[0].trim();
}

function equipoDeOpcion(opcion) {
  const t = String(opcion).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.startsWith('banda') ? 'banda' : t.startsWith('maletin') ? 'maletin' : '';
}

function clarifyHtml(questions) {
  if (!Array.isArray(questions) || !questions.length) return '';
  return questions.map(q => `
    <div class="cmsg-clarify">
      <div class="cq-pregunta">${esc(q.pregunta || '')}</div>
      <div class="cq-opciones">${(q.opciones || []).map(o =>
        `<button type="button" class="clarify-chip" data-val="${esc(chipVal(o))}"${q.slot === 'equipo' ? ` data-equipo="${esc(equipoDeOpcion(o))}"` : ''}
           style="margin:3px;padding:4px 10px;border:1px solid var(--border,#3a3a4a);border-radius:12px;background:var(--panel,#26263a);color:inherit;cursor:pointer;font-size:12px;">${esc(o)}</button>`
      ).join('')}</div>
    </div>`).join('');
}

// ── Feedback (👍/👎) ──────────────────────────────────────────
function feedbackHtml(ejemploId) {
  if (!ejemploId) return '';
  return `<div class="cmsg-actions" data-ejemplo-id="${esc(ejemploId)}">
    <button class="fb-btn" data-status="accepted" title="Correcto">👍</button>
    <button class="fb-btn" data-status="rejected" title="Incorrecto">👎</button>
  </div>`;
}

// ── Memoria validada: "Guardar lógica validada" ────────────────
// Solo la ÚLTIMA lógica aplicada al editor se puede guardar: al generar otra,
// los botones anteriores se desactivan (no se guardan versiones viejas). Se
// guarda el engine_config que va al PLC, no el texto. La prueba física solo
// se marca si el usuario la declara.
const _guardables = new Map();   // guardarId -> { instruccion, dispositivo, program, ejemplo_id }
let _ultimoGuardable = null;

// Frases que formaron la lógica del editor: "haz un llenado" + "cambia el
// tiempo a 6 s" + "no está esperando los 5 s". Cada instrucción modifica el
// programa del editor (va como contexto), así que la memoria se guarda con
// TODAS, no solo con la última. Se reinicia si el editor ya tiene otro
// programa (abierto de archivo, editado a mano...).
let _cadena = { cfg: null, frases: [] };

function cfgDe(program) {
  return JSON.stringify(program?.metadata?.engine_config ?? null);
}

/** Frases del programa que resultará de `prompt` aplicado sobre `programaEditor`. */
function frasesPara(prompt, programaEditor) {
  const sigue = _cadena.cfg && _cadena.cfg === cfgDe(programaEditor);
  return [...(sigue ? _cadena.frases : []), prompt];
}

function unirFrases(frases) {
  if (frases.length === 1) return frases[0];
  return frases.map(f => f.trim().replace(/[\s.]+$/, '')).join('. ') + '.';
}

function registrarGuardable(datos) {
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (Array.isArray(datos.frases)) {
    _cadena = { cfg: cfgDe(datos.program), frases: datos.frases };
    datos = { ...datos, instruccion: unirFrases(datos.frases) };
  }
  _guardables.set(id, datos);
  _ultimoGuardable = id;
  // Las lógicas anteriores dejan de poder guardarse.
  document.querySelectorAll('.cmsg-guardar').forEach(w => {
    if (w.dataset.guardarId !== id) desactivarGuardar(w, 'Hay una lógica más reciente en el editor.');
  });
  return id;
}

function desactivarGuardar(wrap, motivo) {
  wrap.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  wrap.style.opacity = '0.6';
  const m = wrap.querySelector('.guardar-msg');
  if (m && motivo && !m.textContent) m.textContent = motivo;
}

function guardarHtml(id) {
  return `<div class="cmsg-guardar" data-guardar-id="${esc(id)}" style="margin-top:6px;padding:6px 8px;border:1px dashed var(--border,#3a3a4a);border-radius:6px;font-size:12px;">
    <button type="button" class="guardar-btn" style="padding:4px 10px;border-radius:12px;border:1px solid var(--success,#0E9F6E);background:transparent;color:inherit;cursor:pointer;">💾 Guardar lógica validada</button>
    <label style="margin-left:8px;cursor:pointer;"><input type="checkbox" class="guardar-fisica"> Ya la probé en el equipo físico y funcionó</label>
    <div class="guardar-msg" style="margin-top:4px;opacity:.85;"></div>
  </div>`;
}

async function guardarValidada(wrap) {
  const id = wrap.dataset.guardarId;
  const datos = _guardables.get(id);
  const msg = wrap.querySelector('.guardar-msg');
  if (!datos || id !== _ultimoGuardable) {
    desactivarGuardar(wrap, 'Esta lógica ya no es la más reciente: no se guarda.');
    return;
  }
  const logic = datos.program?.metadata?.engine_config;
  if (!logic || typeof logic !== 'object') {
    msg.textContent = 'Este programa no tiene engine_config: no hay JSON que guardar.';
    return;
  }
  const fisica = wrap.querySelector('.guardar-fisica')?.checked ? 'exitosa' : 'no_realizada';
  wrap.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  msg.textContent = 'Guardando…';
  const r = await enviarMemoria({
    dispositivo: datos.dispositivo, instruccion: datos.instruccion, logic,
    ejemplo_id: datos.ejemplo_id, fisica,
  });
  msg.textContent = r.texto;
  if (!r.ok) {
    wrap.querySelectorAll('button, input').forEach(b => { b.disabled = false; });
    return;
  }
  wrap.querySelector('.guardar-btn').textContent = '✔ Lógica guardada';
  _guardables.delete(id);
}

/** POST /memoria/validadas. Devuelve { ok, texto } listo para mostrar. */
async function enviarMemoria({ dispositivo, instruccion, logic, ejemplo_id = '', fisica = 'no_realizada' }) {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/memoria/validadas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispositivo, instruccion, logic, ejemplo_id: ejemplo_id || '', prueba_fisica: fisica,
      }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      const det = Array.isArray(d?.detail) ? d.detail.join(' ') : (d?.detail || `HTTP ${res.status}`);
      return { ok: false, texto: 'No se guardó: ' + det };
    }
    const m = d.memoria || {};
    const textos = {
      guardada: `Guardada en la memoria validada (${m.id}).`,
      nueva_version: `Guardada como versión ${m.version} (${m.id}); la anterior quedó reemplazada.`,
      duplicada: `Ya estaba guardada (${m.id}): no se duplicó.`,
    };
    const texto = (textos[d.resultado] || 'Guardada.')
      + ` Prueba física: ${m.prueba_fisica === 'exitosa' ? 'exitosa' : 'no realizada'}.`
      + (d.persistente ? '' : ' ⚠ El almacén del servidor no es persistente: se perderá al reiniciar.');
    bridge()?.log('ok', texto);
    return { ok: true, texto };
  } catch (e) {
    return { ok: false, texto: 'No se pudo contactar el backend: ' + e.message };
  }
}

// ── Guardar el programa ABIERTO (menú IA → Guardar lógica validada) ──
// Sirve aunque el programa no venga del chat (abierto de archivo, URL, o
// generado antes). Necesita engine_config: un Ladder dibujado a mano no lo
// tiene y no se puede reutilizar ni cargar al PLC.
function equipoDe(cfg) {
  const d = String(cfg?.device || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (d === 'banda' || d === 'maletin') return d;
  return cfg?.band && typeof cfg.band === 'object' ? 'banda' : 'maletin';
}

function abrirGuardarPrograma() {
  const modal = $('memModal');
  if (!modal) return;
  const prog = bridge()?.getProgram();
  const cfg = prog?.metadata?.engine_config;
  const cargable = cfg && typeof cfg === 'object' && (
    (Array.isArray(cfg.outputs) && cfg.outputs.length) ||
    (Array.isArray(cfg.sequence?.steps) && cfg.sequence.steps.length) ||
    (cfg.band && typeof cfg.band === 'object'));
  const msg = $('memMsg');
  msg.textContent = '';
  msg.style.color = '';
  $('memFisica').checked = false;
  const equipo = cargable ? equipoDe(cfg) : null;
  $('memPrograma').textContent = cargable
    ? `Programa: ${prog.metadata?.name || cfg.name || 'sin nombre'} · Equipo: ${equipo === 'banda' ? 'banda transportadora' : 'maletín'}`
    : 'Programa abierto sin engine_config.';
  // Si el programa abierto es la última lógica del chat, se propone su instrucción.
  const ult = _ultimoGuardable && _guardables.get(_ultimoGuardable);
  const mismo = ult && cargable
    && JSON.stringify(ult.program?.metadata?.engine_config) === JSON.stringify(cfg);
  $('memDescripcion').value = mismo ? (ult.instruccion || '') : '';
  $('memDescripcion').disabled = !cargable;
  $('memGuardar').disabled = !cargable;
  if (!cargable) {
    msg.textContent = 'No se puede guardar: este programa no tiene engine_config (por ejemplo, un Ladder dibujado a mano). '
      + 'Solo se guardan lógicas que el PLC puede cargar: genéralas con el asistente IA o abre un programa que la tenga.';
    msg.style.color = 'var(--danger, #e5484d)';
  }
  modal.dataset.equipo = equipo || '';
  modal.hidden = false;
  if (cargable) $('memDescripcion').focus();
}

async function guardarProgramaAbierto() {
  const modal = $('memModal');
  const msg = $('memMsg');
  const cfg = bridge()?.getProgram()?.metadata?.engine_config;
  const instruccion = $('memDescripcion').value.trim();
  if (!instruccion) {
    msg.textContent = 'Escribe qué hace la lógica: con esa descripción se encuentra después.';
    msg.style.color = 'var(--danger, #e5484d)';
    return;
  }
  $('memGuardar').disabled = true;
  msg.style.color = '';
  msg.textContent = 'Guardando…';
  const r = await enviarMemoria({
    dispositivo: modal.dataset.equipo, instruccion, logic: cfg,
    fisica: $('memFisica').checked ? 'exitosa' : 'no_realizada',
  });
  msg.textContent = r.texto;
  msg.style.color = r.ok ? 'var(--success, #0E9F6E)' : 'var(--danger, #e5484d)';
  $('memGuardar').disabled = r.ok;
}

// ── Generar ───────────────────────────────────────────────────
async function onSend() {
  const input = $('chatInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  addMsg('user', prompt);
  input.value = '';

  // Acumular historial para contexto conversacional (máx 6 entradas)
  _historialChat.push(prompt);
  if (_historialChat.length > 6) _historialChat.shift();

  const thinking = addMsg('ai', 'Consultando al asistente IA...');
  const frases = frasesPara(prompt, bridge()?.getProgram());
  _pendienteEquipo = null;
  // Instrucción ambigua y equipo ya elegido antes en este chat -> ese equipo.
  const device = _equipoChat && detectEquipment(prompt).equipment === null ? _equipoChat : undefined;
  try {
    const out = await generateProgram(prompt, profile, {
      device,
      context: {
        programa_anterior: bridge()?.getProgram() || null,
        historial: [..._historialChat],
      },
      onProgress: (stage) => thinking.update(STAGE_LABELS[stage] || stage),
    });
    // Fase 1 (agente): el backend pidió aclaración (prompt ambiguo). Se muestran
    // las preguntas y NO se aplica programa (aún no hay lógica). Se repone el
    // prompt para que las respuestas del usuario se agreguen a su instrucción.
    if (out.needsClarification) {
      thinking.update('Necesito precisar un dato para no inventar:', {
        clarify: out.questions, assumptions: out.assumptions,
      });
      // La pregunta del equipo no completa la instrucción: se reenvía tal cual.
      if ((out.questions || []).some(q => q.slot === 'equipo')) _pendienteEquipo = prompt;
      input.value = prompt + ' ';
      input.focus();
      return;
    }
    // Motor v7: sin alternativa segura -> solo se explica la limitacion.
    if (out.notSupported) {
      thinking.update('No es posible hacerlo de forma segura con este hardware:', {
        compat: out.analysis?.compatibilidad, warnings: out.warnings,
      });
      return;
    }
    // Motor v7: alternativa que cambia lo pedido -> NO se aplica hasta que el
    // usuario la acepte (y el PLC tampoco la acepta sin esa confirmacion).
    if (out.needsConfirmation) {
      const altId = 'alt' + Date.now().toString(36);
      _alternativas.set(altId, { ...out, instruccion: prompt, frases });
      thinking.update('Propuesta alternativa (revísala antes de usarla):', {
        compat: out.confirmation?.compatibilidad, logic: out.logic, warnings: out.warnings, altId,
      });
      return;
    }
    bridge()?.setProgram(out.program);
    bridge()?.log('ok', `Programa aplicado (${out.program.rungs.length} rungs · ${out.warnings.length} avisos)`);
    const guardarId = out.telemetry?.source === 'json-pegado' ? null : registrarGuardable({
      instruccion: prompt, frases, dispositivo: out.device, program: out.program, ejemplo_id: out.ejemplo_id,
    });
    thinking.update(
      `Listo: ${out.program.metadata?.name || 'programa'} — ${out.program.rungs.length} rung(s).`
        + (out.analysis?.fuente === 'memoria' ? ' (reutilizada de la memoria validada, sin llamar al modelo)' : ''),
      { telemetry: out.telemetry, warnings: out.warnings, logic: out.logic, ejemploId: out.ejemplo_id, guardarId },
    );
  } catch (err) {
    thinking.update('No se pudo generar el programa: ' + err.message, { error: true, errors: err.logicErrors });
    bridge()?.log('err', err.message);
  }
}

function onCollapse() {
  const p = $('chatPanel');
  p?.classList.toggle('collapsed');
  const r = $('chatReopenBtn');
  if (r) r.style.display = p?.classList.contains('collapsed') ? 'block' : 'none';
}

async function loadProfile() {
  try {
    const res = await fetch(PROFILE_URL);
    if (res.ok) profile = await res.json();
  } catch { /* sin perfil: la validación de variables se relaja */ }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!$('chatPanel')) return;
  loadProfile();
  $('chatSendBtn')?.addEventListener('click', onSend);
  $('chatCollapseBtn')?.addEventListener('click', onCollapse);
  $('chatReopenBtn')?.addEventListener('click', onCollapse);
  $('chatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
  });

  // Delegación de eventos para botones de feedback (👍/👎)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.fb-btn');
    if (!btn) return;
    const wrap      = btn.closest('.cmsg-actions');
    const ejemploId = wrap?.dataset.ejemploId;
    const status    = btn.dataset.status;
    if (!ejemploId || !status) return;
    wrap.querySelectorAll('.fb-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    try {
      await fetch(`${BACKEND_BASE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ejemplo_id: ejemploId, status }),
      });
    } catch { /* feedback es best-effort */ }
  });

  // Memoria validada desde el menú IA: guardar el programa abierto.
  window.addEventListener('lavo:guardar-memoria', abrirGuardarPrograma);
  const cerrarMem = () => { const m = $('memModal'); if (m) m.hidden = true; };
  $('memClose')?.addEventListener('click', cerrarMem);
  $('memCancelar')?.addEventListener('click', cerrarMem);
  $('memGuardar')?.addEventListener('click', guardarProgramaAbierto);
  $('memModal')?.addEventListener('click', (e) => { if (e.target.id === 'memModal') cerrarMem(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMem(); });

  // Memoria validada: guardar la lógica actual.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.guardar-btn');
    if (!btn) return;
    const wrap = btn.closest('.cmsg-guardar');
    if (wrap) guardarValidada(wrap);
  });

  // Motor v7: aceptar o cancelar una alternativa propuesta.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.alt-btn');
    if (!btn) return;
    const wrap = btn.closest('.cmsg-actions');
    const out = _alternativas.get(wrap?.dataset.altId);
    if (!out) return;
    _alternativas.delete(wrap.dataset.altId);
    wrap.querySelectorAll('.alt-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.55'; });
    if (btn.dataset.accion === 'usar') {
      const program = confirmarAlternativa(out.program);
      bridge()?.setProgram(program);
      bridge()?.log('ok', `Alternativa aceptada y aplicada al editor (${out.program.rungs.length} rungs). Revísala antes de cargarla al PLC.`);
      const guardarId = registrarGuardable({
        instruccion: out.instruccion, frases: out.frases, dispositivo: out.device, program, ejemplo_id: out.ejemplo_id,
      });
      addMsg('ai', 'Alternativa aceptada. Quedó en el editor; se cargará al PLC solo cuando pulses Cargar.', { guardarId });
    } else {
      addMsg('ai', 'Alternativa descartada: el editor no cambió.');
    }
  });

  // Chips de aclaración (Fase 1): al pulsar, agrega el valor al input para
  // que el usuario complete su instrucción y la reenvíe.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.clarify-chip');
    if (!chip) return;
    const input = $('chatInput');
    if (!input) return;
    // "¿Maletín o banda?": elige el equipo y reenvía la MISMA instrucción, sin
    // agregarle "Banda transportadora" (así coincide con la memoria validada).
    if (chip.dataset.equipo) {
      if (!_pendienteEquipo) return;
      _equipoChat = chip.dataset.equipo;
      if (_historialChat[_historialChat.length - 1] === _pendienteEquipo) _historialChat.pop();
      input.value = _pendienteEquipo;
      chip.closest('.cmsg-clarify')?.querySelectorAll('.clarify-chip').forEach(c => { c.disabled = true; c.style.opacity = '0.55'; });
      onSend();
      return;
    }
    const val = chip.dataset.val || '';
    input.value = (input.value.trim() ? input.value.trimEnd() + ' ' : '') + val;
    input.focus();
    chip.style.opacity = '0.55';
  });

  addMsg('ai', 'Asistente listo. Describe el programa en lenguaje natural (p. ej. "la lámpara verde prende con el botón verde o el selector, y se apaga con el paro de emergencia").');
});
