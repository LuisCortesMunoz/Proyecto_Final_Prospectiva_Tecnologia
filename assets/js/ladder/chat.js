/**
 * chat.js — Panel de asistente IA del editor ladder.
 *
 * Arquitectura única: el usuario describe el programa en lenguaje natural,
 * la IA devuelve el JSON lógico simple (ver CONTRACT.md), el front lo valida,
 * compila a geometría y lo aplica al editor vía window.LadderEditor.
 */
import { generateProgram } from './generate.js';
import { BACKEND_BASE_URL } from './config.js';

const PROFILE_URL = 'assets/devices/maletin_basico.json';
let profile = null;

const $ = (id) => document.getElementById(id);
const bridge = () => window.LadderEditor;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Estado del chat ───────────────────────────────────────────
let _mid = 0;
let _historialChat = [];   // prompts del usuario para contexto conversacional

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
  if (opts.logic)    html += logicSummaryHtml(opts.logic);
  if (opts.telemetry) html += telemetryHtml(opts.telemetry);
  if (opts.warnings && opts.warnings.length) html += listHtml(`${opts.warnings.length} aviso(s)`, opts.warnings);
  if (opts.ejemploId) html += feedbackHtml(opts.ejemploId);
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

function logicSummaryHtml(logic) {
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

// ── Aclaración de prompts ambiguos (Fase 1 del agente) ────────
// El backend devolvió status:needs_clarification con preguntas. Se pintan
// como chips; al pulsar uno, su valor se agrega al input (ver el handler en
// DOMContentLoaded) para que el usuario reenvíe una instrucción completa.
function chipVal(opcion) {
  // "Q10 (verde)" -> "Q10"
  return String(opcion).split(' (')[0].trim();
}

function clarifyHtml(questions) {
  if (!Array.isArray(questions) || !questions.length) return '';
  return questions.map(q => `
    <div class="cmsg-clarify">
      <div class="cq-pregunta">${esc(q.pregunta || '')}</div>
      <div class="cq-opciones">${(q.opciones || []).map(o =>
        `<button type="button" class="clarify-chip" data-val="${esc(chipVal(o))}"
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
  try {
    const out = await generateProgram(prompt, profile, {
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
      input.value = prompt + ' ';
      input.focus();
      return;
    }
    bridge()?.setProgram(out.program);
    bridge()?.log('ok', `Programa aplicado (${out.program.rungs.length} rungs · ${out.warnings.length} avisos)`);
    thinking.update(
      `Listo: ${out.program.metadata?.name || 'programa'} — ${out.program.rungs.length} rung(s).`,
      { telemetry: out.telemetry, warnings: out.warnings, logic: out.logic, ejemploId: out.ejemplo_id },
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

  // Chips de aclaración (Fase 1): al pulsar, agrega el valor al input para
  // que el usuario complete su instrucción y la reenvíe.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.clarify-chip');
    if (!chip) return;
    const input = $('chatInput');
    if (!input) return;
    const val = chip.dataset.val || '';
    input.value = (input.value.trim() ? input.value.trimEnd() + ' ' : '') + val;
    input.focus();
    chip.style.opacity = '0.55';
  });

  addMsg('ai', 'Asistente listo. Describe el programa en lenguaje natural (p. ej. "la lámpara verde prende con el botón verde o el selector, y se apaga con el paro de emergencia").');
});
