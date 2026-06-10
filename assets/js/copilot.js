// ============================================================
// LADDERVOICE COPILOT — Práctica 4 (Prompting y Copilotos)
// Frontend estilo ChatGPT sobre FastAPI + Ollama.
// Perfiles de esfuerzo: Instantánea / Media / Alta (+ Genérico).
// ============================================================

// ---------- Configuración ----------
const DEFAULT_API_BASE = 'http://localhost:8000';
const CHAT_TIMEOUT_MS = 180000;

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
  ladder: 'Diseña la lógica ladder para el siguiente proceso (descríbeme cada rung con sus elementos y direcciones):\n\nProceso: ',
  concepto: 'Explícame con un ejemplo sencillo, para un estudiante de primer semestre, qué es ',
  depura: 'Analiza este error y propón una corrección paso a paso:\n\n',
  escribe: 'Mejora la redacción de este texto técnico manteniendo su significado:\n\n',
};

// ---------- Estado ----------
let profiles = { ...FALLBACK_PROFILES };
let currentProfile = localStorage.getItem('lv_copilot_profile') || 'media';
let isBusy = false;

// ---------- Referencias DOM ----------
const $ = id => document.getElementById(id);

const mainEl = $('cpMain');
const threadEl = $('cpThread');
const inputEl = $('cpInput');
const sendBtn = $('cpSendBtn');
const sendIcon = $('cpSendIcon');
const micBtn = $('cpMicBtn');
const plusBtn = $('cpPlusBtn');
const plusMenu = $('cpPlusMenu');
const effortBtn = $('cpEffortBtn');
const effortMenu = $('cpEffortMenu');
const effortLabel = $('cpEffortLabel');
const drawer = $('cpDrawer');
const scrim = $('cpScrim');
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
// NAVBAR + TEMA (mismo comportamiento que main.js)
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

(function initTheme() {
  const tb = $('theme-toggle');
  if (!tb) return;
  const ic = tb.querySelector('i');
  if (localStorage.getItem('lv_theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    if (ic) ic.className = 'fa-solid fa-sun';
  }
  tb.addEventListener('click', () => {
    const isLight = document.documentElement.dataset.theme === 'light';
    document.documentElement.dataset.theme = isLight ? '' : 'light';
    localStorage.setItem('lv_theme', isLight ? '' : 'light');
    if (ic) ic.className = isLight ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
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
    // Sin backend: se conservan las plantillas locales.
  }
  if (!profiles[currentProfile]) currentProfile = 'media';
  populateProfileSelect();
  applyProfile(currentProfile);
}

async function checkHealth() {
  if (!backendPillText) return;
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    backendPillText.textContent = data.ollama ? 'En línea' : 'Sin Ollama';
  } catch (_) {
    backendPillText.textContent = 'Backend offline';
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

// Renderiza texto plano separando bloques ```código```
function renderBody(container, text) {
  const parts = String(text).split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      // quita la etiqueta de lenguaje de la primera línea (```python)
      pre.textContent = part.replace(/^[a-zA-Z0-9+#-]*\n/, '');
      container.appendChild(pre);
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      container.appendChild(span);
    }
  });
}

function addAssistantMessage(text, meta) {
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';

  const role = document.createElement('div');
  role.className = 'cp-msg-role';
  role.innerHTML = '<i class="fa-solid fa-robot"></i>';
  role.appendChild(document.createTextNode(`Copiloto · ${meta?.copilot_label || profiles[currentProfile]?.label || ''}`));
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
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';
  const role = document.createElement('div');
  role.className = 'cp-msg-role';
  role.innerHTML = '<i class="fa-solid fa-file-lines"></i>';
  role.appendChild(document.createTextNode(`Instrucción de sistema activa — ${p?.label || currentProfile}`));
  const msg = document.createElement('div');
  msg.className = 'cp-msg';
  const pre = document.createElement('pre');
  pre.textContent = cfg.system.value.trim() || p?.system_prompt || '';
  msg.appendChild(pre);
  row.append(role, msg);
  threadEl.appendChild(row);
  setEmptyState();
  scrollToBottom();
}

function addTypingIndicator() {
  const row = document.createElement('div');
  row.className = 'cp-msg-row ai';
  row.id = 'cpTypingRow';
  row.innerHTML = `
    <div class="cp-msg-role"><i class="fa-solid fa-robot"></i>Copiloto · ${escapeHtml(profiles[currentProfile]?.label || '')}</div>
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
// ENVÍO AL BACKEND
// ============================================================
function buildPayload(message) {
  return {
    message,
    model: cfg.model.value.trim() || 'llama3.2:3b',
    copilot_profile: currentProfile,
    system_prompt: cfg.system.value.trim() || null,
    temperature: parseFloat(cfg.temperature.value),
    top_p: parseFloat(cfg.topP.value),
    num_predict: parseInt(cfg.numPredict.value, 10),
    num_ctx: parseInt(cfg.numCtx.value, 10),
    repeat_penalty: parseFloat(cfg.repeat.value),
    keep_alive: '5m',
  };
}

async function sendMessage() {
  const message = inputEl.value.trim();
  if (!message || isBusy) return;

  isBusy = true;
  inputEl.value = '';
  autosize();
  updateSendState();
  sendBtn.classList.add('busy');
  sendIcon.className = 'fa-solid fa-circle-notch';

  addUserMessage(message);
  addTypingIndicator();

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
             'Verifica que estén corriendo: 1) ollama serve, 2) uvicorn main:app --reload --port 8000 (carpeta backend).';
    }
    addErrorMessage('Error: ' + hint);
  } finally {
    isBusy = false;
    sendBtn.classList.remove('busy');
    updateSendState();
    checkHealth();
    inputEl.focus();
  }
}

// ============================================================
// COMPOSITOR (textarea, enviar, chips)
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
    inputEl.value = CHIP_TEMPLATES[chip.dataset.chip] || '';
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
}

plusBtn.addEventListener('click', e => {
  e.stopPropagation();
  effortMenu.hidden = true;
  plusMenu.hidden = !plusMenu.hidden;
});

effortBtn.addEventListener('click', e => {
  e.stopPropagation();
  plusMenu.hidden = true;
  effortMenu.hidden = !effortMenu.hidden;
});

document.addEventListener('click', closeMenus);
plusMenu.addEventListener('click', e => e.stopPropagation());
effortMenu.addEventListener('click', e => e.stopPropagation());

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
// DICTADO POR VOZ (Web Speech API)
// ============================================================
(function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.title = 'Dictado no soportado en este navegador (usa Chrome o Edge)';
    return;
  }

  let recognizing = false;
  let baseText = '';
  const rec = new SR();
  rec.lang = 'es-MX';
  rec.interimResults = true;
  rec.continuous = false;

  rec.onresult = e => {
    let transcript = '';
    for (const result of e.results) transcript += result[0].transcript;
    inputEl.value = (baseText ? baseText + ' ' : '') + transcript;
    autosize();
    updateSendState();
  };
  rec.onend = () => {
    recognizing = false;
    micBtn.classList.remove('recording');
    inputEl.focus();
  };
  rec.onerror = () => {
    recognizing = false;
    micBtn.classList.remove('recording');
  };

  micBtn.addEventListener('click', () => {
    if (recognizing) {
      rec.stop();
      return;
    }
    baseText = inputEl.value.trim();
    try {
      rec.start();
      recognizing = true;
      micBtn.classList.add('recording');
    } catch (_) { /* start() doble: ignorar */ }
  });
})();

// ============================================================
// INICIALIZACIÓN
// ============================================================
(function init() {
  const savedApi = localStorage.getItem('lv_api_base');
  if (savedApi) cfg.api.value = savedApi;

  populateProfileSelect();
  applyProfile(currentProfile);
  syncOutputs();
  updateSendState();
  setEmptyState();

  loadProfiles();
  checkHealth();
  inputEl.focus();
})();

console.log('%cLadderVoice Copilot — Práctica 4', 'color:#3b9eff;font-size:1.05rem;font-weight:bold;');
