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
  /\btorreta\b/, /\bplumas?\b/,
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

// ¿Pide MOVER la banda? Los estados ("cuando este corriendo", "con la banda
// detenida") dicen CUANDO ocurre algo, no piden movimiento: se quitan antes.
const RE_MOVER  = /\bmuev\w*|\bmover\w*|\bgir[ae]\w*|\barranc\w*|\bavanz[ae]\w*|\bcorr(?:e|er|a)\b|\bmarcha\b|\bvelocidad\b|\bfrecuencia\b|\bhz\b|\bderecha\b|\bizquierda\b/;
const RE_RUN    = /\bcorriendo\b|\ben marcha\b|\bmoviendo(?:se)?\b|\bavanzando\b|\bse mueve\b|\bfuncionando\b/;
const RE_IDLE   = /\bdetenid[ao]s?\b|\breposo\b|\bparad[ao]s?\b|\bquiet[ao]\b|\bsin moverse\b|\bsin movimiento\b|\bno se mueve\b|\bapagad[ao]\b/;
const RE_LAMP   = /\blampara|\bluces?\b|\bluz\b|\btorreta\b|\bverde\b|\bamarill|\bambar\b|\broj[ao]\b/;
const RE_PLUMA  = /\bplumas?\b/;
const RE_SENSOR = /\bs\s?[12]\b|\bsensor/;
const global = (re) => new RegExp(re.source, 'g');

const int = (s) => Math.round(Number(String(s).replace(',', '.')));
const N_UNO = { 1: '1', 2: '2', uno: '1', dos: '2' };

/** Segundos dentro de un fragmento ("5 s", "5 seg", "5 segundos"). */
function segundos(frag) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:segundos?|segs?|s)\b/.exec(frag);
  return m ? int(m[1]) : null;
}

/** Detecciones a contar ("cuenta 10 piezas", "10 piezas", "3 detecciones"). */
function conteo(frag) {
  const m = /(?:cuenta|contar|cuente|conteo|contador)\D{0,20}(\d+)|(\d+)\s*(?:piezas?|detecciones|deteccion|objetos?|cajas?|veces)/.exec(frag);
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

/** Máscara de torreta 0..7 (verde=1, amarilla=2, roja=4) de un fragmento. */
function mascara(frag) {
  const l = detectTorretaLamps(frag);
  return (l.verde ? 1 : 0) | (l.amarilla ? 2 : 0) | (l.roja ? 4 : 0);
}

/**
 * Traduce una instrucción de banda al JSON lógico con el bloque "band".
 * Solo rellena lo que el texto declara. Si la instrucción NO pide mover la
 * banda (solo torreta, sensores, conteo o plumas), enable = false y el Ladder
 * muestra únicamente esas acciones.
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

  const hayAccion = RE_LAMP.test(t) || RE_PLUMA.test(t) || RE_SENSOR.test(t);
  const pideMover = RE_MOVER.test(t.replace(global(RE_RUN), ' ').replace(global(RE_IDLE), ' '));

  // Paro explícito de la banda: solo si además NO pide movimiento ni
  // configuración, y no hay condición, sensor, torreta ni pluma de por medio.
  const paro = RE_STOP.test(t) || RE_PARAN.test(t);
  const soloParo = paro && !RE_MOVE.test(t) && !RE_COND.test(t) && !hayAccion;
  if (soloParo) {
    warnings.push('La instrucción solo detiene la banda.');
    return { logic: { name: nombre(text), band: { enable: false } }, warnings, hints };
  }

  // Sin acciones, cualquier instrucción de banda se toma como movimiento
  // (comportamiento de siempre). Con acciones, solo si lo pide.
  const band = { enable: pideMover || !hayAccion };

  // Sentido de giro (el ST lo traduce a %R500 = 18 / 34).
  band.direction = RE_IZQ.test(t) ? 'izquierda' : 'derecha';

  // Frecuencia del VFD.
  let mf = /(\d+(?:[.,]\d+)?)\s*(?:hz|hertz)\b/.exec(t);
  if (!mf && /\bfrecuencia\b/.test(t)) mf = /\bfrecuencia\b\D{0,20}(\d+(?:[.,]\d+)?)/.exec(t);
  if (mf) band.freq_hz = int(mf[1]);

  // Sensores S1 / S2: se toma el fragmento que va desde la mención del sensor
  // hasta la mención del siguiente, y ahí se busca qué debe hacer.
  const marcas = [];
  const reS = /\bs\s?([12])\b|\bsensor(?:es)?\s*(1|2|uno|dos)\b/g;
  let m;
  while ((m = reS.exec(tt)) !== null) {
    marcas.push({ n: m[1] || N_UNO[m[2]], i: m.index });
  }
  // "cuando el sensor detecte una pieza" (sin número) se entiende como S1.
  if (!marcas.length && /\bsensor/.test(tt)) {
    marcas.push({ n: '1', i: tt.search(/\bsensor/) });
    warnings.push('Sensor sin número: se tomó S1.');
  }

  let luzEnSensor = false;
  marcas.forEach((mk, k) => {
    const fin  = k + 1 < marcas.length ? marcas[k + 1].i : tt.length;
    const frag = tt.slice(mk.i, fin);
    // La luz puede nombrarse antes del sensor ("enciende la roja cuando S1…"),
    // salvo que esa parte hable del estado de la banda.
    let antes = k === 0 ? tt.slice(0, mk.i) : '';
    if (RE_RUN.test(antes) || RE_IDLE.test(antes)) antes = '';
    const zonaLuz = antes + ' ' + frag;

    const n = mk.n;
    const espera = segundos(frag);
    const cnt = conteo(frag) ?? (marcas.length === 1 ? conteo(tt) : null);
    const pideParo = RE_STOP.test(frag) || RE_PARAN.test(frag) || /\bespera/.test(frag) || espera != null;

    if (RE_LAMP.test(zonaLuz)) {
      // El ST solo enciende la máscara de un sensor junto con un paro
      // (acciones 3 y 4): la banda se detiene mientras dura el evento.
      let luz = mascara(zonaLuz);
      if (!luz) { luz = 7; warnings.push(`S${n}: no se indicó el color: se encienden las tres luces.`); }
      band['s' + n + '_action'] = espera != null ? 'paro_temporizado_torreta' : 'paro_presencia_torreta';
      if (espera != null) band['wait_s' + n + '_s'] = espera;
      band['torreta_s' + n] = luz;
      luzEnSensor = true;
      warnings.push(`S${n}: en el programa maestro la luz de un sensor se enciende junto con un paro `
        + `(la banda se detiene ${espera != null ? `${espera} s` : 'mientras detecta'}) y solo con la banda habilitada por I1.`);
    } else if (pideParo) {
      band['s' + n + '_action'] = 'paro_temporizado';
      if (espera == null) {
        band['wait_s' + n + '_s'] = 5;
        warnings.push('S' + n + ' se mencionó sin tiempo de espera: se asumieron 5 s.');
      } else {
        band['wait_s' + n + '_s'] = espera;
      }
    } else {
      // Solo detectar y contar.
      band['s' + n + '_action'] = 'nada';
    }
    if (cnt != null) band['count_s' + n] = cnt;
    const blq = bloqueo(frag);
    if (blq != null) band['retrigger_s' + n + '_s'] = blq;
  });

  // Luces por estado de la banda (las que no son de un sensor).
  const zonaEstado = luzEnSensor ? (marcas.length ? tt.slice(0, marcas[0].i) : '') : tt;
  const hayEstado = RE_RUN.test(zonaEstado) || RE_IDLE.test(zonaEstado);
  if (RE_LAMP.test(zonaEstado) && (!luzEnSensor || hayEstado)) {
    let luz = mascara(zonaEstado);
    if (!luz) { luz = 7; warnings.push('No se indicó el color de la torreta: se encienden las tres luces.'); }
    if (RE_RUN.test(zonaEstado)) band.torreta_run = luz;
    else if (RE_IDLE.test(zonaEstado) || !band.enable) band.torreta_idle = luz;
    else band.torreta_run = luz;
  }

  // Plumas: "sube la pluma 1", "baja la pluma 2", "detén la pluma 1".
  const reP = /\bplumas?\s*(1|2|uno|dos)?\b/g;
  let mp;
  while ((mp = reP.exec(t)) !== null) {
    const n = mp[1] ? N_UNO[mp[1]] : '1';
    if (!mp[1]) warnings.push('Pluma sin número: se tomó la pluma 1.');
    const antes = t.slice(Math.max(0, mp.index - 20), mp.index);
    const despues = t.slice(mp.index + mp[0].length, mp.index + mp[0].length + 20);
    const cmd = (z) => /\bsub\w*|\blevant\w*|\barriba\b/.test(z) ? 'subir'
      : /\bbaj\w*|\babajo\b/.test(z) ? 'bajar'
      : /\bdeten\w*|\bpar[ae]r?\b|\bstop\b|\balto\b/.test(z) ? 'stop' : null;
    const c = cmd(antes) || cmd(despues);
    if (c) band['pluma' + n] = c;
  }

  return { logic: { name: nombre(text), band }, warnings, hints };
}

function nombre(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return 'Banda: ' + (s.length > 60 ? s.slice(0, 57) + '…' : s);
}
