/**
 * engineB_boolean.js — MOTOR B (arquitectura nueva).
 * La IA emite LÓGICA (ecuaciones/patrones) y el FRONT la compila a geometría
 * con compileLogicToSchema(). Si el backend /generar-logica aún no existe,
 * cae a un modo LOCAL donde el usuario escribe ecuaciones directamente — así
 * el compilador es probable sin depender del backend.
 */
import { BACKEND_BASE_URL } from './config.js';
import { compileLogicToSchema } from '../compiler/logicToSchema.js';

// Fallback local: interpreta el texto como ecuaciones (una por línea).
function parseDirectEquations(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  const rungs = [];
  let name = 'Programa (ecuaciones)';
  for (const line of lines) {
    const nm = line.match(/^name\s*:\s*(.+)$/i);
    if (nm) { name = nm[1].trim(); continue; }
    const m = line.match(/^([A-Za-z_%][\w.%]*)\s*=\s*(.+)$/);
    if (m) rungs.push({ coil: m[1], expr: m[2] });
  }
  return { rungs, name, _direct: true };
}

export default {
  id: 'B',
  label: 'Lógica booleana',
  color: '#4d9ef7',
  description: 'La IA emite lógica (ecuaciones/patrones); el front la compila a geometría.',

  async generate({ prompt, profile, signal }) {
    const t0 = performance.now();
    let logic = null;
    let source = 'backend';

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/generar-logica`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: prompt, prompt, profile_id: profile?.id || null }),
        signal,
      });
      if (!res.ok) throw new Error('endpoint-no-disponible');
      const data = await res.json();
      logic = data?.logic || data;
      if (!logic || !Array.isArray(logic.rungs)) throw new Error('respuesta-sin-logica');
    } catch {
      // El backend de lógica aún no está → compilamos las ecuaciones del usuario.
      logic = parseDirectEquations(prompt);
      source = 'local-equations';
      if (!logic.rungs.length) {
        throw new Error('Motor B (modo local): escribe ecuaciones, una por línea. Ej: Q10 = (I1 + Q10) * !I2');
      }
    }

    const { program, warnings } = compileLogicToSchema(logic, profile);
    const t1 = performance.now();
    return {
      program,
      assistantText: source === 'local-equations'
        ? `Compilé ${logic.rungs.length} ecuación(es) localmente (backend /generar-logica aún no disponible).`
        : `Lógica recibida del backend y compilada (${program.rungs.length} rungs).`,
      telemetry: {
        engine: 'B',
        source,
        latency_ms: Math.round(t1 - t0),
        rungs: program.rungs.length,
        compiler_warnings: warnings.length,
      },
    };
  },
};
