// ============================
// NAVBAR DROPDOWN
// ============================
(function initNavbar() {
  const btn  = document.getElementById('onav-logo-btn');
  const dd   = document.getElementById('onav-dropdown');
  if (!btn || !dd) return;
  const wrap = btn.closest('.onav-logo-wrap');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dd.hidden = !dd.hidden;
    btn.classList.toggle('open', !dd.hidden);
  });
  wrap.addEventListener('mouseenter', () => { dd.hidden = false; btn.classList.add('open'); });
  wrap.addEventListener('mouseleave', () => { dd.hidden = true;  btn.classList.remove('open'); });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) { dd.hidden = true; btn.classList.remove('open'); }
  });
})();

// ============================
// THEME TOGGLE
// ============================
(function initTheme() {
  const tb = document.getElementById('theme-toggle');
  if (!tb) return;
  const ic = tb.querySelector('i');
  const saved = localStorage.getItem('lv_theme');
  if (saved === 'light') {
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

// ============================
// VOICE INTERFACE (index.html)
// ============================
(function initVoice() {
  const micBtn    = document.getElementById('micBtn');
  const micIcon   = document.getElementById('micIcon');
  const waveform  = document.getElementById('voiceWaveform');
  const statusEl  = document.getElementById('voiceStatus');
  const statusTxt = document.getElementById('statusText');
  const hintEl    = document.getElementById('voiceHint');
  const convo     = document.getElementById('conversation');

  if (!micBtn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;

  function setStatus(state, text) {
    micBtn.className   = 'mic-orb' + (state ? ' ' + state : '');
    statusEl.className = 'voice-status' + (state ? ' ' + state : '');
    if (micIcon) micIcon.className = state === 'processing'
      ? 'fa-solid fa-circle-notch fa-spin'
      : 'fa-solid fa-microphone';
    if (statusTxt) statusTxt.textContent = text;
    if (waveform) waveform.classList.toggle('active', state === 'listening');
    if (hintEl) {
      const hints = {
        '': 'Toca el micrófono y dicta una instrucción',
        listening: 'Escuchando... habla ahora',
        processing: 'Procesando tu comando...',
      };
      hintEl.textContent = hints[state] || hints[''];
    }
  }

  function addMessage(role, text) {
    if (!convo) return;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble ' + role;
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? 'Tú' : 'Asistente';
    const body = document.createElement('div');
    body.textContent = text;
    bubble.appendChild(label);
    bubble.appendChild(body);
    convo.appendChild(bubble);
    convo.scrollTop = convo.scrollHeight;
  }

  if (!SpeechRecognition) {
    setStatus('', 'Listo');
    addMessage('ai', 'Tu navegador no soporta Web Speech API. Prueba en Chrome o Edge.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-MX';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    isListening = true;
    setStatus('listening', 'Escuchando...');
  };

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    addMessage('user', transcript);
    setStatus('processing', 'Procesando...');
    setTimeout(() => {
      addMessage('ai', 'Recibido: "' + transcript + '". (Integración con agente IA pendiente)');
      setStatus('', 'Listo');
      isListening = false;
    }, 900);
  };

  recognition.onerror = (e) => {
    const msgs = { 'no-speech': 'No se detectó voz', 'not-allowed': 'Micrófono bloqueado', 'network': 'Error de red' };
    setStatus('', msgs[e.error] || 'Error: ' + e.error);
    isListening = false;
  };

  recognition.onend = () => {
    if (isListening) {
      setStatus('', 'Listo');
      isListening = false;
    }
  };

  micBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
      } catch (err) {
        setStatus('', 'Error al iniciar el micrófono');
      }
    }
  });

  setStatus('', 'Listo');
})();

console.log('%cLadderVoice — Proyecto Final', 'color:#3b9eff;font-size:1.1rem;font-weight:bold;');
