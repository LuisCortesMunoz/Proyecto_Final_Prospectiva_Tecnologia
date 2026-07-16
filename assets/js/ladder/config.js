/**
 * config.js — Configuración compartida del front del editor ladder.
 *
 * URL única del backend (Render). El backend expone /generar-logica, que
 * recibe lenguaje natural y devuelve el JSON LÓGICO SIMPLE (contrato único,
 * ver CONTRACT.md). El front valida y compila ese JSON a la geometría que
 * entiende el renderer.
 */
export const BACKEND_BASE_URL = 'https://backend-render-prospectiva-tecnologia-8y7u.onrender.com';
