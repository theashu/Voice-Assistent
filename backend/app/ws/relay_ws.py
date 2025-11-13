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
        nonlocal is_generating, cancel_sent_for_current, last_audio_at
        if is_binary:
            if cancel_sent_for_current:
                return
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
                    if cancel_sent_for_current and t and t.startswith("response.output_"):
                        return
                    if t == "response.created":
                        is_generating = True
                        cancel_sent_for_current = False
                    elif t in ("response.done", "response.completed"):
                        is_generating = False
                        cancel_sent_for_current = False
                    elif t in ("response.canceled", "response.cancelled"):
                        is_generating = False
                        cancel_sent_for_current = False
                    elif t == "input_audio_buffer.speech_stopped":
                        # Commit immediately on provider's VAD speech stop for lower latency
                        if provider and not is_generating:
                            try:
                                await provider.commit()
                                await provider.response_create()
                            except Exception as e:
                                # Handle buffer too small errors gracefully
                                if "buffer too small" in str(e).lower() or "empty" in str(e).lower():
                                    logger.debug("Audio buffer too small for commit, skipping")
                                else:
                                    logger.error(f"Error during commit: {e}")
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
        IDLE_MS = 150 
        last_language_reinforcement = 0.0
        LANGUAGE_REINFORCEMENT_INTERVAL = 30000 
        min_buffer_time = 120
        
        while True:
            await asyncio.sleep(0.1)
            if not provider:
                continue
            
            current_time = time.time() * 1000
            
            # Periodic language reinforcement to prevent drift
            if current_time - last_language_reinforcement > LANGUAGE_REINFORCEMENT_INTERVAL:
                try:
                    # Send a silent language reinforcement
                    await provider.update_language(provider.language)
                    last_language_reinforcement = current_time
                except Exception:
                    pass
            
            # Only auto-commit when we're not currently generating output and enough time has passed
            if (not is_generating and last_audio_at and 
                (current_time - last_audio_at) > IDLE_MS and
                (current_time - last_audio_at) > min_buffer_time):
                try:
                    await provider.commit()
                    await provider.response_create()
                except Exception as e:
                    # Handle buffer too small errors gracefully
                    if "buffer too small" in str(e).lower() or "empty" in str(e).lower():
                        logger.debug("Audio buffer too small for auto-commit, skipping")
                    else:
                        logger.error(f"Error during auto-commit: {e}")
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
                    if not chosen_language or chosen_language.strip() == "":
                        chosen_language = "English"
                    chosen_voice = obj.get("voice", "alloy")
                    provider = OpenAIProviderSession(client_id, handle_provider_event, language=chosen_language, voice=chosen_voice)
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
                    # Only cancel if there's an active response
                    if provider and is_generating:
                        try:
                            await provider.cancel()
                            # Clear conversation context after interruption
                            await provider.clear_context()
                        except Exception as e:
                            # Handle "no active response" errors gracefully
                            if "not active" in str(e).lower() or "no active" in str(e).lower():
                                logger.debug("No active response to cancel")
                            else:
                                logger.error(f"Error during cancel: {e}")
                    # Ensure state resets so next speech can be processed immediately
                    is_generating = False
                    cancel_sent_for_current = True

                elif t == "input_audio_buffer.commit":
                    # Client indicates end of current utterance; forward commit to provider
                    if provider:
                        try:
                            await provider.commit()
                            # After committing, request a response based on latest input
                            await provider.response_create()
                        except Exception as e:
                            # Handle buffer too small errors gracefully
                            if "buffer too small" in str(e).lower() or "empty" in str(e).lower():
                                logger.debug("Audio buffer too small for manual commit, skipping")
                            else:
                                logger.error(f"Error during manual commit: {e}")

                elif t == "greeting":
                    # Optionally send an initial spoken greeting from the assistant
                    greet_lang = (obj.get("language") or "English").strip()
                    if greet_lang.lower().startswith("hin"):
                        text = "मैं एक दिव्य हिन्दू हूँ। मेरे पास चारों वेदों, गोत्रों और धर्म से संबंधित सम्पूर्ण ज्ञान है। आप जो भी जानना चाहते हैं — चाहे वह आपके गोत्र से जुड़ा हो, जीवन से, या आत्मा से — उसका उत्तर मेरे पास है। बताइए, आप क्या जानना चाहेंगे?"
                    else:
                        text = "I am a divine Hindu. I possess complete knowledge related to the four Vedas, gotras, and the principles of Dharma. Whatever you wish to know — whether it is about your gotra, your life, or your soul — I have the answers. Tell me, what would you like to know?"
                    if provider:
                        await provider.response_create(text)

                elif t == "language.update":
                    # Update the assistant's response language mid-session
                    new_lang = obj.get("language") or "English"
                    # Validate language input to prevent unknown language issues
                    if not new_lang or new_lang.strip() == "":
                        new_lang = "English"
                    
                    if provider:
                        await provider.update_language(new_lang)
                        await websocket.send_text(json.dumps({
                            "type": "language.updated",
                            "language": new_lang
                        }))
                        # Send a strong language enforcement message
                        if new_lang.lower().startswith("eng") or new_lang.lower() == "english":
                            greet_text = "Language switched to English. I will now respond ONLY in English. How can I help you?"
                        elif new_lang.lower().startswith("hin") or new_lang.lower() == "hindi":
                            greet_text = "भाषा अंग्रेजी से हिंदी में बदली गई है। अब मैं केवल हिंदी में जवाब दूंगी। मैं आपकी कैसे सहायता कर सकती हूं?"
                        else:
                            greet_text = f"Language switched to {new_lang}. I will respond only in {new_lang}. How can I help you?"
                        await provider.response_create(greet_text)

                elif t == "voice.update":
                    # Update the assistant's voice mid-session
                    new_voice = obj.get("voice") or "alloy"
                    if provider:
                        await provider.update_voice(new_voice)
                        await websocket.send_text(json.dumps({
                            "type": "voice.updated",
                            "voice": new_voice
                        }))

            elif data.get("bytes"):
                if provider:
                    # If the model is currently speaking, send one cancel to enable barge-in
                    if is_generating and not cancel_sent_for_current:
                        try:
                            await provider.cancel()
                            # Clear context when user interrupts with new audio
                            await provider.clear_context()
                            logger.debug("Cancelled active response for barge-in and cleared context")
                        except Exception as e:
                            # Handle "no active response" errors gracefully
                            if "not active" in str(e).lower() or "no active" in str(e).lower():
                                logger.debug("No active response to cancel during barge-in")
                            else:
                                logger.error(f"Error during barge-in cancel: {e}")
                        cancel_sent_for_current = True
                    
                    # Send audio chunk and update timestamp
                    audio_size = len(data["bytes"])
                    logger.debug(f"Received audio chunk: {audio_size} bytes")
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
