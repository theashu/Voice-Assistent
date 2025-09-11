import json
import logging
import time
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ..providers.openai_relay import OpenAIProviderSession

router = APIRouter()
logger = logging.getLogger("ws_relay")

SESSIONS = {}

@router.websocket("/ws")
async def relay_ws(websocket: WebSocket):
    await websocket.accept()
    client_id = None
    provider = None

    async def handle_provider_event(payload, is_binary: bool):
        if is_binary:
            await websocket.send_bytes(payload)
        else:
            await websocket.send_text(json.dumps(payload))

    try:
        while True:
            data = await websocket.receive()
            if data.get("text"):
                obj = json.loads(data["text"])
                t = obj.get("type")

                if t == "init":
                    client_id = obj.get("sessionId") or f"c_{int(time.time()*1000)}"
                    chosen_language = obj.get("language", "English")

                    provider = OpenAIProviderSession(client_id, handle_provider_event)
                    await provider.connect()
                    SESSIONS[client_id] = provider

                    # Ack back to client
                    await websocket.send_text(json.dumps({
                        "type": "inited",
                        "sessionId": client_id,
                        "language": chosen_language
                    }))

                    # 🔹 Greeting message based on chosen language
                    greeting_map = {
                        "English": "Hi, good to see you, let's chat!",
                        "Hindi": "नमस्ते, आपसे मिलकर खुशी हुई, चलिए बात करते हैं!",
                        "Spanish": "¡Hola, qué bueno verte, vamos a charlar!",
                        "Bengali": "হাই, আপনাকে দেখে ভালো লাগলো, চলুন কথা বলি!"
                    }
                    greeting_text = greeting_map.get(chosen_language, "Hi, good to see you, let's chat!")
                    await provider.response_create(greeting_text)

                elif t == "ttstext":
                    await provider.response_create(obj.get("text", ""))

                elif t == "interruption":
                    await provider.cancel()

            elif data.get("bytes"):
                if provider:
                    await provider.send_audio_chunk(data["bytes"])

            elif data["type"] == "websocket.disconnect":
                break

    except WebSocketDisconnect:
        logger.info("client disconnected")
    finally:
        if provider:
            await provider.close()
        if client_id:
            SESSIONS.pop(client_id, None)