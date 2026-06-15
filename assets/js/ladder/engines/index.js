/**
 * index.js — Registro de motores de generación (arquitecturas A/B).
 * El panel de chat solo conoce esta interfaz; no sabe qué motor está activo.
 * Cada motor expone: { id, label, color, description, generate({prompt,profile,signal}) }
 * y devuelve { program, assistantText, telemetry }.
 */
import engineA from './engineA_geometry.js';
import engineB from './engineB_boolean.js';

export const ENGINES = { A: engineA, B: engineB };
export function getEngine(id) { return ENGINES[id] || engineA; }
