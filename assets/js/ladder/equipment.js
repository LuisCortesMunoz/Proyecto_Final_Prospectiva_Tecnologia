/**
 * equipment.js — Selección de equipo (maletín / banda transportadora) y
 * normalización de una instrucción de banda al bloque "band" CANÓNICO.
 *
 * Flujo de la banda:
 *   texto → detectEquipment → buildBandLogic (intención) → canonicalBand
 *         → validateLogicJson → compileLogicToSchema (Ladder visual)
 *
 * La normalización es DETERMINISTA: frases equivalentes ("enciende lámpara
 * banda", "prende la luz de la banda") terminan exactamente en el mismo
 * bloque "band", con los mismos campos y códigos que valida y escribe
 * plc_banda.py (programa maestro ST de ladder_maestro_banda.csp). Solo si la
 * instrucción no trae ninguna intención reconocible se consulta a la IA, y su
 * respuesta pasa por canonicalBand igual.
 *
 * No toca Modbus, ni los registros del PLC, ni el flujo del maletín: para el
 * maletín, generate.js sigue yendo al backend exactamente igual que antes.
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
// Mismos campos y rangos que validar_config en plc_banda.py:
//   enable · direction · freq_hz
//   stop_mode (%R9) · auto_stop_mode (%R15) · auto_stop_s (%R11)
//   sN_action · wait_sN_s · count_sN · torreta_sN · sN_pluma1 · sN_pluma2
//   torreta_run · torreta_idle · torreta_i1 · pluma1 · pluma2
// Los códigos van SIEMPRE numéricos y "sin configurar" es null, para que dos
// frases equivalentes den el mismo JSON.
export const BAND_FIELDS = [
  'enable', 'direction', 'freq_hz', 'stop_mode', 'auto_stop_mode', 'auto_stop_s',
  's1_action', 'wait_s1_s', 'count_s1', 'torreta_s1', 's1_pluma1', 's1_pluma2',
  's2_action', 'wait_s2_s', 'count_s2', 'torreta_s2', 's2_pluma1', 's2_pluma2',
  'torreta_run', 'torreta_idle', 'torreta_i1', 'pluma1', 'pluma2',
];

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
 * Lleva cualquier bloque "band" (normalizador, IA, JSON pegado o panel) a la
 * forma canónica. Reproduce las mismas deducciones que plc_banda.plan_config
 * (un tiempo sin acción = paro temporizado, una pluma de sensor sin acción =
 * paro mientras detecta, etc.) para que el dibujo y la carga coincidan.
 */
export function canonicalBand(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const dir = norm(b.direction ?? '');
  out.direction = /^(2|izq|izquierda|left|ccw|antihorario|dir2|direccion2)$/.test(dir) ? 'izquierda' : 'derecha';
  out.freq_hz = entero(b.freq_hz);
  out.stop_mode = nulo0(codigo(b.stop_mode, STOP_MODE_CODES, 0, 3));

  out.auto_stop_s = nulo0(entero(b.auto_stop_s));
  let am = codigo(b.auto_stop_mode, AUTO_STOP_CODES, 0, 2);
  if (am == null) am = out.auto_stop_s > 0 ? 1 : null;
  out.auto_stop_mode = nulo0(am);
  if (out.auto_stop_mode == null && typeof out.auto_stop_s === 'number') out.auto_stop_s = null;

  for (const n of [1, 2]) {
    const wait = nulo0(entero(b[`wait_s${n}_s`]));
    const count = nulo0(entero(b[`count_s${n}`]));
    const p1 = nulo0(codigo(b[`s${n}_pluma1`], SENSOR_PLUMA_CODES, 0, 3));
    const p2 = nulo0(codigo(b[`s${n}_pluma2`], SENSOR_PLUMA_CODES, 0, 3));
    let acc = codigo(b[`s${n}_action`], ACTION_CODES, 0, 4);
    if (acc == null && b[`wait_s${n}_s`] != null) acc = 2;
    if (acc == null && (p1 || p2)) acc = 1;
    if (acc == null && b[`count_s${n}`] != null) acc = 0;
    out[`s${n}_action`] = acc;
    // El tiempo solo existe para las acciones temporizadas (2 y 4).
    out[`wait_s${n}_s`] = acc === 2 || acc === 4 ? wait : (typeof acc === 'number' ? null : wait);
    out[`count_s${n}`] = count;
    out[`torreta_s${n}`] = nulo0(entero(b[`torreta_s${n}`]));
    out[`s${n}_pluma1`] = p1;
    out[`s${n}_pluma2`] = p2;
  }
  for (const k of ['torreta_run', 'torreta_idle', 'torreta_i1']) out[k] = nulo0(entero(b[k]));
  for (const n of [1, 2]) out[`pluma${n}`] = codigo(b[`pluma${n}`], PLUMA_CODES, 0, 2);

  // Sin marcha solo si no hay nada que exija BandEnable (espejo de
  // plc_banda.sin_marcha): los sensores y el paro automático requieren I1.
  const usaSensores = [1, 2].some(n => out[`s${n}_action`] != null);
  out.enable = b.enable !== false || usaSensores || !!out.auto_stop_mode;

  const ordenado = {};
  for (const k of BAND_FIELDS) ordenado[k] = out[k] ?? null;
  ordenado.enable = out.enable;
  return ordenado;
}

// ── Descripción legible (nombre del programa y resumen del chat) ──
const STOP_MODE_TXT = ['I3', 'I2 + I3', 'Software + I3', 'I2 + Software + I3'];
const colores = (m) => ['verde', 'amarilla', 'roja'].filter((_, i) => Number(m) & (1 << i)).join(' + ');
const PLUMA_SENSOR_TXT = { 1: 'sube', 2: 'baja', 3: 'stop forzado' };

/** Lista de frases cortas con lo que hará el PLC con este bloque "band". */
export function describeBand(band) {
  const b = canonicalBand(band);
  const L = [];
  if (b.enable) {
    L.push(`Avanza en dirección ${b.direction === 'izquierda' ? '2 (izquierda)' : '1 (derecha)'}`
      + `${b.freq_hz != null ? ` a ${b.freq_hz} Hz` : ''} al pulsar I1`);
  }
  if (b.stop_mode != null) L.push(`Paro: ${STOP_MODE_TXT[b.stop_mode] ?? b.stop_mode}`);
  if (b.auto_stop_mode) {
    L.push(`Paro automático a los ${b.auto_stop_s} s (${b.auto_stop_mode === 2 ? 'desde START' : 'solo movimiento real'})`);
  }
  for (const n of [1, 2]) {
    const acc = b[`s${n}_action`];
    if (acc == null) continue;
    const w = b[`wait_s${n}_s`];
    const txt = ['solo cuenta', 'se detiene mientras detecta', `se detiene ${w} s`,
      'se detiene mientras detecta', `se detiene ${w} s`][acc] ?? `acción ${acc}`;
    let s = `S${n}${b[`count_s${n}`] ? ` al contar ${b[`count_s${n}`]}` : ''}: ${txt}`;
    if ((acc === 3 || acc === 4) && b[`torreta_s${n}`]) s += ` + ${colores(b[`torreta_s${n}`])}`;
    for (const m of [1, 2]) {
      const p = b[`s${n}_pluma${m}`];
      if (p) s += ` · pluma ${m} ${PLUMA_SENSOR_TXT[p] ?? p}`;
    }
    if (acc > 0) s += ' y continúa';
    L.push(s);
  }
  if (b.torreta_run)  L.push(`Luz ${colores(b.torreta_run)} con la banda corriendo`);
  if (b.torreta_idle) L.push(`Luz ${colores(b.torreta_idle)} con la banda detenida`);
  if (b.torreta_i1)   L.push(`Luz ${colores(b.torreta_i1)} mientras I1 esté presionado`);
  for (const n of [1, 2]) {
    const p = b[`pluma${n}`];
    if (p != null) L.push(`Pluma ${n}: ${['stop', 'subir', 'bajar'][p] ?? p}`);
  }
  if (!L.length) L.push('Banda detenida (sin marcha)');
  return L;
}

function nombreBanda(band) {
  const s = describeBand(band).slice(0, 2).join(' · ');
  return 'Banda: ' + (s.length > 70 ? s.slice(0, 67) + '…' : s);
}

// ── Normalización de intención ─────────────────────────────────
// Sinónimos → intención. Se trabaja sobre texto sin acentos.
const RE_LAMP   = /\blampara|\bluces?\b|\bluz\b|\btorreta\b|\bfocos?\b|\bpiloto|\bindicador|\bbaliza|\bverdes?\b|\bamarill|\bambar\b|\broj[ao]s?\b|\bq\s?[345]\b/;
const RE_OFF    = /\b(?:apag\w*|desactiv\w*|quit\w*)\b/;
const RE_PLUMA  = /\bplumas?\b|\bbarreras?\b|\bcompuertas?\b/;
// "para" suelto NO es verbo ("un programa PARA mover la banda"): solo cuenta
// en "para la banda / el motor" o "para 5 segundos".
const RE_STOP   = /\b(?:deten\w*|detien\w*|par(?:ar|ate|e|en|ada|ado)|fren\w*|alto|stop|paus\w*|esper\w*)\b/;
const RE_PARAN  = /\bpara\s+(?:la\s+(?:banda|cinta)|el\s+(?:motor|transportador|variador)|\d)/;
const RE_MOVE   = /\bavanz\w*|\bmuev\w*|\bmover\w*|\bgir[ae]\w*|\bgirar\b|\barranc\w*|\bcorr(?:e|er|a)\b|\bmarcha\b|\bretroce\w*|\bvelocidad\b|\bfrecuencia\b|\bhz\b|\bhertz\b|\bderecha\b|\bizquierda\b|\b(?:direccion|sentido)\s*[12]\b|\breversa\b|\badelante\b/;
const RE_RUN    = /\b(?:corriendo|en marcha|avanzando|moviendose|moviendo|funcionando|operando|trabajando)\b|\b(?:mientras|cuando|durante|si)\b[^,;]{0,25}?\b(?:corre|corra|avanza|avance|se mueve|se mueva|arranque|opera|trabaja)\b/;
const RE_IDLE   = /\bdetenid[ao]s?\b|\breposo\b|\bparad[ao]s?\b|\bquiet[ao]s?\b|\bsin mover\w*|\bsin movimiento\b|\bno se mueve\b|\bno avanza\b|\b(?:mientras|cuando)\b[^,;]{0,25}?\b(?:se detenga|se pare|no corra|no avance|no se mueva)\b/;
const RE_I1     = /\bi\s?1\b|\bboton (?:de )?(?:arranque|inicio|start)\b/;
const RE_I2     = /\bi\s?2\b/;
const RE_I3     = /\bi\s?3\b/;
const RE_SOFT   = /\bsoftware\b|\bvirtual\b|\bparo remoto\b|\bdesde (?:la |el )?(?:app|aplicacion|interfaz|pantalla|panel|pagina|web|computadora|pc)\b|\bboton (?:de )?(?:paro )?(?:de )?(?:la )?(?:interfaz|aplicacion|pantalla|app|panel)\b/;
const RE_WHILE_DET = /\bmientras\b[^,;]{0,30}?\b(?:detect\w*|activ\w*|haya|siga|este|vea)\b|\bhasta que (?:se )?(?:retire|quite|libere|saque|deje de detectar|desaparezca)\b/;
const RE_UNTIL_SENSOR = /\bhasta (?:que )?(?:llegue|detect\w*|el sensor|s\s?[12]\b|sensor)/;
const RE_TOTAL  = /\baunque\b|\bincluso\b|\ben total\b|\btiempo total\b|\bdesde (?:que )?(?:arranc\w*|inici\w*|el inicio|start)\b|\bcontando (?:las )?pausas\b/;
const RE_ADD    = /\b(?:ademas|tambien|agrega\w*|anade\w*|suma\w*)\b/;
const RE_EDIT   = /\b(?:ahora|cambia\w*|modifica\w*|actualiza\w*)\b/;
const RE_IZQ    = /\bizquierda\b|\breversa\b|\binvers[ao]\b|\bhacia atras\b|\batras\b|\bantihorario\b|\bccw\b|\b(?:direccion|sentido)\s*2\b|\bretroce\w*/;
const RE_DER    = /\bderecha\b|\badelante\b|\bhacia delante\b|\bhorario\b|\bcw\b|\b(?:direccion|sentido)\s*1\b/;
const G = (re) => new RegExp(re.source, 'g');

const PLUMA_VERBOS = [
  [/\bsub\w*|\blevant\w*|\balz\w*|\barriba\b|\babr\w*/, 1],
  [/\bbaj\w*|\bdescend\w*|\bdesciend\w*|\babajo\b|\bcierr\w*|\bcerr\w*/, 2],
  [/\bdeten\w*|\bdetien\w*|\bpar(?:a|ar|e)\b|\bstop\b|\bfren\w*|\balto\b/, 3],
];

const NUM_PALABRAS = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30,
  cuarenta: 40, cincuenta: 50, sesenta: 60 };

const int = (s) => Math.round(Number(String(s).replace(',', '.')));

/** Texto sin acentos, sin signos y con los números escritos en palabras. */
function prepararTexto(text) {
  let t = norm(text).replace(/[¿?¡!"()]/g, ' ');
  t = t.replace(/\b(sensor(?:es)?|s|plumas?|direccion|sentido)\s+(?:numero\s+)?(uno|dos)\b/g,
    (_, w, n) => `${w} ${NUM_PALABRAS[n]}`);
  t = t.replace(/\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta)\b(?=\s*(?:segundos?|segs?|minutos?|hz|hertz|piezas?|objetos?|detecciones|cajas?|veces|productos?|paquetes?))/g,
    (w) => String(NUM_PALABRAS[w]));
  return t.replace(/\s+/g, ' ').trim();
}

/** Segundos dentro de un fragmento ("5 s", "5 seg", "5 segundos", "1 minuto"). */
function segundos(frag) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:segundos?|segs?|s)\b/.exec(frag);
  if (m) return int(m[1]);
  const mm = /(\d+(?:[.,]\d+)?)\s*min(?:utos?)?\b/.exec(frag);
  return mm ? int(mm[1]) * 60 : null;
}

/** Detecciones a contar ("cuenta 10 piezas", "después de 3 detecciones"). */
function conteo(frag) {
  const m = /(?:cuenta|contar|cuente|conteo|contador)\D{0,20}?(\d+)|(\d+)\s*(?:piezas?|detecciones|deteccion|objetos?|cajas?|veces|productos?|paquetes?)|al (?:llegar|contar) a (\d+)/.exec(frag);
  if (!m) return null;
  return int(m[1] ?? m[2] ?? m[3]);
}

/**
 * ¿Qué lámparas de la torreta nombra la instrucción?
 * @returns {{verde:boolean, amarilla:boolean, roja:boolean}}
 */
export function detectTorretaLamps(text) {
  const t = norm(text);
  return {
    verde:    /\bverdes?\b/.test(t)  || /\bq\s?3\b/.test(t),
    amarilla: /\bamarill/.test(t)    || /\bambar\b/.test(t) || /\bq\s?4\b/.test(t),
    roja:     /\broj[ao]s?\b/.test(t) || /\bq\s?5\b/.test(t),
  };
}

/** Máscara de torreta 0..7 (verde=1, amarilla=2, roja=4) de un fragmento. */
function mascara(frag) {
  const l = detectTorretaLamps(frag);
  return (l.verde ? 1 : 0) | (l.amarilla ? 2 : 0) | (l.roja ? 4 : 0);
}

/** Sensores que nombra una cláusula (S1, "sensor 2", "ambos sensores"). */
function sensoresEn(c, warnings) {
  if (/\bambos sensores\b|\blos dos sensores\b/.test(c)) return ['1', '2'];
  const ns = new Set();
  for (const m of c.matchAll(/\b(?:s|sensor(?:es)?)\s*(?:numero\s*)?([12])\b/g)) ns.add(m[1]);
  if (!ns.size && /\bsensor(?:es)?\b/.test(c)) {
    warnings.push('Sensor sin número: se tomó S1.');
    ns.add('1');
  }
  return [...ns];
}

/** ¿La cláusula habla de la banda en general (no continúa la de un sensor)? */
function esGlobal(c) {
  const sinEstados = c.replace(G(RE_RUN), ' ').replace(G(RE_IDLE), ' ');
  return RE_MOVE.test(sinEstados) || RE_RUN.test(c) || RE_IDLE.test(c)
    || RE_I1.test(c) || RE_I2.test(c) || RE_I3.test(c) || RE_SOFT.test(c);
}

/**
 * Reparte el texto en cláusulas y las asigna a S1, S2 o a la banda en
 * general. Una cláusula que nombra un sensor abre su contexto; las
 * siguientes lo continúan ("cuando S1 detecte, detente 5 s y sube la pluma
 * 1") hasta que otra cláusula hable de la banda, de otro sensor o termine
 * la oración.
 */
function segmentar(tt, warnings) {
  const grupos = { 1: [], 2: [], g: [] };
  for (const oracion of tt.split(/[.]+/)) {
    let ctx = null;
    for (const cl of oracion.split(/[,;:]|\by luego\b|\bluego\b|\bentonces\b|\by despues\b(?!\s+de)/)) {
      const c = cl.trim();
      if (!c) continue;
      const ns = sensoresEn(c, warnings);
      if (ns.length) ctx = ns;
      else if (esGlobal(c)) ctx = null;
      (ctx || ['g']).forEach(k => grupos[k].push(c));
    }
  }
  return grupos;
}

/** Comandos de pluma de un fragmento: {1: código, 2: código}. */
function plumasDesdeTexto(f, enSensor, warnings) {
  const out = {};
  const txt = f.replace(/\bplumas?\s*1\s*(?:y|e|,)\s*(?:la\s*)?2\b|\bambas plumas\b|\blas dos plumas\b/g, 'pluma 12');
  for (const parte of txt.split(/\by\b|,|;/)) {
    const m = /\b(?:plumas?|barreras?|compuertas?)\s*(?:numero\s*)?(12|1|2)?\b/.exec(parte);
    if (!m) continue;
    let verbo = null, dist = Infinity;
    for (const [re, code] of PLUMA_VERBOS) {
      for (const v of parte.matchAll(G(re))) {
        const d = Math.abs(v.index - m.index);
        if (d < dist) { dist = d; verbo = code; }
      }
    }
    if (verbo == null) continue;
    if (!m[1]) warnings.push('Pluma sin número: se tomó la pluma 1.');
    const nums = m[1] === '12' ? [1, 2] : [m[1] ? Number(m[1]) : 1];
    // En un sensor 3 = forzar stop; en el mando manual stop = 0.
    for (const k of nums) out[k] = enSensor ? verbo : (verbo === 3 ? 0 : verbo);
  }
  return out;
}

/** Acción de un sensor a partir de todo lo que se dijo en su contexto. */
function sensorDesdeTexto(n, f, warnings) {
  const out = {};
  const espera = segundos(f);
  const cnt = conteo(f);
  const hayLuz = RE_LAMP.test(f) && !RE_OFF.test(f);
  const plumas = plumasDesdeTexto(f, true, warnings);
  const conPluma = plumas[1] != null || plumas[2] != null;
  const mientras = RE_WHILE_DET.test(f) || RE_UNTIL_SENSOR.test(f);
  const verboParo = RE_STOP.test(f) || RE_PARAN.test(f);
  const pideParo = verboParo || mientras || espera != null;

  let accion = 0;
  if (pideParo || hayLuz || conPluma) {
    const temporizado = espera != null && !mientras;
    accion = temporizado ? (hayLuz ? 4 : 2) : (hayLuz ? 3 : 1);
    if (temporizado) out[`wait_s${n}_s`] = espera;
    if ((hayLuz || conPluma) && !verboParo && espera == null) {
      warnings.push(`S${n}: el programa maestro solo aplica `
        + `${hayLuz && conPluma ? 'la torreta y las plumas' : hayLuz ? 'la torreta' : 'las plumas'} `
        + 'de un sensor mientras detiene la banda: se detiene mientras detecta y continúa sola.');
    } else if (espera == null && !mientras) {
      warnings.push(`S${n}: no se indicó tiempo de paro: la banda se detiene mientras el sensor detecta y continúa sola al liberarse.`);
    }
    if (RE_UNTIL_SENSOR.test(f)) {
      warnings.push(`S${n}: el ST no tiene paro definitivo por sensor: la banda se detiene mientras S${n} detecta y continúa al retirar la pieza.`);
    }
  }
  out[`s${n}_action`] = accion;
  if (cnt != null) {
    out[`count_s${n}`] = cnt;
    if (/\bcada\b/.test(f)) {
      warnings.push(`S${n}: el ST ejecuta la acción UNA vez al llegar a ${cnt} detecciones (no se repite cada ${cnt}).`);
    }
  }
  if (hayLuz) {
    let luz = mascara(f);
    if (!luz) { luz = 7; warnings.push(`S${n}: no se indicó el color: se encienden las tres luces.`); }
    out[`torreta_s${n}`] = luz;
  }
  for (const m of [1, 2]) if (plumas[m] != null) out[`s${n}_pluma${m}`] = plumas[m];
  return out;
}

/** Destino de una luz que no es de un sensor: I1, marcha o reposo. */
function destinoLuz(c, mueve) {
  if (RE_I1.test(c)) return 'torreta_i1';
  if (RE_RUN.test(c)) return 'torreta_run';
  if (RE_IDLE.test(c)) return 'torreta_idle';
  return mueve ? 'torreta_run' : 'torreta_idle';
}

/** Luces por estado de la banda. Devuelve las que se pidió apagar. */
function lucesGlobales(clausulas, band, mueve, warnings) {
  const apagar = [];
  for (const c0 of clausulas) {
    if (!RE_LAMP.test(c0)) continue;
    const contextos = [RE_RUN, RE_IDLE, RE_I1].filter(re => re.test(c0)).length;
    const partes = contextos > 1 ? c0.split(/\by\b/) : [c0];
    for (const c of partes) {
      if (!RE_LAMP.test(c)) continue;
      let luz = mascara(c);
      const destino = destinoLuz(c, mueve);
      if (RE_OFF.test(c)) {
        const conDestino = RE_I1.test(c) || RE_RUN.test(c) || RE_IDLE.test(c);
        apagar.push({ destino: conDestino ? destino : null, mask: luz || 7 });
        continue;
      }
      if (!luz) { luz = 7; warnings.push('No se indicó el color de la torreta: se encienden las tres luces.'); }
      band[destino] = (band[destino] || 0) | luz;
    }
  }
  return apagar;
}

/** Aplica la instrucción sobre el programa de banda anterior. */
function fusionar(anterior, band, apagar, sumar) {
  const out = canonicalBand(anterior);
  for (const [k, v] of Object.entries(band)) {
    if (v == null) continue;
    if (sumar && /^torreta_/.test(k)) out[k] = (Number(out[k]) || 0) | v;
    else out[k] = v;
  }
  for (const a of apagar) {
    for (const k of a.destino ? [a.destino] : ['torreta_run', 'torreta_idle', 'torreta_i1']) {
      out[k] = (Number(out[k]) || 0) & ~a.mask;
    }
  }
  out.enable = !!(out.enable || band.enable);
  return out;
}

/**
 * Traduce una instrucción de banda al JSON lógico con el bloque "band"
 * CANÓNICO. Solo rellena lo que el texto declara.
 *
 * `previous`: bloque "band" del programa abierto. Solo se usa si la frase
 * pide modificarlo ("además…", "ahora…", "cambia…").
 * `hints` son datos de PRESENTACIÓN (qué lámparas nombró el usuario): van
 * aparte del `logic` justamente para que NO acaben dentro del engine_config.
 *
 * @returns {{logic:object|null, warnings:string[], hints:object}}
 *   logic === null: no se reconoció ninguna intención de banda.
 */
export function buildBandLogic(text, { previous = null } = {}) {
  const warnings = [];
  const t = prepararTexto(text);
  const hints = { lamps: detectTorretaLamps(text) };
  // La frecuencia se aparta antes de buscar tiempos para que "35 Hz" no se
  // confunda con "35 s".
  const tt = t.replace(/\d+(?:[.,]\d+)?\s*(?:hz|hertz)\b/g, ' ');
  const band = {};

  // "aunque el sensor la pause" describe cómo cuenta el paro automático, no
  // una acción del sensor: no abre su contexto.
  const grupos = segmentar(tt.replace(/\b(?:aunque|incluso)\b[^,;.]*/g, ' '), warnings);
  for (const n of [1, 2]) {
    if (grupos[n].length) Object.assign(band, sensorDesdeTexto(n, grupos[n].join(' , '), warnings));
  }
  const g = grupos.g.join(' , ');

  // Movimiento: los estados ("mientras corre", "con la banda detenida") dicen
  // CUÁNDO ocurre algo, no piden mover la banda.
  const pideMover = RE_MOVE.test(t.replace(G(RE_RUN), ' ').replace(G(RE_IDLE), ' '));
  if (RE_IZQ.test(t)) band.direction = 'izquierda';
  else if (RE_DER.test(t)) band.direction = 'derecha';
  let mf = /(\d+(?:[.,]\d+)?)\s*(?:hz|hertz)\b/.exec(t);
  if (!mf) mf = /\b(?:frecuencia|velocidad)\b\D{0,20}?(\d+(?:[.,]\d+)?)/.exec(t);
  if (mf) band.freq_hz = int(mf[1]);

  // Paros: I3 siempre; I2 y/o el paro software si se nombran.
  const i2 = RE_I2.test(t), sw = RE_SOFT.test(t);
  if (i2 || sw) band.stop_mode = (i2 ? 1 : 0) + (sw ? 2 : 0);

  // Paro automático: tiempo de movimiento fuera de los sensores.
  const sAuto = segundos(g);
  const conLuzSolo = RE_LAMP.test(g) && !RE_STOP.test(g) && !RE_MOVE.test(g);
  if (sAuto != null && sAuto > 0 && !conLuzSolo && (RE_STOP.test(g) || RE_PARAN.test(g) || RE_MOVE.test(g))) {
    band.auto_stop_s = sAuto;
    band.auto_stop_mode = RE_TOTAL.test(t) ? 2 : 1;
  } else if (sAuto != null && conLuzSolo) {
    warnings.push('El programa maestro no temporiza lámparas: la luz se enciende sin tiempo.');
  }

  // Luces por estado de la banda y plumas manuales.
  const mueve = pideMover || [1, 2].some(n => band[`s${n}_action`] != null) || !!band.auto_stop_s;
  const apagar = lucesGlobales(grupos.g, band, mueve, warnings);
  if (band.torreta_run && !mueve) {
    warnings.push('La luz "con la banda corriendo" solo enciende cuando la banda corre; esta instrucción no pide moverla.');
  }
  const plumas = plumasDesdeTexto(g, false, warnings);
  for (const n of [1, 2]) if (plumas[n] != null) band[`pluma${n}`] = plumas[n];

  const usaSensores = [1, 2].some(n => band[`s${n}_action`] != null);
  const hayLuces = ['torreta_run', 'torreta_idle', 'torreta_i1'].some(k => band[k] != null) || apagar.length > 0;
  const hayPlumas = band.pluma1 != null || band.pluma2 != null;
  const soloParo = !pideMover && !usaSensores && !band.auto_stop_s && band.stop_mode == null
    && !hayLuces && !hayPlumas && (RE_STOP.test(g) || RE_PARAN.test(g));
  if (soloParo) {
    warnings.push('La instrucción solo detiene la banda.');
    band.enable = false;
  } else {
    band.enable = pideMover || usaSensores || !!band.auto_stop_s || band.stop_mode != null;
    if (!band.enable && usaSensores) {
      warnings.push('Los sensores solo actúan con la banda habilitada por I1.');
    }
  }
  if (usaSensores && !pideMover) {
    warnings.push('El ST solo evalúa los sensores con la banda en marcha: al pulsar I1 la banda avanza '
      + 'y el sensor la detiene.');
  }

  // Programa nuevo sin luces pedidas pero con "apaga…": todas en 0.
  if (!previous || !(RE_ADD.test(t) || RE_EDIT.test(t))) {
    for (const a of apagar) {
      for (const k of a.destino ? [a.destino] : ['torreta_run', 'torreta_idle', 'torreta_i1']) band[k] = 0;
    }
  }

  const reconocido = soloParo || pideMover || usaSensores || hayLuces || hayPlumas
    || band.stop_mode != null || !!band.auto_stop_s;
  if (!reconocido) return { logic: null, warnings, hints };

  let final = band;
  if (previous && (RE_ADD.test(t) || RE_EDIT.test(t))) {
    final = fusionar(previous, band, apagar, RE_ADD.test(t));
    warnings.push('La instrucción se aplicó sobre el programa de banda abierto.');
  }
  const canon = canonicalBand(final);
  if (canon.enable && canon.freq_hz == null) {
    warnings.push('No se indicó frecuencia: la banda usará la que ya tiene el PLC (%R4).');
  }
  return {
    logic: { name: nombreBanda(canon), device: 'banda', band: canon, outputs: [] },
    warnings,
    hints,
  };
}
