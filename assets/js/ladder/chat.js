/**
 * chat.js — Panel de asistente IA del editor ladder.
 *
 * Arquitectura única: el usuario describe el programa en lenguaje natural,
 * la IA devuelve el JSON lógico simple (ver CONTRACT.md), el front lo valida,
 * compila a geometría y lo aplica al editor vía window.LadderEditor.
 */
import { generateProgram } from './generate.js';

const PROFILE_URL = 'assets/devices/maletin_basico.json';
let profile = null;

const $ = (id) => document.getElementById(id);
const bridge = () => window.LadderEditor;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  if (opts.error) {
    let html = `<div class="cmsg-text err">${esc(text)}</div>`;
    if (opts.errors && opts.errors.length) html += listHtml('Errores de validación', opts.errors);
    return html;
  }
  let html = `<div class="cmsg-text">${esc(text)}</div>`;
  if (opts.telemetry) html += telemetryHtml(opts.telemetry);
  if (opts.warnings && opts.warnings.length) html += listHtml(`${opts.warnings.length} aviso(s)`, opts.warnings);
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

// ── Generar ───────────────────────────────────────────────────
async function onSend() {
  const input = $('chatInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  addMsg('user', prompt);
  input.value = '';

  const thinking = addMsg('ai', 'Interpretando y generando el programa…');
  try {
    const out = await generateProgram(prompt, profile);
    bridge()?.setProgram(out.program);
    bridge()?.log('ok', `Programa aplicado (${out.program.rungs.length} rungs · ${out.warnings.length} avisos)`);
    thinking.update(
      `Listo: ${out.program.metadata?.name || 'programa'} — ${out.program.rungs.length} rung(s).`,
      { telemetry: out.telemetry, warnings: out.warnings },
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
  addMsg('ai', 'Asistente listo. Describe el programa en lenguaje natural (p. ej. "la lámpara verde prende con el botón verde o el selector, y se apaga con el paro de emergencia").');
});
