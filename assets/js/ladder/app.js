/**
 * app.js — Orquestador del editor Ladder
 * Store reactivo + event handlers + render loop
 *
 * CAMBIO v2: Agregado soporte para importar .js generado por el modelo IA
 * Lineas modificadas marcadas con: // ← NUEVO
 */

import { defaultProgram, newRung, newElement, validateProgram, isOutputType, OUTPUT_TYPES, shiftColsFrom, compactColumns } from './schema.js';
import { exportToURL, importFromURL, pushToURL }                                             from './codec.js';
import { renderAllRungs, renderIOTable, renderWatchTable, renderXRefTable, GR }              from './renderer.js';

function ts() { return new Date().toLocaleTimeString('es-MX', { hour12: false }); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// URL del servidor PLC (puente HTTP->Modbus). Corre LOCAL, en la maquina de la
// misma red del PLC (no en Render, que no alcanza la LAN). Se puede cambiar con
//   localStorage.setItem('lv_plc_bridge', 'http://localhost:8000')
function plcBridgeUrl() {
  return (localStorage.getItem('lv_plc_bridge') || 'http://localhost:8000').replace(/\/+$/, '');
}

// ── Store ────────────────────────────────────────────────────────
const store = (() => {
  let _prog  = importFromURL() ?? defaultProgram();
  let _sel   = { rungId: null, elementId: null };
  let _multi = { rungId: null, ids: new Set() };   // selección múltiple (para paralelo por rango)
  let _armed = null;
  let _log   = [{ ts: ts(), type: 'info', msg: 'LadderVoice editor listo — v2.0' }];
  let _undoStack = [];
  let _redoStack = [];
  const _subs = [];
  function notify() { _subs.forEach(fn => fn()); }
  function _pushUndo() {
    _undoStack.push(JSON.parse(JSON.stringify(_prog)));
    if (_undoStack.length > 30) _undoStack.shift();
    _redoStack = [];
  }

  return {
    subscribe(fn) { _subs.push(fn); },

    getProgram() { return _prog; },
    setProgram(p) { _pushUndo(); _prog = p; notify(); },

    updateMeta(patch) {
      _pushUndo();
      const p = deepClone(_prog);
      Object.assign(p.metadata, patch);
      _prog = p; notify();
    },

    addRung() {
      _pushUndo();
      const p = deepClone(_prog);
      const r = newRung(p.rungs);
      p.rungs.push(r);
      _sel = { rungId: r.id, elementId: null };
      _prog = p; notify();
    },

    // Inserta un rung vacío después del rung con id dado
    addRungAfter(afterId) {
      _pushUndo();
      const p   = deepClone(_prog);
      const idx = p.rungs.findIndex(r => r.id === afterId);
      const r   = newRung(p.rungs);
      if (idx >= 0) p.rungs.splice(idx + 1, 0, r);
      else p.rungs.push(r);
      _sel = { rungId: r.id, elementId: null };
      _prog = p; notify();
    },

    // Duplica un rung (clona con nuevos IDs)
    duplicateRung(id) {
      _pushUndo();
      const p   = deepClone(_prog);
      const idx = p.rungs.findIndex(r => r.id === id);
      if (idx < 0) return;
      const clone = deepClone(p.rungs[idx]);
      const maxId = p.rungs.reduce((m, r) => Math.max(m, r.id), 0);
      clone.id = maxId + 1;
      // Regenerar IDs de elementos
      const regen = (el) => ({ ...el, id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2,5) });
      clone.network = clone.network.map(row => ({ ...row, elements: row.elements.map(regen) }));
      p.rungs.splice(idx + 1, 0, clone);
      _sel = { rungId: clone.id, elementId: null };
      _prog = p; notify();
    },

    deleteRung(id) {
      _pushUndo();
      const p = deepClone(_prog);
      p.rungs = p.rungs.filter(r => r.id !== id);
      if (_sel.rungId === id) _sel = { rungId: null, elementId: null };
      _prog = p; notify();
    },

    moveRung(id, dir) {
      _pushUndo();
      const p   = deepClone(_prog);
      const idx = p.rungs.findIndex(r => r.id === id);
      if (idx < 0) return;
      const nxt = idx + dir;
      if (nxt < 0 || nxt >= p.rungs.length) return;
      [p.rungs[idx], p.rungs[nxt]] = [p.rungs[nxt], p.rungs[idx]];
      _prog = p; notify();
    },

    setRungComment(id, comment) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === id);
      if (r) r.comment = comment;
      _prog = p; notify();
    },

    toggleRungEnabled(id) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === id);
      if (r) r.enabled = !r.enabled;
      _prog = p; notify();
    },

    // ── Elementos ────────────────────────────────────────────
    addElement(rungId, type, atCol = null) {
      _pushUndo();
      const p  = deepClone(_prog);
      const r  = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      const els = r.network[0].elements;
      const isOut = isOutputType(type);
      let col;
      if (isOut) {
        // Siempre al final (zona derecha)
        col = els.length > 0 ? els.reduce((m, e) => Math.max(m, e.pos.col), -1) + 1 : 0;
      } else if (atCol !== null) {
        // Insertar antes de cualquier output que esté en esa col o después
        const outAt = els.findIndex(e => isOutputType(e.type) && e.pos.col >= atCol);
        col = outAt >= 0 ? Math.min(atCol, els[outAt].pos.col) : atCol;
      } else {
        // Default: antes de la primera bobina/output
        const outAt = els.findIndex(e => isOutputType(e.type));
        col = outAt >= 0 ? outAt : els.length;
      }
      // Desplazar elementos existentes con col >= nueva col (solo no-output si insertamos contact)
      els.filter(e => e.pos.col >= col && !(isOut && isOutputType(e.type))).forEach(e => e.pos.col++);
      // Mantener alineadas las ramas paralelas al insertar en serie en la principal
      if (!isOut) {
        for (const row of r.network.slice(1)) {
          for (const e of row.elements) if (e.pos.col >= col) e.pos.col++;
          if (row.span) {
            if (row.span.from >= col) row.span.from++;
            if (row.span.to   >= col) row.span.to++;
          }
        }
      }
      const el = newElement(type, col);
      els.push(el);
      _sel   = { rungId, elementId: el.id };
      _armed = null;
      _prog  = p; notify();
    },

    // Agrega una NUEVA rama paralela (leg) sobre la columna atCol de la fila 0.
    // Cada llamada crea una rama independiente → permite OR de N vías sin colisiones.
    addParallelElement(rungId, type, atCol) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      // Los paralelos solo aceptan contactos (no bobinas ni outputs)
      const safeType = isOutputType(type) ? 'contact_no' : type;
      const el = newElement(safeType, atCol);
      r.network.push({ row: r.network.length, span: { from: atCol, to: atCol }, elements: [el] });
      r.network.forEach((row, i) => row.row = i);
      _sel   = { rungId, elementId: el.id };
      _armed = null;
      _prog  = p; notify();
    },

    // Crea una rama paralela que abarca un RANGO de columnas [fromCol..toCol]
    // de la principal (para enclavar un grupo de contactos en serie).
    addParallelRange(rungId, fromCol, toCol, type) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      const safeType = isOutputType(type) ? 'contact_no' : type;
      const from = Math.min(fromCol, toCol);
      const to   = Math.max(fromCol, toCol);
      const el   = newElement(safeType, from);
      r.network.push({ row: r.network.length, span: { from, to }, elements: [el] });
      r.network.forEach((row, i) => row.row = i);
      _sel   = { rungId, elementId: el.id };
      _multi = { rungId: null, ids: new Set() };
      _armed = null;
      _prog  = p; notify();
    },

    // Agrega un elemento EN SERIE dentro de una rama paralela existente.
    // Inserta una columna a la derecha del final de la rama y corre lo que
    // esté más a la derecha, manteniendo todo alineado con la principal.
    addSeriesToBranch(rungId, branchRowIdx, type) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      const branch = r.network[branchRowIdx];
      if (!branch || branchRowIdx === 0) return;
      const safeType  = isOutputType(type) ? 'contact_no' : type;
      const branchTo  = branch.span?.to ?? Math.max(...branch.elements.map(e => e.pos.col));
      const insertCol = branchTo + 1;
      // Hacer espacio: correr a la derecha todo lo que esté en col >= insertCol
      shiftColsFrom(r, insertCol, +1);
      const el = newElement(safeType, insertCol);
      branch.elements.push(el);
      branch.span = { from: branch.span?.from ?? insertCol, to: insertCol };
      _sel   = { rungId, elementId: el.id };
      _armed = null;
      _prog  = p; notify();
    },

    deleteElement(rungId, elId) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      for (let ri = 0; ri < r.network.length; ri++) {
        const row = r.network[ri];
        const idx = row.elements.findIndex(e => e.id === elId);
        if (idx < 0) continue;
        row.elements.splice(idx, 1);
        // En ramas (ri>0) recomputar el span desde los elementos restantes;
        // NO renumerar a 0 (rompería la alineación con la principal).
        if (ri > 0 && row.span && row.elements.length) {
          row.span.from = Math.min(...row.elements.map(e => e.pos.col));
          row.span.to   = Math.max(...row.elements.map(e => e.pos.col));
        }
        break;
      }
      // Limpiar ramas vacías (no la fila 0) y renumerar filas
      r.network = r.network.filter((row, i) => i === 0 || row.elements.length > 0);
      r.network.forEach((row, i) => row.row = i);
      // Quitar columnas que quedaron vacías, preservando alineación
      compactColumns(r);
      _sel  = { rungId, elementId: null };
      _prog = p; notify();
    },

    updateElement(rungId, elId, patch) {
      _pushUndo();
      const p = deepClone(_prog);
      const r = p.rungs.find(r => r.id === rungId);
      if (!r) return;
      for (const row of r.network) {
        const el = row.elements.find(e => e.id === elId);
        if (!el) continue;
        Object.assign(el, patch);
        break;
      }
      if (patch.address && !p.symbol_table[patch.address]) {
        p.symbol_table[patch.address] = { symbol: patch.address, type: 'BOOL', modbus: { fn: 'internal', address: null }, comment: '' };
      }
      _prog = p; notify();
    },

    // ── Selección ─────────────────────────────────────────────
    getSelection()          { return _sel; },
    selectRung(id)          { _sel = { rungId: id, elementId: null }; _multi = { rungId: null, ids: new Set() }; notify(); },
    selectElement(rid, eid) { _sel = { rungId: rid, elementId: eid }; _multi = { rungId: null, ids: new Set() }; notify(); },
    clearSelection()        { _sel = { rungId: null, elementId: null }; _multi = { rungId: null, ids: new Set() }; notify(); },

    // ── Selección múltiple (Ctrl/Shift+clic) ──────────────────
    getMultiSelection() { return _multi; },
    toggleMultiSelect(rungId, elId) {
      if (_multi.rungId !== rungId) _multi = { rungId, ids: new Set() };
      if (_multi.ids.has(elId)) _multi.ids.delete(elId);
      else                       _multi.ids.add(elId);
      _sel = { rungId, elementId: elId };
      notify();
    },

    // ── Sidebar armed ─────────────────────────────────────────
    getArmed() { return _armed; },
    arm(type)  { _armed = type; notify(); },
    disarm()   { _armed = null; notify(); },

    // ── Log ───────────────────────────────────────────────────
    getLog() { return _log; },
    log(type, msg) {
      _log.push({ ts: ts(), type, msg });
      if (_log.length > 150) _log.shift();
      notify();
    },

    // ── Undo / Redo ───────────────────────────────────────────
    canUndo() { return _undoStack.length > 0; },
    canRedo() { return _redoStack.length > 0; },
    undo() {
      if (!_undoStack.length) return;
      _redoStack.push(JSON.parse(JSON.stringify(_prog)));
      _prog = _undoStack.pop();
      notify();
    },
    redo() {
      if (!_redoStack.length) return;
      _undoStack.push(JSON.parse(JSON.stringify(_prog)));
      _prog = _redoStack.pop();
      notify();
    },
  };
})();

// ── Puente para módulos externos (panel de chat / motores IA) ──
// El store es privado del módulo; exponemos una API mínima en window para que
// chat.js pueda aplicar programas generados por cualquier motor (A/B).
window.LadderEditor = {
  setProgram: (p) => store.setProgram(p),
  getProgram: () => store.getProgram(),
  selectRung: (id) => store.selectRung(id),
  log: (type, msg) => store.log(type, msg),
  undo: () => store.undo(),
  redo: () => store.redo(),
};

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Clipboard interno ─────────────────────────────────────────
let _clipboard = null;

function copyElement() {
  const sel  = store.getSelection();
  if (!sel.elementId) return;
  const rung = store.getProgram().rungs.find(r => r.id === sel.rungId);
  for (const row of rung?.network ?? []) {
    const el = row.elements.find(e => e.id === sel.elementId);
    if (el) { _clipboard = { kind: 'element', data: deepClone(el) }; showToast('Elemento copiado', 'success'); return; }
  }
}

function cutElement() {
  copyElement();
  const sel = store.getSelection();
  if (sel.elementId) store.deleteElement(sel.rungId, sel.elementId);
}

function copyRung() {
  const sel  = store.getSelection();
  if (!sel.rungId) return;
  const rung = store.getProgram().rungs.find(r => r.id === sel.rungId);
  if (rung) { _clipboard = { kind: 'rung', data: deepClone(rung) }; showToast('Rung copiado', 'success'); }
}

function pasteFromClipboard() {
  if (!_clipboard) { showToast('Portapapeles vacío', 'info'); return; }
  const sel = store.getSelection();
  if (_clipboard.kind === 'element') {
    if (!sel.rungId) { showToast('Selecciona un rung primero', 'info'); return; }
    const src = _clipboard.data;
    store.addElement(sel.rungId, src.type, null);
    // Actualizar dirección del elemento recién pegado
    const prog  = store.getProgram();
    const rung  = prog.rungs.find(r => r.id === sel.rungId);
    const newEl = rung?.network[0].elements.reduce((a,b) => b.pos.col > a.pos.col ? b : a, { pos: { col: -1 } });
    if (newEl?.id) store.updateElement(sel.rungId, newEl.id, { address: src.address });
    showToast('Elemento pegado', 'success');
  } else if (_clipboard.kind === 'rung') {
    const afterId = sel.rungId ?? store.getProgram().rungs.at(-1)?.id;
    if (afterId) store.duplicateRung(_clipboard.data.id !== undefined ? _clipboard.data.id : afterId);
    showToast('Rung pegado', 'success');
  }
}

// ── Agrupar selección en paralelo ─────────────────────────────
function groupSelectionParallel() {
  const multi = store.getMultiSelection();
  if (!multi.rungId || multi.ids.size === 0) {
    showToast('Selecciona contactos con Ctrl+clic primero', 'info');
    return;
  }
  const rung = store.getProgram().rungs.find(r => r.id === multi.rungId);
  if (!rung) return;
  // Solo elementos de la línea principal (fila 0) que no sean salidas
  const mainEls = (rung.network[0]?.elements ?? [])
    .filter(e => multi.ids.has(e.id) && !isOutputType(e.type));
  if (mainEls.length === 0) {
    showToast('Selecciona contactos de la línea principal', 'info');
    return;
  }
  const cols  = mainEls.map(e => e.pos.col);
  const from  = Math.min(...cols);
  const to    = Math.max(...cols);
  const armed = store.getArmed() || 'contact_no';
  store.addParallelRange(multi.rungId, from, to, armed);
  showToast(`Rama paralela sobre columnas ${from}–${to}`, 'success');
  store.log('info', `Paralelo de rango ${from}-${to} en rung ${multi.rungId}`);
}

// ── Zoom ──────────────────────────────────────────────────────
let _zoom = 1.0;
function adjustZoom(delta) {
  _zoom = Math.max(0.4, Math.min(2.5, _zoom + delta));
  const ra = document.getElementById('rungArea');
  if (ra) { ra.style.transform = `scale(${_zoom})`; ra.style.transformOrigin = 'top left'; }
  const zv = document.getElementById('etZoomVal');
  if (zv) zv.textContent = `${Math.round(_zoom * 100)}%`;
  showToast(`Zoom: ${Math.round(_zoom * 100)}%`, 'info');
}

// ── Render ─────────────────────────────────────────────────────
function renderTerminal() {
  const panel = document.getElementById('tab-terminal');
  if (!panel) return;
  panel.innerHTML = `<div class="terminal">${
    store.getLog().map(l => `<div class="t-line ${l.type}">
      <span class="t-ts">${l.ts}</span>
      <span class="t-tag">[${l.type.toUpperCase()}]</span>
      <span class="t-msg">${esc(l.msg)}</span>
    </div>`).join('')
  }</div>`;
  panel.scrollTop = panel.scrollHeight;
}

function renderActiveTab(prog) {
  const name  = document.querySelector('.bb-tab.active')?.id?.replace('tab-btn-', '');
  if (!name || name === 'terminal') return;
  const panel = document.getElementById(`tab-${name}`);
  if (!panel) return;
  if (name === 'io')    panel.innerHTML = renderIOTable(prog);
  if (name === 'watch') panel.innerHTML = renderWatchTable(prog);
  if (name === 'xref')  panel.innerHTML = renderXRefTable(prog);
}

function updateSidebarArmed() {
  const armed = store.getArmed();
  document.querySelectorAll('.comp-item').forEach(el => el.classList.toggle('active', el.dataset.type === armed));
}

function updateEtLabel(prog) {
  const el = document.querySelector('.et-label');
  if (el) el.textContent = `${prog.metadata.name} — ${prog.rungs.length} rung${prog.rungs.length !== 1 ? 's' : ''}`;
}

function render() {
  const prog  = store.getProgram();
  const sel   = store.getSelection();
  const multi = store.getMultiSelection();
  const selFull = { ...sel, multiRungId: multi.rungId, multiIds: multi.ids };
  const ra   = document.getElementById('rungArea');
  if (ra) renderAllRungs(ra, prog, selFull);
  renderTerminal();
  renderActiveTab(prog);
  updateSidebarArmed();
  updateEtLabel(prog);
}

store.subscribe(render);

// ── Properties popup ──────────────────────────────────────────
function positionPopup(popup, x, y) {
  popup.style.visibility = 'hidden';
  popup.classList.add('visible');
  const pw = popup.offsetWidth  || 224;
  const ph = popup.offsetHeight || 260;
  popup.classList.remove('visible');
  popup.style.visibility = '';
  const left = x + pw + 8 > window.innerWidth  ? x - pw - 4 : x + 4;
  const top  = y + ph + 8 > window.innerHeight ? y - ph - 4 : y + 4;
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
  const timerPr = document.getElementById('propTimerPreset');
  const timerWr = document.getElementById('propTimerWrap');

  if (!sel.rungId) { if (title) title.textContent = 'Propiedades'; return; }
  const rung = prog.rungs.find(r => r.id === sel.rungId);
  if (!rung) return;
  if (rungCmt) rungCmt.value = rung.comment || '';

  if (!sel.elementId) {
    if (title)  title.textContent = `Rung ${rung.id}`;
    if (addr)   addr.value  = '';
    if (sym)    sym.value   = '';
    if (comment) comment.value = '';
    if (timerWr) timerWr.style.display = 'none';
    if (state) { state.textContent = rung.enabled ? 'HABILITADO' : 'DESHABILITADO'; state.className = 'pp-state-val ' + (rung.enabled ? 'on' : 'off'); }
    return;
  }

  // Buscar el elemento en TODAS las filas (no solo row 0)
  let el = null;
  for (const row of rung.network) {
    el = row.elements.find(e => e.id === sel.elementId);
    if (el) break;
  }
  if (!el) return;
  const entry = prog.symbol_table?.[el.address];

  if (title)   title.textContent = `${el.address || '—'} · ${el.type}`;
  if (addr)    addr.value    = el.address || '';
  if (sym)     sym.value     = entry?.symbol || '';
  if (typeSel) typeSel.value = el.type;
  if (comment) comment.value = entry?.comment || '';

  // Timer preset
  if (timerWr) {
    if (el.params?.preset_ms !== undefined) {
      timerWr.style.display = '';
      if (timerPr) timerPr.value = el.params.preset_ms;
    } else if (el.params?.preset !== undefined) {
      timerWr.style.display = '';
      if (timerPr) timerPr.value = el.params.preset;
    } else {
      timerWr.style.display = 'none';
    }
  }

  if (state) {
    const en = prog.execution_state?.rung_states?.[String(rung.id)];
    state.textContent = en ? 'TRUE' : 'FALSE';
    state.className   = 'pp-state-val ' + (en ? 'on' : 'off');
  }
}

// ── Context menu ──────────────────────────────────────────────
let _ctxTarget = null;

function showCtxMenu(x, y, mode) {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;

  let html = '';
  if (mode === 'element') {
    const prog = store.getProgram();
    const rung = prog.rungs.find(r => r.id === _ctxTarget.rungId);
    let el = null;
    for (const row of rung?.network ?? []) {
      el = row.elements.find(e => e.id === _ctxTarget.elId);
      if (el) break;
    }
    const isContact = el?.type?.startsWith('contact_');
    const isMain    = _ctxTarget.row === 0;
    html = `
      <div class="ctx-header"><i class="ti ti-adjustments"></i> ${esc(el?.type ?? '?')} · ${esc(el?.address ?? '?')}</div>
      <div class="ctx-item" data-action="edit-props"><i class="ti ti-pencil"></i> Editar propiedades</div>
      ${isMain && isContact ? `<div class="ctx-item" data-action="add-parallel"><i class="ti ti-git-branch"></i> Poner en paralelo aquí</div>` : ''}
      ${isMain && store.getMultiSelection().ids.size >= 1 ? `<div class="ctx-item" data-action="group-parallel"><i class="ti ti-arrows-join"></i> Agrupar selección en paralelo</div>` : ''}
      ${!isMain ? `<div class="ctx-item" data-action="add-series-branch"><i class="ti ti-dots"></i> Agregar contacto en serie</div>` : ''}
      ${isContact ? `<div class="ctx-item" data-action="toggle-nc"><i class="ti ti-switch-horizontal"></i> ${el.type === 'contact_no' ? 'Cambiar a NC (cerrado)' : 'Cambiar a NO (abierto)'}</div>` : ''}
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="copy-el"><i class="ti ti-copy"></i> Copiar</div>
      <div class="ctx-item" data-action="cut-el"><i class="ti ti-cut"></i> Cortar</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item ctx-danger" data-action="delete-el"><i class="ti ti-trash"></i> Eliminar elemento</div>`;
  } else {
    const rung = store.getProgram().rungs.find(r => r.id === _ctxTarget.rungId);
    html = `
      <div class="ctx-header"><i class="ti ti-brackets"></i> Rung ${_ctxTarget.rungId}</div>
      <div class="ctx-item" data-action="insert-el"><i class="ti ti-cursor-text"></i> Insertar elemento</div>
      <div class="ctx-item" data-action="rung-comment"><i class="ti ti-message"></i> Editar comentario</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="add-rung-below"><i class="ti ti-row-insert-bottom"></i> Agregar rung abajo</div>
      <div class="ctx-item" data-action="dup-rung"><i class="ti ti-copy"></i> Duplicar rung</div>
      <div class="ctx-item" data-action="paste-here"><i class="ti ti-clipboard"></i> Pegar</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="move-up"><i class="ti ti-arrow-up"></i> Subir rung</div>
      <div class="ctx-item" data-action="move-down"><i class="ti ti-arrow-down"></i> Bajar rung</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="toggle-enable"><i class="ti ti-player-${rung?.enabled ? 'pause' : 'play'}"></i> ${rung?.enabled ? 'Deshabilitar' : 'Habilitar'} rung</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item ctx-danger" data-action="delete-rung"><i class="ti ti-trash"></i> Eliminar rung</div>`;
  }

  menu.innerHTML = html;
  menu.style.display = 'block';
  const mw = menu.offsetWidth  || 200;
  const mh = menu.offsetHeight || 200;
  const left = x + mw + 8 > window.innerWidth  ? x - mw - 4 : x + 4;
  const top  = y + mh + 8 > window.innerHeight ? y - mh - 4 : y + 4;
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top  = Math.max(4, top)  + 'px';
  menu.classList.add('visible');
}

function hideCtxMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) { m.classList.remove('visible'); m.style.display = 'none'; }
  _ctxTarget = null;
}

function onCtxMenuClick(e) {
  const item = e.target.closest('[data-action]');
  if (!item || !_ctxTarget) return;
  const action  = item.dataset.action;
  const { rungId, elId, col, row } = _ctxTarget;
  hideCtxMenu();

  switch (action) {
    case 'edit-props': {
      if (elId) store.selectElement(rungId, elId);
      else      store.selectRung(rungId);
      // Abrir popup en el centro del riel del rung
      const rungDiv = document.getElementById(`rung-${rungId}`);
      if (rungDiv) {
        const r = rungDiv.getBoundingClientRect();
        showPropPopup(r.left + r.width * 0.5, r.top + r.height * 0.5);
      }
      break;
    }
    case 'add-parallel': {
      const armed = store.getArmed() || 'contact_no';
      store.addParallelElement(rungId, armed, col);
      showToast('Rama paralela agregada', 'success');
      store.log('info', `Paralelo en rung ${rungId} col ${col}`);
      break;
    }
    case 'add-series-branch': {
      const armed = store.getArmed() || 'contact_no';
      store.addSeriesToBranch(rungId, row, armed);
      showToast('Contacto en serie agregado a la rama', 'success');
      store.log('info', `Serie en rama ${row} del rung ${rungId}`);
      break;
    }
    case 'group-parallel':
      groupSelectionParallel();
      break;
    case 'toggle-nc': {
      const prog = store.getProgram();
      const rung = prog.rungs.find(r => r.id === rungId);
      for (const row of rung?.network ?? []) {
        const el = row.elements.find(e => e.id === elId);
        if (el) {
          const t = el.type === 'contact_no' ? 'contact_nc' : 'contact_no';
          store.updateElement(rungId, elId, { type: t });
          break;
        }
      }
      break;
    }
    case 'copy-el':  copyElement();           break;
    case 'cut-el':   cutElement();            break;
    case 'delete-el':
      store.deleteElement(rungId, elId);
      store.log('info', `Elemento ${elId} eliminado del rung ${rungId}`);
      break;
    case 'insert-el': {
      const armed = store.getArmed();
      if (armed) { store.addElement(rungId, armed); showToast(`${armed} insertado`, 'success'); }
      else showToast('Selecciona un componente del sidebar primero', 'info');
      break;
    }
    case 'rung-comment': {
      const rung = store.getProgram().rungs.find(r => r.id === rungId);
      const nc   = prompt('Comentario del rung:', rung?.comment ?? '');
      if (nc !== null) store.setRungComment(rungId, nc);
      break;
    }
    case 'add-rung-below':
      store.addRungAfter(rungId);
      store.log('info', `Rung insertado después del rung ${rungId}`);
      break;
    case 'dup-rung':
      store.duplicateRung(rungId);
      showToast('Rung duplicado', 'success');
      break;
    case 'paste-here':
      store.selectRung(rungId);
      pasteFromClipboard();
      break;
    case 'move-up':   store.moveRung(rungId, -1); break;
    case 'move-down': store.moveRung(rungId,  1); break;
    case 'toggle-enable': store.toggleRungEnabled(rungId); break;
    case 'delete-rung': {
      const rung  = store.getProgram().rungs.find(r => r.id === rungId);
      const count = rung?.network.reduce((s,row) => s + row.elements.length, 0) ?? 0;
      const ok    = count === 0 || confirm(`¿Eliminar rung ${rungId}? Contiene ${count} elemento(s).`);
      if (ok) { store.deleteRung(rungId); store.log('warn', `Rung ${rungId} eliminado`); }
      break;
    }
  }
}

// ── Event: rung area click ────────────────────────────────────
function onRungAreaClick(e) {
  if (e.target.closest('#ctxMenu')) return;
  const addBtn = e.target.closest('#btn-add-rung');
  if (addBtn) {
    store.addRung();
    store.log('info', `Rung ${store.getProgram().rungs.at(-1)?.id} agregado`);
    return;
  }

  const host   = e.target.closest('.rung');
  const elHit  = e.target.closest('.ladder-el');
  const armed  = store.getArmed();

  // Con un componente armado: colocar usando la zona bajo el cursor (serie/paralelo)
  if (armed && host) {
    const rungId = Number(host.dataset.rungId);
    const svgEl  = host.querySelector('.rung-svg');
    if (svgEl) applyPlan(rungId, armed, dropPlan(rungId, svgEl, e.clientX, e.clientY, armed));
    else       store.addElement(rungId, armed);
    return;
  }

  if (elHit) {
    const rungId = Number(elHit.dataset.rungId);
    const elId   = elHit.dataset.elId;
    // Ctrl/Shift+clic → selección múltiple (para agrupar en paralelo)
    if (e.ctrlKey || e.metaKey || e.shiftKey) { store.toggleMultiSelect(rungId, elId); return; }
    store.selectElement(rungId, elId);
    return;
  }
  if (host) store.selectRung(Number(host.dataset.rungId));
}

// ── Event: rung area double-click → abre propiedades ─────────
function onRungAreaDblClick(e) {
  const elHit = e.target.closest('.ladder-el');
  if (!elHit) return;
  const rungId = Number(elHit.dataset.rungId);
  const elId   = elHit.dataset.elId;
  store.selectElement(rungId, elId);
  showPropPopup(e.clientX, e.clientY);
}

// ── Event: context menu (clic derecho) ────────────────────────
function onContextMenu(e) {
  const elHit  = e.target.closest('.ladder-el');
  const rungEl = e.target.closest('[data-rung-id]');
  if (!elHit && !rungEl) return;
  e.preventDefault();

  if (elHit) {
    const rungId = Number(elHit.dataset.rungId);
    const elId   = elHit.dataset.elId;
    const col    = Number(elHit.dataset.col ?? 0);
    const row    = Number(elHit.dataset.row ?? 0);
    // Si el elemento ya forma parte de una selección múltiple, conservarla
    // (para poder "Agrupar en paralelo"); si no, seleccionar solo este.
    const multi = store.getMultiSelection();
    if (!(multi.rungId === rungId && multi.ids.has(elId))) store.selectElement(rungId, elId);
    _ctxTarget = { type: 'element', rungId, elId, col, row };
    showCtxMenu(e.clientX, e.clientY, 'element');
  } else {
    const rungId = Number(rungEl.dataset.rungId);
    store.selectRung(rungId);
    _ctxTarget = { type: 'rung', rungId };
    showCtxMenu(e.clientX, e.clientY, 'rung');
  }
}

function onDocumentMouseDown(e) {
  const popup = document.getElementById('propPopup');
  const menu  = document.getElementById('ctxMenu');
  if (popup && !popup.contains(e.target)) hidePropPopup();
  if (menu  && !menu.contains(e.target))  hideCtxMenu();
}

// ── Sidebar click: armar componente ──────────────────────────
function onSidebarClick(e) {
  const item = e.target.closest('.comp-item');
  if (!item?.dataset.type) return;
  const type = item.dataset.type;
  if (store.getArmed() === type) { store.disarm(); return; }
  store.arm(type);
  const sel = store.getSelection();
  if (sel.rungId) {
    store.addElement(sel.rungId, type);
    showToast(`${type} agregado al rung ${sel.rungId}`, 'success');
  } else {
    showToast('Selecciona un rung para insertar el componente', 'info');
  }
}

// ── Drag-and-drop ─────────────────────────────────────────────
const SVGNS = 'http://www.w3.org/2000/svg';

// Convierte coords de pantalla a coords internas del SVG (maneja el zoom CSS).
function clientToSvg(svgEl, clientX, clientY) {
  const rect = svgEl.getBoundingClientRect();
  const vbW  = svgEl.viewBox?.baseVal?.width  || rect.width  || 1;
  const vbH  = svgEl.viewBox?.baseVal?.height || rect.height || 1;
  const x = (clientX - rect.left) / (rect.width  || 1) * vbW;
  const y = (clientY - rect.top)  / (rect.height || 1) * vbH;
  return { x, y };
}

// Decide qué hará un drop/clic SEGÚN COORDENADAS (robusto, sin depender del
// elemento exacto bajo el cursor):
//   - Fila principal, banda superior  → SERIE  (inserta en la columna más cercana)
//   - Fila principal, banda inferior  → PARALELO (nueva rama sobre esa columna)
//   - Sobre una rama existente        → SERIE dentro de esa rama
//   - Salidas (bobina/timer)          → siempre en serie al final
function dropPlan(rungId, svgEl, clientX, clientY, type) {
  const prog = store.getProgram();
  const rung = prog.rungs.find(r => r.id === rungId);
  const numCols = Number(svgEl.dataset.numCols) || 1;
  const numRows = rung?.network?.length || 1;
  const mainHasEls = (rung?.network?.[0]?.elements?.length || 0) > 0;
  const { x, y } = clientToSvg(svgEl, clientX, clientY);

  if (isOutputType(type)) return { mode: 'series', insCol: null };

  const overCol = Math.max(0, Math.min(numCols - 1, Math.floor((x - GR.RAIL) / GR.COL_W)));
  let   insCol  = Math.max(0, Math.min(numCols,     Math.round((x - GR.RAIL) / GR.COL_W)));

  // Un contacto nunca debe quedar después de una bobina/salida: lo limitamos
  // a insertarse, como mucho, justo antes de la primera salida.
  const outs = (rung?.network?.[0]?.elements || []).filter(el => isOutputType(el.type));
  if (outs.length) {
    const minOut = Math.min(...outs.map(el => el.pos.col));
    if (insCol > minOut) insCol = minOut;
  }

  // ¿El cursor cae sobre una rama (fila >= 1)?
  if (y > GR.ROW_H && numRows > 1) {
    const row = Math.floor(y / GR.ROW_H);
    if (row > numRows - 1) {
      // por debajo de todo el rung → nueva rama en paralelo
      return mainHasEls ? { mode: 'parallel', col: overCol } : { mode: 'series', insCol };
    }
    return { mode: 'series-branch', row, col: overCol };
  }

  // Fila principal: banda superior (~60%) = serie, inferior = paralelo
  const lowerBand = y > GR.ROW_H * 0.58;
  if (lowerBand && mainHasEls) return { mode: 'parallel', col: overCol };
  return { mode: 'series', insCol };
}

// Dibuja un indicador grande y claro de lo que hará el drop.
function drawDropPlan(svgEl, plan, numCols, H) {
  removeDropIndicator(svgEl);
  if (!svgEl) return;
  const add  = el => { el.classList.add('drop-ghost'); el.setAttribute('pointer-events', 'none'); svgEl.appendChild(el); return el; };
  const rect = (x, y, w, h, fill, stroke) => {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('rx', '2');
    r.setAttribute('fill', fill);
    if (stroke) { r.setAttribute('stroke', stroke); r.setAttribute('stroke-width', '1.5'); }
    return add(r);
  };
  const line = (x1, y1, x2, y2) => {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', '#4d9ef7'); l.setAttribute('stroke-width', '2.5');
    l.setAttribute('stroke-dasharray', '4 3'); l.setAttribute('stroke-linecap', 'round');
    return add(l);
  };
  const label = (x, y, txt) => {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('font-size', '8'); t.setAttribute('font-weight', '700');
    t.setAttribute('font-family', 'DM Mono, monospace'); t.setAttribute('fill', '#9fd0ff');
    t.textContent = txt;
    return add(t);
  };

  if (plan.mode === 'parallel') {
    const lx = GR.RAIL + plan.col * GR.COL_W;
    const rx = lx + GR.COL_W;
    const m0 = GR.LPAD + GR.EL_H / 2;
    const yb = H - 6;
    rect(lx, 2, GR.COL_W, H - 4, 'rgba(77,158,247,0.13)', '#4d9ef7');
    line(lx, m0, lx, yb); line(rx, m0, rx, yb); line(lx, yb, rx, yb);
    label(lx + 4, 10, 'PARALELO');
  } else if (plan.mode === 'series-branch') {
    const ry = plan.row * GR.ROW_H;
    const xx = GR.RAIL + (plan.col + 1) * GR.COL_W;
    rect(xx - 2.5, ry + 2, 5, GR.ROW_H - 4, '#4d9ef7', null);
    label(xx + 5, ry + 10, '+ SERIE');
  } else {
    const c  = plan.insCol == null ? numCols : plan.insCol;
    const xx = GR.RAIL + c * GR.COL_W;
    rect(xx - 2.5, 2, 5, GR.ROW_H - 4, '#4d9ef7', null);
    label(xx + 5, 10, 'SERIE');
  }
}

// Ejecuta el plan calculado (mismo para drop y para clic-con-componente-armado).
function applyPlan(rungId, type, plan) {
  if (plan.mode === 'parallel') {
    store.addParallelElement(rungId, type, plan.col);
    showToast('Rama en paralelo agregada', 'success');
  } else if (plan.mode === 'series-branch') {
    store.addSeriesToBranch(rungId, plan.row, type);
    showToast('En serie dentro de la rama', 'success');
  } else {
    store.addElement(rungId, type, plan.insCol);
    showToast(isOutputType(type) ? 'Salida agregada' : 'Elemento en serie agregado', 'success');
  }
}

function removeDropIndicator(el) {
  el?.querySelectorAll('.drop-ghost').forEach(e => e.remove());
}

function clearAllDragIndicators() {
  document.querySelectorAll('.rung.drag-over').forEach(r => {
    r.classList.remove('drag-over');
    removeDropIndicator(r.querySelector('.rung-svg'));
  });
}

function onSidebarDragStart(e) {
  const item = e.target.closest('.comp-item');
  if (!item?.dataset.type) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', item.dataset.type);
  store.arm(item.dataset.type);
}

let _lastDragRungId = null;

// Resuelve el contenedor .rung y su SVG sin importar qué subelemento (rect de
// hit, wire, etc.) esté bajo el cursor — clave para que el drag sea fiable.
function rungHostFromEvent(e) {
  return e.target.closest('.rung');
}

function onRungAreaDragOver(e) {
  const host = rungHostFromEvent(e);
  if (!host) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';

  const rungId = Number(host.dataset.rungId);
  if (_lastDragRungId !== rungId) {
    clearAllDragIndicators();
    _lastDragRungId = rungId;
  }
  host.classList.add('drag-over');

  const type  = store.getArmed();
  const svgEl = host.querySelector('.rung-svg');
  if (!svgEl || !type) return;
  const H       = Number(svgEl.getAttribute('height')) || GR.ROW_H;
  const numCols = Number(svgEl.dataset.numCols) || 1;
  const plan    = dropPlan(rungId, svgEl, e.clientX, e.clientY, type);
  drawDropPlan(svgEl, plan, numCols, H);
}

function onRungAreaDragLeave(e) {
  const host = rungHostFromEvent(e);
  if (!host) return;
  if (e.relatedTarget && host.contains(e.relatedTarget)) return;
  host.classList.remove('drag-over');
  removeDropIndicator(host.querySelector('.rung-svg'));
  _lastDragRungId = null;
}

function onRungAreaDrop(e) {
  e.preventDefault();
  clearAllDragIndicators();
  _lastDragRungId = null;

  const host = rungHostFromEvent(e);
  if (!host) return;
  const type   = e.dataTransfer.getData('text/plain') || store.getArmed();
  if (!type) return;
  const rungId = Number(host.dataset.rungId);
  const svgEl  = host.querySelector('.rung-svg');
  if (!svgEl) { store.addElement(rungId, type); return; }

  // Misma decisión por coordenadas que mostró el indicador durante el dragover
  applyPlan(rungId, type, dropPlan(rungId, svgEl, e.clientX, e.clientY, type));
}

// ── Búsqueda en sidebar ───────────────────────────────────────
function onSidebarSearch(e) {
  const q     = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.comp-item[data-type]');
  const sects = document.querySelectorAll('.sb-section');
  items.forEach(item => {
    if (!q) { item.style.display = ''; return; }
    const label = item.querySelector('strong')?.textContent.toLowerCase() ?? '';
    const sub   = item.querySelector('span')?.textContent.toLowerCase() ?? '';
    const type  = (item.dataset.type ?? '').toLowerCase().replace(/_/g,' ');
    item.style.display = (label.includes(q) || sub.includes(q) || type.includes(q)) ? '' : 'none';
  });
  sects.forEach(sec => {
    if (!q) { sec.style.display = ''; return; }
    let next = sec.nextElementSibling, any = false;
    while (next && !next.classList.contains('sb-section')) {
      if (next.style.display !== 'none') { any = true; break; }
      next = next.nextElementSibling;
    }
    sec.style.display = any ? '' : 'none';
  });
}

// ── Toolbar ───────────────────────────────────────────────────
function onToolbarClick(e) {
  const btn = e.target.closest('.et-btn');
  if (!btn) return;
  const sel  = store.getSelection();
  const icon = btn.querySelector('i');
  const iconClass = icon?.className ?? '';
  const txt  = btn.textContent.trim();

  if (txt.includes('Deshacer')) { if (store.canUndo()) store.undo(); else showToast('Nada que deshacer', 'info'); return; }
  if (txt.includes('Rehacer'))  { if (store.canRedo()) store.redo(); else showToast('Nada que rehacer', 'info');  return; }
  if (txt.includes('Insertar')) {
    const armed = store.getArmed();
    if (armed && sel.rungId) { store.addElement(sel.rungId, armed); showToast(`${armed} insertado`, 'success'); }
    else showToast('Selecciona rung + componente para insertar', 'info');
    return;
  }
  if (txt.includes('Eliminar')) {
    if (sel.elementId) {
      store.deleteElement(sel.rungId, sel.elementId);
      store.log('info', `Elemento eliminado del rung ${sel.rungId}`);
    } else if (sel.rungId) {
      const rung  = store.getProgram().rungs.find(r => r.id === sel.rungId);
      const count = rung?.network.reduce((s,row) => s + row.elements.length, 0) ?? 0;
      const ok    = count === 0 || confirm(`¿Eliminar rung ${sel.rungId}? (${count} elemento(s))`);
      if (ok) { store.deleteRung(sel.rungId); store.log('warn', `Rung ${sel.rungId} eliminado`); }
    }
    return;
  }
  if (txt.includes('Subir')  && sel.rungId) { store.moveRung(sel.rungId, -1); return; }
  if (txt.includes('Bajar')  && sel.rungId) { store.moveRung(sel.rungId,  1); return; }
  if (txt.includes('Copiar')) {
    if (sel.elementId) copyElement();
    else if (sel.rungId) copyRung();
    return;
  }
  if (txt.includes('Pegar')) { pasteFromClipboard(); return; }
  if (txt.includes('Paralelo')) { groupSelectionParallel(); return; }
  if (iconClass.includes('ti-zoom-in'))  { adjustZoom(0.2);  return; }
  if (iconClass.includes('ti-zoom-out')) { adjustZoom(-0.2); return; }
}

// ── Nav top menu: Compilar / Cargar / Stop ────────────────────
function onNavBtnClick(e) {
  const btn = e.target.closest('.tnav-btn, .tnav-menu-btn');
  if (!btn) return;
  const txt = btn.textContent.trim();

  // Menús desplegables de la barra
  if (btn.dataset.menu) {
    const menuId = btn.dataset.menu;
    const menu   = document.getElementById(menuId);
    if (!menu) return;
    // Cerrar otros
    document.querySelectorAll('.tnav-dropmenu').forEach(m => { if (m.id !== menuId) m.hidden = true; });
    menu.hidden = !menu.hidden;
    return;
  }

  if (txt.includes('Compilar')) {
    const errs = validateProgram(store.getProgram());
    if (errs.length === 0) {
      store.log('ok',   'Compilación exitosa — 0 errores, 0 advertencias');
      store.log('info', `${store.getProgram().rungs.length} rungs · ${Object.keys(store.getProgram().symbol_table).length} variables`);
      showToast('Compilación exitosa', 'success');
    } else {
      errs.forEach(err => store.log('err', err));
      showToast(`${errs.length} error(es)`, 'error');
    }
    const t = document.getElementById('tab-btn-terminal');
    if (t) showTab('terminal', t);
  }
  if (txt.includes('Cargar')) {
    cargarAlPLC();
  }
  if (txt.includes('Stop')) {
    store.log('warn', 'Stop enviado (stub)');
    showToast('Stop (stub)', 'info');
  }
}

// ── Cargar al PLC (envia el engine_config por Modbus TCP via servidor local) ──
async function cargarAlPLC() {
  const t = document.getElementById('tab-btn-terminal');
  if (t) showTab('terminal', t);

  const prog = store.getProgram();
  const cfg  = prog?.metadata?.engine_config;
  if (!cfg || !Array.isArray(cfg.outputs) || !cfg.outputs.length) {
    store.log('err', 'Este programa no tiene "engine_config". Genera el programa con el asistente IA (modo Diseñador) para poder cargarlo al PLC.');
    showToast('Sin engine_config para el PLC', 'error');
    return;
  }

  const url = plcBridgeUrl();
  store.log('info', `Enviando ${cfg.outputs.length} salida(s) al PLC vía ${url}/aplicar-plc …`);
  showToast('Cargando al PLC…', 'info');

  try {
    const res = await fetch(`${url}/aplicar-plc`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ logic: cfg }),
      signal:  AbortSignal.timeout(20000),
    });
    const d = await res.json().catch(() => null);

    if (!res.ok) {
      store.log('err', 'PLC: ' + (d?.detail || `HTTP ${res.status}`));
      showToast('Error al cargar al PLC', 'error');
      return;
    }

    store.log('ok', `Programa cargado al PLC ${d.plc || ''} — ${d.salidas} salida(s) escritas.`);
    (d.plan || []).forEach(p => store.log('info', '· ' + p));
    showToast('Programa cargado al PLC', 'success');
  } catch (e) {
    const offline = /Failed to fetch|NetworkError|timeout|aborted/i.test(e.message || '');
    store.log('err', offline
      ? `No se pudo contactar el servidor PLC en ${url}. ¿Está corriendo el backend local (uvicorn app:app) en la red del PLC?`
      : ('PLC: ' + e.message));
    showToast('Sin conexión al servidor PLC', 'error');
  }
}

// ── Acciones del menú desplegable de la nav ───────────────────
function onNavDropMenuClick(e) {
  const item = e.target.closest('[data-nav-action]');
  if (!item) return;
  document.querySelectorAll('.tnav-dropmenu').forEach(m => m.hidden = true);
  const action = item.dataset.navAction;
  switch (action) {
    case 'new':
      if (confirm('¿Crear nuevo programa? Se perderán los cambios no guardados.')) {
        store.setProgram(defaultProgram());
        history.replaceState(null, '', window.location.pathname);
        showToast('Nuevo programa creado', 'success');
      }
      break;
    case 'open-url': {
      const url = prompt('Pega la URL del programa:');
      if (url) {
        const p = importFromURL();
        if (p) { store.setProgram(p); showToast('Programa cargado', 'success'); }
        else showToast('URL inválida', 'error');
      }
      break;
    }
    case 'save-url': copyLink(); break;
    case 'export-json': {
      const blob = new Blob([JSON.stringify(store.getProgram(), null, 2)], { type: 'application/json' });
      const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: store.getProgram().metadata.name + '.json' });
      a.click(); URL.revokeObjectURL(a.href);
      showToast('JSON exportado', 'success');
      break;
    }
    case 'import-json': {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.onchange = () => {
        const fr = new FileReader();
        fr.onload = () => { try { store.setProgram(JSON.parse(fr.result)); showToast('JSON importado', 'success'); } catch { showToast('JSON inválido', 'error'); } };
        fr.readAsText(inp.files[0]);
      };
      inp.click();
      break;
    }
    case 'undo': if (store.canUndo()) store.undo(); else showToast('Nada que deshacer', 'info'); break;
    case 'copy-sel': { if (store.getSelection().elementId) copyElement(); else if (store.getSelection().rungId) copyRung(); break; }
    case 'paste-sel': pasteFromClipboard(); break;
    case 'delete-sel': {
      const sel = store.getSelection();
      if (sel.elementId) store.deleteElement(sel.rungId, sel.elementId);
      else if (sel.rungId) store.deleteRung(sel.rungId);
      break;
    }
    case 'plc-addr': {
      const meta = store.getProgram().metadata;
      const ip   = prompt('IP del PLC:', meta.plc_target.ip);
      if (ip !== null) store.updateMeta({ plc_target: { ...meta.plc_target, ip } });
      break;
    }
    case 'scan-time': {
      const meta = store.getProgram().metadata;
      const st   = prompt('Scan time (ms):', meta.scan_time_ms);
      if (st !== null && !isNaN(st)) store.updateMeta({ scan_time_ms: Number(st) });
      break;
    }
    case 'proj-name': {
      const meta = store.getProgram().metadata;
      const name = prompt('Nombre del proyecto:', meta.name);
      if (name !== null) store.updateMeta({ name });
      break;
    }
  }
}

// ── Property panel inputs ────────────────────────────────────
function onPropInput(e) {
  const sel = store.getSelection();
  if (!sel.rungId) return;
  const id  = e.target.id;

  if (id === 'propAddr' && sel.elementId) {
    store.updateElement(sel.rungId, sel.elementId, { address: e.target.value });
  }
  if (id === 'propType' && sel.elementId) {
    store.updateElement(sel.rungId, sel.elementId, { type: e.target.value });
  }
  if (id === 'propTimerPreset' && sel.elementId) {
    const prog = store.getProgram();
    const rung = prog.rungs.find(r => r.id === sel.rungId);
    let el = null;
    for (const row of rung?.network ?? []) { el = row.elements.find(e => e.id === sel.elementId); if (el) break; }
    if (el?.params) {
      const val = Number(e.target.value);
      const patch = el.params.preset_ms !== undefined ? { params: { ...el.params, preset_ms: val } } : { params: { ...el.params, preset: val } };
      store.updateElement(sel.rungId, sel.elementId, patch);
    }
  }
  if (id === 'propSym' && sel.elementId) {
    const prog = store.getProgram();
    const rung = prog.rungs.find(r => r.id === sel.rungId);
    let el = null;
    for (const row of rung?.network ?? []) { el = row.elements.find(e => e.id === sel.elementId); if (el) break; }
    if (el?.address) {
      const p = deepClone(prog);
      if (!p.symbol_table[el.address]) p.symbol_table[el.address] = { symbol: '', type: 'BOOL', modbus: { fn: 'internal', address: null }, comment: '' };
      p.symbol_table[el.address].symbol = e.target.value;
      store.setProgram(p);
    }
  }
  if (id === 'propComment' && sel.elementId) {
    const prog = store.getProgram();
    const rung = prog.rungs.find(r => r.id === sel.rungId);
    let el = null;
    for (const row of rung?.network ?? []) { el = row.elements.find(e => e.id === sel.elementId); if (el) break; }
    if (el?.address && prog.symbol_table[el.address]) {
      const p = deepClone(prog);
      p.symbol_table[el.address].comment = e.target.value;
      store.setProgram(p);
    }
  }
  if (id === 'propRungComment' && sel.rungId) {
    store.setRungComment(sel.rungId, e.target.value);
  }
}

// ── Tab switcher ─────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.bb-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name)?.classList.add('active');
  const prog  = store.getProgram();
  const panel = document.getElementById('tab-' + name);
  if (!panel) return;
  if (name === 'io')       panel.innerHTML = renderIOTable(prog);
  if (name === 'watch')    panel.innerHTML = renderWatchTable(prog);
  if (name === 'xref')     panel.innerHTML = renderXRefTable(prog);
  if (name === 'terminal') renderTerminal();
}
window.showTab = showTab;

// ── Compile / Upload stubs ────────────────────────────────────
function toggleBottomBar() { document.getElementById('bottombar')?.classList.toggle('collapsed'); }
window.toggleBottomBar = toggleBottomBar;

// ── Copy link ─────────────────────────────────────────────────
function copyLink() {
  const url = exportToURL(store.getProgram());
  pushToURL(store.getProgram());
  navigator.clipboard.writeText(url).then(() => showToast('¡Link copiado!', 'success')).catch(() => prompt('Copia este link:', url));
}
window.copyLink = copyLink;

// ── Keyboard ─────────────────────────────────────────────────
function onKeyDown(e) {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  const sel = store.getSelection();
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.elementId) {
    e.preventDefault(); store.deleteElement(sel.rungId, sel.elementId);
  }
  if (e.key === 'Escape') { store.clearSelection(); store.disarm(); hidePropPopup(); hideCtxMenu(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
    e.preventDefault();
    if (store.canUndo()) store.undo(); else showToast('Nada que deshacer', 'info');
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    e.preventDefault();
    if (store.canRedo()) store.redo(); else showToast('Nada que rehacer', 'info');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); if (sel.elementId) copyElement(); else if (sel.rungId) copyRung(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); pasteFromClipboard(); }
  if ((e.ctrlKey || e.metaKey) && e.key === '+') { e.preventDefault(); adjustZoom(0.2); }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); adjustZoom(-0.2); }
}

// ═══════════════════════════════════════════════════════════
// ← NUEVO: Importar programa desde .js generado por el modelo
// ─────────────────────────────────────────────────────────
// El .js generado por Python exporta: export const program = {...}
// Lo leemos como texto, extraemos el objeto JSON y lo cargamos
// en el store con store.setProgram() — que re-renderiza todo solo.
// ═══════════════════════════════════════════════════════════
function initImportIA() {
  const btn   = document.getElementById('btn-import-ia');    // ← NUEVO
  const input = document.getElementById('input-import-ia'); // ← NUEVO
  if (!btn || !input) return;

  // Click en el boton → abre el selector de archivo
  btn.addEventListener('click', () => input.click());        // ← NUEVO

  // Cuando el usuario elige un archivo
  input.addEventListener('change', () => {                   // ← NUEVO
    const file = input.files?.[0];
    if (!file) return;

    // Solo aceptar .js
    if (!file.name.endsWith('.js')) {
      showToast('Selecciona un archivo .js generado por el modelo', 'error');
      input.value = '';
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const contenido = e.target.result;

        // El .js tiene la forma:
        //   export const program = { ... };
        //   export default program;
        //
        // Extraemos el JSON entre el primer { y el ultimo }
        // antes del punto y coma de "export const program = ...;"
        const inicio = contenido.indexOf('{');
        if (inicio === -1) throw new Error('No se encontró el objeto program en el archivo.');

        // Encontrar el cierre: buscamos el ";" que sigue al ultimo "}"
        // Tomamos desde { hasta el final y quitamos la ultima linea
        let bloque = contenido.slice(inicio);

        // Remover el ";" final y lo que siga (export default program;)
        // Buscamos el ultimo } seguido opcionalmente de espacios/newline y ";"
        bloque = bloque.replace(/\}\s*;\s*[\s\S]*$/, '}');

        const programa = JSON.parse(bloque);

        // Validar que tiene la estructura minima esperada
        if (!programa.rungs || !programa.metadata) {
          throw new Error('El archivo no tiene la estructura de programa esperada (falta rungs o metadata).');
        }

        // Cargar en el store — esto dispara render() automaticamente
        store.setProgram(programa);

        // Resetear seleccion al primer rung
        if (programa.rungs.length > 0) {
          store.selectRung(programa.rungs[0].id);
        }

        // Log en terminal
        store.log('ok',   `Importado: "${programa.metadata.name}" — ${programa.rungs.length} rungs`);
        store.log('info', `Variables: ${Object.keys(programa.symbol_table || {}).length} en symbol table`);
        if (programa.metadata._explicacion)    store.log('info', programa.metadata._explicacion);
        if (programa.metadata._implementacion) store.log('info', 'Cscape: ' + programa.metadata._implementacion);

        // Ir a la terminal para ver el resultado
        const termTab = document.getElementById('tab-btn-terminal');
        if (termTab) showTab('terminal', termTab);

        showToast(`"${programa.metadata.name}" importado — ${programa.rungs.length} rungs`, 'success');
        input.value = '';

      } catch (err) {
        store.log('err', 'Error al importar: ' + err.message);
        showToast('Error al importar: ' + err.message, 'error');
        console.error('[ImportIA]', err);
        input.value = '';
      }
    };

    reader.onerror = () => {
      showToast('No se pudo leer el archivo', 'error');
      input.value = '';
    };

    reader.readAsText(file, 'UTF-8');
  });
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Sidebar draggable
  document.querySelectorAll('.comp-item[data-type]').forEach(el => el.setAttribute('draggable', 'true'));

  // Búsqueda sidebar
  document.querySelector('.sb-search input')?.addEventListener('input', onSidebarSearch);

  // Eventos de click
  document.getElementById('rungArea')?.addEventListener('click',     onRungAreaClick);
  document.getElementById('rungArea')?.addEventListener('dblclick',  onRungAreaDblClick);
  document.querySelector('.sidebar')?.addEventListener('click',      onSidebarClick);
  document.querySelector('.editor-toolbar')?.addEventListener('click', onToolbarClick);
  document.querySelector('.top-nav')?.addEventListener('click',      onNavBtnClick);
  document.getElementById('propScroll')?.addEventListener('input',   onPropInput);
  document.addEventListener('keydown', onKeyDown);

  // Clic derecho (context menu) — solo en el rung area
  document.getElementById('rungArea')?.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mousedown', onDocumentMouseDown);
  document.getElementById('pp-close-btn')?.addEventListener('click', hidePropPopup);

  // Context menu acciones
  document.getElementById('ctxMenu')?.addEventListener('click', onCtxMenuClick);

  // Nav drop menus
  document.querySelector('.top-nav')?.addEventListener('click', onNavDropMenuClick);
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-menu]') && !e.target.closest('.tnav-dropmenu')) {
      document.querySelectorAll('.tnav-dropmenu').forEach(m => m.hidden = true);
    }
  });

  // Bottom bar collapse
  document.getElementById('bb-collapse-btn')?.addEventListener('click', toggleBottomBar);

  // Escape cierra popups
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hidePropPopup(); hideCtxMenu(); } });

  // Drag-and-drop
  document.querySelector('.sidebar')?.addEventListener('dragstart', onSidebarDragStart);
  const ra = document.getElementById('rungArea');
  ra?.addEventListener('dragover',  onRungAreaDragOver);
  ra?.addEventListener('dragleave', onRungAreaDragLeave);
  ra?.addEventListener('drop',      onRungAreaDrop);

  // Autosave silencioso en URL
  store.subscribe(() => { try { pushToURL(store.getProgram()); } catch {} });

  // Render inicial
  initImportIA();

  render();

  const fromUrl = !!new URLSearchParams(window.location.search).get('l');
  store.log('info', fromUrl ? 'Programa cargado desde URL.' : 'Programa de ejemplo cargado.');
  store.log('info', `PLC target: ${store.getProgram().metadata.plc_target.ip}:${store.getProgram().metadata.plc_target.port}`);
});

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}