// ============================================================
// LADDERVOICE COPILOT — Práctica 4 (Prompting y Copilotos)
// Frontend estilo ChatGPT sobre FastAPI + Ollama.
// Perfiles de esfuerzo: Instantánea / Media / Alta (+ Genérico).
// Modo Diseñador: arquitectura única (ver CONTRACT.md). El prompt
// pasa por window.LadderGen.generate (→ /generar-logica → JSON lógico
// simple → compilación en el front) y abre el programa en el editor.
// ============================================================

// ---------- Configuración ----------
// Backend en la nube (Render + Groq), el mismo que usa el modo Diseñador.
// Antes apuntaba a 'http://localhost:8000' (backend local con Ollama).
const DEFAULT_API_BASE = 'https://backend-render-prospectiva-tecnologia.onrender.com';
const CHAT_TIMEOUT_MS = 180000;

// El modo Diseñador genera el programa vía window.LadderGen (gen-bridge.js),
// que apunta al backend de Render. Render gratuito puede tardar en despertar.
const LADDER_TIMEOUT_MS = 150000;

// Copia local de los perfiles para que el selector y el panel
// funcionen aunque el backend aún no esté corriendo. Al cargar
// /profiles se reemplazan por los del backend (fuente de verdad).
const FALLBACK_PROFILES = {
  generico: {
    label: 'Genérico',
    description: 'Sin especializar, para comparar.',
    system_prompt: 'Eres un asistente académico claro, preciso y útil para estudiantes universitarios. Respondes siempre en español.',
    params: { temperature: 0.7, top_p: 0.9, num_predict: 300, num_ctx: 4096, repeat_penalty: 1.1 },
  },
  instantanea: {
    label: 'Instantánea',
    description: 'Respuestas rápidas y breves.',
    system_prompt: 'Eres LadderVoice Copilot en modo Instantánea. Responde en español, breve y directo.',
    params: { temperature: 0.4, top_p: 0.9, num_predict: 180, num_ctx: 2048, repeat_penalty: 1.1 },
  },
  media: {
    label: 'Media',
    description: 'Equilibrio entre rapidez y detalle.',
    system_prompt: 'Eres LadderVoice Copilot en modo Media. Responde en español con pasos numerados.',
    params: { temperature: 0.7, top_p: 0.9, num_predict: 450, num_ctx: 4096, repeat_penalty: 1.1 },
  },
  alta: {
    label: 'Alta',
    description: 'Razonamiento profundo para tareas complejas.',
    system_prompt: 'Eres LadderVoice Copilot en modo Alta. Analiza a fondo antes de responder, en español.',
    params: { temperature: 0.7, top_p: 0.9, num_predict: 900, num_ctx: 8192, repeat_penalty: 1.1 },
  },
};

const CHIP_TEMPLATES = {
  ladder: 'Genera un arranque-paro de motor con enclavamiento: botón de inicio I0.0, botón de paro I0.1 y motor en Q0.0.',
  concepto: 'Explícame con un ejemplo sencillo, para un estudiante de primer semestre, qué es ',
  depura: 'Analiza este error y propón una corrección paso a paso:\n\n',
  escribe: 'Mejora la redacción de este texto técnico manteniendo su significado:\n\n',
};

const LISTENING_PLACEHOLDER = 'Escuchando… habla ahora';

// ---------- Modos de operación ----------
// Capa adicional sobre la infraestructura existente: cada modo solo
// cambia el comportamiento de respuesta (prompt prioritario + ruta).
// - aprendizaje / practico: usan el chat actual (backend local + Ollama),
//   con instrucciones que les prohíben generar Ladder.
// - disenador: usa window.LadderGen.generate (arquitectura única) → editor.
const OPERATION_MODES = {
  aprendizaje: {
    label: 'Aprendizaje',
    icon: 'fa-solid fa-graduation-cap',
    placeholder: 'Pregunta un concepto de Ladder o PLCs…',
    system_prefix:
      'MODO APRENDIZAJE — instrucciones prioritarias de comportamiento:\n' +
      'Actúas como tutor educativo de programación Ladder y PLCs para principiantes. ' +
      'Tu función es únicamente educativa.\n' +
      '- Explica conceptos de Ladder: contactos NO/NC, bobinas, set/reset, timers TON/TOF, ' +
      'contadores CTU/CTD y enclavamientos (sello).\n' +
      '- Responde preguntas teóricas con ejemplos sencillos y analogías, y guía paso a paso.\n' +
      '- Cuando ayude al aprendizaje, termina con una pregunta breve para que el usuario practique.\n' +
      '- NO generes JSON, NO generes programas Ladder completos listos para usar y NO menciones ' +
      'envíos al editor. Si el usuario pide generar un programa, explica los conceptos involucrados ' +
      'y sugiérele cambiar al modo Diseñador.\n' +
      '- Responde únicamente en texto.',
  },
  practico: {
    label: 'Práctico',
    icon: 'fa-solid fa-screwdriver-wrench',
    placeholder: 'Plantea tu duda técnica o describe tu lógica…',
    system_prefix:
      'MODO PRÁCTICO — instrucciones prioritarias de comportamiento:\n' +
      'Actúas como asesor técnico de programación Ladder y automatización para usuarios intermedios.\n' +
      '- Resuelve dudas específicas y recomienda estructuras de programación ' +
      '(enclavamiento, prioridad del paro, interlocks, secuencias).\n' +
      '- Analiza las propuestas del usuario, detecta errores conceptuales y explica buenas prácticas ' +
      '(paro con contacto NC cableado, prioridad de paro sobre marcha, seguridad).\n' +
      '- Puedes describir en texto qué contactos, bobinas o bloques usar, pero NO generes JSON ' +
      'ni programas finales para el editor. Si el usuario quiere el programa ya generado, ' +
      'sugiérele cambiar al modo Diseñador.\n' +
      '- Responde principalmente en texto.',
  },
  disenador: {
    label: 'Diseñador',
    icon: 'fa-solid fa-diagram-project',
    placeholder: 'Describe el programa Ladder que quieres generar…',
    system_prefix: null, // este modo usa el generador Ladder, no el chat
  },
};

// Cada chip activa el modo que le corresponde
const CHIP_MODES = {
  ladder: 'disenador',
  concepto: 'aprendizaje',
  depura: 'practico',
  escribe: 'practico',
};

// ---------- Estado ----------
let profiles = { ...FALLBACK_PROFILES };
let currentProfile = localStorage.getItem('lv_copilot_profile') || 'media';
let currentMode = localStorage.getItem('lv_copilot_mode') || 'aprendizaje';
let isBusy = false;

// Contexto conversacional del modo Diseñador: el backend no guarda estado,
// así que el frontend recuerda el último programa generado y los prompts
// previos (se pasan como `contexto` a window.LadderGen.generate) para que
// instrucciones como "cámbialo" o "agrégale un paro" tengan referencia.
let lastLadderProgram = null; // JSON del último programa generado
let ladderPrompts = [];       // prompts previos del modo Diseñador

// ---------- Referencias DOM ----------
const $ = id => document.getElementById(id);

const mainEl = $('cpMain');
const threadEl = $('cpThread');
const inputEl = $('cpInput');
const sendBtn = $('cpSendBtn');
const sendIcon = $('cpSendIcon');
const micBtn = $('cpMicBtn');
const micHint = $('cpMicHint');
const plusBtn = $('cpPlusBtn');
const plusMenu = $('cpPlusMenu');
const effortBtn = $('cpEffortBtn');
const effortMenu = $('cpEffortMenu');
const effortLabel = $('cpEffortLabel');
const modeBtn = $('cpModeBtn');
const modeMenu = $('cpModeMenu');
const modeLabel = $('cpModeLabel');
const modeIcon = $('cpModeIcon');
const drawer = $('cpDrawer');
const scrim = $('cpScrim');
const backendPill = $('backendPill');
const backendPillText = $('backendPillText');

const cfg = {
  api: $('cfgApi'),
  model: $('cfgModel'),
  profile: $('cfgProfile'),
  system: $('cfgSystem'),
  temperature: $('cfgTemperature'),
  topP: $('cfgTopP'),
  numPredict: $('cfgNumPredict'),
  numCtx: $('cfgNumCtx'),
  repeat: $('cfgRepeat'),
};
const out = {
  temperature: $('outTemperature'),
  topP: $('outTopP'),
  numPredict: $('outNumPredict'),
  repeat: $('outRepeat'),
};

// ============================================================
// NAVBAR (mismo comportamiento que main.js)
// ============================================================
(function initNavbar() {
  const btn = $('onav-logo-btn');
  const dd = $('onav-dropdown');
  if (!btn || !dd) return;
  const wrap = btn.closest('.onav-logo-wrap');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    dd.hidden = !dd.hidden;
    btn.classList.toggle('open', !dd.hidden);
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) {
      dd.hidden = true;
      btn.classList.remove('open');
    }
  });
})();

// ============================================================
// PERFILES
// ============================================================
function apiBase() {
  return (cfg.api.value || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
}

function populateProfileSelect() {
  cfg.profile.innerHTML = '';
  for (const [id, p] of Object.entries(profiles)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    cfg.profile.appendChild(opt);
  }
  cfg.profile.value = currentProfile;
}

function applyProfile(id) {
  const p = profiles[id];
  if (!p) return;

  currentProfile = id;
  localStorage.setItem('lv_copilot_profile', id);

  effortLabel.textContent = p.label;
  cfg.profile.value = id;
  cfg.system.value = p.system_prompt;

  const prm = p.params || {};
  if (prm.temperature != null) cfg.temperature.value = prm.temperature;
  if (prm.top_p != null) cfg.topP.value = prm.top_p;
  if (prm.num_predict != null) cfg.numPredict.value = prm.num_predict;
  if (prm.num_ctx != null) cfg.numCtx.value = String(prm.num_ctx);
  if (prm.repeat_penalty != null) cfg.repeat.value = prm.repeat_penalty;
  syncOutputs();

  effortMenu.querySelectorAll('.cp-menu-item[data-profile]').forEach(item => {
    item.classList.toggle('selected', item.dataset.profile === id);
  });
  document.querySelectorAll('#cpEffortCards .cp-effort-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.profile === id);
  });
}

async function loadProfiles() {
  try {
    const res = await fetch(`${apiBase()}/profiles`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.profiles && Object.keys(data.profiles).length) {
      profiles = data.profiles;
    }
  } catch (_) {
    // Sin backend local: se conservan las plantillas locales.
  }
  if (!profiles[currentProfile]) currentProfile = 'media';
  populateProfileSelect();
  applyProfile(currentProfile);
}

// ---------- Indicador de estado del backend ----------
// Estados: ok (conectado), busy (generando), warn (modelo no
// disponible), error (sin conexión).
function setBackendStatus(state, text) {
  if (!backendPill) return;
  backendPill.className = 'onav-online cp-status-' + state;
  backendPillText.textContent = text;
}

async function checkHealth() {
  if (!backendPillText) return;
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    // Backend Groq (Render) responde {status:'ok'}; el viejo de Ollama, {ollama:true}.
    if (data.status === 'ok' || data.ollama) setBackendStatus('ok', 'Backend conectado');
    else setBackendStatus('warn', 'Modelo no disponible');
  } catch (_) {
    setBackendStatus('error', 'Error de conexión');
  }
}

// ============================================================
// MENSAJES
// ============================================================
function setEmptyState() {
  mainEl.classList.toggle('is-empty', threadEl.children.length === 0);
}

function scrollToBottom() {
  threadEl.scrollTop = threadEl.scrollHeight;
}

function addUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'cp-msg-row user';
  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  msg.textContent = text;
  row.appendChild(msg);
  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

// ------------------------------------------------------------
// Render de Markdown SEGURO (sin librerías): primero se escapa
// todo el HTML del modelo y después solo se insertan etiquetas
// generadas aquí (strong, em, code, h1-h3, ul/ol, p). Los bloques
// ``` van a <pre><code> vía textContent, nunca como HTML.
// ------------------------------------------------------------
function escapeMd(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Formato en línea: `código`, **negritas**, *cursivas*
function mdInline(s) {
  return escapeMd(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

// Convierte un fragmento de Markdown (sin fences) a HTML controlado
function mdToHtml(src) {
  const lines = String(src).split('\n');
  let html = '';
  let list = null;          // 'ul' | 'ol' abierta
  let para = [];            // líneas del párrafo en curso

  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushPara = () => {
    if (para.length) {
      html += `<p>${para.map(mdInline).join('<br>')}</p>`;
      para = [];
    }
  };

  for (const raw of lines) {
    const t = raw.trim();

    if (!t) { flushPara(); closeList(); continue; }

    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length;
      html += `<h${lvl}>${mdInline(h[2])}</h${lvl}>`;
      continue;
    }

    const ul = t.match(/^[-*•]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${mdInline(ul[1])}</li>`;
      continue;
    }

    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${mdInline(ol[1])}</li>`;
      continue;
    }

    closeList();
    para.push(t);
  }
  flushPara();
  closeList();
  return html;
}

// Renderiza la respuesta completa: alterna texto Markdown y ```código```
function renderBody(container, text) {
  const parts = String(text).split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Bloque de código: separa etiqueta de lenguaje de la 1.ª línea
      let lang = '';
      let code = part;
      const nl = part.indexOf('\n');
      if (nl > -1 && /^[a-zA-Z0-9+#_-]*$/.test(part.slice(0, nl).trim())) {
        lang = part.slice(0, nl).trim().toLowerCase();
        code = part.slice(nl + 1);
      }
      // JSON: se reformatea con sangría para que sea legible
      if (lang === 'json' || (!lang && /^\s*[{[]/.test(code))) {
        try {
          code = JSON.stringify(JSON.parse(code), null, 2);
          lang = lang || 'json';
        } catch (_) { /* no era JSON válido: se muestra tal cual */ }
      }
      const pre = document.createElement('pre');
      if (lang) pre.dataset.lang = lang;
      const codeEl = document.createElement('code');
      codeEl.textContent = code.replace(/\s+$/, '');
      pre.appendChild(codeEl);
      container.appendChild(pre);
    } else if (part.trim()) {
      const div = document.createElement('div');
      div.className = 'cp-md';
      div.innerHTML = mdToHtml(part);
      container.appendChild(div);
    }
  });
}

function addAssistantMessage(text, meta) {
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';

  const role = document.createElement('div');
  role.className = 'cp-msg-role';
  role.innerHTML = '<i class="fa-solid fa-robot"></i>';
  const modeName = OPERATION_MODES[currentMode]?.label || '';
  role.appendChild(document.createTextNode(
    `Copiloto · ${modeName} · ${meta?.copilot_label || profiles[currentProfile]?.label || ''}`
  ));
  row.appendChild(role);

  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  renderBody(msg, text);
  row.appendChild(msg);

  if (meta?.metrics) {
    const m = meta.metrics;
    const line = document.createElement('div');
    line.className = 'cp-msg-metrics';
    const items = [];
    items.push(`<span><i class="fa-solid fa-microchip"></i>${escapeHtml(meta.model || '')}</span>`);
    if (m.prompt_eval_count != null) items.push(`<span>entrada: ${m.prompt_eval_count} tok</span>`);
    if (m.eval_count != null) items.push(`<span>salida: ${m.eval_count} tok</span>`);
    if (m.backend_ms != null) items.push(`<span>latencia: ${(m.backend_ms / 1000).toFixed(1)} s</span>`);
    if (m.tokens_per_second != null) items.push(`<span>${m.tokens_per_second} tok/s</span>`);
    line.innerHTML = items.join('');
    row.appendChild(line);
  }

  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

function addErrorMessage(text) {
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai error';
  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  msg.textContent = text;
  row.appendChild(msg);
  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

function addSystemInfoMessage() {
  const p = profiles[currentProfile];
  const m = OPERATION_MODES[currentMode];
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';
  const role = document.createElement('div');
  role.className = 'cp-msg-role';
  role.innerHTML = '<i class="fa-solid fa-file-lines"></i>';
  role.appendChild(document.createTextNode(
    `Instrucción de sistema activa — ${m?.label || currentMode} · ${p?.label || currentProfile}`
  ));
  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  const pre = document.createElement('pre');
  pre.textContent = currentMode === 'disenador'
    ? 'El modo Diseñador no usa el chat local: envía tu instrucción al generador ' +
      'Ladder, que la IA convierte en un JSON lógico simple (ver CONTRACT.md); ' +
      'el front lo valida y compila a un programa listo para abrir en el editor.'
    : effectiveSystemPrompt();
  msg.appendChild(pre);
  row.append(role, msg);
  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

function addTypingIndicator(label) {
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';
  row.id = 'cpTypingRow';
  const defaultLabel = `Copiloto · ${OPERATION_MODES[currentMode]?.label || ''} · ${profiles[currentProfile]?.label || ''}`;
  row.innerHTML = `
    <div class="cp-msg-role"><i class="fa-solid fa-robot"></i>${escapeHtml(label || defaultLabel)}</div>
    <div class="cp-typing"><span></span><span></span><span></span></div>`;
  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

function removeTypingIndicator() {
  $('cpTypingRow')?.remove();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

// ============================================================
// GENERACIÓN LADDER (arquitectura única — window.LadderGen)
// ============================================================

// `out` es el resultado de window.LadderGen.generate:
//   { program, logic, warnings, telemetry }
function addLadderMessage(out) {
  const program = out.program;
  const symbols = program.symbol_table ? Object.keys(program.symbol_table).length : 0;

  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';

  const role = document.createElement('div');
  role.className = 'cp-msg-role';
  role.innerHTML = '<i class="fa-solid fa-diagram-project"></i>';
  role.appendChild(document.createTextNode('Generador Ladder'));
  row.appendChild(role);

  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  const lines = [
    `Programa generado: ${program.metadata?.name || 'sin nombre'}`,
    `Rungs: ${program.rungs.length} · Variables: ${symbols}`,
  ];
  if (out.warnings?.length) lines.push(`${out.warnings.length} aviso(s): ${out.warnings.join(' · ')}`);
  msg.textContent = lines.join('\n');
  row.appendChild(msg);

  const actions = document.createElement('div');
  actions.className = 'cp-msg-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'cp-action-btn';
  openBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i> Abrir en Editor Ladder';
  openBtn.addEventListener('click', () => {
    // Pestaña nueva: si navegáramos aquí mismo se perdería el historial
    // del chat (el estado de la conversación vive solo en memoria).
    // `from=chat` hace que el editor muestre su botón "Volver al chat",
    // y conservar window.opener le permite re-enfocar esta pestaña.
    // Respaldo robusto: además de la URL (que puede truncarse en programas
    // grandes y perder el engine_config), dejamos el programa COMPLETO en
    // localStorage para que el editor lo recupere si la URL falla.
    try { localStorage.setItem('lv_handoff_program', JSON.stringify(program)); } catch { /* cuota llena */ }
    window.open(`ladder.html?l=${window.LadderGen.encodeProgramToURL(program)}&from=chat`, '_blank');
  });
  actions.appendChild(openBtn);

  // Visor del JSON de instrucciones Ladder generado
  const jsonPre = document.createElement('pre');
  jsonPre.className = 'cp-json';
  jsonPre.dataset.lang = 'json';
  jsonPre.hidden = true;
  jsonPre.textContent = JSON.stringify(program, null, 2);

  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.className = 'cp-action-btn ghost';
  jsonBtn.innerHTML = '<i class="fa-solid fa-code"></i> Ver JSON';
  jsonBtn.addEventListener('click', () => {
    jsonPre.hidden = !jsonPre.hidden;
    jsonBtn.innerHTML = jsonPre.hidden
      ? '<i class="fa-solid fa-code"></i> Ver JSON'
      : '<i class="fa-solid fa-code"></i> Ocultar JSON';
  });
  actions.appendChild(jsonBtn);

  row.appendChild(actions);
  row.appendChild(jsonPre);

  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

async function sendLadderRequest(message) {
  const isFollowUp = lastLadderProgram != null;
  addTypingIndicator(isFollowUp
    ? 'Generador Ladder · aplicando cambios…'
    : 'Generador Ladder · creando programa…');
  setBackendStatus('busy', 'Generando programa Ladder…');

  // Si ya hay un programa generado, se manda como contexto para que la IA
  // entienda instrucciones de modificación ("cámbialo", "agrégale un paro").
  let context = null;
  if (isFollowUp) {
    context = {
      programa_anterior: lastLadderProgram,
      historial: ladderPrompts.slice(-4),
    };
  }

  try {
    const out = await window.LadderGen.generate(message, {
      context,
      signal: AbortSignal.timeout(LADDER_TIMEOUT_MS),
    });
    removeTypingIndicator();

    addLadderMessage(out);
    lastLadderProgram = out.program;
    ladderPrompts.push(message);
    setBackendStatus('ok', 'Backend conectado');
  } catch (err) {
    removeTypingIndicator();
    setBackendStatus('error', 'Error de conexión');
    let hint = err.message;
    if (err.name === 'TimeoutError') {
      hint = 'El servidor de Render tardó demasiado (el plan gratuito se duerme y puede tardar ~1 min en despertar). Intenta de nuevo.';
    } else if (/Failed to fetch|NetworkError/i.test(err.message)) {
      hint = 'No se pudo conectar con el backend de Render. Revisa tu conexión a internet.';
    }
    // Si el JSON lógico no validó, listar los errores concretos del contrato.
    if (Array.isArray(err.logicErrors) && err.logicErrors.length) {
      hint += '\n• ' + err.logicErrors.join('\n• ');
    }
    addErrorMessage('Error al generar Ladder: ' + hint);
  }
}

// ============================================================
// CHAT (backend local — Práctica 4)
// ============================================================
function buildPayload(message) {
  return {
    message,
    model: cfg.model.value.trim() || 'llama3.2:3b',
    copilot_profile: currentProfile,
    system_prompt: effectiveSystemPrompt() || null,
    temperature: parseFloat(cfg.temperature.value),
    top_p: parseFloat(cfg.topP.value),
    num_predict: parseInt(cfg.numPredict.value, 10),
    num_ctx: parseInt(cfg.numCtx.value, 10),
    repeat_penalty: parseFloat(cfg.repeat.value),
    keep_alive: '5m',
  };
}

async function sendChatRequest(message) {
  addTypingIndicator();
  setBackendStatus('busy', 'Generando respuesta…');
  try {
    const res = await fetch(`${apiBase()}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(message)),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    const data = await res.json().catch(() => null);
    removeTypingIndicator();

    if (!res.ok) {
      const detail = data?.detail || `Error HTTP ${res.status}`;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }

    addAssistantMessage(data.reply, data);
  } catch (err) {
    removeTypingIndicator();
    let hint = err.message;
    if (err.name === 'TimeoutError') {
      hint = 'La petición tardó demasiado. Prueba el perfil Instantánea o un modelo más pequeño.';
    } else if (/Failed to fetch|NetworkError/i.test(err.message)) {
      hint = `No se pudo conectar con el backend en ${apiBase()}. ` +
             'Revisa tu conexión a internet. Si el servidor de Render estaba dormido, ' +
             'puede tardar ~1 min en despertar: vuelve a intentar.';
    }
    addErrorMessage('Error: ' + hint);
  } finally {
    checkHealth();
  }
}

// ============================================================
// ENVÍO (dispatcher)
// ============================================================
async function sendMessage() {
  const message = inputEl.value.trim();
  if (!message || isBusy) return;

  stopDictation(); // si el mic sigue abierto, se apaga al enviar

  isBusy = true;
  inputEl.value = '';
  autosize();
  updateSendState();
  sendBtn.classList.add('busy');
  sendIcon.className = 'fa-solid fa-circle-notch';

  addUserMessage(message);

  try {
    if (currentMode === 'disenador') {
      await sendLadderRequest(message);
    } else {
      await sendChatRequest(message);
    }
  } finally {
    isBusy = false;
    sendBtn.classList.remove('busy');
    updateSendState();
    inputEl.focus();
  }
}

// ============================================================
// COMPOSITOR (textarea, enviar, chips, modo ladder)
// ============================================================
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

function updateSendState() {
  const hasText = inputEl.value.trim().length > 0;
  sendBtn.disabled = isBusy || !hasText;
  if (!isBusy) sendIcon.className = 'fa-solid fa-arrow-up';
}

function applyMode(id) {
  if (!OPERATION_MODES[id]) id = 'aprendizaje';
  currentMode = id;
  localStorage.setItem('lv_copilot_mode', id);

  const m = OPERATION_MODES[id];
  modeLabel.textContent = m.label;
  modeIcon.className = m.icon;
  // En Diseñador la píldora se resalta: avisa que SÍ se generará Ladder.
  modeBtn.classList.toggle('active', id === 'disenador');

  modeMenu.querySelectorAll('.cp-menu-item[data-mode]').forEach(item => {
    item.classList.toggle('selected', item.dataset.mode === id);
  });
  document.querySelectorAll('#cpModeCards .cp-mode-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.mode === id);
  });

  if (!isListening()) inputEl.placeholder = m.placeholder;
}

// Prompt que realmente se envía en los modos de chat: las instrucciones
// del modo van primero (prioritarias) y debajo el perfil de esfuerzo
// (o el system prompt editado por el usuario en el panel).
function effectiveSystemPrompt() {
  const base = cfg.system.value.trim() || profiles[currentProfile]?.system_prompt || '';
  const prefix = OPERATION_MODES[currentMode]?.system_prefix;
  return (prefix ? `${prefix}\n\n${base}` : base).slice(0, 6000);
}

inputEl.addEventListener('input', () => { autosize(); updateSendState(); });
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener('click', sendMessage);

document.querySelectorAll('.cp-chip[data-chip]').forEach(chip => {
  chip.addEventListener('click', () => {
    const kind = chip.dataset.chip;
    applyMode(CHIP_MODES[kind] || currentMode);
    inputEl.value = CHIP_TEMPLATES[kind] || '';
    autosize();
    updateSendState();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });
});

// ============================================================
// MENÚS EMERGENTES
// ============================================================
function closeMenus() {
  plusMenu.hidden = true;
  effortMenu.hidden = true;
  modeMenu.hidden = true;
}

plusBtn.addEventListener('click', e => {
  e.stopPropagation();
  effortMenu.hidden = true;
  modeMenu.hidden = true;
  plusMenu.hidden = !plusMenu.hidden;
});

effortBtn.addEventListener('click', e => {
  e.stopPropagation();
  plusMenu.hidden = true;
  modeMenu.hidden = true;
  effortMenu.hidden = !effortMenu.hidden;
});

modeBtn.addEventListener('click', e => {
  e.stopPropagation();
  plusMenu.hidden = true;
  effortMenu.hidden = true;
  modeMenu.hidden = !modeMenu.hidden;
});

document.addEventListener('click', closeMenus);
plusMenu.addEventListener('click', e => e.stopPropagation());
effortMenu.addEventListener('click', e => e.stopPropagation());
modeMenu.addEventListener('click', e => e.stopPropagation());

modeMenu.querySelectorAll('.cp-menu-item[data-mode]').forEach(item => {
  item.addEventListener('click', () => {
    applyMode(item.dataset.mode);
    closeMenus();
    inputEl.focus();
  });
});

// Tarjetas del hero (modos y perfiles): mismo estado que las píldoras
document.querySelectorAll('#cpModeCards .cp-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    applyMode(card.dataset.mode);
    inputEl.focus();
  });
});
document.querySelectorAll('#cpEffortCards .cp-effort-card').forEach(card => {
  card.addEventListener('click', () => {
    applyProfile(card.dataset.profile);
    inputEl.focus();
  });
});

effortMenu.querySelectorAll('.cp-menu-item[data-profile]').forEach(item => {
  item.addEventListener('click', () => {
    applyProfile(item.dataset.profile);
    closeMenus();
    inputEl.focus();
  });
});

$('cpOpenSettings').addEventListener('click', () => { closeMenus(); openDrawer(); });
$('cpViewSystem').addEventListener('click', () => { closeMenus(); addSystemInfoMessage(); });
$('cpClearChat').addEventListener('click', () => {
  closeMenus();
  threadEl.innerHTML = '';
  lastLadderProgram = null; // limpiar chat también olvida el contexto Ladder
  ladderPrompts = [];
  setEmptyState();
  inputEl.focus();
});

// ============================================================
// DRAWER
// ============================================================
function openDrawer() {
  scrim.hidden = false;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  scrim.hidden = true;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
}
$('cpDrawerClose').addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrawer(); closeMenus(); }
});

function syncOutputs() {
  out.temperature.textContent = parseFloat(cfg.temperature.value).toFixed(2);
  out.topP.textContent = parseFloat(cfg.topP.value).toFixed(2);
  out.numPredict.textContent = cfg.numPredict.value;
  out.repeat.textContent = parseFloat(cfg.repeat.value).toFixed(2);
}
[cfg.temperature, cfg.topP, cfg.numPredict, cfg.repeat].forEach(el => {
  el.addEventListener('input', syncOutputs);
});

cfg.profile.addEventListener('change', () => applyProfile(cfg.profile.value));

$('cfgReloadTemplate').addEventListener('click', () => {
  const p = profiles[currentProfile];
  if (p) cfg.system.value = p.system_prompt;
});

cfg.api.addEventListener('change', () => {
  localStorage.setItem('lv_api_base', apiBase());
  loadProfiles();
  checkHealth();
});

// ============================================================
// DICTADO POR VOZ (Web Speech API) — interruptor on/off
// ============================================================
// - Un clic enciende; otro clic apaga INMEDIATAMENTE (rec.abort()
//   descarta resultados pendientes, así no sigue escribiendo).
// - `dictating` actúa de candado: los onresult que lleguen tarde
//   se ignoran y rec.start() nunca se llama dos veces.
let dictating = false;
let stopDictation = () => {};
let isListening = () => false;

(function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SR) {
    micBtn.disabled = true;
    micBtn.title = 'Dictado no soportado en este navegador (usa Chrome o Edge)';
    return;
  }

  let sessionBase = ''; // texto que ya había antes de empezar a dictar
  const rec = new SR();
  rec.lang = 'es-MX';
  rec.interimResults = true;
  rec.continuous = true; // sigue escuchando hasta que el usuario apague

  isListening = () => dictating;

  function joinText(base, extra) {
    if (!base) return extra;
    if (!extra) return base;
    return base + (/\s$/.test(base) ? '' : ' ') + extra;
  }

  function showHint(text, type) {
    if (!micHint) return;
    micHint.textContent = text || '';
    micHint.hidden = !text;
    micHint.className = 'cp-mic-hint' + (type ? ' ' + type : '');
  }

  function micUI(on) {
    micBtn.classList.toggle('recording', on);
    micBtn.title = on ? 'Detener dictado' : 'Dictar por voz';
    const icon = micBtn.querySelector('i');
    if (icon) icon.className = on ? 'fa-solid fa-stop' : 'fa-solid fa-microphone';
    inputEl.placeholder = on
      ? LISTENING_PLACEHOLDER
      : (OPERATION_MODES[currentMode]?.placeholder || 'Pregunta lo que quieras');
    if (on) {
      showHint('Escuchando… presiona de nuevo para detener.', 'listening');
    } else {
      showHint('');
    }
  }

  function startDictation() {
    if (dictating) return; // evita dobles arranques
    sessionBase = inputEl.value.trim();
    try {
      rec.start();
      dictating = true;
      micUI(true);
    } catch (_) {
      // InvalidStateError: ya había una sesión activa; se ignora.
    }
  }

  stopDictation = function () {
    if (!dictating) return;
    dictating = false; // primero el candado: onresult tardíos se ignoran
    try { rec.abort(); } catch (_) { /* sin sesión activa */ }
    micUI(false);
  };

  rec.onresult = e => {
    if (!dictating) return; // el usuario ya apagó: no escribir más
    let finalText = '';
    let interimText = '';
    for (const result of e.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    inputEl.value = joinText(sessionBase, (finalText + ' ' + interimText).trim());
    autosize();
    updateSendState();
  };

  rec.onend = () => {
    // Fin automático (silencio largo, red, etc.) sin pasar por el botón.
    if (dictating) {
      dictating = false;
      micUI(false);
    }
    inputEl.focus();
  };

  rec.onerror = e => {
    const wasDictating = dictating;
    dictating = false;
    micUI(false);
    if (!wasDictating && e.error === 'aborted') return;
    switch (e.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        showHint('Permiso de micrófono denegado. Actívalo desde el candado de la barra de direcciones.', 'error');
        break;
      case 'audio-capture':
        showHint('No se detectó ningún micrófono. Conecta uno e intenta de nuevo.', 'error');
        break;
      case 'network':
        showHint('Error de red en el servicio de voz. Revisa tu conexión.', 'error');
        break;
      case 'no-speech':
        showHint('No se escuchó nada. Intenta de nuevo.', 'error');
        break;
      case 'aborted':
        break; // apagado manual: no es un error
      default:
        showHint('Error del dictado: ' + e.error, 'error');
    }
  };

  micBtn.addEventListener('click', () => {
    if (dictating) stopDictation();
    else startDictation();
  });
})();

// ============================================================
// INICIALIZACIÓN
// ============================================================
(function init() {
  const savedApi = localStorage.getItem('lv_api_base');
  // Ignora URLs locales guardadas de la versión vieja (Ollama en localhost):
  // ahora el backend vive en la nube (Render). Solo se respeta un remoto real.
  if (savedApi && !/localhost|127\.0\.0\.1/.test(savedApi)) cfg.api.value = savedApi;

  populateProfileSelect();
  applyProfile(currentProfile);
  applyMode(currentMode);
  syncOutputs();
  updateSendState();
  setEmptyState();

  loadProfiles();
  checkHealth();
  inputEl.focus();
})();

console.log('%cLadderVoice Copilot — Práctica 4', 'color:#2e7de1;font-size:1.05rem;font-weight:bold;');
