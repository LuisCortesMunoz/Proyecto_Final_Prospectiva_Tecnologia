// ============================
// CONFIGURACION BACKEND
// ============================
// URL real de Render, sin slash al final.
const BACKEND_BASE_URL = 'https://backend-render-prospectiva-tecnologia.onrender.com';
const VOZ_A_LADDER_URL = `${BACKEND_BASE_URL}/voz-a-ladder`;

// Si quieres que se abra el editor automáticamente al terminar, cambia a true.
const AUTO_OPEN_LADDER = false;

// ============================
// NAVBAR DROPDOWN
// ============================
(function initNavbar() {
  const btn = document.getElementById('onav-logo-btn');
  const dd = document.getElementById('onav-dropdown');

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

    if (ic) {
      ic.className = isLight ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    }
  });
})();

// ============================
// VOICE INTERFACE CON STT + LADDER
// ============================
(function initVoice() {
  const micBtn = document.getElementById('micBtn');
  const micIcon = document.getElementById('micIcon');
  const waveform = document.getElementById('voiceWaveform');
  const statusEl = document.getElementById('voiceStatus');
  const statusTxt = document.getElementById('statusText');
  const hintEl = document.getElementById('voiceHint');
  const convo = document.getElementById('conversation');

  if (!micBtn) return;

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let activeStream = null;

  function setStatus(state, text) {
    micBtn.className = 'mic-orb' + (state ? ' ' + state : '');

    if (statusEl) {
      statusEl.className = 'voice-status' + (state ? ' ' + state : '');
    }

    if (micIcon) {
      micIcon.className = state === 'processing'
        ? 'fa-solid fa-circle-notch fa-spin'
        : state === 'listening'
          ? 'fa-solid fa-stop'
          : 'fa-solid fa-microphone';
    }

    if (statusTxt) {
      statusTxt.textContent = text;
    }

    if (waveform) {
      waveform.classList.toggle('active', state === 'listening');
    }

    if (hintEl) {
      const hints = {
        '': 'Toca el micrófono y dicta una instrucción',
        listening: 'Grabando... toca otra vez para detener',
        processing: 'Transcribiendo y generando Ladder...',
      };

      hintEl.textContent = hints[state] || hints[''];
    }
  }

  function addMessage(role, text, extraNode = null) {
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

    if (extraNode) {
      bubble.appendChild(extraNode);
    }

    convo.appendChild(bubble);
    convo.scrollTop = convo.scrollHeight;
  }

  function getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];

    for (const type of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return '';
  }

  function getFileExtension(mimeType) {
    if (!mimeType) return 'webm';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('wav')) return 'wav';
    return 'webm';
  }

  function encodeProgramToURL(program) {
    const json = JSON.stringify(program);
    const bytes = new TextEncoder().encode(json);

    let binary = '';
    for (const b of bytes) {
      binary += String.fromCharCode(b);
    }

    // Base64 URL-safe: debe coincidir con codec.js (decode). Sin +, / ni =
    // para que el parametro ?l= no se corrompa al leerlo en el editor.
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function openProgramInLadder(program) {
    const encoded = encodeProgramToURL(program);
    window.location.href = `ladder.html?l=${encoded}`;
  }

  function createOpenLadderButton(program) {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '12px';

    const btn = document.createElement('button');
    btn.textContent = 'Abrir en Editor Ladder';
    btn.type = 'button';
    btn.style.cursor = 'pointer';
    btn.style.border = '0';
    btn.style.borderRadius = '999px';
    btn.style.padding = '10px 14px';
    btn.style.fontWeight = '700';

    btn.addEventListener('click', () => {
      openProgramInLadder(program);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  async function enviarAudioAVozLadder(audioBlob, mimeType) {
    const extension = getFileExtension(mimeType || audioBlob.type || 'audio/webm');

    const formData = new FormData();
    formData.append('audio', audioBlob, `comando_voz.${extension}`);

    const response = await fetch(VOZ_A_LADDER_URL, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const detail = data?.detail || `Error HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data;
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addMessage('ai', 'Tu navegador no permite grabar audio. Prueba en Chrome o Edge con HTTPS.');
      return;
    }

    try {
      const mimeType = getSupportedMimeType();

      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];

      const options = mimeType ? { mimeType } : undefined;
      mediaRecorder = new MediaRecorder(activeStream, options);

      mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        try {
          const finalMimeType = mediaRecorder.mimeType || mimeType || 'audio/webm';
          const audioBlob = new Blob(audioChunks, { type: finalMimeType });

          if (activeStream) {
            activeStream.getTracks().forEach(track => track.stop());
            activeStream = null;
          }

          if (!audioBlob.size) {
            throw new Error('No se grabó audio. Intenta de nuevo.');
          }

          setStatus('processing', 'Procesando...');
          addMessage('ai', 'Audio recibido. Transcribiendo y generando programa Ladder...');

          const data = await enviarAudioAVozLadder(audioBlob, finalMimeType);

          const texto = data.texto || data.stt?.texto || '';
          const ladder = data.ladder;
          const program = ladder?.program;

          addMessage('user', texto || '(transcripción vacía)');

          if (!program) {
            throw new Error('El backend respondió, pero no regresó un programa Ladder válido.');
          }

          const resumen = `Programa generado: ${ladder.nombre}. Rungs: ${ladder.rungs}. Variables: ${ladder.variables}.`;

          if (AUTO_OPEN_LADDER) {
            addMessage('ai', resumen + ' Abriendo editor Ladder...');
            openProgramInLadder(program);
          } else {
            addMessage('ai', resumen, createOpenLadderButton(program));
          }

          setStatus('', 'Listo');

        } catch (err) {
          console.error(err);
          addMessage('ai', 'Error: ' + err.message);
          setStatus('', 'Error');

        } finally {
          isRecording = false;
          audioChunks = [];
        }
      };

      mediaRecorder.start();
      isRecording = true;
      setStatus('listening', 'Grabando...');

    } catch (err) {
      console.error(err);
      addMessage('ai', 'No pude iniciar el micrófono: ' + err.message);
      setStatus('', 'Error');
      isRecording = false;

      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
        activeStream = null;
      }
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      setStatus('processing', 'Procesando...');
    }
  }

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  setStatus('', 'Listo');
})();

console.log('%cLadderVoice — Proyecto Final', 'color:#3b9eff;font-size:1.1rem;font-weight:bold;');