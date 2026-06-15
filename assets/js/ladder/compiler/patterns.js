/**
 * patterns.js — Patrones secuenciales para la arquitectura B.
 *
 * La IA elige un patrón + parámetros; el compilador lo expande a rungs.
 * La IA nunca cablea timers ni toca columnas.
 *
 * Estado del esqueleto:
 *   - latch   : ✅ enclavamiento (azúcar sobre una ecuación booleana).
 *   - blinker : ⛔ pendiente. El schema actual NO modela el bit ".done" del
 *               timer como contacto direccionable, así que un oscilador
 *               correcto (TON↔TON) requiere extender schema.js primero.
 *               Se deja fuera a propósito para no emitir geometría incorrecta.
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
