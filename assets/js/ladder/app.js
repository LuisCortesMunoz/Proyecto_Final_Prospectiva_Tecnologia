/**
 * app.js — Orquestador del editor Ladder
 * Store reactivo + event handlers + render loop
 */

import { defaultProgram, newRung, newElement, validateProgram } from './schema.js';
import { exportToURL, importFromURL, pushToURL }                from './codec.js';
import { renderAllRungs, renderIOTable, renderWatchTable, renderXRefTable } from './renderer.js';

// ── Helpers ──────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('es-MX', { hour12: false });
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ── Store ────────────────────────────────────────────────
const store = (() => {
  let _prog   = importFromURL() ?? defaultProgram();
  let _sel    = { rungId: null, elementId: null };
  let _armed  = null;          // component type armed from sidebar
  let _log    = [{ ts: ts(), type: 'info', msg: 'LadderVoice editor listo — v1.0' }];
  const _subs = [];

  function notify() { _subs.forEach(fn => fn()); }

  return {
    subscribe(fn) { _subs.push(fn); },

    // ── Program ───────────────────────────────────────────
    getProgram() { return _prog; },

    setProgram(p) { _prog = p; notify(); },

    updateMeta(patch) {
      const p = deepClone(_prog);
      Object.assign(p.metadata, patch);
      _prog = p; notify();
    },

    addRung() {
      const p = deepClone(_prog);
      const r = newRung(p.rungs);
      p.rungs.push(r);
      _sel = { rungId: r.id, elementId: null };
      _prog = p; notify();
    },

    deleteRung(id) {
      const p = deepClone(_prog);
      p.rungs = p.rungs.filter(r => r.id !== id);
      if (_sel.rungId === id) _sel = { rungId: null, elementId: null };
      _prog = p; notify();
    },

    moveRung(id, dir) {
      const p   = deepClone(_prog);
      const idx = p.rungs.findIndex(r => r.id === id);
      if (idx < 0) return;
      const nxt = idx + dir;
      if (nxt < 0 || nxt >= p.rungs.length) return;
      [p.rungs[idx], p.rungs[nxt]] = [p.rungs[nxt], p.rungs[idx]];
      _prog = p; notify();
    },

    setRungComment(id, comment) {
      const p   = deepClone(_prog);
      const r   = p.rungs.find(r => r.id === id);
      if (r) r.comment = comment;
      _prog = p; notify();
    },

    // ── Elements ─────────────────────────────────────────
    addElement(rungId, type, atCol = null) {
      const p  = deepClone(_prog);
      const r  = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      const els = r.network[0].elements;
      let col;
      if (atCol !== null) {
        col = atCol;
      } else {
        // Default: contacts before coils, coils at the end
        const coilAt = els.findIndex(e => e.type.startsWith('coil'));
        col = coilAt >= 0 ? coilAt : els.length;
      }
      els.filter(e => e.pos.col >= col).forEach(e => e.pos.col++);
      const el = newElement(type, col);
      els.push(el);
      _sel   = { rungId, elementId: el.id };
      _armed = null;
      _prog  = p; notify();
    },

    // Agrega una nueva rama paralela al rung con un elemento inicial
    addParallelRow(rungId, type) {
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      // Las bobinas no van en ramas paralelas — convertir a contacto
      const safeType = type.startsWith('coil') ? 'contact_no' : type;
      const el = newElement(safeType, 0);
      r.network.push({ row: r.network.length, elements: [el] });
      _sel   = { rungId, elementId: el.id };
      _armed = null;
      _prog  = p; notify();
    },

    deleteElement(rungId, elId) {
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      for (const row of r.network) {
        const idx = row.elements.findIndex(e => e.id === elId);
        if (idx < 0) continue;
        row.elements.splice(idx, 1);
        const sorted = row.elements.slice().sort((a, b) => a.pos.col - b.pos.col);
        sorted.forEach((e, i) => e.pos.col = i);
        // Limpiar ramas vacías (excepto la fila 0)
        r.network = r.network.filter((row, i) => i === 0 || row.elements.length > 0);
        r.network.forEach((row, i) => row.row = i);
        break;
      }
      _sel  = { rungId, elementId: null };
      _prog = p; notify();
    },

    updateElement(rungId, elId, patch) {
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      // Buscar el elemento en todas las filas
      let found = false;
      for (const row of r.network) {
        const el = row.elements.find(e => e.id === elId);
        if (!el) continue;
        Object.assign(el, patch);
        found = true;
        break;
      }
      if (!found) return;
      // Auto-register new addresses as internal marks
      if (patch.address && !p.symbol_table[patch.address]) {
        p.symbol_table[patch.address] = {
          symbol: patch.address, type: 'BOOL',
          modbus: { fn: 'internal', address: null }, comment: '',
        };
      }
      _prog = p; notify();
    },

    // ── Selection ────────────────────────────────────────
    getSelection() { return _sel; },
    selectRung(id)         { _sel = { rungId: id, elementId: null }; notify(); },
    selectElement(rid, eid){ _sel = { rungId: rid, elementId: eid }; notify(); },
    clearSelection()        { _sel = { rungId: null, elementId: null }; notify(); },

    // ── Armed sidebar type ───────────────────────────────
    getArmed()    { return _armed; },
    arm(type)     { _armed = type; notify(); },
    disarm()      { _armed = null; notify(); },

    // ── Log (terminal) ───────────────────────────────────
    getLog() { return _log; },
    log(type, msg) {
      _log.push({ ts: ts(), type, msg });
      if (_log.length > 150) _log.shift();
      notify();
    },
  };
})();

// ── Toast ────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Render pipeline ──────────────────────────────────────
function renderTerminal() {
  const panel = document.getElementById('tab-terminal');
  if (!panel) return;
  const log = store.getLog();
  panel.innerHTML = `<div class="terminal">${
    log.map(l => `<div class="t-line ${l.type}">
      <span class="t-ts">${l.ts}</span>
      <span class="t-tag">[${l.type.toUpperCase()}]</span>
      <span class="t-msg">${esc(l.msg)}</span>
    </div>`).join('')
  }</div>`;
  panel.scrollTop = panel.scrollHeight;
}

function renderActiveTab(prog) {
  const activeTab = document.querySelector('.bb-tab.active')?.id?.replace('tab-btn-', '');
  if (!activeTab || activeTab === 'terminal') return;
  const panel = document.getElementById(`tab-${activeTab}`);
  if (!panel) return;
  if (activeTab === 'io')    panel.innerHTML = renderIOTable(prog);
  if (activeTab === 'watch') panel.innerHTML = renderWatchTable(prog);
  if (activeTab === 'xref')  panel.innerHTML = renderXRefTable(prog);
}

// ── Popup helpers ─────────────────────────────────────────
function positionPopup(popup, x, y) {
  popup.style.visibility = 'hidden';
  popup.style.display    = 'flex';
  const pw = popup.offsetWidth  || 224;
  const ph = popup.offsetHeight || 260;
  popup.style.display    = '';
  popup.style.visibility = '';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + pw + 8 > vw ? x - pw - 4 : x + 4;
  const top  = y + ph + 8 > vh ? y - ph - 4 : y + 4;
  popup.style.left = Math.max(4, left) + 'px';
  popup.style.top  = Math.max(4, top)  + 'px';
}

function showPropPopup(x, y) {
  const popup = document.getElementById('propPopup');
  if (!popup) return;
  fillPropPopup(store.getProgram(), store.getSelection());
  positionPopup(popup, x, y);
  popup.classList.add('visible');
}

function hidePropPopup() {
  document.getElementById('propPopup')?.classList.remove('visible');
}

function fillPropPopup(prog, sel) {
  const title   = document.getElementById('propTitle');
  const addr    = document.getElementById('propAddr');
  const sym     = document.getElementById('propSym');
  const typeSel = document.getElementById('propType');
  const comment = document.getElementById('propComment');
  const state   = document.getElementById('propState');
  const rungCmt = document.getElementById('propRungComment');

  if (!sel.rungId) {
    if (title) title.textContent = 'Propiedades';
    return;
  }
  const rung = prog.rungs.find(r => r.id === sel.rungId);
  if (!rung) return;

  if (rungCmt) rungCmt.value = rung.comment || '';

  if (!sel.elementId) {
    if (title) title.textContent = `Rung ${rung.id}`;
    if (addr)  addr.value  = '';
    if (sym)   sym.value   = '';
    if (comment) comment.value = '';
    if (state) { state.textContent = rung.enabled ? 'HABILITADO' : 'DESHABILITADO'; state.className = 'pp-state-val ' + (rung.enabled ? 'on' : 'off'); }
    return;
  }

  const el    = rung.network[0].elements.find(e => e.id === sel.elementId);
  if (!el) return;
  const entry = prog.symbol_table?.[el.address];

  if (title)   title.textContent = `${el.address || '?'} — ${el.type}`;
  if (addr)    addr.value    = el.address || '';
  if (sym)     sym.value     = entry?.symbol  || '';
  if (typeSel) typeSel.value = el.type;
  if (comment) comment.value = entry?.comment || '';
  if (state) {
    const en = prog.execution_state?.rung_states?.[String(rung.id)];
    state.textContent = en ? 'TRUE' : 'FALSE';
    state.className   = 'pp-state-val ' + (en ? 'on' : 'off');
  }
}

// ── Context menu (right-click) ────────────────────────────
function onContextMenu(e) {
  const elDiv  = e.target.closest('.ladder-el');
  const rungEl = e.target.closest('[data-rung-id]');
  if (!elDiv && !rungEl) return;   // let native menu work elsewhere
  e.preventDefault();
  if (elDiv) {
    store.selectElement(Number(elDiv.dataset.rungId), elDiv.dataset.elId);
  } else {
    store.selectRung(Number(rungEl.dataset.rungId));
  }
  showPropPopup(e.clientX, e.clientY);
}

function onDocumentMouseDown(e) {
  const popup = document.getElementById('propPopup');
  if (popup && !popup.contains(e.target)) hidePropPopup();
}

// ── Bottombar collapse ────────────────────────────────────
function toggleBottomBar() {
  document.getElementById('bottombar')?.classList.toggle('collapsed');
}
window.toggleBottomBar = toggleBottomBar;

// updatePropertyPanel is now a no-op kept for render() compatibility
function updatePropertyPanel() {}

function updateSidebarArmed() {
  const armed = store.getArmed();
  document.querySelectorAll('.comp-item').forEach(el => {
    el.classList.toggle('active', el.dataset.type === armed);
  });
}

function updateEtLabel(prog) {
  const el = document.querySelector('.et-label');
  if (el) el.textContent = `${prog.metadata.name} — ${prog.rungs.length} rung${prog.rungs.length !== 1 ? 's' : ''}`;
}

function render() {
  const prog = store.getProgram();
  const sel  = store.getSelection();

  const rungArea = document.getElementById('rungArea');
  if (rungArea) renderAllRungs(rungArea, prog, sel);

  renderTerminal();
  renderActiveTab(prog);
  updatePropertyPanel(prog, sel);
  updateSidebarArmed();
  updateEtLabel(prog);
}

store.subscribe(render);

// ── Event delegation: rung area ──────────────────────────
function onRungAreaClick(e) {
  const elDiv  = e.target.closest('.ladder-el');
  const rungEl = e.target.closest('[data-rung-id]');
  const addBtn = e.target.closest('#btn-add-rung');

  if (addBtn) {
    const armed = store.getArmed();
    if (armed && store.getSelection().rungId) {
      store.addElement(store.getSelection().rungId, armed);
    } else {
      store.addRung();
      store.log('info', `Rung ${store.getProgram().rungs.slice(-1)[0]?.id} agregado`);
    }
    return;
  }

  if (elDiv) {
    const rungId = Number(elDiv.dataset.rungId);
    const elId   = elDiv.dataset.elId;
    const armed  = store.getArmed();
    if (armed) {
      store.addElement(rungId, armed);
    } else {
      store.selectElement(rungId, elId);
    }
    return;
  }

  if (rungEl) {
    const rid   = Number(rungEl.dataset.rungId);
    const armed = store.getArmed();
    if (armed) {
      store.addElement(rid, armed);
    } else {
      store.selectRung(rid);
    }
  }
}

// ── Sidebar: arm component ───────────────────────────────
function onSidebarClick(e) {
  const item = e.target.closest('.comp-item');
  if (!item) return;
  const type = item.dataset.type;
  if (!type) return;
  const currently = store.getArmed();
  if (currently === type) {
    store.disarm();
  } else {
    store.arm(type);
    // If a rung is selected, add immediately
    const sel = store.getSelection();
    if (sel.rungId) {
      store.addElement(sel.rungId, type);
      showToast(`${type} agregado al rung ${sel.rungId}`, 'success');
    } else {
      showToast('Selecciona un rung para insertar el componente', 'info');
    }
  }
}

// ── Drag-and-drop ────────────────────────────────────────
// Calculates which column to insert at based on mouse X over the rung canvas
function calcInsertCol(rungId, clientX) {
  const prog = store.getProgram();
  const rung = prog.rungs.find(r => r.id === rungId);
  if (!rung) return 0;
  const sorted = rung.network[0].elements.slice().sort((a, b) => a.pos.col - b.pos.col);
  for (const el of sorted) {
    const dom = document.querySelector(`[data-el-id="${el.id}"]`);
    if (!dom) continue;
    const rect = dom.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return el.pos.col;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1].pos.col + 1 : 0;
}

// Shows a vertical blue line indicating where the element will be inserted
function showDropIndicator(canvas, clientX) {
  removeDropIndicator(canvas);
  const ladderEls = [...canvas.querySelectorAll('.ladder-el')];
  if (!ladderEls.length) return;
  const canvasRect = canvas.getBoundingClientRect();
  let insertX = null;
  for (const el of ladderEls) {
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      insertX = rect.left - canvasRect.left - 3;
      break;
    }
  }
  if (insertX === null) {
    const last = ladderEls[ladderEls.length - 1];
    insertX = last.getBoundingClientRect().right - canvasRect.left + 3;
  }
  const ghost = document.createElement('div');
  ghost.className = 'drop-ghost';
  ghost.style.cssText = `position:absolute;left:${Math.max(0, insertX)}px;top:4px;bottom:4px;width:3px;background:var(--accent);border-radius:2px;box-shadow:0 0 8px var(--accent-bright);pointer-events:none;z-index:10;`;
  canvas.style.position = 'relative';
  canvas.appendChild(ghost);
}

function removeDropIndicator(el) {
  el?.querySelectorAll('.drop-ghost').forEach(e => e.remove());
}

function removeParallelIndicator(rungEl) {
  rungEl?.querySelectorAll('.parallel-ghost').forEach(e => e.remove());
}

function clearDragIndicators(rungEl) {
  rungEl.classList.remove('drag-over');
  removeDropIndicator(rungEl);
  removeParallelIndicator(rungEl);
}

function showParallelIndicator(rungEl) {
  removeParallelIndicator(rungEl);
  const network = rungEl.querySelector('.rung-network');
  if (!network) return;
  const ghost = document.createElement('div');
  ghost.className = 'parallel-ghost';
  network.appendChild(ghost);
}

function onSidebarDragStart(e) {
  const item = e.target.closest('.comp-item');
  if (!item?.dataset.type) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', item.dataset.type);
  store.arm(item.dataset.type);
}

let _lastDragRungId = null;

function onRungAreaDragOver(e) {
  const rungEl = e.target.closest('[data-rung-id]');
  if (!rungEl) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';

  const rungId = Number(rungEl.dataset.rungId);
  if (_lastDragRungId !== rungId) {
    document.querySelectorAll('.rung.drag-over').forEach(clearDragIndicators);
    _lastDragRungId = rungId;
  }
  rungEl.classList.add('drag-over');

  // Zona paralela = tercio inferior del rung
  const rect = rungEl.getBoundingClientRect();
  const relY = (e.clientY - rect.top) / rect.height;

  if (relY > 0.68) {
    // Zona paralela: indicador horizontal pulsante
    removeDropIndicator(rungEl);
    showParallelIndicator(rungEl);
  } else {
    // Zona serie: indicador vertical en la fila principal
    removeParallelIndicator(rungEl);
    const mainCanvas = rungEl.querySelector('.rung-canvas:not(.branch-row)');
    if (mainCanvas) showDropIndicator(mainCanvas, e.clientX);
  }
}

function onRungAreaDragLeave(e) {
  const rungEl = e.target.closest('[data-rung-id]');
  if (!rungEl) return;
  if (e.relatedTarget && rungEl.contains(e.relatedTarget)) return;
  clearDragIndicators(rungEl);
  _lastDragRungId = null;
}

function onRungAreaDrop(e) {
  e.preventDefault();
  document.querySelectorAll('.rung.drag-over').forEach(clearDragIndicators);
  _lastDragRungId = null;

  const rungEl = e.target.closest('[data-rung-id]');
  if (!rungEl) return;
  const type = e.dataTransfer.getData('text/plain');
  if (!type) return;

  const rungId = Number(rungEl.dataset.rungId);
  const rect   = rungEl.getBoundingClientRect();
  const relY   = (e.clientY - rect.top) / rect.height;

  if (relY > 0.68) {
    store.addParallelRow(rungId, type);
    showToast('Rama paralela agregada', 'success');
  } else {
    const col = calcInsertCol(rungId, e.clientX);
    store.addElement(rungId, type, col);
    showToast(`${type} agregado al rung ${rungId}`, 'success');
  }
}

// ── Búsqueda de componentes en el sidebar ─────────────────
function onSidebarSearch(e) {
  const q     = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.comp-item[data-type]');
  const sects = document.querySelectorAll('.sb-section');

  items.forEach(item => {
    if (!q) { item.style.display = ''; return; }
    const label = item.querySelector('strong')?.textContent.toLowerCase() ?? '';
    const sub   = item.querySelector('span')?.textContent.toLowerCase() ?? '';
    const type  = (item.dataset.type ?? '').toLowerCase().replace(/_/g, ' ');
    item.style.display = (label.includes(q) || sub.includes(q) || type.includes(q)) ? '' : 'none';
  });

  sects.forEach(sec => {
    if (!q) { sec.style.display = ''; return; }
    let next = sec.nextElementSibling;
    let any  = false;
    while (next && !next.classList.contains('sb-section')) {
      if (next.style.display !== 'none') { any = true; break; }
      next = next.nextElementSibling;
    }
    sec.style.display = any ? '' : 'none';
  });
}

// ── Toolbar buttons ──────────────────────────────────────
function onToolbarClick(e) {
  const btn = e.target.closest('.et-btn');
  if (!btn) return;
  const text = btn.textContent.trim();
  const sel  = store.getSelection();

  if (text.includes('Eliminar')) {
    if (sel.elementId) {
      store.deleteElement(sel.rungId, sel.elementId);
      store.log('info', `Elemento eliminado del rung ${sel.rungId}`);
    } else if (sel.rungId) {
      const rung = store.getProgram().rungs.find(r => r.id === sel.rungId);
      const count = rung?.network.reduce((s, row) => s + row.elements.length, 0) ?? 0;
      const ok = count === 0
        || confirm(`¿Eliminar rung ${sel.rungId}? Contiene ${count} elemento${count !== 1 ? 's' : ''}.`);
      if (ok) {
        store.deleteRung(sel.rungId);
        store.log('warn', `Rung ${sel.rungId} eliminado`);
      }
    }
  }
  if (text.includes('Subir')  && sel.rungId) store.moveRung(sel.rungId, -1);
  if (text.includes('Bajar')  && sel.rungId) store.moveRung(sel.rungId,  1);
  if (text.includes('Insertar') && sel.rungId) {
    const armed = store.getArmed();
    if (armed) store.addElement(sel.rungId, armed);
    else showToast('Selecciona un componente del sidebar primero', 'info');
  }
}

// ── Property panel inputs ────────────────────────────────
function onPropInput(e) {
  const sel = store.getSelection();
  if (!sel.rungId) return;
  const id = e.target.id;

  if (id === 'propAddr' && sel.elementId) {
    store.updateElement(sel.rungId, sel.elementId, { address: e.target.value });
  }
  if (id === 'propSym' && sel.elementId) {
    const prog = store.getProgram();
    const el   = prog.rungs.find(r => r.id === sel.rungId)
                           ?.network[0].elements.find(e => e.id === sel.elementId);
    if (el?.address) {
      const p = JSON.parse(JSON.stringify(prog));
      if (!p.symbol_table[el.address]) p.symbol_table[el.address] = { symbol: '', type: 'BOOL', modbus: { fn: 'internal', address: null }, comment: '' };
      p.symbol_table[el.address].symbol = e.target.value;
      store.setProgram(p);
    }
  }
  if (id === 'propType' && sel.elementId) {
    store.updateElement(sel.rungId, sel.elementId, { type: e.target.value });
  }
  if (id === 'propComment' && sel.elementId) {
    const prog = store.getProgram();
    const el   = prog.rungs.find(r => r.id === sel.rungId)
                           ?.network[0].elements.find(e => e.id === sel.elementId);
    if (el?.address && prog.symbol_table[el.address]) {
      const p = JSON.parse(JSON.stringify(prog));
      p.symbol_table[el.address].comment = e.target.value;
      store.setProgram(p);
    }
  }
  if (id === 'propRungComment' && sel.rungId) {
    store.setRungComment(sel.rungId, e.target.value);
  }
}

// ── Tab switcher ─────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.bb-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name)?.classList.add('active');
  // Re-render tab content
  const prog = store.getProgram();
  const panel = document.getElementById('tab-' + name);
  if (!panel) return;
  if (name === 'io')       panel.innerHTML = renderIOTable(prog);
  if (name === 'watch')    panel.innerHTML = renderWatchTable(prog);
  if (name === 'xref')     panel.innerHTML = renderXRefTable(prog);
  if (name === 'terminal') renderTerminal();
}
window.showTab = showTab;

// ── Compile / Upload (stubs) ──────────────────────────────
function onNavBtnClick(e) {
  const btn = e.target.closest('.tnav-btn');
  if (!btn) return;
  const txt = btn.textContent.trim();

  if (txt.includes('Compilar')) {
    const errs = validateProgram(store.getProgram());
    if (errs.length === 0) {
      store.log('ok',   'Compilación exitosa — 0 errores, 0 advertencias');
      store.log('info', `${store.getProgram().rungs.length} rungs · ${Object.keys(store.getProgram().symbol_table).length} variables`);
      showToast('Compilación exitosa', 'success');
    } else {
      errs.forEach(err => store.log('err', err));
      showToast(`${errs.length} error(es) de compilación`, 'error');
    }
    // Make sure terminal tab is visible
    const termTab = document.getElementById('tab-btn-terminal');
    if (termTab) showTab('terminal', termTab);
  }

  if (txt.includes('Cargar')) {
    const prog = store.getProgram();
    const ip   = prog.metadata.plc_target.ip;
    const port = prog.metadata.plc_target.port;
    store.log('info', `Intentando conectar a ${ip}:${port} (stub — sin backend)`);
    store.log('warn', 'Módulo Modbus no disponible aún — integrar backend Python');
    showToast('Carga stub: backend Modbus no conectado', 'info');
    const termTab = document.getElementById('tab-btn-terminal');
    if (termTab) showTab('terminal', termTab);
  }

  if (txt.includes('Stop')) {
    store.log('warn', 'Stop — programa en PLC detenido (stub)');
    showToast('Stop enviado (stub)', 'info');
  }
}

// ── Copy link ────────────────────────────────────────────
function copyLink() {
  const url = exportToURL(store.getProgram());
  pushToURL(store.getProgram());
  navigator.clipboard.writeText(url).then(() => {
    showToast('¡Link copiado al portapapeles!', 'success');
    store.log('info', 'Programa codificado en URL y copiado.');
  }).catch(() => {
    // Fallback para file://
    prompt('Copia este link:', url);
  });
}
window.copyLink = copyLink;

// ── Keyboard shortcuts ────────────────────────────────────
function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  const sel = store.getSelection();

  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.elementId) {
    e.preventDefault();
    store.deleteElement(sel.rungId, sel.elementId);
  }
  if (e.key === 'Escape') {
    store.clearSelection();
    store.disarm();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    showToast('Undo aún no disponible', 'info');
  }
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Make sidebar items draggable
  document.querySelectorAll('.comp-item[data-type]').forEach(el => {
    el.setAttribute('draggable', 'true');
  });

  // Búsqueda en sidebar
  document.querySelector('.sb-search input')?.addEventListener('input', onSidebarSearch);

  // Event wiring — click
  document.getElementById('rungArea')?.addEventListener('click',      onRungAreaClick);
  document.querySelector('.sidebar')?.addEventListener('click',       onSidebarClick);
  document.querySelector('.editor-toolbar')?.addEventListener('click',onToolbarClick);
  document.querySelector('.top-nav')?.addEventListener('click',       onNavBtnClick);
  document.getElementById('propScroll')?.addEventListener('input',    onPropInput);
  document.addEventListener('keydown', onKeyDown);

  // Context menu (right-click → popup)
  document.getElementById('rungArea')?.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mousedown', onDocumentMouseDown);
  document.getElementById('pp-close-btn')?.addEventListener('click', hidePropPopup);

  // Bottom bar collapse
  document.getElementById('bb-collapse-btn')?.addEventListener('click', toggleBottomBar);

  // Escape also closes popup
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePropPopup(); });

  // Event wiring — drag-and-drop
  document.querySelector('.sidebar')?.addEventListener('dragstart', onSidebarDragStart);
  const ra = document.getElementById('rungArea');
  ra?.addEventListener('dragover',  onRungAreaDragOver);
  ra?.addEventListener('dragleave', onRungAreaDragLeave);
  ra?.addEventListener('drop',      onRungAreaDrop);

  // Autosave URL on change (silently)
  store.subscribe(() => {
    try { pushToURL(store.getProgram()); } catch {}
  });

  // Initial render
  render();

  // Log program source
  const fromUrl = !!new URLSearchParams(window.location.search).get('l');
  store.log('info', fromUrl ? 'Programa cargado desde URL.' : 'Programa de ejemplo cargado.');
  store.log('info', `PLC target: ${store.getProgram().metadata.plc_target.ip}:${store.getProgram().metadata.plc_target.port}`);
});

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
