/**
 * patterns.js — Helpers de patrones secuenciales reutilizables por el compilador.
 *
 * El compilador (logicToSchema.js) expande las secciones del JSON lógico simple
 * a rungs. `latch` da el sello (auto-retención) usado por states[].type='latch'.
 * El parpadeo se modela vía timers[].type='OSCILLATOR' (bloque OSC) + el bit
 * del oscilador como contacto en la expr de la salida, no aquí.
 */
export const patterns = {
  // { pattern:'latch', coil:'Q10', start:'I1', stop:'I2' | stops:['I2','I8'] }
  latch(spec, ctx, helpers) {
    const stops = spec.stops || (spec.stop ? [spec.stop] : []);
    const stopExpr = stops.map(s => '!' + s).join(' * ');
    const expr = `(${spec.start} + ${spec.coil})${stopExpr ? ' * ' + stopExpr : ''}`;
    return helpers.compileEquation(
      { coil: spec.coil, expr, comment: spec.comment || `Enclavamiento ${spec.coil}` },
      helpers.mkRungId() - 1,
      ctx,
    );
  },
};
