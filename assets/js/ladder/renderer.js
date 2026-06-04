/**
 * renderer.js — Convierte el programa JSON en HTML/DOM
 * Todas las funciones son puras: reciben datos, retornan HTML strings.
 *
 * FIXES v2:
 *  1. Wire layout: el flex va DESPUES del último elemento (no antes)
 *     para que la bobina quede pegada al riel derecho, igual que Cscape.
 *  2. Bobina: el SVG ya NO dibuja sus propios wires de entrada/salida
 *     (los wires del canvas la conectan). Evita la línea doble.
 *  3. Rama paralela: altura aumentada a 52px para alinearse con fila 0.
 *  4. Etiqueta de dirección: se muestra encima del elemento con la
 *     notacion original del PLC (%I1, %Q10) extraida del symbol_table
 *     o formateada desde la dirección normalizada.
 */

const BLOCK_LABELS = {
  block_ton: 'TON', block_tof: 'TOF', block_ctu: 'CTU',
  block_ctd: 'CTD', block_cmp: 'CMP', block_mov: 'MOV', block_add: 'ADD',
};

// ── Convierte dirección interna (I0.1) a notacion PLC (%I1) para mostrar ──
function fmtAddr(address) {
  if (!address) return '';
  const s = String(address).toUpperCase();
  // I0.N → %I<N>
  let m = s.match(/^I0\.(\d+)$/);
  if (m) return `%I${m[1]}`;
  // Q0.N → %Q<N>
  m = s.match(/^Q0\.(\d+)$/);
  if (m) return `%Q${m[1]}`;
  // M0.N → %M<N>
  m = s.match(/^M0\.(\d+)$/);
  if (m) return `%M${m[1]}`;
  // MWN → %RN
  m = s.match(/^MW(\d+)$/);
  if (m) return `%R${m[1]}`;
  return address;
}

/** SVG por tipo de elemento */
function elementSVG(type, energized) {
  const c  = energized ? '#4d9ef7' : '#3d6fa8';
  const sw = energized ? 1.8 : 1.6;

  switch (type) {

    // ── Contacto NO: dos barras verticales ──────────────
    case 'contact_no':
      return `<svg width="36" height="28" viewBox="0 0 36 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="10" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="10" y1="5"  x2="10" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="5"  x2="26" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="14" x2="36" y2="14" stroke="${c}" stroke-width="${sw}"/>
      </svg>`;

    // ── Contacto NC: barras + diagonal ──────────────────
    case 'contact_nc':
      return `<svg width="36" height="28" viewBox="0 0 36 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="10" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="10" y1="5"  x2="10" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="5"  x2="26" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="14" x2="36" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="22" x2="24" y2="6"  stroke="${c}" stroke-width="1.4"/>
      </svg>`;

    // ── Flanco positivo ──────────────────────────────────
    case 'contact_pos_edge':
      return `<svg width="36" height="28" viewBox="0 0 36 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="10" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="10" y1="5"  x2="10" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="5"  x2="26" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="14" x2="36" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <text x="18" y="18" text-anchor="middle" font-size="9" font-weight="700"
              fill="${c}" font-family="monospace">P</text>
      </svg>`;

    // ── Flanco negativo ──────────────────────────────────
    case 'contact_neg_edge':
      return `<svg width="36" height="28" viewBox="0 0 36 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="10" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="10" y1="5"  x2="10" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="5"  x2="26" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="26" y1="14" x2="36" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <text x="18" y="18" text-anchor="middle" font-size="9" font-weight="700"
              fill="${c}" font-family="monospace">N</text>
      </svg>`;

    // ── Bobinas: solo circulo, SIN wires propios ─────────
    // Los wires los pone el canvas, no el SVG.
    // Antes tenia <line> de 0→12 y 28→40 que causaban doble linea.
    case 'coil':
    case 'coil_s':
    case 'coil_r': {
      const lbl = type === 'coil_s' ? 'S' : type === 'coil_r' ? 'R' : '';
      return `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="10" fill="none" stroke="${c}" stroke-width="${sw}"/>
        ${lbl
          ? `<text x="14" y="18" text-anchor="middle" font-size="10"
                   font-weight="700" fill="${c}" font-family="monospace">${lbl}</text>`
          : ''}
      </svg>`;
    }

    // ── Bloques de funcion: rectangulo con etiqueta ──────
    default:
      if (BLOCK_LABELS[type]) {
        return `<svg width="52" height="28" viewBox="0 0 52 28" aria-hidden="true">
          <rect x="1" y="3" width="50" height="22" rx="3"
                fill="none" stroke="${c}" stroke-width="1.4"/>
          <text x="26" y="18" text-anchor="middle" font-size="9"
                font-weight="600" fill="${c}"
                font-family="monospace">${BLOCK_LABELS[type]}</text>
        </svg>`;
      }
      return `<svg width="36" height="28" viewBox="0 0 36 28">
        <text x="18" y="18" text-anchor="middle" font-size="9"
              fill="${c}">?</text>
      </svg>`;
  }
}

function sym(address, symbolTable) {
  const s = symbolTable?.[address]?.symbol;
  return (s && s !== address) ? s : '';
}

/**
 * Renderiza una fila del network (fila 0 = serie principal, filas 1+ = ramas paralelas)
 *
 * Layout del canvas (izquierda → derecha):
 *   [riel] [wire] [el] [wire] [el] [wire] [el] [wire:flex] [riel]
 *
 * El wire FLEX va al final, entre el ultimo elemento y el riel derecho.
 * Esto hace que los contactos queden a la izquierda y la bobina
 * quede pegada al riel derecho, igual que en Cscape.
 *
 * Excepcion: si la fila esta vacia, un solo wire flex llena el espacio.
 */
function renderNetworkRow(row, rowIdx, rungId, energized, selRung, selection, symbolTable) {
  const isBranch  = rowIdx > 0;
  const elements  = row.elements ?? [];
  const sorted    = [...elements].sort((a, b) => a.pos.col - b.pos.col);
  const ac        = energized ? ' active' : '';
  const railClass = isBranch ? 'branch-rail' : 'power-rail';

  // Detectar si el ultimo elemento es una bobina
  // Las bobinas tienen SVG mas angosto (28px) — necesitan wire de salida
  const lastEl   = sorted[sorted.length - 1];
  const lastIsCoil = lastEl && lastEl.type.startsWith('coil');

  let canvas = `<div class="${railClass}"></div>`;

  if (sorted.length === 0) {
    // Fila vacia: solo wire flex para mantener la altura
    canvas += `<div class="wire${ac} flex"></div>`;
  } else {
    sorted.forEach((el, i) => {
      const isLast = i === sorted.length - 1;
      const selEl  = selRung && selection?.elementId === el.id;
      const label  = fmtAddr(el.address);

      // Wire ANTES del elemento: fijo entre contactos, flex solo al final
      if (!isLast) {
        canvas += `<div class="wire${ac}" style="width:16px"></div>`;
      }

      canvas += `<div class="ladder-el${selEl ? ' selected-el' : ''}"
        data-rung-id="${rungId}" data-el-id="${el.id}"
        title="${el.type} · ${el.address}">
        <span class="el-addr">${label}</span>
        ${elementSVG(el.type, energized)}
        <span class="el-sym">${sym(el.address, symbolTable)}</span>
      </div>`;

      // Wire DESPUES del ultimo elemento:
      // - flex si es contacto (empuja la bobina al final)
      // - fijo si es bobina (la conecta al riel derecho)
      if (isLast) {
        canvas += lastIsCoil
          ? `<div class="wire${ac}" style="width:8px"></div>`
          : `<div class="wire${ac} flex"></div>`;
      }
    });
  }

  canvas += `<div class="${railClass}"></div>`;

  const cls = isBranch ? 'rung-canvas branch-row' : 'rung-canvas';
  return `<div class="${cls}" data-row="${rowIdx}">${canvas}</div>`;
}

/** Renderiza un rung completo con soporte para ramas paralelas */
export function renderRung(rung, program, selection) {
  const energized = !!program.execution_state?.rung_states?.[String(rung.id)];
  const selRung   = selection?.rungId === rung.id;
  const rows      = rung.network ?? [{ row: 0, elements: [] }];

  const networkHTML = rows.map((row, idx) =>
    renderNetworkRow(row, idx, rung.id, energized, selRung, selection, program.symbol_table)
  ).join('');

  const cls = ['rung', selRung && 'selected', energized && 'energized']
    .filter(Boolean).join(' ');

  return `<div class="${cls}" id="rung-${rung.id}"
    role="listitem" tabindex="0" data-rung-id="${rung.id}"
    aria-label="Rung ${rung.id}: ${rung.comment}">
    <div class="rung-num">${rung.id}</div>
    <div class="rung-inner">
      <div class="rung-comment" data-rung-id="${rung.id}">${esc(rung.comment)}</div>
      <div class="rung-network">${networkHTML}</div>
    </div>
  </div>`;
}

/** Vuelca todos los rungs en el contenedor dado */
export function renderAllRungs(container, program, selection) {
  const rungs = program.rungs ?? [];
  const html  = rungs.map(r => renderRung(r, program, selection)).join('');
  container.innerHTML = html + `<div class="rung-add" id="btn-add-rung"
    role="button" tabindex="0" aria-label="Agregar nuevo rung">
    <i class="ti ti-plus"></i> Agregar rung
  </div>`;
}

/** Tabla Estado I/O */
export function renderIOTable(program) {
  const rows = Object.entries(program.symbol_table).map(([addr, e]) => `
    <tr>
      <td class="mono">${esc(fmtAddr(addr))}</td>
      <td>${esc(e.symbol)}</td>
      <td class="mono">${e.type}</td>
      <td class="mono">${e.modbus.fn}</td>
      <td class="mono">${e.modbus.address ?? '—'}</td>
      <td>${esc(e.comment)}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr>
      <th>Dirección</th><th>Símbolo</th><th>Tipo</th>
      <th>Modbus fn</th><th>Reg</th><th>Comentario</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:var(--text-tertiary);text-align:center;padding:12px">Sin variables definidas</td></tr>'}</tbody>
  </table>`;
}

/** Watch table */
export function renderWatchTable(program) {
  const rows = Object.entries(program.symbol_table).map(([addr, e]) => `
    <tr>
      <td>${esc(fmtAddr(addr))} — ${esc(e.symbol)}</td>
      <td class="mono">${e.type}</td>
      <td><span class="val-mono">—</span></td>
      <td><button class="force-btn">Forzar</button></td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Variable</th><th>Tipo</th><th>Valor</th><th>Acción</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Referencias cruzadas */
export function renderXRefTable(program) {
  const refs = [];
  for (const rung of program.rungs) {
    for (const row of rung.network ?? []) {
      for (const el of row.elements ?? []) {
        refs.push({
          addr: fmtAddr(el.address),
          sym:  program.symbol_table?.[el.address]?.symbol ?? el.address,
          rung: rung.id,
          fila: row.row ?? 0,
          use:  el.type,
        });
      }
    }
  }
  if (!refs.length) return `<p style="padding:12px;color:var(--text-tertiary);
    font-family:var(--font-mono);font-size:11px">Sin referencias</p>`;
  const rows = refs.map(r => `
    <tr>
      <td class="mono">${esc(r.addr)}</td>
      <td>${esc(r.sym)}</td>
      <td class="mono">${r.rung}</td>
      <td class="mono">${r.fila > 0 ? `paralela ${r.fila}` : 'serie'}</td>
      <td class="mono">${r.use}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr>
      <th>Dirección</th><th>Símbolo</th><th>Rung</th><th>Fila</th><th>Uso</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}