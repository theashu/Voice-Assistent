import json
import logging
import time
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ..providers.openai_relay import OpenAIProviderSession
from ..utils.audio_utils import b64_decode_str

router = APIRouter()
logger = logging.getLogger("ws_relay")

SESSIONS = {}

@router.websocket("/ws")
async def relay_ws(websocket: WebSocket):
    await websocket.accept()
    client_id = None
    provider = None
    last_audio_at = 0.0
    idle_commit_task = None
    is_generating = False
    cancel_sent_for_current = False
    async def handle_provider_event(payload, is_binary: bool):
        if is_binary:
            await websocket.send_bytes(payload)
        else:
            try:
                # If this is an audio delta event with base64 payload, send as binary to client
                if isinstance(payload, dict) and payload.get("type") == "response.output_audio.delta":
                    b64 = payload.get("delta")
                    if b64:
                        await websocket.send_bytes(b64_decode_str(b64))
                        return
                # Track generation state to coordinate barge-in
                if isinstance(payload, dict):
                    t = payload.get("type")
                    if t == "response.created":
                        is_generating = True
                        cancel_sent_for_current = False
                    elif t in ("response.done", "response.completed"):
                        is_generating = False
                        cancel_sent_for_current = False
                    elif t == "input_audio_buffer.speech_stopped":
                        # Commit immediately on provider's VAD speech stop for lower latency
                        if provider and not is_generating:
                            try:
                                await provider.commit()
                                await provider.response_create()
                            except Exception:
                                pass
                            finally:
                                last_audio_at = 0.0
                    elif t == "response.error" or t == "error":
                        # On errors, reset state to allow next turn
                        is_generating = False
                        cancel_sent_for_current = False
            except Exception:
                pass
            await websocket.send_text(json.dumps(payload))
    async def idle_commit_loop():
        nonlocal last_audio_at, provider, is_generating
        IDLE_MS = 300
        while True:
            await asyncio.sleep(0.1)
            if not provider:
                continue
            # Only auto-commit when we're not currently generating output
            if not is_generating and last_audio_at and (time.time() * 1000 - last_audio_at) > IDLE_MS:
                try:
                    await provider.commit()
                    await provider.response_create()
                except Exception:
                    pass
                finally:
                    last_audio_at = 0.0

    try:
        while True:
            data = await websocket.receive()
            if data.get("text"):
                obj = json.loads(data["text"])
                t = obj.get("type")
                if t == "init":
                    client_id = obj.get("sessionId") or f"c_{int(time.time()*1000)}"
                    chosen_language = obj.get("language", "English")
                    provider = OpenAIProviderSession(client_id, handle_provider_event, language=chosen_language)
                    await provider.connect()
                    SESSIONS[client_id] = provider
                    if not idle_commit_task:
                        idle_commit_task = asyncio.create_task(idle_commit_loop())
                    await websocket.send_text(json.dumps({
                        "type": "inited",
                        "sessionId": client_id,
                        "language": chosen_language
                    }))

                elif t == "ttstext":
                    await provider.response_create(obj.get("text", ""))

                elif t == "interruption":
                    await provider.cancel()
                    # Ensure state resets so next speech can be processed immediately
                    is_generating = False
                    cancel_sent_for_current = True

                elif t == "input_audio_buffer.commit":
                    # Client indicates end of current utterance; forward commit to provider
                    if provider:
                        await provider.commit()
                        # After committing, request a response based on latest input
                        await provider.response_create()

                elif t == "greeting":
                    # Optionally send an initial spoken greeting from the assistant
                    greet_lang = obj.get("language") or "English"
                    text = f"Hello! Let's chat in {greet_lang}. How can I help you today?"
                    if provider:
                        await provider.response_create(text)

                elif t == "language.update":
                    # Update the assistant's response language mid-session
                    new_lang = obj.get("language") or "English"
                    if provider:
                        await provider.update_language(new_lang)
                        await websocket.send_text(json.dumps({
                            "type": "language.updated",
                            "language": new_lang
                        }))

            elif data.get("bytes"):
                if provider:
                    # If the model is currently speaking, send one cancel to enable barge-in
                    if is_generating and not cancel_sent_for_current:
                        try:
                            await provider.cancel()
                        except Exception:
                            pass
                        cancel_sent_for_current = True
                    await provider.send_audio_chunk(data["bytes"])
                    last_audio_at = time.time() * 1000

            elif data["type"] == "websocket.disconnect":
                break

    except WebSocketDisconnect:
        logger.info("client disconnected")
    finally:
        if provider:
            await provider.close()
        if idle_commit_task:
            try:
                idle_commit_task.cancel()
            except Exception:
                pass
        if client_id:
            SESSIONS.pop(client_id, None)
