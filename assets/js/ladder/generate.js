/**
 * generate.js — Punto ÚNICO de generación de programas ladder.
 *
 * Flujo (arquitectura única, ver CONTRACT.md):
 *   texto → identificar equipo → IA (/generar-logica) → JSON lógico simple
 *         → validateLogicJson → compileLogicToSchema → normalizeAndValidate → program
 *
 * Hay DOS equipos, cada uno con su PLC y su Ladder maestro:
 *   MODO MALETÍN → outputs / sequence (Q10-Q12, I1..I7)
 *   MODO BANDA   → bloque "band" (VFD, sensores S1/S2, torreta)
 * El equipo se decide ANTES de generar y viaja en `device`, para que el
 * backend mapee la instrucción al Ladder maestro correcto. Si la instrucción
 * puede aplicar a los dos, no se adivina: se pregunta.
 *
 * Lo usan el panel de chat (ladder.html), la voz del landing (main.js) y el
 * copiloto del asistente (copilot.js). No hay un segundo motor ni geometría
 * generada por la IA.
 */
import { BACKEND_BASE_URL } from './config.js';
import { compileLogicToSchema } from './compiler/logicToSchema.js';
import { validateLogicJson, normalizeAndValidate } from './validate.js';
import { detectEquipment, equipmentQuestion, buildBandLogic, detectTorretaLamps } from './equipment.js';

/**
 * @param {string} text   Instrucción en lenguaje natural (o un JSON lógico pegado).
 * @param {object|null} profile  Perfil del dispositivo (maletin_basico.json).
 * @param {{signal?:AbortSignal, context?:object, onProgress?:Function, device?:string}} [opts]
 *   `device` fuerza el equipo ('maletin' | 'banda'), p. ej. tras responder la
 *   pregunta de desambiguación. Si no viene, se deduce del texto.
 * @returns {Promise<{program, logic, warnings:string[], telemetry}>}
 * Lanza Error en fallo; si el JSON lógico no valida, el Error trae `.logicErrors`.
 */
export async function generateProgram(text, profile, { signal, context, onProgress, device } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ahora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let logic = null;
  let source = 'backend';
  let ejemplo_id = '';
  let localWarnings = [];
  let bandHints = null;   // presentación de la banda; NO viaja en el engine_config
  let equipo = normalizeDevice(device);

  // Fallback dev: el usuario puede pegar directamente un JSON lógico simple.
  const pasted = tryParseLogicJson(text);
  if (pasted) {
    logic = pasted;
    source = 'json-pegado';
    if (!equipo) equipo = pasted.band ? 'banda' : 'maletin';
  } else {
    // ── Selección de equipo (maletín / banda transportadora) ────
    // Prioridad: el equipo que ya eligió el usuario > lo que diga el texto.
    if (!equipo) {
      const det = detectEquipment(text);
      if (det.equipment === null) {
        // Ambigua: se devuelve por el MISMO canal `needs_clarification` que ya
        // usan chat.js y copilot.js, así que no hace falta tocar ninguna UI.
        return {
          needsClarification: true,
          questions: [equipmentQuestion()],
          assumptions: [],
          analysis: { equipo: 'ambiguo', motivo: det.reason },
          telemetry: { source: 'equipo', latency_ms: Math.round(ahora() - t0) },
        };
      }
      equipo = det.equipment;
    }

    // La torreta que nombra el usuario es dato de PRESENTACIÓN: se calcula
    // aquí para que el panel visual de la banda se dibuje igual que siempre.
    if (equipo === 'banda') bandHints = { lamps: detectTorretaLamps(text) };

    // ── Generación: MISMO endpoint para los dos equipos, con `device` ──
    onProgress?.('fetching');
    let data = null;
    try {
      data = await pedirLogica(text, profile, context, equipo, signal);
    } catch (e) {
      if (equipo !== 'banda') throw e;
      // Red de seguridad SOLO para la banda: si el backend no responde, se
      // arma el bloque "band" con la lectura local de siempre.
      const b = buildBandLogic(text);
      logic = b.logic;
      bandHints = b.hints;
      localWarnings = [...b.warnings,
        'El backend no respondió (' + e.message + '); se usó la lectura local de la banda.'];
      source = 'banda-local';
    }

    if (data) {
      // El backend puede pedir aclaración en vez de generar (prompt ambiguo, o
      // equipo sin decidir). Los llamadores lo detectan por `needsClarification`
      // y muestran las preguntas SIN intentar compilar un programa inexistente.
      if (data.status === 'needs_clarification') {
        return {
          needsClarification: true,
          questions: Array.isArray(data.questions) ? data.questions : [],
          assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
          analysis: data.analysis || {},
          telemetry: { source: 'backend', latency_ms: Math.round(ahora() - t0) },
        };
      }
      logic = data.logic || data;
      ejemplo_id = data.ejemplo_id || '';
      if (data.device) equipo = data.device;
      source = equipo === 'banda' ? 'banda-backend' : 'backend';
    }
  }

  if (!logic || typeof logic !== 'object') {
    throw new Error('No se obtuvo un JSON lógico válido.');
  }

  // 1) Validar el JSON lógico ANTES de compilar (no renderizar lógica falsa).
  onProgress?.('validating');
  const lv = validateLogicJson(logic, profile);
  if (!lv.ok) {
    const err = new Error('El JSON lógico no pasó la validación: ' + lv.errors[0]);
    err.logicErrors = lv.errors;
    err.logic = logic;
    throw err;
  }

  // 2) Compilar a geometría y 3) normalizar/validar el schema.
  onProgress?.('compiling');
  const { program, warnings: compileWarnings } = compileLogicToSchema(logic, profile, { bandHints });
  const nv = normalizeAndValidate(program);

  return {
    program: nv.program,
    logic,
    device: equipo,
    warnings: [...localWarnings, ...lv.warnings, ...compileWarnings, ...nv.warnings],
    telemetry: {
      source,
      device: equipo,
      latency_ms: Math.round(ahora() - t0),
      rungs: nv.program.rungs.length,
      repairs: nv.repairs.length,
    },
    ejemplo_id,
  };
}

/**
 * POST /generar-logica con el equipo ya decidido. Es el ÚNICO punto donde el
 * front llama a la IA: el backend elige el prompt y el mapeo del Ladder
 * maestro que corresponde a `device`.
 */
async function pedirLogica(text, profile, context, device, signal) {
  let res;
  try {
    res = await fetch(`${BACKEND_BASE_URL}/generar-logica`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texto: text,
        device,                                   // 'maletin' | 'banda'
        device_profile: profile?.id || null,
        contexto: context || null,
      }),
      signal,
    });
  } catch (e) {
    throw new Error('No se pudo contactar el backend (/generar-logica): ' + e.message +
      '. Mientras tanto puedes pegar un JSON lógico simple en el chat.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new Error(d?.detail || `El backend respondió HTTP ${res.status} en /generar-logica.`);
  }
  return res.json();
}

/** Reduce lo que llegue ('Banda transportadora', 'Maletín'…) al id canónico. */
function normalizeDevice(device) {
  const t = String(device || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!t) return null;
  if (t.startsWith('banda') || t.includes('transportador') || t.includes('cinta')) return 'banda';
  if (t.startsWith('maletin')) return 'maletin';
  return null;
}

// ¿El texto es un JSON lógico simple pegado? (modo dev / sin backend)
function tryParseLogicJson(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (o && (Array.isArray(o.outputs) || o.logic || o.band)) return o.logic || o;
  } catch { /* no es JSON */ }
  return null;
}
