/* ============================================================
   LadderLab — app.js
   Interacciones del editor de ladder
   ============================================================ */

'use strict';

// ── Estado de la aplicación ─────────────────────────────────
const state = {
  selectedRung: 1,
  selectedComp: 'contact_no',
  rungCount: 3,
  tabs: ['terminal', 'io', 'watch', 'xref'],
};

// Datos de propiedades por rung (mock)
const rungProps = {
  1: { title: 'Rung 1 — Contacto NC', addr: 'I0.1',  symbol: 'SENSOR_T',  type: 'Contacto NC', comment: 'Sensor temperatura',     state: true  },
  2: { title: 'Rung 2 — Timer TON',   addr: 'T0',    symbol: 'TIMER_A',   type: 'Contacto NO', comment: 'Timer arranque válvula', state: false },
  3: { title: 'Rung 3 — Bobina S',    addr: 'Q0.2',  symbol: 'ALARMA',    type: 'Bobina S',    comment: 'Alarma temperatura alta', state: false },
};

// ── Selección de rung ────────────────────────────────────────
function selectRung(n) {
  // Quitar selección previa
  document.querySelectorAll('.rung').forEach(r => r.classList.remove('selected'));

  // Seleccionar el rung clickeado
  const rung = document.getElementById('rung-' + n);
  if (!rung) return;
  rung.classList.add('selected');
  state.selectedRung = n;

  // Actualizar panel de propiedades
  const props = rungProps[n];
  if (props) {
    document.getElementById('propTitle').textContent   = props.title;
    document.getElementById('propAddr').value          = props.addr;
    document.getElementById('propSymbol').value        = props.symbol;
    document.getElementById('propComment').value       = props.comment;

    const typeSelect = document.getElementById('propType');
    for (let opt of typeSelect.options) {
      if (opt.value === props.type || opt.text === props.type) {
        opt.selected = true;
        break;
      }
    }

    const stateEl = document.getElementById('propState');
    stateEl.textContent = props.state ? 'TRUE' : 'FALSE';
    stateEl.className   = 'pp-state-val ' + (props.state ? 'on' : 'off');
  }
}

// ── Agregar rung ────────────────────────────────────────────
function addRung() {
  state.rungCount++;
  const n = state.rungCount;

  const rungArea = document.getElementById('rungArea');
  const addBtn   = rungArea.querySelector('.rung-add');

  const rung = document.createElement('div');
  rung.className = 'rung';
  rung.id = 'rung-' + n;
  rung.setAttribute('role', 'listitem');
  rung.setAttribute('tabindex', '0');
  rung.setAttribute('aria-label', 'Rung ' + n + ': nuevo rung vacío');
  rung.onclick = () => selectRung(n);

  rung.innerHTML = `
    <div class="rung-num">${n}</div>
    <div class="rung-inner">
      <div class="rung-comment">Nuevo rung</div>
      <div class="rung-canvas">
        <div class="power-rail"></div>
        <div class="wire flex"></div>
        <div style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono);padding:0 12px;">
          — rung vacío — arrastra un componente aquí —
        </div>
        <div class="wire flex"></div>
        <div class="power-rail"></div>
      </div>
    </div>
  `;

  // Registrar props para el nuevo rung
  rungProps[n] = {
    title:   'Rung ' + n + ' — Nuevo',
    addr:    '',
    symbol:  '',
    type:    'Contacto NO',
    comment: '',
    state:   false,
  };

  rungArea.insertBefore(rung, addBtn);

  // Seleccionarlo automáticamente
  selectRung(n);

  // Scroll suave al nuevo rung
  rung.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Log en terminal
  addTerminalLine('info', `Rung ${n} agregado`);

  // Actualizar contador en toolbar
  updateRungCounter();
}

// ── Cambio de tab ────────────────────────────────────────────
function showTab(id, el) {
  // Ocultar todos los panels
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.remove('active');
    p.setAttribute('aria-hidden', 'true');
  });

  // Mostrar el panel seleccionado
  const panel = document.getElementById('tab-' + id);
  if (panel) {
    panel.classList.add('active');
    panel.removeAttribute('aria-hidden');
  }

  // Actualizar tabs
  document.querySelectorAll('.bb-tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  el.classList.add('active');
  el.setAttribute('aria-selected', 'true');
}

// ── Selección de componente en sidebar ───────────────────────
function setupSidebar() {
  document.querySelectorAll('.comp-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      state.selectedComp = item.dataset.type || '';
    });
  });
}

// ── Búsqueda en sidebar ──────────────────────────────────────
function setupSearch() {
  const input = document.querySelector('.sb-search input');
  if (!input) return;

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    document.querySelectorAll('.comp-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });

    // Mostrar/ocultar secciones vacías
    document.querySelectorAll('.sb-section').forEach(section => {
      let next = section.nextElementSibling;
      let visible = false;
      while (next && !next.classList.contains('sb-section')) {
        if (next.style.display !== 'none') visible = true;
        next = next.nextElementSibling;
      }
      section.style.display = visible ? '' : 'none';
    });
  });
}

// ── Agregar línea al terminal ────────────────────────────────
function addTerminalLine(type, msg) {
  const terminal = document.querySelector('#tab-terminal .terminal');
  if (!terminal) return;

  const now  = new Date();
  const time = now.toTimeString().slice(0, 8);
  const tags = { ok: '[OK]', info: '[INFO]', err: '[ERR]', warn: '[WARN]' };

  const line = document.createElement('div');
  line.className = 't-line ' + type;
  line.innerHTML = `
    <span class="t-ts">${time}</span>
    <span class="t-tag">${tags[type] || '[INFO]'}</span>
    <span class="t-msg">${msg}</span>
  `;

  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

// ── Actualizar contador de rungs en toolbar ──────────────────
function updateRungCounter() {
  const label = document.querySelector('.et-label');
  if (label) {
    label.textContent = `Programa principal — ${state.rungCount} rungs`;
  }
}

// ── Botones navbar (mock behavior) ──────────────────────────
function setupNavbarButtons() {
  const compileBtn = document.querySelector('.nb-btn.compile');
  const uploadBtn  = document.querySelector('.nb-btn.upload');
  const stopBtn    = document.querySelector('.nb-btn.danger');

  if (compileBtn) {
    compileBtn.addEventListener('click', () => {
      addTerminalLine('info', `Compilando ${state.rungCount} rungs...`);
      setTimeout(() => addTerminalLine('ok',   'Compilación exitosa — 0 errores'), 600);
      setTimeout(() => addTerminalLine('info', `${state.rungCount} rungs · ${state.rungCount * 2 + 1} variables`), 700);
      showTab('terminal', document.getElementById('tab-btn-terminal'));
    });
  }

  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
      addTerminalLine('info', 'Enviando programa al PLC 192.168.1.10:502...');
      setTimeout(() => addTerminalLine('ok', 'Programa cargado correctamente'), 900);
      setTimeout(() => addTerminalLine('ok', 'Modo RUN activo · Scan time: 2.3 ms'), 1000);
      showTab('terminal', document.getElementById('tab-btn-terminal'));
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      addTerminalLine('warn', 'Comando STOP enviado al PLC');
      showTab('terminal', document.getElementById('tab-btn-terminal'));
    });
  }
}

// ── Keyboard navigation para rungs ──────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'ArrowDown' || e.key === 'j') {
      const next = Math.min(state.selectedRung + 1, state.rungCount);
      selectRung(next);
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      const prev = Math.max(state.selectedRung - 1, 1);
      selectRung(prev);
    }
  });
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupSidebar();
  setupSearch();
  setupNavbarButtons();
  setupKeyboard();
  selectRung(1);

  // Simular scan time fluctuante
  const scanEl = document.querySelector('.bb-scan span');
  if (scanEl) {
    setInterval(() => {
      const val = (1.8 + Math.random() * 1.2).toFixed(1);
      scanEl.textContent = val + ' ms';
    }, 2000);
  }
});
