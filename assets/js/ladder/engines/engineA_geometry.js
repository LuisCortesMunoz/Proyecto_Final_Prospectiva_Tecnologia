/**
 * engineA_geometry.js — MOTOR A (arquitectura actual).
 * La IA (backend en Render) genera el JSON con geometría directa; el front
 * solo lo renderiza. Envuelve lo que YA funciona, sin tocarlo.
 */
import { BACKEND_BASE_URL } from './config.js';

export default {
  id: 'A',
  label: 'Geometría IA',
  color: '#d98e2b',
  description: 'La IA genera el JSON con geometría directa (backend). Arquitectura actual.',

  async generate({ prompt, signal }) {
    const t0 = performance.now();
    const res = await fetch(`${BACKEND_BASE_URL}/generar-ladder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Mandamos varios nombres de campo por robustez ante el contrato exacto.
      body: JSON.stringify({ texto: prompt, mensaje: prompt, prompt }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status} en /generar-ladder`);

    const program = data?.ladder?.program || data?.program || data?.programa;
    if (!program) throw new Error('El backend respondió pero sin un programa Ladder válido.');

    const t1 = performance.now();
    const meta = data?.ladder || {};
    return {
      program,
      assistantText: meta.nombre
        ? `Programa "${meta.nombre}" — ${meta.rungs ?? program.rungs?.length} rungs, ${meta.variables ?? '—'} variables.`
        : 'Programa generado por el backend.',
      telemetry: {
        engine: 'A',
        endpoint: '/generar-ladder',
        latency_ms: Math.round(t1 - t0),
        rungs: program.rungs?.length ?? null,
        ramas_paralelas: meta.ramas_paralelas ?? null,
        es_enclavamiento: meta.es_enclavamiento ?? null,
      },
    };
  },
};
