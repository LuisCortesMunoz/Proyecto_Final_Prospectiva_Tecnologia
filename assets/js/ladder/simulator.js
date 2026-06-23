/**
 * simulator.js — Evaluador de lógica ladder para el modo simulación del editor.
 *
 * Calcula el estado de cada rung y actualiza variable_values tras un ciclo de
 * scan completo. No toca el DOM ni el store: recibe el programa y devuelve el
 * nuevo estado.
 */

import { isOutputType } from './schema.js';

// ── Evaluación de un contacto ──────────────────────────────────
function evalContact(el, vars) {
  const raw = !!vars[el.address];
  if (el.type === 'contact_no') return raw;       // XIC: pasa cuando TRUE
  if (el.type === 'contact_nc') return !raw;      // XIO: pasa cuando FALSE
  return true;                                    // otros tipos (bloques): pasan
}

// ── Evaluación de un rung ──────────────────────────────────────
function evaluateRung(rung, vars) {
  if (!rung.enabled) return false;

  const row0     = rung.network[0]?.elements ?? [];
  const contacts = row0.filter(e => !isOutputType(e.type));
  const outputs  = row0.filter(e => isOutputType(e.type));

  if (!outputs.length) return false;   // sin bobina: nada que energizar
  if (!contacts.length) return true;   // solo bobina: siempre energizada

  // Ramas paralelas (row > 0) con span definido
  const branches = rung.network.slice(1).filter(b => b.span);

  // Agrupar ramas por rango de span (pueden solaparse múltiples ramas en [from, to])
  const spanGroups = new Map();
  for (const b of branches) {
    const key = `${b.span.from}:${b.span.to}`;
    if (!spanGroups.has(key)) spanGroups.set(key, { from: b.span.from, to: b.span.to, brs: [] });
    spanGroups.get(key).brs.push(b.elements);
  }

  const consumed = new Set();
  let result = true;

  // Evaluar cada grupo de ramas: OR entre el camino principal del rango y las ramas
  for (const { from, to, brs } of spanGroups.values()) {
    for (let c = from; c <= to; c++) consumed.add(c);

    const mainEls  = contacts.filter(e => e.pos.col >= from && e.pos.col <= to);
    const mainVal  = mainEls.every(e => evalContact(e, vars));
    const anyBranch = brs.some(bElems => bElems.every(e => evalContact(e, vars)));

    result = result && (mainVal || anyBranch);
  }

  // Contactos no cubiertos por ninguna rama: todos en serie (AND)
  const rest = contacts.filter(e => !consumed.has(e.pos.col));
  result = result && rest.every(e => evalContact(e, vars));

  return result;
}

// ── Secuenciador de pasos (semáforo) ───────────────────────────
// El simulador genérico no mide tiempo; el secuenciador sí. Avanza los pasos
// con el reloj real y activa los bits PASOk; los rungs [PASOk]──(Qx) que generó
// el compilador propagan a las salidas en el scan normal. Espejo del motor en
// Texto Estructurado del PLC (arranque por flanco, "once"/"loop").

export function freshSeqState() {
  return { active: false, step: 0, stepStart: 0, startPrev: false };
}

/**
 * Avanza la secuencia un tick (usa reloj real, robusto a scans extra) y fija
 * los bits PASOk en `vars`. No toca las salidas: de eso se encarga scanCycle.
 * @param {object} sim   - metadata._sequence_sim { startAddr, mode, steps[] }
 * @param {object} vars  - variable_values (se mutan los bits de paso)
 * @param {object} state - estado persistente (freshSeqState)
 */
export function advanceSequence(sim, vars, state) {
  if (!sim || !Array.isArray(sim.steps) || !sim.steps.length) return;
  const now = Date.now();
  const start = !!vars[sim.startAddr];

  // Arranque por flanco positivo, solo si no esta corriendo ya.
  if (start && !state.startPrev && !state.active) {
    state.active = true; state.step = 0; state.stepStart = now;
  }
  state.startPrev = start;

  if (state.active) {
    const dur = sim.steps[state.step]?.durationMs || 0;
    if (now - state.stepStart >= dur) {
      state.step += 1;
      state.stepStart = now;
      if (state.step >= sim.steps.length) {
        if (sim.mode === 'loop') state.step = 0;     // cíclico: vuelve al inicio
        else { state.active = false; state.step = 0; } // una vez: termina (todo apagado)
      }
    }
  }

  // Activa solo el paso actual (nunca dos a la vez).
  sim.steps.forEach((s, i) => { vars[s.stepAddr] = state.active && i === state.step; });
}

// ── Ciclo de scan completo ──────────────────────────────────────
/**
 * Ejecuta un ciclo de scan sobre el programa y devuelve los nuevos estados.
 * @param {object} prog        - programa completo
 * @param {object} vars        - variable_values actuales { address: boolean }
 * @returns {{ rungStates: object, newVals: object }}
 */
export function scanCycle(prog, vars) {
  const newVals    = { ...vars };
  const rungStates = {};

  for (const rung of (prog.rungs ?? [])) {
    const energized = evaluateRung(rung, newVals);
    rungStates[String(rung.id)] = energized;

    // Actualizar las bobinas según el tipo
    const row0 = rung.network[0]?.elements ?? [];
    for (const el of row0) {
      if (!isOutputType(el.type) || !el.address) continue;
      if (el.type === 'coil')   newVals[el.address] = energized;         // OTE: sigue al rung
      else if (el.type === 'coil_s' && energized) newVals[el.address] = true;   // OTL: solo sube
      else if (el.type === 'coil_r' && energized) newVals[el.address] = false;  // OTU: solo baja
      // Timers/contadores: simplificados; solo marcan energización del rung
    }
  }

  return { rungStates, newVals };
}
