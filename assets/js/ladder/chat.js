/**
 * chat.js — Panel de asistente IA con SWITCH de arquitectura (Motor A / B).
 *
 * No reemplaza nada: ambos motores producen el MISMO `program` y se aplican al
 * editor vía window.LadderEditor. El switch vive en el panel para hacer la
 * comparativa de arquitecturas (geometría IA vs lógica booleana).
 */
import { getEngine, ENGINES } from './engines/index.js';
import { normalizeAndValidate } from './validate.js';

const LS_KEY = 'ladder.engine';
let engineId = localStorage.getItem(LS_KEY) || 'A';

const $ = (id) => document.getElementById(id);
const bridge = () => window.LadderEditor;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Switch de motor ───────────────────────────────────────────
function setEngine(id) {
  engineId = ENGINES[id] ? id : 'A';
  localStorage.setItem(LS_KEY, engineId);
  updateSwitchUI();
}

function updateSwitchUI() {
  const eng = getEngine(engineId);
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.engine === engineId));
  const badge = $('chatBadge');
  if (badge) { badge.textContent = `Motor ${eng.id} · ${eng.label}`; badge.style.background = eng.color; }
  const input = $('chatInput');
  if (input) input.placeholder = engineId === 'B'
    ? 'Motor B (local): escribe ecuaciones, una por línea.  Ej: Q10 = (I1 + Q10) * !I2'
    : 'Describe el programa en lenguaje natural...';
}

// ── Mensajes ──────────────────────────────────────────────────
let _mid = 0;
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
  if (opts.error) return `<div class="cmsg-text err">${esc(text)}</div>`;
  let html = `<div class="cmsg-text">${esc(text)}</div>`;
  if (opts.telemetry) html += telemetryHtml(opts.telemetry);
  if (opts.warnings && opts.warnings.length) {
    html += `<details class="cmsg-warn"><summary>${opts.warnings.length} aviso(s) de validación</summary><ul>${opts.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
  }
  return html;
}

function telemetryHtml(t) {
  const rows = Object.entries(t)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  let extra = '';
  if (t.validation) extra = `<tr><td>validación</td><td>${t.validation.ok ? 'OK' : 'con avisos'} · ${t.validation.warnings} avisos · ${t.validation.repairs} reparos</td></tr>`;
  return `<table class="cmsg-tel">${rows}${extra}</table>`;
}

// ── Ejecutar un motor ─────────────────────────────────────────
async function runEngine(id, prompt) {
  const eng = getEngine(id);
  const thinking = addMsg('ai', `Generando con Motor ${eng.id} (${eng.label})…`);
  try {
    const out = await eng.generate({ prompt, profile: null });
    const v = normalizeAndValidate(out.program);
    bridge()?.setProgram(v.program);
    bridge()?.log('ok', `Motor ${eng.id}: aplicado (${v.program.rungs.length} rungs · ${v.warnings.length} avisos · ${v.repairs.length} reparos)`);
    thinking.update(out.assistantText || 'Listo.', {
      telemetry: { ...out.telemetry, validation: { ok: v.ok, warnings: v.warnings.length, repairs: v.repairs.length } },
      warnings: v.warnings,
    });
    return { out, v };
  } catch (err) {
    thinking.update('Error: ' + err.message, { error: true });
    bridge()?.log('err', `Motor ${id}: ${err.message}`);
    return null;
  }
}

async function onSend() {
  const input = $('chatInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  addMsg('user', prompt);
  input.value = '';
  await runEngine(engineId, prompt);
}

async function onCompare() {
  const input = $('chatInput');
  const prompt = input.value.trim();
  if (!prompt) { addMsg('ai', 'Escribe un prompt para comparar ambos motores.'); return; }
  addMsg('user', prompt + '   ⟶ comparar A vs B');
  input.value = '';
  addMsg('ai', '⇄ Comparativa — corriendo el mismo prompt en ambos motores. El editor queda con el resultado de B.');
  const a = await runEngine('A', prompt);
  const b = await runEngine('B', prompt);
  const la = a?.out?.telemetry?.latency_ms ?? '—';
  const lb = b?.out?.telemetry?.latency_ms ?? '—';
  const wa = a?.v?.warnings.length ?? '—';
  const wb = b?.v?.warnings.length ?? '—';
  addMsg('ai', `Resumen comparativa →  A: ${la} ms, ${wa} avisos   |   B: ${lb} ms, ${wb} avisos.`);
}

function onCollapse() {
  const p = $('chatPanel');
  p?.classList.toggle('collapsed');
  const r = $('chatReopenBtn');
  if (r) r.style.display = p?.classList.contains('collapsed') ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  if (!$('chatPanel')) return;
  document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setEngine(b.dataset.engine)));
  $('chatSendBtn')?.addEventListener('click', onSend);
  $('chatCompareBtn')?.addEventListener('click', onCompare);
  $('chatCollapseBtn')?.addEventListener('click', onCollapse);
  $('chatReopenBtn')?.addEventListener('click', onCollapse);
  $('chatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
  });
  updateSwitchUI();
  addMsg('ai', 'Asistente listo. Elige el motor arriba (A: geometría IA · B: lógica booleana) y describe el programa. Con Motor B sin backend puedes escribir ecuaciones directamente, p. ej.  Q10 = (I1 + Q10) * !I2');
});
