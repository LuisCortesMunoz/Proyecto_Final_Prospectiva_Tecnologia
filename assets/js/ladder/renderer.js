/**
 * renderer.js — SVG-based ladder rung renderer
 * Cada rung se renderiza como un SVG para alineación exacta de nodos y paralelos.
 */

import { isOutputType } from './schema.js';

// Constantes de la grilla
export const GR = {
  COL_W: 80,   // px por columna (incluye wires a ambos lados)
  ROW_H: 52,   // px por fila (main + cada rama paralela)
  RAIL:   6,   // ancho del riel de poder
  EL_W:  40,   // ancho SVG de contacto/bobina
  BLK_W: 54,   // ancho SVG de bloque (TON, CMP, etc.)
  EL_H:  24,   // alto SVG de elemento
  LPAD:  13,   // espacio sobre el elemento para label dirección
  BPAD:  10,   // espacio bajo el elemento para label símbolo
  JR:     3,   // radio de nodo de unión (T-junction)
};

function isBlock(t) { return t.startsWith('block_'); }
function elW(t) { return isBlock(t) ? GR.BLK_W : GR.EL_W; }
function midY(rowIdx) { return rowIdx * GR.ROW_H + GR.LPAD + GR.EL_H / 2; }
function colCX(col)   { return GR.RAIL + col * GR.COL_W + GR.COL_W / 2; }  // centro X de columna
function jX(col)      { return GR.RAIL + col * GR.COL_W; }                  // borde izq de columna
function svgW(n)      { return GR.RAIL + n * GR.COL_W + GR.RAIL; }
function svgH(n)      { return n * GR.ROW_H; }

// I0.1 → %I1  |  Q0.10 → %Q10  |  M0.1 → %M1  |  MW1 → %R1
function fmtAddr(address) {
  if (!address) return '';
  const s = String(address).toUpperCase();
  let m;
  m = s.match(/^I0\.(\d+)$/);  if (m) return `%I${m[1]}`;
  m = s.match(/^Q0\.(\d+)$/);  if (m) return `%Q${m[1]}`;
  m = s.match(/^M0\.(\d+)$/);  if (m) return `%M${m[1]}`;
  m = s.match(/^MW(\d+)$/);    if (m) return `%R${m[1]}`;
  return address;
}

// Posición izquierda del elemento (dentro del SVG)
function elLX(col, type) { return colCX(col) - elW(type) / 2; }
function elRX(col, type) { return colCX(col) + elW(type) / 2; }

const BLK = { block_ton:'TON', block_tof:'TOF', block_osc:'OSC', block_ctu:'CTU', block_ctd:'CTD', block_cmp:'CMP', block_mov:'MOV', block_add:'ADD' };

// Colores de lámpara para la simulación
const LAMP_COLOR = { green: '#22c55e', yellow: '#f59e0b', red: '#ef4444' };
const LAMP_DIM   = { green: 'rgba(34,197,94,0.22)', yellow: 'rgba(245,158,11,0.22)', red: 'rgba(239,68,68,0.22)' };

function elInner(type, en, el, varVals) {
  // Para bobinas con color de lámpara definido, usar estado individual (variable_values)
  if (type === 'coil' && el?.params?.lamp_color) {
    const lc  = el.params.lamp_color;
    const lit = !!varVals?.[el.address];
    const fc  = lit ? LAMP_COLOR[lc] ?? '#22c55e' : '#6f8aa6';
    const fd  = lit ? LAMP_DIM[lc]   ?? 'rgba(34,197,94,0.22)' : 'none';
    const sw  = lit ? 2.2 : 1.6;
    return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${fc}" stroke-width="${sw}"/>
      <circle cx="20" cy="12" r="8" fill="${fd}" stroke="${fc}" stroke-width="${sw}"/>
      ${lit ? `<circle cx="20" cy="12" r="4.5" fill="${fc}" opacity="0.55"/>` : ''}
      <line x1="28" y1="12" x2="40" y2="12" stroke="${fc}" stroke-width="${sw}"/>`;
  }

  // Paleta estándar: energizado azul sereno, desenergizado pizarra clara.
  const c  = en ? '#2f7ad6' : '#6f8aa6';
  const sw = en ? 1.8 : 1.6;
  switch (type) {
    case 'contact_no': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <line x1="12" y1="4" x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="4" x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>`;
    case 'contact_nc': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <line x1="12" y1="4" x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="4" x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <line x1="14" y1="20" x2="26" y2="4" stroke="${c}" stroke-width="1.3"/>`;
    case 'contact_pos_edge': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <line x1="12" y1="4" x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="4" x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">P</text>`;
    case 'contact_neg_edge': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <line x1="12" y1="4" x2="12" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="4" x2="28" y2="20" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">N</text>`;
    case 'coil': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <circle cx="20" cy="12" r="8" fill="none" stroke="${c}" stroke-width="${sw}"/>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>`;
    case 'coil_s': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <circle cx="20" cy="12" r="8" fill="none" stroke="${c}" stroke-width="${sw}"/>
      <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="${c}" font-family="monospace">S</text>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>`;
    case 'coil_r': return `
      <line x1="0" y1="12" x2="12" y2="12" stroke="${c}" stroke-width="${sw}"/>
      <circle cx="20" cy="12" r="8" fill="none" stroke="${c}" stroke-width="${sw}"/>
      <text x="20" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="${c}" font-family="monospace">R</text>
      <line x1="28" y1="12" x2="40" y2="12" stroke="${c}" stroke-width="${sw}"/>`;
    default:
      if (BLK[type]) return `
        <rect x="0" y="0" width="54" height="24" rx="3" fill="${en ? 'rgba(47,122,214,0.10)' : 'rgba(99,122,150,0.06)'}" stroke="${c}" stroke-width="1.4"/>
        <text x="27" y="16" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="monospace">${BLK[type]}</text>`;
      return `<text x="20" y="16" text-anchor="middle" font-size="9" fill="${c}">?</text>`;
  }
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function symLabel(addr, st) {
  const s = st?.[addr]?.symbol;
  return (s && s !== addr) ? esc(s) : '';
}

/**
 * Renderiza un rung completo como div con SVG embebido.
 * El SVG tiene posicionamiento exacto de elementos, wires y ramas paralelas.
 */
export function renderRung(rung, program, selection) {
  const en      = !!program.execution_state?.rung_states?.[String(rung.id)];
  const varVals = program.execution_state?.variable_values ?? {};
  const selRung = selection?.rungId === rung.id;
  const rows    = rung.network ?? [{ row: 0, elements: [] }];

  const wC = en ? '#2f7ad6' : '#aebfd2';   // wire color (claro, sin neón)
  const rC = en ? '#2f7ad6' : '#7089a8';   // rail color (pizarra clara, ya no azul marino)
  const jC = en ? '#2f7ad6' : '#6f8aa6';   // junction node fill
  const addrC = en ? 'rgba(31,111,214,0.95)' : 'rgba(45,110,190,0.72)';
  const symC  = en ? 'rgba(45,110,190,0.80)' : 'rgba(90,112,140,0.72)';

  // Columnas: tomar el máximo entre la principal y TODAS las ramas, para
  // que una rama con varios elementos en serie no se desborde del SVG.
  const mainEls = [...(rows[0]?.elements ?? [])].sort((a,b) => a.pos.col - b.pos.col);
  let maxCol = 0;
  for (const row of rows) {
    for (const el of (row.elements ?? [])) if (el.pos.col > maxCol) maxCol = el.pos.col;
    if (row.span && row.span.to > maxCol) maxCol = row.span.to;
  }
  const numCols = maxCol + 1;
  const numRows = rows.length;

  const W = svgW(numCols);
  const H = svgH(numRows);
  const m0 = midY(0);  // wire Y de la fila principal

  let bg='', rails='', wires='', elsvg='', juncs='', hits='';

  // Zona de salida (última columna) — tint sutil
  if (mainEls.length > 0 && isOutputType(mainEls[mainEls.length-1].type)) {
    const lc = mainEls[mainEls.length-1].pos.col;
    bg += `<rect x="${jX(lc)}" y="0" width="${GR.COL_W + GR.RAIL}" height="${H}" fill="rgba(46,100,170,0.07)" rx="2"/>`;
  }

  // Rieles de poder
  rails += `<rect x="0" y="3" width="${GR.RAIL}" height="${H-6}" fill="${rC}" rx="2"/>`;
  rails += `<rect x="${W-GR.RAIL}" y="3" width="${GR.RAIL}" height="${H-6}" fill="${rC}" rx="2"/>`;

  rows.forEach((row, ri) => {
    const sorted = [...(row.elements ?? [])].sort((a,b) => a.pos.col - b.pos.col);
    const ry = midY(ri);
    const isBr = ri > 0;
    const span = row.span ?? (
      sorted.length
        ? { from: sorted[0].pos.col, to: sorted[sorted.length-1].pos.col }
        : { from: 0, to: numCols - 1 }
    );

    if (isBr) {
      // ── Conectores verticales ───────────────────────────
      const lx = jX(span.from);
      const rx = jX(span.to + 1);
      wires += `<line x1="${lx}" y1="${m0}" x2="${lx}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      wires += `<line x1="${rx}" y1="${m0}" x2="${rx}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      // Nodos T-junction en la fila principal
      juncs += `<circle cx="${lx}" cy="${m0}" r="${GR.JR}" fill="${jC}"/>`;
      juncs += `<circle cx="${rx}" cy="${m0}" r="${GR.JR}" fill="${jC}"/>`;
      // Wires horizontales de la rama
      if (sorted.length === 0) {
        wires += `<line x1="${lx}" y1="${ry}" x2="${rx}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      } else {
        wires += `<line x1="${lx}" y1="${ry}" x2="${elLX(sorted[0].pos.col, sorted[0].type)}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
        for (let i=0; i<sorted.length-1; i++) {
          wires += `<line x1="${elRX(sorted[i].pos.col, sorted[i].type)}" y1="${ry}" x2="${elLX(sorted[i+1].pos.col, sorted[i+1].type)}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
        }
        wires += `<line x1="${elRX(sorted[sorted.length-1].pos.col, sorted[sorted.length-1].type)}" y1="${ry}" x2="${rx}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      }
    } else {
      // ── Fila principal: wire continuo ─────────────────────
      if (sorted.length === 0) {
        wires += `<line x1="${GR.RAIL}" y1="${ry}" x2="${W-GR.RAIL}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      } else {
        wires += `<line x1="${GR.RAIL}" y1="${ry}" x2="${elLX(sorted[0].pos.col, sorted[0].type)}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
        for (let i=0; i<sorted.length-1; i++) {
          wires += `<line x1="${elRX(sorted[i].pos.col, sorted[i].type)}" y1="${ry}" x2="${elLX(sorted[i+1].pos.col, sorted[i+1].type)}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
        }
        wires += `<line x1="${elRX(sorted[sorted.length-1].pos.col, sorted[sorted.length-1].type)}" y1="${ry}" x2="${W-GR.RAIL}" y2="${ry}" stroke="${wC}" stroke-width="2"/>`;
      }
    }

    // ── Elementos de esta fila ─────────────────────────────
    sorted.forEach(el => {
      const ew  = elW(el.type);
      const ex  = colCX(el.pos.col) - ew / 2;
      const ey  = ry - GR.EL_H / 2;
      const sel = selRung && selection?.elementId === el.id;
      const inMulti = selection?.multiRungId === rung.id && selection?.multiIds?.has?.(el.id);

      if (sel) {
        elsvg += `<rect x="${ex-4}" y="${ey-2}" width="${ew+8}" height="${GR.EL_H+4}" rx="3" fill="rgba(46,125,225,0.18)" stroke="rgba(46,125,225,0.5)" stroke-width="1"/>`;
      } else if (inMulti) {
        elsvg += `<rect x="${ex-4}" y="${ey-2}" width="${ew+8}" height="${GR.EL_H+4}" rx="3" fill="rgba(77,158,247,0.12)" stroke="#4d9ef7" stroke-width="1" stroke-dasharray="3 2"/>`;
      }
      elsvg += `<g transform="translate(${ex},${ey})">${elInner(el.type, en, el, varVals)}</g>`;

      // Etiqueta dirección (encima)
      elsvg += `<text x="${colCX(el.pos.col)}" y="${ey-3}" text-anchor="middle" font-size="10" font-weight="600" fill="${addrC}" font-family="DM Mono,monospace">${esc(el.address)}</text>`;
      // Etiqueta símbolo (debajo)
      const sym = symLabel(el.address, program.symbol_table);
      if (sym) elsvg += `<text x="${colCX(el.pos.col)}" y="${ey+GR.EL_H+9}" text-anchor="middle" font-size="8" fill="${symC}" font-family="DM Mono,monospace">${sym}</text>`;

      // Área de hit (transparente, captura click/dblclick/contextmenu)
      hits += `<rect class="ladder-el" x="${ex-8}" y="${ey-GR.LPAD+2}" width="${ew+16}" height="${GR.EL_H+GR.LPAD+GR.BPAD-4}" fill="transparent" rx="3"
        data-rung-id="${rung.id}" data-el-id="${esc(el.id)}" data-col="${el.pos.col}" data-row="${ri}" style="cursor:pointer"/>`;
    });
  });

  const cls = ['rung', selRung && 'selected', en && 'energized'].filter(Boolean).join(' ');
  return `<div class="${cls}" id="rung-${rung.id}" role="listitem" tabindex="0" data-rung-id="${rung.id}" aria-label="Rung ${rung.id}: ${esc(rung.comment)}">
    <div class="rung-num">${rung.id}</div>
    <div class="rung-inner">
      <div class="rung-comment" data-rung-id="${rung.id}">${esc(rung.comment)}</div>
      <div class="rung-svg-wrap" data-rung-id="${rung.id}">
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="rung-svg" data-rung-id="${rung.id}" data-num-cols="${numCols}">
          ${bg}${rails}${wires}${elsvg}${juncs}${hits}
        </svg>
      </div>
    </div>
  </div>`;
}

export function renderAllRungs(container, program, selection) {
  const rungs = program.rungs ?? [];
  container.innerHTML = rungs.map(r => renderRung(r, program, selection)).join('') +
    `<div class="rung-add" id="btn-add-rung" role="button" tabindex="0" aria-label="Agregar nuevo rung">
      <i class="ti ti-plus"></i> Agregar rung
    </div>`;
}

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
    <tbody>${rows ||
      '<tr><td colspan="6" style="color:var(--text-tertiary);text-align:center;padding:12px">Sin variables definidas</td></tr>'
    }</tbody>
  </table>`;
}

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

export function renderXRefTable(program) {
  const refs = [];
  for (const rung of program.rungs) {
    for (const row of rung.network ?? []) {
      for (const el of row.elements ?? []) {
        refs.push({
          addr: el.address,
          sym:  program.symbol_table?.[el.address]?.symbol ?? el.address,
          rung: rung.id,
          row:  row.row,
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
      <td class="mono">${r.row > 0 ? `rama ${r.row}` : 'principal'}</td>
      <td class="mono">${r.use}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Dirección</th><th>Símbolo</th><th>Rung</th><th>Fila</th><th>Uso</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
