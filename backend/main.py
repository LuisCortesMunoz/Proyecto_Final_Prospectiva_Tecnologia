"""
LadderVoice Copilot — Backend de la Practica 4 (Prompting y Copilotos con Ollama).

Arquitectura: Frontend (copilot.html) -> FastAPI (este archivo) -> Ollama /api/chat.

Perfiles de copiloto (niveles de esfuerzo, estilo ChatGPT):
  - generico:    asistente sin especializar (sirve de linea base para comparar)
  - instantanea: rapidez sobre profundidad, respuestas breves
  - media:       equilibrio entre rapidez y detalle, paso a paso
  - alta:        maximo razonamiento para tareas complejas (PLC, Ladder, codigo)

Ejecutar:
  uvicorn main:app --reload --port 8000
"""

import time
from typing import Dict, Optional

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_CHAT_URL = f"{OLLAMA_BASE_URL}/api/chat"
DEFAULT_MODEL = "llama3.2:3b"
REQUEST_TIMEOUT_S = 180

# ============================================================
# PERFILES DE COPILOTO
# Cada perfil define: etiqueta, descripcion, system_prompt y
# parametros de inferencia sugeridos (el frontend los aplica
# al seleccionar el perfil, pero siguen siendo editables).
# ============================================================
COPILOT_PROFILES: Dict[str, Dict] = {
    "generico": {
        "label": "Genérico",
        "description": "Asistente sin especializar. Úsalo como línea base para comparar contra los perfiles especializados.",
        "system_prompt": (
            "Eres un asistente académico claro, preciso y útil para estudiantes "
            "universitarios. Respondes siempre en español."
        ),
        "params": {
            "temperature": 0.7,
            "top_p": 0.9,
            "num_predict": 300,
            "num_ctx": 4096,
            "repeat_penalty": 1.1,
        },
    },
    "instantanea": {
        "label": "Instantánea",
        "description": "La opción más rápida. Para dudas sencillas, traducciones, correcciones y listas rápidas.",
        "system_prompt": (
            "Eres LadderVoice Copilot en modo Instantánea: un copiloto de automatización "
            "industrial y programación de PLCs en lenguaje Ladder para estudiantes "
            "universitarios. Tu prioridad es la rapidez.\n\n"
            "Reglas:\n"
            "- Responde en español, de forma breve y directa (idealmente 5 líneas o menos).\n"
            "- Usa listas cortas cuando mejoren la claridad.\n"
            "- Si la tarea es compleja (diseñar lógica Ladder completa, depurar código "
            "extenso), da solo la respuesta esencial y sugiere cambiar al modo Media o Alta.\n"
            "- Si falta información, haz una sola pregunta puntual en lugar de asumir.\n"
            "- No inventes referencias, datos técnicos ni normas.\n"
            "- Si no sabes algo, dilo explícitamente."
        ),
        "params": {
            "temperature": 0.4,
            "top_p": 0.9,
            "num_predict": 180,
            "num_ctx": 2048,
            "repeat_penalty": 1.1,
        },
    },
    "media": {
        "label": "Media",
        "description": "Punto intermedio. Explicaciones paso a paso, comparar opciones, errores sencillos de código.",
        "system_prompt": (
            "Eres LadderVoice Copilot en modo Media: un copiloto de automatización "
            "industrial y programación de PLCs en lenguaje Ladder para estudiantes "
            "universitarios. Buscas el equilibrio entre rapidez y profundidad.\n\n"
            "Tu tarea principal es ayudar con: explicaciones paso a paso, comparación de "
            "opciones, resumen de documentos, mejora de prompts, errores sencillos de "
            "código (Python, Flask, JavaScript) y lógica Ladder básica.\n\n"
            "Formato:\n"
            "- Responde en español con pasos numerados o secciones cortas.\n"
            "- Al explicar Ladder usa ejemplos con entradas (I0.x), salidas (Q0.x), "
            "marcas (M0.x) y timers (T0).\n\n"
            "Reglas:\n"
            "- Si falta información, pregunta antes de asumir.\n"
            "- No inventes referencias, datos técnicos ni normas.\n"
            "- Advierte riesgos eléctricos básicos cuando la pregunta involucre "
            "conexiones, motores o baterías.\n"
            "- Si no sabes algo, dilo explícitamente."
        ),
        "params": {
            "temperature": 0.7,
            "top_p": 0.9,
            "num_predict": 450,
            "num_ctx": 4096,
            "repeat_penalty": 1.1,
        },
    },
    "alta": {
        "label": "Alta",
        "description": "Máximo razonamiento. Problemas largos, programación y depuración, análisis de PLC/Ladder, decisiones con muchos pasos.",
        "system_prompt": (
            "Eres LadderVoice Copilot en modo Alta: un copiloto experto en automatización "
            "industrial, PLCs y lógica Ladder (contactos NO/NC, bobinas, set/reset, "
            "timers TON/TOF, contadores CTU/CTD, comparadores), comunicación Modbus TCP "
            "y desarrollo en Python (FastAPI, Flask) y JavaScript. Tu prioridad es la "
            "calidad del razonamiento sobre la velocidad.\n\n"
            "Método de trabajo:\n"
            "- Analiza el problema antes de responder y muestra tu razonamiento en pasos.\n"
            "- Separa explícitamente hechos, inferencias y recomendaciones.\n"
            "- Al depurar código: identifica la causa probable, la evidencia que la "
            "sustenta y la corrección propuesta con código comentado.\n\n"
            "Formato:\n"
            "- Responde en español. Para tareas complejas usa secciones tituladas: "
            "Análisis, Propuesta, Pasos, Riesgos.\n"
            "- Para lógica Ladder describe cada rung con sus elementos y direcciones "
            "(I0.x, Q0.x, M0.x, T0, C0).\n\n"
            "Reglas:\n"
            "- Si falta información crítica (modelo de PLC, voltaje, corriente, diagrama "
            "de conexión), pregunta primero antes de dar instrucciones específicas.\n"
            "- Advierte riesgos de seguridad eléctrica cuando aplique.\n"
            "- No inventes referencias, registros Modbus, datos de hardware ni normas.\n"
            "- Si no puedes verificar algo, dilo explícitamente."
        ),
        "params": {
            "temperature": 0.7,
            "top_p": 0.9,
            "num_predict": 900,
            "num_ctx": 8192,
            "repeat_penalty": 1.1,
        },
    },
}

DEFAULT_PROFILE = "media"


# ============================================================
# MODELOS Pydantic
# ============================================================
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    model: str = Field(default=DEFAULT_MODEL)
    copilot_profile: str = Field(default=DEFAULT_PROFILE)
    # Si llega vacio o None se usa la plantilla del perfil.
    system_prompt: Optional[str] = Field(default=None, max_length=6000)
    temperature: float = Field(default=0.7, ge=0.0, le=1.2)
    top_p: float = Field(default=0.9, ge=0.1, le=1.0)
    num_predict: int = Field(default=450, ge=20, le=1000)
    num_ctx: int = Field(default=4096, ge=512, le=8192)
    repeat_penalty: float = Field(default=1.1, ge=1.0, le=2.0)
    keep_alive: str = Field(default="5m")


class ChatMetrics(BaseModel):
    backend_ms: float
    total_duration_ms: Optional[float] = None
    load_duration_ms: Optional[float] = None
    prompt_eval_count: Optional[int] = None
    eval_count: Optional[int] = None
    eval_duration_ms: Optional[float] = None
    tokens_per_second: Optional[float] = None


class ChatResponse(BaseModel):
    model: str
    copilot_profile: str
    copilot_label: str
    system_prompt_used: str
    reply: str
    metrics: ChatMetrics


# ============================================================
# APP
# ============================================================
app = FastAPI(
    title="LadderVoice Copilot API",
    description="Practica 4 — copilotos especializados con perfiles de esfuerzo sobre Ollama.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_profile(profile_id: str) -> Dict:
    profile = COPILOT_PROFILES.get(profile_id)
    if profile is None:
        raise HTTPException(
            status_code=400,
            detail=f"Perfil no válido: '{profile_id}'. Opciones: {', '.join(COPILOT_PROFILES)}.",
        )
    return profile


def ns_to_ms(value) -> Optional[float]:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return round(value / 1_000_000, 1)


@app.get("/")
def root():
    return {
        "name": "LadderVoice Copilot API",
        "practica": 4,
        "endpoints": ["/health", "/profiles", "/chat (POST)", "/docs"],
    }


@app.get("/health")
def health():
    ollama_ok = False
    try:
        r = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        ollama_ok = r.ok
    except requests.exceptions.RequestException:
        ollama_ok = False
    return {"status": "ok", "ollama": ollama_ok}


@app.get("/profiles")
def profiles():
    return {
        "default": DEFAULT_PROFILE,
        "profiles": COPILOT_PROFILES,
    }


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    profile = get_profile(req.copilot_profile)

    system_prompt = (req.system_prompt or "").strip() or profile["system_prompt"]

    payload = {
        "model": req.model,
        "stream": False,
        "keep_alive": req.keep_alive,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.message},
        ],
        "options": {
            "temperature": req.temperature,
            "top_p": req.top_p,
            "num_predict": req.num_predict,
            "num_ctx": req.num_ctx,
            "repeat_penalty": req.repeat_penalty,
        },
    }

    start = time.perf_counter()
    try:
        response = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=REQUEST_TIMEOUT_S)
        response.raise_for_status()
    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=503,
            detail="No se pudo conectar con Ollama en localhost:11434. ¿Está corriendo 'ollama serve'?",
        )
    except requests.exceptions.Timeout:
        raise HTTPException(
            status_code=504,
            detail=f"Ollama tardó más de {REQUEST_TIMEOUT_S}s en responder. Prueba un modelo más pequeño o el perfil Instantánea.",
        )
    except requests.exceptions.HTTPError as exc:
        detail = f"Error de Ollama: {exc.response.status_code} — {exc.response.text[:300]}"
        raise HTTPException(status_code=500, detail=detail)

    backend_ms = round((time.perf_counter() - start) * 1000, 1)

    data = response.json()
    reply = (data.get("message") or {}).get("content", "").strip()
    if not reply:
        raise HTTPException(status_code=500, detail="Ollama respondió sin contenido.")

    eval_count = data.get("eval_count")
    eval_duration_ms = ns_to_ms(data.get("eval_duration"))
    tokens_per_second = None
    if eval_count and eval_duration_ms:
        tokens_per_second = round(eval_count / (eval_duration_ms / 1000), 1)

    return ChatResponse(
        model=data.get("model", req.model),
        copilot_profile=req.copilot_profile,
        copilot_label=profile["label"],
        system_prompt_used=system_prompt,
        reply=reply,
        metrics=ChatMetrics(
            backend_ms=backend_ms,
            total_duration_ms=ns_to_ms(data.get("total_duration")),
            load_duration_ms=ns_to_ms(data.get("load_duration")),
            prompt_eval_count=data.get("prompt_eval_count"),
            eval_count=eval_count,
            eval_duration_ms=eval_duration_ms,
            tokens_per_second=tokens_per_second,
        ),
    )
