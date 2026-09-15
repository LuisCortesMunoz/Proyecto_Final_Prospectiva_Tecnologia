/**
 * equipment.js — Selección de equipo (maletín / banda transportadora) y forma
 * CANÓNICA del bloque "band".
 *
 * Flujo de la banda (ver banda_intent.py en el backend):
 *   texto → detectEquipment → /generar-logica: el LLM entiende la instrucción
 *         completa y la devuelve como intención estructurada → el backend la
 *         normaliza, comprueba que ninguna acción se perdió y la valida contra
 *         el ST → canonicalBand (aquí) → validateLogicJson → compileLogicToSchema
 *
 * Este módulo NO interpreta lenguaje natural de la banda: esa lectura es del
 * LLM. Aquí solo se decide el equipo y se deja el bloque "band" en su forma
 * canónica para el panel, el Ladder y la carga al PLC. No toca Modbus ni el
 * flujo del maletín.
 */

// Quita acentos y normaliza para que las expresiones regulares sean simples.
const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── Vocabularios ──────────────────────────────────────────────
// EXCLUSIVO de la banda: si aparece, la instrucción es de la banda.
const BAND_TERMS = [
  /\bbandas?\b/, /\btransportador/, /\bcintas?\b/,
  /\bvfd\b/, /\bvariador/,
  /\bs\s?[12]\b/, /\bsensor(?:es)?\s*(?:1|2|uno|dos)\b/,
  /\btorreta\b/, /\bplumas?\b/,
  /\bfrecuencias?\b/, /\b\d+(?:[.,]\d+)?\s*hz\b/, /\bhertz\b/,
  /\bderecha\b/, /\bizquierda\b/, /\bhorario\b/, /\bantihorario\b/,
  /\bavanz/, /\bparo automatico\b/, /\bparo (?:por )?software\b/,
];

// EXCLUSIVO del maletín: si aparece, la instrucción es del maletín.
const MALETIN_TERMS = [
  /\bmaletin\b/,
  /\bi\s?1\b/, /\bi\s?2\b/, /\bi\s?7\b/,
  /\benclav/, /\bcontador/, /\bsecuencia/, /\bsemaforo/,
  /\bparo de emergencia\b/,
];

// COMPARTIDO: existe en los dos equipos, así que NO decide por sí solo.
// Su presencia sin ningún término exclusivo es justo el caso ambiguo
// ("enciende una lámpara", "activa Q10", "cuando se active el sensor").
const SHARED_TERMS = [
  /\blampara/, /\bluces?\b/, /\bluz\b/,
  /\bq\s?1[012]\b/, /\bverde\b/, /\bamarilla\b/, /\broja\b/,
  /\bsensor/, /\bmotor/, /\bsistema\b/, /\bpieza/,
  /\bi\s?3\b/, /\bi\s?4\b/,
  /\btemporizador/, /\btimer\b/, /\bsalida\b/, /\bentrada\b/,
  // "boton"/"pulsador" no deciden solos (espejo de device_router.py): el PLC
  // de la banda no tiene botones, pero "activa una salida cuando se presione
  // un botón" debe preguntar en vez de asumir. Con un I1/I2/I7 o la palabra
  // "maletín" en la frase sí hay término exclusivo y no se pregunta.
  /\bbot(?:on|ones)\b/, /\bpulsador/, /\bselector/,
];

// Nombre explícito del equipo (regla prioritaria; espejo de device_router.py).
const NOMBRE_BANDA   = /\bbandas?\b|\btransportadora?s?\b/;
const NOMBRE_MALETIN = /\bmaletin(?:es)?\b/;

const hits = (t, list) => list.filter(re => re.test(t)).length;

/**
 * ¿A qué equipo pertenece la instrucción?
 * @returns {{equipment:'maletin'|'banda'|null, reason:string}}
 *   equipment === null significa AMBIGUA: hay que preguntarle al usuario.
 */
export function detectEquipment(text) {
  const t = norm(text);

  // REGLA PRIORITARIA: "banda" sin "maletín" es SIEMPRE la banda, aunque la
  // frase traiga I1/I2 ("banda prende la verde con I1", "detén la banda con
  // I2"). Con los dos nombres se usa la aclaración de siempre.
  const nb = NOMBRE_BANDA.test(t), nm = NOMBRE_MALETIN.test(t);
  if (nb && nm) return { equipment: null, reason: 'nombra la banda y el maletin' };
  if (nb) return { equipment: 'banda', reason: 'la instruccion nombra la banda' };

  const band = hits(t, BAND_TERMS);
  const mal  = hits(t, MALETIN_TERMS);

  if (band && !mal) return { equipment: 'banda',   reason: 'terminos exclusivos de la banda' };
  if (mal && !band) return { equipment: 'maletin', reason: 'terminos exclusivos del maletin' };
  if (band && mal)  return { equipment: null,      reason: 'mezcla terminos de los dos equipos' };

  // Sin términos exclusivos: solo se pregunta si hay algo que de verdad pueda
  // ir en cualquiera de los dos. Si no hay ninguna señal, se conserva el
  // comportamiento actual (el backend del maletín se encarga).
  if (hits(t, SHARED_TERMS)) return { equipment: null, reason: 'solo terminos comunes a los dos equipos' };
  return { equipment: 'maletin', reason: 'sin senales de banda: flujo actual' };
}

/** Pregunta de desambiguación, con el mismo formato que usa el backend. */
export function equipmentQuestion() {
  return {
    slot: 'equipo',
    pregunta: '¿Quieres programar el maletin o la banda transportadora?',
    opciones: ['Maletín', 'Banda transportadora'],
  };
}

// ── Bloque "band" canónico ─────────────────────────────────────
// Mismos campos y rangos que validar_config en plc_banda.py y CAMPOS_BAND en
// banda_intent.py:
//   enable · direction · freq_hz · start_button
//   stop_mode (%R9) · auto_stop_mode (%R15) · auto_stop_s (%R11)
//   sN_action · sN_band_mode (%R16/%R17) · wait_sN_s · count_sN · torreta_sN
//   sN_pluma1 · sN_pluma2 · torreta_run · torreta_idle · torreta_i1 · pluma1 · pluma2
// Los códigos van SIEMPRE numéricos y "sin configurar" es null.
export const BAND_FIELDS = [
  'enable', 'direction', 'freq_hz', 'start_button', 'stop_mode', 'auto_stop_mode', 'auto_stop_s',
  's1_action', 's1_band_mode', 'wait_s1_s', 'count_s1', 'torreta_s1', 's1_pluma1', 's1_pluma2',
  's2_action', 's2_band_mode', 'wait_s2_s', 'count_s2', 'torreta_s2', 's2_pluma1', 's2_pluma2',
  'torreta_run', 'torreta_idle', 'torreta_i1', 'pluma1', 'pluma2',
  // Acciones enclavadas al alcanzar el conteo (§14c, %R70..%R79).
  's1_count_action_mask', 's1_count_lamp_mask', 's1_count_dir', 's1_count_pluma1', 's1_count_pluma2',
  's2_count_action_mask', 's2_count_lamp_mask', 's2_count_dir', 's2_count_pluma1', 's2_count_pluma2',
];

// S_CountActionMask: 1 detener banda · 2 detener proceso · 4 luces · 8 dirección
// · 16 pluma 1 · 32 pluma 2. Se suman.
const COUNT_DIR_CODES = { sin_cambio: 0, derecha: 1, direccion_1: 1, izquierda: 2, direccion_2: 2, invertir: 3 };

const ACTION_CODES = {
  nada: 0, contar: 0, contar_y_parar: 0,
  paro_presencia: 1, paro_mientras_detecta: 1,
  paro_temporizado: 2, paro_enclavado: 2,
  paro_presencia_torreta: 3, paro_mientras_detecta_torreta: 3,
  paro_temporizado_torreta: 4,
};
const STOP_MODE_CODES = { i3: 0, solo_i3: 0, i2: 1, i2_i3: 1, software: 2, sw: 2, software_i3: 2,
  i2_software: 3, i2_software_i3: 3, todos: 3 };
const AUTO_STOP_CODES = { off: 0, no: 0, deshabilitado: 0, movimiento: 1, real: 1, total: 2, desde_start: 2 };
const SENSOR_PLUMA_CODES = { nada: 0, ninguno: 0, sin_intervenir: 0, subir: 1, arriba: 1, up: 1,
  bajar: 2, abajo: 2, down: 2, stop: 3, parar: 3, detener: 3, forzar_stop: 3 };
const PLUMA_CODES = { stop: 0, parar: 0, paro: 0, subir: 1, arriba: 1, up: 1, bajar: 2, abajo: 2, down: 2 };

/** Código numérico lo..hi de un número o nombre. Un valor no reconocido se
 *  deja tal cual para que la validación lo reporte (no se inventa nada). */
function codigo(v, tabla, lo, hi) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase().replace(/[+\s]+/g, '_');
  if (/^-?\d+$/.test(s)) { const n = Number(s); return n >= lo && n <= hi ? n : v; }
  return s in tabla ? tabla[s] : v;
}
function entero(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : v;
}
const nulo0 = (v) => (v === 0 ? null : v);

/**
 * Lleva cualquier bloque "band" (backend, JSON pegado o panel) a la forma
 * canónica. Reproduce las mismas deducciones que plc_banda.plan_config para
 * que el dibujo y la carga coincidan. Es idempotente sobre lo que ya
 * normalizó el backend, así que no altera la cobertura de la intención.
 */
export function canonicalBand(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  // Con el ST vigente la banda solo se mueve si se pide: sensores, torreta y
  // plumas funcionan sin movimiento (DirCmd = FreqRequest = 0).
  out.enable = b.enable !== false;
  if (out.enable) {
    const dir = norm(b.direction ?? '');
    out.direction = /^(2|izq|izquierda|left|ccw|antihorario|dir2|direccion2)$/.test(dir) ? 'izquierda' : 'derecha';
    out.freq_hz = entero(b.freq_hz);
    out.start_button = String(b.start_button || 'I1').trim().toUpperCase();
  }
  out.stop_mode = nulo0(codigo(b.stop_mode, STOP_MODE_CODES, 0, 3));

  out.auto_stop_s = nulo0(entero(b.auto_stop_s));
  let am = codigo(b.auto_stop_mode, AUTO_STOP_CODES, 0, 2);
  if (am == null) am = out.auto_stop_s > 0 ? 1 : null;
  out.auto_stop_mode = nulo0(am);
  if (out.auto_stop_mode == null && typeof out.auto_stop_s === 'number') out.auto_stop_s = null;

  for (const n of [1, 2]) {
    const wait = nulo0(entero(b[`wait_s${n}_s`]));
    const p1 = nulo0(codigo(b[`s${n}_pluma1`], SENSOR_PLUMA_CODES, 0, 3));
    const p2 = nulo0(codigo(b[`s${n}_pluma2`], SENSOR_PLUMA_CODES, 0, 3));
    const mask = nulo0(entero(b[`torreta_s${n}`]));
    let acc = codigo(b[`s${n}_action`], ACTION_CODES, 0, 4);
    if (acc == null && b[`wait_s${n}_s`] != null) acc = 2;
    // Plumas o torreta sin acción: un evento que sigue al sensor.
    if (acc == null && (p1 || p2 || mask)) acc = 0;
    if (acc == null && b[`count_s${n}`] != null) acc = 0;
    const cmask = nulo0(codigo(b[`s${n}_count_action_mask`], {}, 0, 63));
    if (acc == null && cmask) acc = 0;
    out[`s${n}_count_action_mask`] = cmask;
    out[`s${n}_count_lamp_mask`] = nulo0(entero(b[`s${n}_count_lamp_mask`]));
    out[`s${n}_count_dir`] = nulo0(codigo(b[`s${n}_count_dir`], COUNT_DIR_CODES, 0, 3));
    out[`s${n}_count_pluma1`] = nulo0(codigo(b[`s${n}_count_pluma1`], SENSOR_PLUMA_CODES, 0, 3));
    out[`s${n}_count_pluma2`] = nulo0(codigo(b[`s${n}_count_pluma2`], SENSOR_PLUMA_CODES, 0, 3));
    out[`s${n}_action`] = acc;
    out[`s${n}_band_mode`] = acc == null ? null : (codigo(b[`s${n}_band_mode`], {}, 0, 1) ?? 0);
    // El tiempo solo existe para los eventos temporizados (2 y 4).
    out[`wait_s${n}_s`] = acc === 2 || acc === 4 ? wait : (typeof acc === 'number' ? null : wait);
    out[`count_s${n}`] = nulo0(entero(b[`count_s${n}`]));
    out[`torreta_s${n}`] = mask;
    out[`s${n}_pluma1`] = p1;
    out[`s${n}_pluma2`] = p2;
  }
  for (const k of ['torreta_run', 'torreta_idle', 'torreta_i1']) out[k] = nulo0(entero(b[k]));
  for (const n of [1, 2]) out[`pluma${n}`] = codigo(b[`pluma${n}`], PLUMA_CODES, 0, 2);

  const ordenado = {};
  for (const k of BAND_FIELDS) ordenado[k] = out[k] ?? null;
  ordenado.enable = out.enable;
  return ordenado;
}

// ── Descripción legible (resumen del chat) ─────────────────────
const STOP_MODE_TXT = ['I3', 'I2 + I3', 'Software + I3', 'I2 + Software + I3'];
const colores = (m) => ['verde', 'amarilla', 'roja'].filter((_, i) => Number(m) & (1 << i)).join(' + ');
const PLUMA_SENSOR_TXT = { 1: 'sube', 2: 'baja', 3: 'stop forzado' };

/** Lista de frases cortas con lo que hará el PLC con este bloque "band". */
export function describeBand(band) {
  const b = canonicalBand(band);
  const L = [];
  if (b.enable) {
    L.push(`Avanza en dirección ${b.direction === 'izquierda' ? '2 (izquierda)' : '1 (derecha)'}`
      + `${b.freq_hz != null ? ` a ${b.freq_hz} Hz` : ''} al pulsar ${b.start_button || 'I1'}`);
  } else {
    L.push('Sin movimiento de banda (no requiere botón de arranque)');
  }
  if (b.stop_mode != null) L.push(`Paro: ${STOP_MODE_TXT[b.stop_mode] ?? b.stop_mode}`);
  if (b.auto_stop_mode) {
    L.push(`Paro automático a los ${b.auto_stop_s} s (${b.auto_stop_mode === 2 ? 'desde START' : 'solo movimiento real'})`);
  }
  for (const n of [1, 2]) {
    const acc = b[`s${n}_action`];
    if (acc == null) continue;
    const w = b[`wait_s${n}_s`];
    const temporizado = acc === 2 || acc === 4;
    const pausa = b[`s${n}_band_mode`] !== 1 && acc > 0;
    let s = `S${n}${b[`count_s${n}`] ? ` al contar ${b[`count_s${n}`]}` : ''}: `
      + (temporizado ? `evento de ${w} s` : 'evento mientras detecta')
      + (pausa ? ' · pausa la banda y continúa' : ' · no afecta la banda');
    if (b[`torreta_s${n}`]) s += ` · luz ${colores(b[`torreta_s${n}`])}`;
    for (const m of [1, 2]) {
      const p = b[`s${n}_pluma${m}`];
      if (p) s += ` · pluma ${m} ${PLUMA_SENSOR_TXT[p] ?? p}`;
    }
    L.push(s);
    const cm = Number(b[`s${n}_count_action_mask`]) || 0;
    if (cm) {
      const dir = { 1: 'dirección 1', 2: 'dirección 2', 3: 'invierte la dirección' }[b[`s${n}_count_dir`]];
      const acciones = [
        cm & 1 && 'detiene la banda',
        cm & 2 && 'detiene el proceso',
        cm & 4 && `enciende ${colores(b[`s${n}_count_lamp_mask`])}`,
        cm & 8 && dir,
        cm & 16 && `pluma 1 ${PLUMA_SENSOR_TXT[b[`s${n}_count_pluma1`]] ?? ''}`,
        cm & 32 && `pluma 2 ${PLUMA_SENSOR_TXT[b[`s${n}_count_pluma2`]] ?? ''}`,
      ].filter(Boolean);
      L.push(`S${n} al llegar a ${b[`count_s${n}`]}: ${acciones.join(' · ')} (enclavado hasta nueva configuración o Reset)`);
    }
  }
  if (b.torreta_run)  L.push(`Luz ${colores(b.torreta_run)} con la banda corriendo`);
  if (b.torreta_idle) L.push(`Luz ${colores(b.torreta_idle)} con la banda detenida`);
  if (b.torreta_i1)   L.push(`Luz ${colores(b.torreta_i1)} mientras I1 esté presionado`);
  for (const n of [1, 2]) {
    const p = b[`pluma${n}`];
    if (p != null) L.push(`Pluma ${n}: ${['stop', 'subir', 'bajar'][p] ?? p}`);
  }
  return L;
}
