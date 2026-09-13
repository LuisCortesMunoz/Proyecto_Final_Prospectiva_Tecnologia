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

  // Desenergizado: gris oscuro neutro. Energizado: azul.
  const c  = en ? '#2e7de1' : '#3f3f46';
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
        <rect x="0" y="0" width="54" height="24" rx="3" fill="${en ? 'rgba(46,125,225,0.08)' : 'none'}" stroke="${c}" stroke-width="1.4"/>
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
      <div class="rung-head">
        <div class="rung-comment" data-rung-id="${rung.id}">${esc(rung.comment)}</div>
        <button class="rung-menu-btn" data-rung-id="${rung.id}" title="Opciones del rung" tabindex="-1">
          <i class="ti ti-dots-vertical"></i>
        </button>
      </div>
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

// ── Panel visual de la banda transportadora ────────────────────
// Esquema de la estación física (botonera, VFD + motor, banda, sensores,
// plumas y torreta), tomando como referencia visual el proyecto Cscape de la
// banda. Se dibuja con metadata._band_view y el bloque "band" del
// engine_config; los componentes que no participan en la instrucción quedan
// atenuados. Es presentación pura: no ejecuta ni altera lógica.
//
// paintBandLive() pinta encima el feedback REAL del PLC (lo llama
// band-control.js en cada sondeo); sin lectura, el esquema es solo la vista
// de la configuración.

const BAND_LAMP = {
  verde:    { on: '#22c55e', off: 'rgba(34,197,94,0.18)',  label: 'Verde',    io: 'Q3', bit: 1 },
  amarilla: { on: '#f59e0b', off: 'rgba(245,158,11,0.18)', label: 'Amarilla', io: 'Q4', bit: 2 },
  roja:     { on: '#ef4444', off: 'rgba(239,68,68,0.18)',  label: 'Roja',     io: 'Q5', bit: 4 },
};

// Códigos de acción de sensor del ST (y los nombres que traduce el backend).
const BAND_ACCION = {
  nada: 0, paro_presencia: 1, paro_mientras_detecta: 1, paro_temporizado: 2,
  paro_presencia_torreta: 3, paro_mientras_detecta_torreta: 3,
  paro_temporizado_torreta: 4,
};

function bandAccion(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : (BAND_ACCION[String(v).toLowerCase()] ?? null);
}

/** Texto corto de lo que hace un sensor en esta instrucción. */
function bandSensorTexto(accion, seconds, count, retrigger) {
  let t;
  if (accion === 0) t = 'solo cuenta';
  else if (accion === 1 || accion === 3) t = 'detiene mientras detecta';
  else if (seconds != null) t = `detiene ${seconds} s`;
  else t = 'detecta';
  if (accion === 3 || accion === 4) t += ' + torreta';
  if (count > 0) t += ` · cada ${count} pz`;
  if (retrigger != null) t += ` · bloqueo ${retrigger} s`;
  return t;
}

/** Botonera física: I1 arranque (pulsador verde) e I3 paro (hongo rojo). */
function bandBotonera(x, y) {
  return `
    <g class="bp-botonera">
      <rect x="${x}" y="${y}" width="128" height="92" rx="5"
            fill="var(--bg-surface)" stroke="var(--border)" stroke-width="1.3"/>
      <text x="${x + 10}" y="${y + 15}" font-size="10" font-weight="700"
            fill="var(--text-secondary)" font-family="var(--font-ui)">Botonera</text>
      <g class="bp-btn bp-btn-start" data-bp="i1">
        <circle cx="${x + 34}" cy="${y + 48}" r="15" fill="var(--bg-elevated)"
                stroke="var(--wire-inactive)" stroke-width="1.3"/>
        <circle class="bp-btn-cap" cx="${x + 34}" cy="${y + 48}" r="10"
                fill="rgba(34,197,94,0.25)" stroke="#16a34a" stroke-width="1.6"/>
        <text x="${x + 34}" y="${y + 78}" text-anchor="middle" font-size="9.5"
              fill="var(--text-secondary)" font-family="var(--font-ui)">
          <tspan font-family="var(--font-mono)" font-weight="700" fill="var(--text-mono)">I1</tspan> Arranque
        </text>
      </g>
      <g class="bp-btn bp-btn-stop" data-bp="i3">
        <rect x="${x + 84}" y="${y + 50}" width="16" height="10" rx="2"
              fill="var(--bg-elevated)" stroke="var(--wire-inactive)" stroke-width="1.2"/>
        <circle class="bp-btn-cap" cx="${x + 92}" cy="${y + 45}" r="13"
                fill="rgba(239,68,68,0.25)" stroke="#dc2626" stroke-width="1.6"/>
        <text x="${x + 92}" y="${y + 78}" text-anchor="middle" font-size="9.5"
              fill="var(--text-secondary)" font-family="var(--font-ui)">
          <tspan font-family="var(--font-mono)" font-weight="700" fill="var(--text-mono)">I3</tspan> Paro
        </text>
      </g>
    </g>`;
}

/** Variador: caja con el comando al VFD y la frecuencia (consigna / real). */
function bandVFD(x, y, view) {
  const dir = view.direction === 'izquierda' ? 2 : 1;
  return `
    <g class="bp-vfd">
      <rect x="${x}" y="${y}" width="128" height="70" rx="5"
            fill="var(--bg-surface)" stroke="var(--accent)" stroke-width="1.5"/>
      <text x="${x + 10}" y="${y + 16}" font-size="10" font-weight="700"
            fill="var(--accent)" font-family="var(--font-mono)">VFD</text>
      <text x="${x + 118}" y="${y + 16}" text-anchor="end" font-size="9"
            fill="var(--text-tertiary)" font-family="var(--font-mono)">%R500</text>
      <line x1="${x + 8}" y1="${y + 22}" x2="${x + 120}" y2="${y + 22}"
            stroke="var(--border)" stroke-width="1"/>
      <text x="${x + 10}" y="${y + 37}" font-size="9.5"
            fill="var(--text-secondary)" font-family="var(--font-ui)">
        Marcha: <tspan data-bp="vfd-cmd">Dirección ${dir} (${view.vfd_cmd})</tspan>
      </text>
      <text x="${x + 10}" y="${y + 51}" font-size="9.5"
            fill="var(--text-secondary)" font-family="var(--font-ui)">
        Consigna: <tspan font-weight="700" fill="var(--accent)">${view.freq_hz != null ? `${view.freq_hz} Hz` : 'sin cambio'}</tspan>
      </text>
      <text x="${x + 10}" y="${y + 64}" font-size="9.5"
            fill="var(--text-tertiary)" font-family="var(--font-ui)">
        Velocidad: <tspan data-bp="vfd-speed" font-family="var(--font-mono)">— Hz</tspan>
      </text>
    </g>`;
}

/** Banda con rodillos, motor, recorrido y flechas de ambos sentidos. */
function bandCinta(izq) {
  const rodillo = (cx) => `
      <g class="bp-roller">
        <circle cx="${cx}" cy="135" r="12" fill="var(--bg-surface)"
                stroke="var(--text-secondary)" stroke-width="1.4"/>
        <g class="bp-roller-spokes">
          <line x1="${cx - 8}" y1="135" x2="${cx + 8}" y2="135" stroke="var(--wire-inactive)" stroke-width="1.2"/>
          <line x1="${cx}" y1="127" x2="${cx}" y2="143" stroke="var(--wire-inactive)" stroke-width="1.2"/>
        </g>
        <circle cx="${cx}" cy="135" r="2.2" fill="var(--text-secondary)"/>
      </g>`;
  return `
    <g class="bp-belt">
      <rect x="170" y="118" width="350" height="34" rx="17"
            fill="var(--bg-elevated)" stroke="var(--text-secondary)" stroke-width="1.6"/>
      <line class="bp-track bp-track-top" x1="187" y1="121" x2="503" y2="121"
            stroke="var(--wire-inactive)" stroke-width="2" stroke-dasharray="6 6"/>
      <line class="bp-track bp-track-bottom" x1="187" y1="149" x2="503" y2="149"
            stroke="var(--wire-inactive)" stroke-width="2" stroke-dasharray="6 6"/>
      ${rodillo(187)}
      ${rodillo(503)}
      <g class="bp-arrow bp-arrow-1"${izq ? ' opacity="0"' : ''}>
        <line x1="300" y1="135" x2="396" y2="135" stroke="var(--accent)" stroke-width="2.4"/>
        <polygon points="400,135 388,129 388,141" fill="var(--accent)"/>
      </g>
      <g class="bp-arrow bp-arrow-2"${izq ? '' : ' opacity="0"'}>
        <line x1="304" y1="135" x2="400" y2="135" stroke="var(--accent)" stroke-width="2.4"/>
        <polygon points="300,135 312,129 312,141" fill="var(--accent)"/>
      </g>
      <text class="bp-belt-state" data-bp="belt-state" x="206" y="138.5" font-size="8.5"
            font-weight="700" letter-spacing="0.06em" fill="var(--text-tertiary)"
            font-family="var(--font-mono)">CONFIG</text>
      <!-- Motor acoplado al rodillo motriz -->
      <line x1="187" y1="147" x2="187" y2="162" stroke="var(--text-secondary)" stroke-width="1.4"/>
      <rect class="bp-motor" x="172" y="162" width="30" height="22" rx="4"
            fill="var(--bg-surface)" stroke="var(--text-secondary)" stroke-width="1.4"/>
      <text x="187" y="177" text-anchor="middle" font-size="10" font-weight="700"
            fill="var(--text-secondary)" font-family="var(--font-mono)">M</text>
      <line x1="140" y1="173" x2="172" y2="173" stroke="var(--accent)" stroke-width="1.3"
            stroke-dasharray="4 3"/>
    </g>`;
}

/** Sensor fotoeléctrico sobre la banda: cuerpo, haz y lectura en vivo. */
function bandSensor(x, n, io, activo, texto) {
  const c = '#0284c7';
  return `
    <g class="bp-sensor${activo ? '' : ' is-unused'}" data-bp="s${n}">
      <text x="${x}" y="18" text-anchor="middle" font-size="9.5"
            fill="var(--text-secondary)" font-family="var(--font-ui)">${esc(texto)}</text>
      <rect x="${x - 17}" y="28" width="34" height="20" rx="3"
            fill="rgba(2,132,199,0.10)" stroke="${c}" stroke-width="1.4"/>
      <text x="${x}" y="42" text-anchor="middle" font-size="10" font-weight="700"
            fill="${c}" font-family="var(--font-mono)">S${n}</text>
      <circle class="bp-sensor-led" cx="${x + 12}" cy="33" r="2.2" fill="var(--wire-inactive)"/>
      <text x="${x + 21}" y="42" font-size="9" fill="var(--text-mono)"
            font-family="var(--font-mono)">${io}</text>
      <line class="bp-beam" x1="${x}" y1="48" x2="${x}" y2="114" stroke="${c}"
            stroke-width="1.2" stroke-dasharray="3 3" opacity="0.75"/>
      <polygon class="bp-beam-tip" points="${x - 3},110 ${x + 3},110 ${x},116" fill="${c}" opacity="0.75"/>
      <text data-bp="s${n}-live" x="${x + 7}" y="84" font-size="9"
            fill="var(--text-tertiary)" font-family="var(--font-mono)"></text>
    </g>`;
}

/** Pluma (compuerta) al costado de la banda con sus dos sentidos. */
function bandPluma(x, n, io, activo) {
  return `
    <g class="bp-pluma${activo ? '' : ' is-unused'}" data-bp="p${n}">
      <rect x="${x - 3}" y="152" width="6" height="10" fill="var(--wire-inactive)"/>
      <rect class="bp-pluma-head" x="${x - 22}" y="162" width="44" height="24" rx="4"
            fill="var(--bg-surface)" stroke="var(--text-secondary)" stroke-width="1.4"/>
      <text x="${x - 11}" y="178" text-anchor="middle" font-size="10" font-weight="700"
            fill="var(--text-secondary)" font-family="var(--font-mono)">P${n}</text>
      <polygon class="bp-pluma-up" points="${x + 8},172 ${x + 13},166 ${x + 18},172"
               fill="var(--wire-inactive)"/>
      <polygon class="bp-pluma-down" points="${x + 8},176 ${x + 13},182 ${x + 18},176"
               fill="var(--wire-inactive)"/>
      <rect x="${x - 3}" y="186" width="6" height="14" fill="var(--wire-inactive)"/>
      <rect x="${x - 14}" y="200" width="28" height="4" rx="2" fill="var(--wire-inactive)"/>
      <text x="${x}" y="216" text-anchor="middle" font-size="9" fill="var(--text-mono)"
            font-family="var(--font-mono)">${io}</text>
      <text data-bp="p${n}-state" x="${x}" y="228" text-anchor="middle" font-size="9"
            fill="var(--text-tertiary)" font-family="var(--font-ui)">Pluma ${n}</text>
    </g>`;
}

/** Torreta de 3 módulos (roja arriba); se atenúan las que no participan. */
function bandTorreta(x, uses) {
  const orden = [['roja', 0], ['amarilla', 1], ['verde', 2]];
  let out = `
    <g class="bp-torreta">
      <rect x="${x - 12}" y="14" width="24" height="6" rx="3" fill="var(--wire-inactive)"/>`;
  for (const [color, i] of orden) {
    const activo = !!uses[color];
    const y = 20 + i * 27;
    const L = BAND_LAMP[color];
    out += `
      <g class="bp-lamp" data-bp="lamp-${color}" style="--lamp-on:${L.on}">
        <rect class="bp-lamp-body" x="${x - 14}" y="${y}" width="28" height="25" rx="3"
              fill="${activo ? L.off : 'none'}"
              stroke="${activo ? L.on : 'var(--wire-inactive)'}"
              stroke-width="${activo ? 2 : 1.3}" opacity="${activo ? 1 : 0.45}"/>
        <text x="${x + 22}" y="${y + 16}" font-size="9.5"
              fill="${activo ? 'var(--text-secondary)' : 'var(--text-tertiary)'}"
              opacity="${activo ? 1 : 0.6}" font-family="var(--font-ui)">${L.label}
          <tspan font-family="var(--font-mono)" font-size="9" fill="var(--text-mono)">${L.io}</tspan></text>
      </g>`;
  }
  out += `
      <rect x="${x - 2}" y="101" width="4" height="93" fill="var(--wire-inactive)"/>
      <rect x="${x - 17}" y="194" width="34" height="7" rx="2" fill="var(--wire-inactive)"/>
      <text x="${x}" y="216" text-anchor="middle" font-size="9.5" font-weight="600"
            fill="var(--text-tertiary)" font-family="var(--font-ui)">Torreta</text>
    </g>`;
  return out;
}

// Último feedback pintado: se reaplica si el esquema se redibuja entre sondeos.
let bandLive = null;

/**
 * Dibuja el panel de la banda en `container`.
 * Si el programa no trae _band_view, oculta el panel y no toca nada más.
 */
export function renderBandPanel(container, program) {
  if (!container) return;
  const view = program?.metadata?._band_view;
  if (!view || !view.enable) { container.hidden = true; container.innerHTML = ''; return; }
  container.hidden = false;

  const u = view.uses || {};
  const band = program?.metadata?.engine_config?.band || {};
  const izq = view.direction === 'izquierda';

  // Sensores: participan si tienen espera, acción o conteo declarados.
  const sensor = (n) => {
    const accion = bandAccion(band[`s${n}_action`]);
    const seconds = view[`wait_s${n}_s`] ?? band[`wait_s${n}_s`] ?? null;
    const count = Number(band[`count_s${n}`]) || 0;
    const activo = !!u[`s${n}`] || accion != null || band[`count_s${n}`] != null;
    const texto = activo
      ? bandSensorTexto(accion ?? (seconds != null ? 2 : null), seconds, count, view[`retrigger_s${n}_s`])
      : 'sin usar';
    return { activo, texto, seconds };
  };
  const s1 = sensor(1), s2 = sensor(2);

  // Lámparas: las que nombra la instrucción o alguna máscara de torreta.
  const mascaras = ['torreta_run', 'torreta_idle', 'torreta_s1', 'torreta_s2']
    .reduce((m, k) => m | (Number(band[k]) || 0), 0);
  const lamps = {};
  for (const [color, L] of Object.entries(BAND_LAMP)) lamps[color] = !!u[color] || !!(mascaras & L.bit);

  const pluma1 = band.pluma1 != null, pluma2 = band.pluma2 != null;

  const svg = `
<svg viewBox="0 0 760 248" class="bp-svg${izq ? ' dir-2' : ''}" role="img"
     aria-label="Esquema de la banda transportadora">
  ${bandBotonera(12, 14)}
  ${bandVFD(12, 132, view)}
  ${bandCinta(izq)}
  ${bandSensor(262, 1, 'I4', s1.activo, s1.texto)}
  ${bandSensor(420, 2, 'I5', s2.activo, s2.texto)}
  ${bandPluma(340, 1, 'Q8↑ · Q6↓', pluma1)}
  ${bandPluma(462, 2, 'Q9↑ · Q7↓', pluma2)}
  ${bandTorreta(618, lamps)}
  <text x="345" y="244" text-anchor="middle" font-size="10" font-weight="600"
        fill="var(--text-secondary)" font-family="var(--font-ui)">
    Banda transportadora — <tspan data-bp="dir-text">${izq ? 'Dirección 2 (izquierda)' : 'Dirección 1 (derecha)'}</tspan>
  </text>
</svg>`;

  const chips = [];
  chips.push(`<span class="bp-chip bp-chip-accent"><i class="ti ti-arrows-horizontal"></i> ${izq ? 'Dirección 2' : 'Dirección 1'}</span>`);
  if (u.freq) chips.push(`<span class="bp-chip"><i class="ti ti-wave-sine"></i> ${view.freq_hz} Hz</span>`);
  if (s1.activo) chips.push(`<span class="bp-chip"><i class="ti ti-eye"></i> S1${s1.seconds != null ? ` · ${s1.seconds} s` : ''}</span>`);
  if (s2.activo) chips.push(`<span class="bp-chip"><i class="ti ti-eye"></i> S2${s2.seconds != null ? ` · ${s2.seconds} s` : ''}</span>`);
  // El paro por sensor lo determinan los tiempos de espera, no la lampara:
  // las lamparas ahora solo se encienden si la instruccion las nombra.
  if (view.wait_s1_s != null || view.wait_s2_s != null)
    chips.push(`<span class="bp-chip"><i class="ti ti-player-stop"></i> Paro por sensor</span>`);
  if (pluma1 || pluma2)
    chips.push(`<span class="bp-chip"><i class="ti ti-arrows-vertical"></i> Plumas</span>`);

  container.innerHTML = `
    <div class="bp-head">
      <div class="bp-title"><i class="ti ti-topology-bus"></i> Banda transportadora</div>
      <div class="bp-chips">${chips.join('')}</div>
    </div>
    <div class="bp-body">${svg}</div>`;

  if (bandLive) paintBandLive(container, bandLive.est, bandLive.opts);
}

/**
 * Pinta sobre el esquema el estado REAL leído del PLC (GET /banda/estado).
 * `est = null` devuelve el esquema a la vista de configuración (sin lectura).
 * opts.paro: I3 presionado según la lectura de la entrada física.
 */
export function paintBandLive(container, est, opts = {}) {
  bandLive = est ? { est, opts } : null;
  const svg = container?.querySelector('.bp-svg');
  if (!svg) return;
  const q = (k) => svg.querySelector(`[data-bp="${k}"]`);
  const setTxt = (k, t) => { const el = q(k); if (el) el.textContent = t; };
  const on = (k, v, clase = 'is-on') => q(k)?.classList.toggle(clase, !!v);

  svg.classList.toggle('is-live', !!est);
  if (!est) {
    svg.classList.remove('is-running', 'is-stop');
    setTxt('belt-state', 'CONFIG');
    setTxt('vfd-speed', '— Hz');
    for (const k of ['i1', 'i3', 'lamp-verde', 'lamp-amarilla', 'lamp-roja']) on(k, false);
    for (const n of [1, 2]) {
      on(`s${n}`, false, 'is-wait');
      on(`s${n}`, false, 'is-detect');
      setTxt(`s${n}-live`, '');
      q(`p${n}`)?.classList.remove('is-up', 'is-down');
      setTxt(`p${n}-state`, `Pluma ${n}`);
    }
    return;
  }

  // Banda: sentido real si corre; si no, el que tiene cargado el PLC.
  const running = !!est.running;
  const dir = Number(est.direccion || est.dir_cmd);
  svg.classList.toggle('is-running', running);
  svg.classList.toggle('is-stop', !!opts.paro);
  if (dir === 1 || dir === 2) {
    svg.classList.toggle('dir-2', dir === 2);
    setTxt('dir-text', dir === 2 ? 'Dirección 2 (izquierda)' : 'Dirección 1 (derecha)');
    svg.querySelector('.bp-arrow-1')?.setAttribute('opacity', dir === 2 ? '0' : '1');
    svg.querySelector('.bp-arrow-2')?.setAttribute('opacity', dir === 2 ? '1' : '0');
  }
  setTxt('belt-state', opts.paro ? 'PARO' : running ? 'MARCHA' : 'DETENIDA');
  setTxt('vfd-speed', `${est.vfd_speed_hz ?? '—'} Hz`);
  if (est.vfd_control != null) {
    const cmd = { 18: 'Dirección 1', 34: 'Dirección 2', 1: 'Stop' }[est.vfd_control] || 'Comando';
    setTxt('vfd-cmd', `${cmd} (${est.vfd_control})`);
  }

  // Botonera: I1 = banda habilitada (latch del ST); I3 = entrada física leída.
  on('i1', est.band_enable);
  on('i3', opts.paro);

  // Sensores: temporizador corriendo = banda detenida por ese sensor.
  for (const n of [1, 2]) {
    const tmr = Number(est[`s${n}_timer_s`]) || 0;
    on(`s${n}`, tmr > 0, 'is-wait');
    on(`s${n}`, est[`s${n}_detecta`] === true, 'is-detect');   // entrada I4/I5 leída
    const cnt = est[`s${n}_count`];
    setTxt(`s${n}-live`, `${cnt ?? '—'} pz${tmr > 0 ? ` · ${tmr} s` : ''}`);
  }

  // Plumas: estado real %R62/%R63 (0 detenida, 1 subiendo, 2 bajando).
  for (const n of [1, 2]) {
    const p = est[`pluma${n}`] || {};
    const g = q(`p${n}`);
    g?.classList.toggle('is-up', Number(p.status) === 1);
    g?.classList.toggle('is-down', Number(p.status) === 2);
    setTxt(`p${n}-state`, p.estado || `Pluma ${n}`);
  }

  // Torreta: el ST no expone Q3..Q5, así que se muestra la máscara que aplica
  // al estado actual (%R40 corriendo / %R41 detenida). Durante un evento de
  // sensor con torreta, las lámparas físicas pueden diferir.
  const mask = Number(running ? est.torreta?.run : est.torreta?.idle) || 0;
  for (const [color, L] of Object.entries(BAND_LAMP)) on(`lamp-${color}`, mask & L.bit);
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
