/**
 * logic-examples.js — Los 7 casos de prueba del JSON lógico simple.
 *
 * Son los ejemplos canónicos del documento de reestructuración (ver
 * CONTRACT.md). Sirven para ejercitar el compilador en dev: cada `logic`
 * se puede pasar a compileLogicToSchema(logic) (sin perfil) o pegar en el
 * chat del editor. Usan nombres lógicos genéricos (I1..I7) tal como en el PDF.
 */
export const LOGIC_EXAMPLES = [
  {
    id: 'directo',
    title: 'Lógica directa',
    user: 'Con I1 prende Q10.',
    logic: {
      name: 'Salida directa',
      logic_type: 'combinational',
      outputs: [{ coil: 'Q10', expr: 'I1', mode: 'direct', comment: 'Q10 sigue directamente a I1' }],
    },
  },
  {
    id: 'or',
    title: 'Lógica OR (rama paralela)',
    user: 'Q10 debe prender con I1 o con I3.',
    logic: {
      name: 'OR de dos entradas',
      logic_type: 'combinational',
      outputs: [{ coil: 'Q10', expr: 'I1 + I3', mode: 'direct', comment: 'Q10 prende si I1 o I3 están activos' }],
    },
  },
  {
    id: 'and',
    title: 'Lógica AND (serie)',
    user: 'Q10 prende solo si I1 está activo y el selector I4 está activo.',
    logic: {
      name: 'AND de dos entradas',
      logic_type: 'combinational',
      outputs: [{ coil: 'Q10', expr: 'I1 * I4', mode: 'direct', comment: 'Q10 prende solo cuando I1 e I4 están activos' }],
    },
  },
  {
    id: 'paro',
    title: 'Paro general (contacto NC)',
    user: 'Q10 prende con I1, pero se apaga si activo el paro general.',
    logic: {
      name: 'Marcha con paro general',
      logic_type: 'combinational',
      outputs: [{ coil: 'Q10', expr: 'I1 * !I7', mode: 'direct', comment: 'Q10 prende con I1 siempre que I7 no esté activo' }],
      global_rules: { global_stop: 'I7', stop_priority: true },
    },
  },
  {
    id: 'enclavamiento',
    title: 'Enclavamiento (sello set/reset)',
    user: 'Con I1 arranca Q10 y se queda encendida. Con I2 se apaga.',
    logic: {
      name: 'Enclavamiento de Q10',
      logic_type: 'stateful',
      outputs: [{ coil: 'Q10', expr: 'M1', mode: 'latched', comment: 'Q10 queda enclavada con I1 y se libera con I2' }],
      states: [{ id: 'M1', type: 'latch', set: 'I1', reset: 'I2', comment: 'Memoria interna para enclavamiento de Q10' }],
    },
  },
  {
    id: 'ton',
    title: 'Timer TON (retardo a la conexión)',
    user: 'Cuando presione I1, espera 5 segundos y prende Q10.',
    logic: {
      name: 'Retardo de 5 s',
      logic_type: 'timed',
      outputs: [{ coil: 'Q10', expr: 'T1.DN', mode: 'timer_on_delay', comment: 'Q10 prende cuando el temporizador T1 termina' }],
      timers: [{ id: 'T1', type: 'TON', enable: 'I1', preset_ms: 5000, comment: 'Temporizador de retardo a la conexión activado por I1' }],
    },
  },
  {
    id: 'blinker',
    title: 'Parpadeo (oscilador)',
    user: 'Mientras I1 esté activo, Q12 debe parpadear cada segundo.',
    logic: {
      name: 'Parpadeo de Q12',
      logic_type: 'timed',
      outputs: [{ coil: 'Q12', expr: 'I1 * BLINK_1S', mode: 'blinker', comment: 'Q12 parpadea mientras I1 esté activo' }],
      timers: [{ id: 'BLINK_1S', type: 'OSCILLATOR', enable: 'I1', preset_ms: 1000, comment: 'Oscilador de 1 segundo para parpadeo' }],
    },
  },
];

export default LOGIC_EXAMPLES;
