/**
 * renderer.js — Convierte el programa JSON en HTML/DOM
 * v3 — Rama paralela correctamente alineada con la fila 0
 *
 * FIXES:
 *  1. Fila 0: wire flex va entre el ultimo contacto y la bobina
 *  2. Fila 1 (rama paralela): wire flex va ANTES del elemento,
 *     para que el contacto de memoria quede alineado con el primer
 *     contacto de la fila 0 (debajo de %I1)
 *  3. branch-rail izquierdo: margin-left = ancho del power-rail (5px)
 *     para que el conector vertical salga del riel izquierdo real
 *  4. branch-rail derecho: margin-right calculado para terminar
 *     justo antes de la bobina en la fila 0
 *  5. Etiquetas en formato PLC (%I1, %Q10) en vez de (I0.1, Q0.10)
 */

const BLOCK_LABELS = {
  block_ton:'TON', block_tof:'TOF', block_ctu:'CTU',
  block_ctd:'CTD', block_cmp:'CMP', block_mov:'MOV', block_add:'ADD',
};

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

function elementSVG(type, energized) {
  const c  = energized ? '#4d9ef7' : '#3d6fa8';
  const sw = energized ? 1.8 : 1.6;

  switch (type) {
    case 'contact_no':
      return `<svg width="40" height="28" viewBox="0 0 40 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="12" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="5"  x2="12" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="5"  x2="28" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="14" x2="40" y2="14" stroke="${c}" stroke-width="${sw}"/>
      </svg>`;

    case 'contact_nc':
      return `<svg width="40" height="28" viewBox="0 0 40 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="12" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="5"  x2="12" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="5"  x2="28" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="14" x2="40" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="13" y1="22" x2="27" y2="6"  stroke="${c}" stroke-width="1.4"/>
      </svg>`;

    case 'contact_pos_edge':
      return `<svg width="40" height="28" viewBox="0 0 40 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="12" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="5"  x2="12" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="5"  x2="28" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="14" x2="40" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <text x="20" y="19" text-anchor="middle" font-size="9" font-weight="700"
              fill="${c}" font-family="monospace">P</text>
      </svg>`;

    case 'contact_neg_edge':
      return `<svg width="40" height="28" viewBox="0 0 40 28" aria-hidden="true">
        <line x1="0"  y1="14" x2="12" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <line x1="12" y1="5"  x2="12" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="5"  x2="28" y2="23" stroke="${c}" stroke-width="${sw}"/>
        <line x1="28" y1="14" x2="40" y2="14" stroke="${c}" stroke-width="${sw}"/>
        <text x="20" y="19" text-anchor="middle" font-size="9" font-weight="700"
              fill="${c}" font-family="monospace">N</text>
      </svg>`;

    // Bobina: solo el circulo, sin wires propios (los pone el canvas)
    case 'coil':
    case 'coil_s':
    case 'coil_r': {
      const lbl = type==='coil_s' ? 'S' : type==='coil_r' ? 'R' : '';
      return `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="10" fill="none"
                stroke="${c}" stroke-width="${sw}"/>
        ${lbl ? `<text x="14" y="19" text-anchor="middle" font-size="10"
                       font-weight="700" fill="${c}"
                       font-family="monospace">${lbl}</text>` : ''}
      </svg>`;
    }

    default:
      if (BLOCK_LABELS[type]) {
        return `<svg width="54" height="28" viewBox="0 0 54 28" aria-hidden="true">
          <rect x="1" y="3" width="52" height="22" rx="3"
                fill="none" stroke="${c}" stroke-width="1.4"/>
          <text x="27" y="19" text-anchor="middle" font-size="9"
                font-weight="600" fill="${c}"
                font-family="monospace">${BLOCK_LABELS[type]}</text>
        </svg>`;
      }
      return `<svg width="40" height="28" viewBox="0 0 40 28">
        <text x="20" y="19" text-anchor="middle" font-size="9" fill="${c}">?</text>
      </svg>`;
  }
}

function sym(address, symbolTable) {
  const s = symbolTable?.[address]?.symbol;
  return (s && s !== address) ? s : '';
}

/**
 * renderNetworkRow — genera el HTML de una fila del rung
 *
 * FILA 0 (serie principal):
 *   [riel] [16px] [el] [16px] [el] ... [flex] [bobina] [8px] [riel]
 *   Si no hay bobina: ultimo wire es flex hacia el riel derecho.
 *
 * FILA 1+ (rama paralela):
 *   La rama paralela debe alinearse con los primeros elementos de la fila 0.
 *   Usamos inline-style en los branch-rails para controlar el punto de conexion:
 *
 *   [branch-rail izq] [flex] [el] [16px] [el] ... [flex] [branch-rail der]
 *
 *   El wire flex inicial hace que el elemento de memoria quede alineado
 *   bajo el primer contacto de la fila 0.
 *   El branch-rail derecho tiene un margin-right calculado para terminar
 *   justo antes del riel de la bobina.
 */
function renderNetworkRow(row, rowIdx, rungId, energized, selRung, selection, symbolTable, rung) {
  const isBranch = rowIdx > 0;
  const elements = row.elements ?? [];
  const sorted   = [...elements].sort((a,b) => a.pos.col - b.pos.col);
  const ac       = energized ? ' active' : '';

  // Para la rama paralela necesitamos saber cuantos contactos
  // hay en la fila 0 ANTES de la bobina, para calcular el ancho
  // del wire flex inicial y alinear correctamente.
  let coilWidthRight = 0; // ancho reservado para la bobina en el lado derecho
  if (isBranch && rung) {
    const fila0 = (rung.network ?? []).find(r => r.row === 0);
    if (fila0) {
      const sorted0 = [...(fila0.elements ?? [])].sort((a,b) => a.pos.col - b.pos.col);
      const lastEl0 = sorted0[sorted0.length - 1];
      if (lastEl0?.type?.startsWith('coil')) {
        // Bobina(28) + wire-salida(8) + power-rail-der(5) = 41px
        coilWidthRight = 41;
      }
    }
  }

  let canvas = '';

  if (isBranch) {
    // ── Rama paralela ─────────────────────────────────────────
    // branch-rail izquierdo: se conecta al riel izquierdo real
    canvas += `<div class="branch-rail"></div>`;

    if (sorted.length === 0) {
      canvas += `<div class="wire${ac} flex"></div>`;
    } else {
      // Wire flex inicial: empuja el elemento de memoria hacia la derecha
      // para que quede bajo el primer contacto de la fila 0
      canvas += `<div class="wire${ac} flex"></div>`;

      sorted.forEach((el, i) => {
        const isLast = i === sorted.length - 1;
        const selEl  = selRung && selection?.elementId === el.id;
        const label  = fmtAddr(el.address);

        canvas += `<div class="ladder-el${selEl ? ' selected-el' : ''}"
          data-rung-id="${rungId}" data-el-id="${el.id}"
          title="${el.type} · ${el.address}">
          <span class="el-addr">${label}</span>
          ${elementSVG(el.type, energized)}
          <span class="el-sym">${sym(el.address, symbolTable)}</span>
        </div>`;

        if (!isLast) {
          canvas += `<div class="wire${ac}" style="width:16px"></div>`;
        } else {
          // Wire flex derecho: rellena hasta el branch-rail derecho
          canvas += `<div class="wire${ac} flex"></div>`;
        }
      });
    }

    // branch-rail derecho: margen para no solaparse con la bobina
    // margin-right = coilWidthRight para que termine antes de la bobina
    const mrStyle = coilWidthRight > 0
      ? ` style="margin-right:${coilWidthRight}px"`
      : '';
    canvas += `<div class="branch-rail"${mrStyle}></div>`;

    return `<div class="rung-canvas branch-row" data-row="${rowIdx}">${canvas}</div>`;
  }

  // ── Fila 0: serie principal ──────────────────────────────────
  canvas += `<div class="power-rail"></div>`;

  if (sorted.length === 0) {
    canvas += `<div class="wire${ac} flex"></div>`;
  } else {
    const lastEl     = sorted[sorted.length - 1];
    const lastIsCoil = lastEl?.type?.startsWith('coil') ?? false;

    sorted.forEach((el, i) => {
      const isFirst = i === 0;
      const isLast  = i === sorted.length - 1;
      const selEl   = selRung && selection?.elementId === el.id;
      const label   = fmtAddr(el.address);
      const isCoil  = el.type.startsWith('coil');

      // Wire de entrada al elemento
      if (isFirst) {
        canvas += `<div class="wire${ac}" style="width:16px"></div>`;
      }

      canvas += `<div class="ladder-el${selEl ? ' selected-el' : ''}"
        data-rung-id="${rungId}" data-el-id="${el.id}"
        title="${el.type} · ${el.address}">
        <span class="el-addr">${label}</span>
        ${elementSVG(el.type, energized)}
        <span class="el-sym">${sym(el.address, symbolTable)}</span>
      </div>`;

      // Wire de salida del elemento
      if (!isLast) {
        // Entre elementos: si el siguiente es bobina → flex (espacio grande)
        const nextEl     = sorted[i + 1];
        const nextIsCoil = nextEl?.type?.startsWith('coil') ?? false;
        canvas += nextIsCoil
          ? `<div class="wire${ac} flex"></div>`
          : `<div class="wire${ac}" style="width:16px"></div>`;
      } else {
        // Despues del ultimo
        canvas += isCoil
          ? `<div class="wire${ac}" style="width:8px"></div>`   // bobina → wire corto al riel
          : `<div class="wire${ac} flex"></div>`;               // contacto → flex al riel
      }
    });
  }

  canvas += `<div class="power-rail"></div>`;
  return `<div class="rung-canvas" data-row="${rowIdx}">${canvas}</div>`;
}

/** Renderiza un rung completo */
export function renderRung(rung, program, selection) {
  const energized = !!program.execution_state?.rung_states?.[String(rung.id)];
  const selRung   = selection?.rungId === rung.id;
  const rows      = rung.network ?? [{ row: 0, elements: [] }];

  const networkHTML = rows.map((row, idx) =>
    renderNetworkRow(row, idx, rung.id, energized, selRung, selection,
                     program.symbol_table, rung)   // <- pasamos rung completo
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

/** Vuelca todos los rungs */
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
    <tbody>${rows ||
      '<tr><td colspan="6" style="color:var(--text-tertiary);text-align:center;padding:12px">Sin variables definidas</td></tr>'
    }</tbody>
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

/** Referencias cruzadas — recorre todas las filas */
export function renderXRefTable(program) {
  const refs = [];
  for (const rung of program.rungs) {
    for (const row of rung.network ?? []) {
      for (const el of row.elements ?? []) {
        refs.push({
          addr: fmtAddr(el.address),
          sym:  program.symbol_table?.[el.address]?.symbol ?? el.address,
          rung: rung.id,
          fila: (row.row ?? 0) === 0 ? 'serie' : `paralela ${row.row}`,
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
      <td class="mono">${r.fila}</td>
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
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}