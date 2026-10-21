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
import { detectEquipment, equipmentQuestion, canonicalBand, describeBand, equipoNombrado } from './equipment.js';

/**
 * @param {string} text   Instrucción en lenguaje natural (o un JSON lógico pegado).
 * @param {object|null} profile  Perfil del dispositivo (maletin_basico.json).
 * @param {{signal?:AbortSignal, context?:object, onProgress?:Function, device?:string, aclaraciones?:object}} [opts]
 *   `device` fuerza el equipo ('maletin' | 'banda'). Si no viene, se deduce del texto.
 *   `aclaraciones` = respuestas a las preguntas de aclaración, APARTE del texto
 *   ({parametro: {pregunta, respuesta}}): el texto viaja tal cual lo escribió el
 *   usuario y el backend las combina (ver aclaraciones.py).
 * @returns {Promise<{program, logic, warnings:string[], telemetry}>}
 * Lanza Error en fallo; si el JSON lógico no valida, el Error trae `.logicErrors`.
 */
export async function generateProgram(text, profile, { signal, context, onProgress, device, aclaraciones } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ahora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let logic = null;
  let source = 'backend';
  let ejemplo_id = '';
  let confirmacion = null;
  let analysis = {};
  const acl = aclaraciones && Object.keys(aclaraciones).length ? aclaraciones : null;
  // "¿Maletín o banda?" respondida con un botón: el equipo, sin tocar el texto.
  let equipo = normalizeDevice(device) || normalizeDevice(acl?.equipo?.respuesta ?? acl?.equipo);

  // Fallback dev: el usuario puede pegar directamente un JSON lógico simple.
  const pasted = tryParseLogicJson(text);
  if (pasted) {
    logic = pasted;
    source = 'json-pegado';
    if (!equipo) equipo = pasted.band ? 'banda' : 'maletin';
    if (pasted.band) logic = { ...pasted, band: canonicalBand(pasted.band) };
  } else {
    // ── Selección de equipo (maletín / banda transportadora) ────
    // Prioridad: el equipo que ya eligió el usuario > el de la lógica activa
    // que se está editando > lo que diga el texto. "Cambia el último tiempo a
    // 8 s" no nombra equipo: es del que ya se está programando, no se pregunta.
    if (!equipo) equipo = equipoDeLaLogica(context?.programa_anterior);
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

    // ── Generación: MISMO endpoint para los dos equipos, con `device` ──
    // En la banda el LLM entiende la instrucción completa y el backend la
    // normaliza, comprueba su cobertura y la valida: aquí no se lee el texto.
    onProgress?.('fetching');
    const data = await pedirLogica(text, profile, context, equipo, signal, acl);

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
      // Motor v7: no hay alternativa segura -> se informa, no se dibuja nada.
      if (data.status === 'not_supported') {
        return {
          notSupported: true,
          analysis: data.analysis || {},
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          telemetry: { source: 'backend', latency_ms: Math.round(ahora() - t0) },
        };
      }
      // Motor v7: alternativa que cambia lo pedido. Se compila para poder
      // revisarla, pero el llamador NO la aplica sin confirmacion explicita y
      // el backend no la carga al PLC mientras confirmado !== true.
      if (data.status === 'needs_confirmation') {
        confirmacion = {
          questions: Array.isArray(data.questions) ? data.questions : [],
          compatibilidad: data.analysis?.compatibilidad || {},
        };
      }
      analysis = data.analysis || {};
      logic = data.logic || data;
      ejemplo_id = data.ejemplo_id || '';
      if (data.device) equipo = data.device;
      source = equipo === 'banda' ? 'banda-backend' : 'backend';
      // La IA de la banda pasa por la MISMA forma canónica que el normalizador.
      if (equipo === 'banda' && logic && typeof logic === 'object') {
        logic = { ...logic, device: 'banda', outputs: [], band: canonicalBand(logic.band) };
      }
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
  const { program, warnings: compileWarnings } = compileLogicToSchema(logic, profile);
  const nv = normalizeAndValidate(program);

  return {
    program: nv.program,
    logic,
    device: equipo,
    warnings: [...lv.warnings, ...compileWarnings, ...nv.warnings],
    telemetry: {
      source,
      device: equipo,
      latency_ms: Math.round(ahora() - t0),
      rungs: nv.program.rungs.length,
      repairs: nv.repairs.length,
      // Memoria validada / contexto por ramificaciones (analysis.metricas del backend).
      fuente: analysis.fuente,
      memoria_id: analysis.memoria_id,
      llamadas_modelo: analysis.metricas?.llamadas_modelo,
      tokens_prompt: analysis.metricas?.tokens_prompt_reales || analysis.metricas?.tokens_prompt_estimados,
      t_modelo_ms: analysis.metricas?.t_modelo_ms,
      t_memoria_ms: analysis.metricas?.t_memoria_ms,
    },
    ejemplo_id,
    analysis,
    // Motor v7: presente solo si es una alternativa que requiere confirmacion.
    needsConfirmation: !!confirmacion,
    confirmation: confirmacion,
  };
}

/**
 * Marca una alternativa del motor v7 como ACEPTADA por el usuario. Solo asi
 * /aplicar-plc la carga al PLC (el backend responde 409 si falta).
 */
export function confirmarAlternativa(program) {
  const cfg = program?.metadata?.engine_config;
  if (cfg && typeof cfg === 'object') {
    cfg.confirmado = true;
    if (cfg.band?.engine && typeof cfg.band.engine === 'object') cfg.band.engine.confirmado = true;
  }
  return program;
}

/**
 * POST /generar-logica con el equipo ya decidido. Es el ÚNICO punto donde el
 * front llama a la IA: el backend elige el prompt y el mapeo del Ladder
 * maestro que corresponde a `device`.
 */
async function pedirLogica(text, profile, context, device, signal, aclaraciones) {
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
        aclaraciones: aclaraciones || null,
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

/**
 * Qué hacer con una instrucción, según la lógica activa de la sesión
 * (window.LavoSesion). Lo usan el copiloto y el chat del editor:
 *   generar             → /generar-logica; con lógica activa va como contexto
 *                         y el resultado la EDITA (tipo 'modificacion')
 *   mostrar / explicar  → sobre la lógica activa, sin regenerarla
 *   confirmar_reemplazo → pide empezar otra lógica (o el otro equipo): se
 *                         confirma antes de reemplazar la activa
 */
export function planearInstruccion(text, sesion = globalThis.LavoSesion) {
  const program = sesion?.programa?.() || null;
  if (!program) return { accion: 'generar', context: null, tipo: 'nueva' };
  const intencion = sesion.clasificar(text);
  if (intencion === 'mostrar') return { accion: 'mostrar', program };
  if (intencion === 'explicar') return { accion: 'explicar', program };
  if (intencion === 'nueva' || cambiaDeEquipo(text, program)) {
    return { accion: 'confirmar_reemplazo', program, motivo: intencion === 'nueva' ? 'nueva' : 'equipo' };
  }
  return { accion: 'generar', context: sesion.contexto(), tipo: 'modificacion' };
}

// ── Aclaraciones (respuestas a needs_clarification) ─────────────
// Mismos nombres que aclaraciones.py del backend: una pregunta del modelo con
// campo "frecuencia_hz" y la determinista "freq_hz" son el mismo parámetro.
const ALIAS_ACLARACION = {
  freq_hz: 'freq_hz', frecuencia: 'freq_hz', frecuencia_hz: 'freq_hz', velocidad: 'freq_hz', hz: 'freq_hz',
  direccion: 'direccion', sentido: 'direccion', direction: 'direccion',
  equipo: 'equipo', device: 'equipo', dispositivo: 'equipo',
  output: 'output', salida: 'output', input: 'input', entrada: 'input', proceso: 'proceso',
};

/** Parámetro al que responde una pregunta (campo, slot o id), normalizado. */
export function claveAclaracion(q) {
  const k = String(q?.campo || q?.slot || q?.id || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return ALIAS_ACLARACION[k] || k;
}

/** Preguntas cuyo parámetro todavía no se respondió. */
export function preguntasPendientes(questions, aclaraciones) {
  return (questions || []).filter(q => !(claveAclaracion(q) in (aclaraciones || {})));
}

/** Opción que pide escribir más ("Describir la secuencia paso a paso"): no es un valor. */
export function esOpcionAbierta(opcion) {
  return /^(describir|describe|escribir|escribe|especificar|especifica|otra|otro)\b/i.test(String(opcion || '').trim());
}

/**
 * El usuario eligió una opción de una pregunta de aclaración. Registra la
 * respuesta en la solicitud (window.LavoSesion), sin tocar el texto, y dice
 * qué hacer:
 *   esperar  → faltan otras preguntas de la misma solicitud
 *   enviar   → ya están todas: reenviar la instrucción original + respuestas
 *   rehacer  → cambió una respuesta de una solicitud ya aplicada: se rehace
 *              desde la misma base y reemplaza esa versión
 *   abierta  → la opción pide escribir ("Describir la secuencia..."): el
 *              siguiente mensaje del usuario es la respuesta
 *   sin_cambio → eligió la misma opción que ya tenía
 *   obsoleta → la pregunta es de una instrucción anterior (o la lógica cambió
 *              después): no se mezcla con la actual
 */
export function decidirRespuesta(sesion, solId, clave, pregunta, respuesta) {
  const actual = sesion?.solicitud?.();
  if (!actual || actual.id !== solId) return { accion: 'obsoleta' };
  if (actual.estado === 'aplicada' && sesion.rev() !== actual.revAplicada) return { accion: 'obsoleta' };
  if (esOpcionAbierta(respuesta)) return { accion: 'abierta', sol: actual };
  if (actual.aclaraciones?.[clave]?.respuesta === String(respuesta)) return { accion: 'sin_cambio', sol: actual };
  const sol = sesion.responder(solId, clave, pregunta, respuesta);
  if (sol.estado === 'aplicada') return { accion: 'rehacer', sol };
  return { accion: preguntasPendientes(sol.preguntas, sol.aclaraciones).length ? 'esperar' : 'enviar', sol };
}

/** Frases que formaron la lógica tras aplicar `sol` (para la memoria validada). */
export function frasesDeSolicitud(sesion, sol) {
  const previas = sol.tipo === 'modificacion' ? (sol.base?.historial || []) : [];
  return [...previas, sesion.conAclaraciones(sol.texto, sol.aclaraciones)];
}

/** Equipo del programa que se está editando (por su engine_config), o null. */
export function equipoDeLaLogica(program) {
  const cfg = program?.metadata?.engine_config;
  if (!cfg || typeof cfg !== 'object') return null;
  return normalizeDevice(cfg.device) || (cfg.band && typeof cfg.band === 'object' ? 'banda' : 'maletin');
}

/**
 * ¿La instrucción pide programar el OTRO equipo? Eso no es editar la lógica
 * activa sino empezar otra: el llamador lo confirma antes de reemplazarla.
 */
export function cambiaDeEquipo(text, program) {
  const activo = equipoDeLaLogica(program);
  const nombrado = equipoNombrado(text);
  return !!(activo && nombrado && nombrado !== activo);
}

/**
 * Explica la lógica activa SIN regenerarla ("explícame por qué no funciona").
 * Usa /chat con el JSON vigente como contexto; no cambia el programa.
 */
export async function explicarLogica(pregunta, program, { signal } = {}) {
  const cfg = program?.metadata?.engine_config;
  if (!cfg) throw new Error('No hay una lógica activa con JSON que explicar.');
  const json = JSON.stringify(cfg.respuesta_llm || cfg);
  const resumen = cfg.band ? describeBand(cfg.band).join('\n') : '';
  const message = [
    `Pregunta del usuario: ${pregunta}`,
    resumen ? `Resumen de lo que ejecuta el PLC:\n${resumen}` : '',
    `JSON de la lógica activa${json.length > 2600 ? ' (recortado)' : ''}:\n${json.slice(0, 2600)}`,
  ].filter(Boolean).join('\n\n').slice(0, 3900);
  const res = await fetch(`${BACKEND_BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      system_prompt: 'Eres LAVO, asistente de PLCs Horner XL4 (maletín y banda transportadora). '
        + 'Explica en español, breve y claro, la lógica activa que te dan: qué hace, en qué orden y, si '
        + 'preguntan por una falla, la causa más probable dentro de esa lógica. NO generes un JSON '
        + 'nuevo ni cambies la lógica; si hace falta un cambio, sugiere la instrucción que lo haría.',
      temperature: 0.3,
      num_predict: 500,
    }),
    signal,
  });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(d?.detail || `El backend respondió HTTP ${res.status} en /chat.`);
  return String(d?.reply || '').trim();
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
