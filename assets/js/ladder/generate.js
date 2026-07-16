/**
 * generate.js — Punto ÚNICO de generación de programas ladder.
 *
 * Flujo (arquitectura única, ver CONTRACT.md):
 *   texto → IA (/generar-logica) → JSON lógico simple
 *         → validateLogicJson → compileLogicToSchema → normalizeAndValidate → program
 *
 * Lo usan el panel de chat (ladder.html), la voz del landing (main.js) y el
 * copiloto del asistente (copilot.js). No hay un segundo motor ni geometría
 * generada por la IA.
 */
import { BACKEND_BASE_URL } from './config.js';
import { compileLogicToSchema } from './compiler/logicToSchema.js';
import { validateLogicJson, normalizeAndValidate } from './validate.js';

/**
 * @param {string} text   Instrucción en lenguaje natural (o un JSON lógico pegado).
 * @param {object|null} profile  Perfil del dispositivo (maletin_basico.json).
 * @returns {Promise<{program, logic, warnings:string[], telemetry}>}
 * Lanza Error en fallo; si el JSON lógico no valida, el Error trae `.logicErrors`.
 */
export async function generateProgram(text, profile, { signal, context, onProgress } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let logic = null;
  let source = 'backend';
  let ejemplo_id = '';

  // Fallback dev: el usuario puede pegar directamente un JSON lógico simple.
  const pasted = tryParseLogicJson(text);
  if (pasted) {
    logic = pasted;
    source = 'json-pegado';
  } else {
    onProgress?.('fetching');
    let res;
    try {
      res = await fetch(`${BACKEND_BASE_URL}/generar-logica`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: text, device_profile: profile?.id || null, contexto: context || null }),
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
    const data = await res.json();
    // Fase 1 (agente): el backend puede pedir aclaracion en vez de generar
    // (prompt ambiguo). Se devuelve un resultado discriminado; los llamadores
    // (chat.js / copilot.js) lo detectan por `needsClarification` y muestran las
    // preguntas SIN intentar compilar un programa inexistente.
    if (data && data.status === 'needs_clarification') {
      const t1nc = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return {
        needsClarification: true,
        questions: Array.isArray(data.questions) ? data.questions : [],
        assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
        analysis: data.analysis || {},
        telemetry: { source: 'backend', latency_ms: Math.round(t1nc - t0) },
      };
    }
    logic = data?.logic || data;
    ejemplo_id = data?.ejemplo_id || '';
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
  const { program, warnings: compileWarnings } = compileLogicToSchema(logic, profile);
  const nv = normalizeAndValidate(program);

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    program: nv.program,
    logic,
    warnings: [...lv.warnings, ...compileWarnings, ...nv.warnings],
    telemetry: {
      source,
      latency_ms: Math.round(t1 - t0),
      rungs: nv.program.rungs.length,
      repairs: nv.repairs.length,
    },
    ejemplo_id,
  };
}

// ¿El texto es un JSON lógico simple pegado? (modo dev / sin backend)
function tryParseLogicJson(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (o && (Array.isArray(o.outputs) || o.logic)) return o.logic || o;
  } catch { /* no es JSON */ }
  return null;
}
