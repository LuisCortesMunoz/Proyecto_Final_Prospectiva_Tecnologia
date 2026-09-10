/**
 * equipment.js — Selección de equipo (maletín / banda transportadora) y
 * traducción de una instrucción de banda al bloque "band" del engine_config.
 *
 * Por qué existe:
 *   El backend (/generar-logica) solo conoce el vocabulario del maletín
 *   (outputs/sequence). Nunca emite el bloque "band", así que el compilador
 *   jamás producía metadata._band_view y el panel visual de la banda —que ya
 *   existe en renderer.js— quedaba oculto siempre. Este módulo es el puente
 *   MÍNIMO que faltaba: decide a qué equipo pertenece la instrucción y, si es
 *   la banda, arma el MISMO bloque "band" que plc_maestro.py ya ejecuta.
 *
 * No toca Modbus, ni los registros del PLC, ni el Ladder maestro, ni los
 * prompts, ni el flujo del maletín: para el maletín, generate.js sigue yendo
 * al backend exactamente igual que antes.
 */

// Quita acentos y normaliza para que las expresiones regulares sean simples.
const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ── Vocabularios ──────────────────────────────────────────────
// EXCLUSIVO de la banda: si aparece, la instrucción es de la banda.
const BAND_TERMS = [
  /\bbandas?\b/, /\btransportador/, /\bcintas?\b/,
  /\bvfd\b/, /\bvariador/,
  /\bs\s?[12]\b/, /\bsensor(?:es)?\s*(?:1|2|uno|dos)\b/,
  /\btorreta\b/,
  /\bfrecuencias?\b/, /\b\d+(?:[.,]\d+)?\s*hz\b/, /\bhertz\b/,
  /\bderecha\b/, /\bizquierda\b/, /\bhorario\b/, /\bantihorario\b/,
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

const hits = (t, list) => list.filter(re => re.test(t)).length;

/**
 * ¿A qué equipo pertenece la instrucción?
 * @returns {{equipment:'maletin'|'banda'|null, reason:string}}
 *   equipment === null significa AMBIGUA: hay que preguntarle al usuario.
 */
export function detectEquipment(text) {
  const t = norm(text);
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

// ── Instrucción de banda → bloque "band" ──────────────────────
// Campos y rangos idénticos a validar_config en plc_banda.py (Ladder maestro
// nuevo de la banda):
//   enable · direction · freq_hz
//   s1_action · wait_s1_s · count_s1 · torreta_s1   (idem para S2)
//   torreta_run · torreta_idle
//   retrigger_s1_s · retrigger_s2_s  → solo PRESENTACIÓN: el Ladder maestro no
//   tiene registro de anti-retrigger (lo resuelve con SN_Rising).

const RE_IZQ  = /\bizquierda\b|\breversa\b|\binversa\b|\batras\b|\bantihorario\b|\bccw\b/;
const RE_DER  = /\bderecha\b|\badelante\b|\bhorario\b|\bcw\b/;
// "para" NO entra aqui: en "dame un programa PARA mover la banda" es una
// preposicion, no el verbo parar, y hacia que la instruccion se leyera como
// un apagado (enable:false -> programa sin rungs). El verbo se reconoce por
// sus formas inequivocas y por la frase "para la banda / el motor".
const RE_STOP  = /\b(?:deten|detener|detenga|detiene|apaga|apagar|apague|parar|pare|frena|frenar|alto)\b/;
const RE_PARAN = /\bpara\s+(?:la\s+(?:banda|cinta)|el\s+(?:motor|transportador|variador))/;
// Si la instruccion pide movimiento o configuracion, no es un apagado.
const RE_MOVE  = /\bmov\w*|\bgira|\barranc|\bavanz|\bcorre|\bmarcha|\bconfigur|\bvelocidad|\bfrecuencia|\bhz\b|\bderecha\b|\bizquierda\b/;
const RE_COND = /\bcuando\b|\bsi\b|\bal\b|\bdetect/;

const int = (s) => Math.round(Number(String(s).replace(',', '.')));

/** Segundos dentro de un fragmento ("5 s", "5 seg", "5 segundos"). */
function segundos(frag) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:segundos?|segs?|s)\b/.exec(frag);
  return m ? int(m[1]) : null;
}

/** Piezas a contar en un fragmento ("cuenta 10 piezas", "10 piezas"). */
function conteo(frag) {
  const m = /(?:cuenta|contar|cuente|conteo|contador)\D{0,20}(\d+)|(\d+)\s*piezas?/.exec(frag);
  if (!m) return null;
  return int(m[1] != null ? m[1] : m[2]);
}

/** Tiempo de bloqueo / anti-retrigger declarado explícitamente. */
function bloqueo(frag) {
  const m = /(?:bloqueo|bloquea|bloquear|anti-?retrigger|ignora|ignorar|rearranque)\D{0,24}(\d+(?:[.,]\d+)?)\s*(?:segundos?|segs?|s)\b/.exec(frag);
  return m ? int(m[1]) : null;
}

/**
 * ¿Qué lámparas de la torreta nombra la instrucción?
 * Es un dato de PRESENTACIÓN: decide cuáles se dibujan encendidas en el panel.
 * No viaja en el engine_config ni cambia los rungs, porque en el PLC la torreta
 * la gobierna el Ladder maestro (§12.7) a partir del estado de la banda.
 * @returns {{verde:boolean, amarilla:boolean, roja:boolean}}
 */
export function detectTorretaLamps(text) {
  const t = norm(text);
  return {
    verde:    /\bverde\b/.test(t)    || /\bq\s?10\b/.test(t),
    amarilla: /\bamarill/.test(t)  || /\bambar\b/.test(t) || /\bq\s?11\b/.test(t),
    roja:     /\broj[ao]\b/.test(t) || /\bq\s?12\b/.test(t),
  };
}

/**
 * Traduce una instrucción de banda al JSON lógico con el bloque "band".
 * Solo rellena lo que el texto declara: el compilador dibuja únicamente los
 * componentes presentes (un sensor sin tiempo de espera no se dibuja, la
 * frecuencia solo si se especificó, etc.).
 *
 * `hints` son datos de PRESENTACIÓN (qué lámparas nombró el usuario): van
 * aparte del `logic` justamente para que NO acaben dentro del engine_config.
 *
 * @returns {{logic:object, warnings:string[], hints:object}}
 */
export function buildBandLogic(text) {
  const warnings = [];
  const t = norm(text);
  const hints = { lamps: detectTorretaLamps(text) };
  // La frecuencia se aparta antes de buscar tiempos para que "35 Hz" no se
  // confunda con "35 s".
  const tt = t.replace(/\d+(?:[.,]\d+)?\s*(?:hz|hertz)/g, ' ');

  // Paro explícito de la banda: solo si además NO pide movimiento ni
  // configuración, y no hay condición ni sensor de por medio.
  const paro = RE_STOP.test(t) || RE_PARAN.test(t);
  const soloParo = paro && !RE_MOVE.test(t) && !RE_COND.test(t) && !/\bs\s?[12]\b|\bsensor/.test(t);
  if (soloParo) {
    warnings.push('La instrucción apaga la banda: el programa queda sin rungs.');
    return { logic: { name: nombre(text), band: { enable: false } }, warnings, hints };
  }

  const band = { enable: true };

  // Sentido de giro (el compilador lo traduce a %R00500 = 18 / 34).
  band.direction = RE_IZQ.test(t) ? 'izquierda' : (RE_DER.test(t) ? 'derecha' : 'derecha');

  // Frecuencia del VFD.
  let mf = /(\d+(?:[.,]\d+)?)\s*(?:hz|hertz)\b/.exec(t);
  if (!mf && /\bfrecuencia\b/.test(t)) mf = /\bfrecuencia\b\D{0,20}(\d+(?:[.,]\d+)?)/.exec(t);
  if (mf) band.freq_hz = int(mf[1]);

  // Sensores S1 / S2: se toma el fragmento que va desde la mención del sensor
  // hasta la mención del siguiente, y ahí se busca su tiempo de espera.
  const marcas = [];
  const reS = /\bs\s?([12])\b|\bsensor(?:es)?\s*(1|2|uno|dos)\b/g;
  const nUno = { 1: '1', 2: '2', uno: '1', dos: '2' };
  let m;
  while ((m = reS.exec(tt)) !== null) {
    marcas.push({ n: m[1] || nUno[m[2]], i: m.index });
  }
  // "cuando el sensor detecte una pieza" (sin número) se entiende como S1.
  if (!marcas.length && /\bsensor/.test(tt)) {
    marcas.push({ n: '1', i: tt.search(/\bsensor/) });
    warnings.push('Sensor sin número: se tomó S1.');
  }

  marcas.forEach((mk, k) => {
    const fin  = k + 1 < marcas.length ? marcas[k + 1].i : tt.length;
    const frag = tt.slice(mk.i, fin);
    const espera = segundos(frag);
    if (espera == null) {
      band['wait_s' + mk.n + '_s'] = 5;
      warnings.push('S' + mk.n + ' se mencionó sin tiempo de espera: se asumieron 5 s.');
    } else {
      band['wait_s' + mk.n + '_s'] = espera;
    }
    // El Ladder maestro nuevo distingue el paro temporizado (SN_Action = 2)
    // del paro por presencia (SN_Action = 1). El atajo histórico "wait_sN_s"
    // siempre significó "se detiene N segundos y sigue sola": se declara la
    // acción explícitamente para que el backend no tenga que deducirla.
    band['s' + mk.n + '_action'] = 'paro_temporizado';
    // El conteo dejó de ser una acción: basta el preset del contador.
    const cnt = conteo(frag);
    if (cnt != null) band['count_s' + mk.n] = cnt;
    const blq = bloqueo(frag);
    if (blq != null) band['retrigger_s' + mk.n + '_s'] = blq;
  });

  // "Cuenta 10 piezas en S2": el conteo suele ir ANTES de nombrar el sensor,
  // fuera del fragmento. Si sólo se mencionó un sensor, el conteo es suyo.
  if (marcas.length === 1 && band['count_s' + marcas[0].n] == null) {
    const cnt = conteo(tt);
    if (cnt != null) band['count_s' + marcas[0].n] = cnt;
  }

  return { logic: { name: nombre(text), band }, warnings, hints };
}

function nombre(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return 'Banda: ' + (s.length > 60 ? s.slice(0, 57) + '…' : s);
}
