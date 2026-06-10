# LadderVoice Copilot — Backend (Práctica 4)

Adaptación de la **Práctica 4: Diseñar un copiloto especializado** (Prompting y Copilotos con Ollama)
al frontend de LadderVoice. El frontend es `copilot.html` (raíz del repositorio) con interfaz estilo
ChatGPT y un selector de **perfiles de esfuerzo**:

| Perfil | Para qué sirve | Parámetros sugeridos |
|---|---|---|
| **Instantánea** | Dudas sencillas, traducciones, listas rápidas | `temperature 0.4`, `num_predict 180`, `num_ctx 2048` |
| **Media** | Explicaciones paso a paso, comparar opciones, errores sencillos | `temperature 0.7`, `num_predict 450`, `num_ctx 4096` |
| **Alta** | Programación y depuración, lógica Ladder, análisis profundo | `temperature 0.7`, `num_predict 900`, `num_ctx 8192` |
| Genérico | Línea base sin especializar, para comparar | `temperature 0.7`, `num_predict 300` |

Cada perfil es una **instrucción de sistema** distinta (rol + contexto + reglas + límites + formato)
que el backend coloca en `messages[0]` al llamar a Ollama `/api/chat`. El system prompt es editable
desde el panel "Personalizar copiloto" del frontend.

## Requisitos

- [Ollama](https://ollama.com) instalado y un modelo descargado:
  ```bash
  ollama pull llama3.2:3b
  ```
- Python 3.10+

## Ejecución

### 1. Backend (esta carpeta)

```powershell
cd backend
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Verificación:
- http://localhost:8000/docs — documentación interactiva
- http://localhost:8000/profiles — perfiles disponibles
- http://localhost:8000/health — estado del backend y de Ollama

### 2. Frontend (raíz del repositorio)

```powershell
cd ..
python -m http.server 5500
```

Abrir **http://localhost:5500/copilot.html**

> Nota: si abres la página publicada en GitHub Pages (HTTPS), el navegador puede bloquear
> la conexión a `http://localhost:8000`. Para la práctica, sirve el frontend en local con
> `http.server` como se indica arriba.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Información de la API |
| GET | `/health` | Estado del backend y conexión con Ollama |
| GET | `/profiles` | Perfiles de copiloto (label, descripción, system prompt, parámetros) |
| POST | `/chat` | Envía `{message, model, copilot_profile, system_prompt, temperature, top_p, num_predict, num_ctx, repeat_penalty}` y devuelve `{reply, system_prompt_used, metrics}` |

Las métricas devueltas incluyen: latencia del backend, duración total de Ollama, carga del modelo,
tokens de entrada/salida y tokens por segundo. El frontend las muestra debajo de cada respuesta.

## Prueba guiada: genérico vs especializado

1. Selecciona el perfil **Genérico** y envía:
   *"Explícame qué es la odometría diferencial y dame un ejemplo para estudiantes de primer semestre."*
2. Cambia al perfil **Alta** y envía exactamente el mismo prompt.
3. Compara: claridad, uso de ejemplos, nivel adecuado, advertencias técnicas, formato y utilidad.

## Entregable: tabla de pruebas (mínimo 3 prompts por perfil)

| Perfil | Prompt | ¿Cumple rol? | ¿Cumple formato? | ¿Alucina? | Tokens salida | Latencia | Observación |
|---|---|---|---|---|---|---|---|
| Instantánea | | | | | | | |
| Instantánea | | | | | | | |
| Instantánea | | | | | | | |
| Media | | | | | | | |
| Media | | | | | | | |
| Media | | | | | | | |
| Alta | | | | | | | |
| Alta | | | | | | | |
| Alta | | | | | | | |

## Entregable: reflexión técnica

1. ¿Qué perfil fue más útil y por qué?
2. ¿Qué diferencias observaste entre el prompt genérico y el system prompt especializado?
3. ¿Qué instrucciones redujeron la ambigüedad?
4. ¿Qué instrucciones hicieron la respuesta demasiado rígida?
5. ¿El modelo inventó información? ¿En qué caso?
6. ¿Qué guardrails agregarías?
7. ¿Cómo conectarías este copiloto con documentos propios en un sistema RAG?
