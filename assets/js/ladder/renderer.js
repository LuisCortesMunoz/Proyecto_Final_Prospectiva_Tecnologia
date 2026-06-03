/**
 * renderer.js — Convierte el programa JSON en HTML/DOM
 * Todas las funciones son puras: reciben datos, retornan HTML strings.
 */

const BLOCK_LABELS = {
  block_ton: 'TON', block_tof: 'TOF', block_ctu: 'CTU',
  block_ctd: 'CTD', block_cmp: 'CMP', block_mov: 'MOV', block_add: 'ADD',
};

/** SVG por tipo — mismo estilo que la paleta del sidebar */
function elementSVG(type, energized) {
  const c  = energized ? '#4d9ef7' : '#3d6fa8';
  const sw = energized ? 1.8 : 1.6;

  switch (type) {
    case 'contact_no':
      return `<svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="0"  y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="4"  x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="4"  x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
      </svg>`;

    case 'contact_nc':
      return `<svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="0"  y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="4"  x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="4"  x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <line x1="14" y1="20" x2="26" y2="4"  stroke="${c}" stroke-width="1.3"/>
      </svg>`;

    case 'contact_pos_edge':
      return `<svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="0"  y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="4"  x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="4"  x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">P</text>
      </svg>`;

    case 'contact_neg_edge':
      return `<svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="0"  y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="4"  x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="4"  x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">N</text>
      </svg>`;

    case 'coil':
    case 'coil_s':
    case 'coil_r': {
      const lbl = type === 'coil_s' ? 'S' : type === 'coil_r' ? 'R' : '';
      return `<svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="0"  y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
        <circle cx="20" cy="12" r="8" fill="none" stroke="${c}" stroke-width="${sw}"/>
        ${lbl ? `<text x="20" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="${c}" font-family="monospace">${lbl}</text>` : ''}
        <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
      </svg>`;
    }

    default:
      if (BLOCK_LABELS[type]) {
        return `<svg width="54" height="24" viewBox="0 0 54 24" aria-hidden="true">
          <rect x="2" y="3" width="50" height="18" rx="3" fill="none" stroke="${c}" stroke-width="1.4"/>
          <text x="27" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">${BLOCK_LABELS[type]}</text>
        </svg>`;
      }
      return `<svg width="40" height="24" viewBox="0 0 40 24">
        <text x="20" y="16" text-anchor="middle" font-size="9" fill="${c}">?</text>
      </svg>`;
  }
}

function sym(address, symbolTable) {
  const s = symbolTable?.[address]?.symbol;
  return (s && s !== address) ? s : '';
}

/** Renderiza una fila de la red (serie o rama paralela) */
function renderNetworkRow(row, rowIdx, rungId, energized, selRung, selection, symbolTable) {
  const isBranch  = rowIdx > 0;
  const elements  = row.elements ?? [];
  const sorted    = [...elements].sort((a, b) => a.pos.col - b.pos.col);
  const ac        = energized ? ' active' : '';
  const railClass = isBranch ? 'branch-rail' : 'power-rail';

  let canvas = `<div class="${railClass}"></div>`;

  sorted.forEach((el, i) => {
    const isLast = i === sorted.length - 1;
    const selEl  = selRung && selection?.elementId === el.id;
    canvas += isLast
      ? `<div class="wire${ac} flex"></div>`
      : `<div class="wire${ac}" style="width:14px"></div>`;
    canvas += `<div class="ladder-el${selEl ? ' selected-el' : ''}"
      data-rung-id="${rungId}" data-el-id="${el.id}"
      title="${el.type} · ${el.address}">
      <span class="el-addr">${el.address}</span>
      ${elementSVG(el.type, energized)}
      <span class="el-sym">${sym(el.address, symbolTable)}</span>
    </div>`;
  });

  canvas += sorted.length > 0
    ? `<div class="wire${ac}" style="width:14px"></div>`
    : `<div class="wire${ac} flex"></div>`;
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

  const cls = ['rung', selRung && 'selected', energized && 'energized'].filter(Boolean).join(' ');

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

/** Tabla Estado I/O desde symbol_table */
export function renderIOTable(program) {
  const rows = Object.entries(program.symbol_table).map(([addr, e]) => `
    <tr>
      <td class="mono">${esc(addr)}</td>
      <td>${esc(e.symbol)}</td>
      <td class="mono">${e.type}</td>
      <td class="mono">${e.modbus.fn}</td>
      <td class="mono">${e.modbus.address ?? '—'}</td>
      <td>${esc(e.comment)}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Dirección</th><th>Símbolo</th><th>Tipo</th><th>Modbus fn</th><th>Reg</th><th>Comentario</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:var(--text-tertiary);text-align:center;padding:12px">Sin variables definidas</td></tr>'}</tbody>
  </table>`;
}

/** Watch table (valores en ejecución — stub) */
export function renderWatchTable(program) {
  const rows = Object.entries(program.symbol_table).map(([addr, e]) => `
    <tr>
      <td>${esc(addr)} — ${esc(e.symbol)}</td>
      <td class="mono">${e.type}</td>
      <td><span class="val-mono">—</span></td>
      <td><button class="force-btn">Forzar</button></td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Variable</th><th>Tipo</th><th>Valor</th><th>Acción</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Referencias cruzadas desde rungs */
export function renderXRefTable(program) {
  const refs = [];
  for (const rung of program.rungs) {
    for (const el of rung.network?.[0]?.elements ?? []) {
      refs.push({
        addr: el.address,
        sym:  program.symbol_table?.[el.address]?.symbol ?? el.address,
        rung: rung.id,
        use:  el.type,
      });
    }
  }
  if (!refs.length) return `<p style="padding:12px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px">Sin referencias</p>`;
  const rows = refs.map(r => `
    <tr>
      <td class="mono">${esc(r.addr)}</td>
      <td>${esc(r.sym)}</td>
      <td class="mono">${r.rung}</td>
      <td class="mono">${r.use}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Dirección</th><th>Símbolo</th><th>Rung</th><th>Uso</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
