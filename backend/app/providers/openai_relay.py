import aiohttp
import asyncio
import json
import logging
from aiohttp import WSMsgType
from ..config import settings
from ..utils.audio_utils import b64_encode_bytes

logger = logging.getLogger("openai_relay")

OPENAI_WS_URL = settings.OPENAI_API_HOST.replace("https://","wss://") + f"/v1/realtime?model={settings.OPENAI_MODEL}"

class OpenAIProviderSession:
    def __init__(self, session_id: str, on_event, language: str = "English", voice: str = "alloy"):
        self.session_id = session_id
        self.on_event = on_event
        self.language = language or "English"
        self.voice = voice or "nova" 
        self._session = None
        self._ws = None
        self._reader_task = None

    async def connect(self):
        headers = {"Authorization": f"Bearer {settings.OPENAI_API_KEY}"}
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(OPENAI_WS_URL, headers=headers)
        self._reader_task = asyncio.create_task(self._reader_loop())

        init_msg = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": f"CRITICAL: You are a voice assistant that MUST respond ONLY in {self.language}. This is a hard requirement that cannot be violated. Never respond in any other language, even if the user speaks in a different language. If the user speaks in another language, acknowledge it briefly but immediately continue responding in {self.language}. Your primary language is {self.language} and you must maintain this consistently throughout the entire conversation. Use voice: {self.voice} for all responses."
            }
        }
        await self._ws.send_str(json.dumps(init_msg))

    async def _reader_loop(self):
        async for msg in self._ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except:
                    payload = {"type":"raw.text","data":msg.data}
                await self.on_event(payload, is_binary=False)
            elif msg.type == WSMsgType.BINARY:
                await self.on_event(msg.data, is_binary=True)

    async def send_audio_chunk(self, chunk: bytes):
        payload = {"type": "input_audio_buffer.append", "audio": b64_encode_bytes(chunk)}
        await self._ws.send_str(json.dumps(payload))

    async def commit(self):
        await self._ws.send_str(json.dumps({"type": "input_audio_buffer.commit"}))

    async def response_create(self, text: str | None = None):
        # If text is provided, send as instructions; otherwise trigger generation from latest input buffer
        response_obj = {}
        if text:
            response_obj["instructions"] = f"{text} Remember: You MUST respond ONLY in {self.language}. Never use any other language. Focus only on what the user is asking about now, not previous topics."
        else:
            response_obj["instructions"] = f"Respond to the user's current input in {self.language} only. This is a critical requirement - never respond in any other language. Focus on the current topic the user is asking about, not previous conversation topics."
        msg = {"type": "response.create", "response": response_obj}
        await self._ws.send_str(json.dumps(msg))

    async def cancel(self):
        await self._ws.send_str(json.dumps({"type":"response.cancel"}))

    async def close(self):
        if self._ws:
            await self._ws.close()
        if self._session:
            await self._session.close()


    async def update_language(self, language: str):
        self.language = language or self.language or "English"
        msg = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": f"CRITICAL: You are a voice assistant that MUST respond ONLY in {self.language}. This is a hard requirement that cannot be violated. Never respond in any other language, even if the user speaks in a different language. If the user speaks in another language, acknowledge it briefly but immediately continue responding in {self.language}. Your primary language is {self.language} and you must maintain this consistently throughout the entire conversation. Use voice: {self.voice} for all responses."
            }
        }
        await self._ws.send_str(json.dumps(msg))

    async def update_voice(self, voice: str):
        self.voice = voice or self.voice or "alloy"
        msg = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": f"CRITICAL: You are a voice assistant that MUST respond ONLY in {self.language}. This is a hard requirement that cannot be violated. Never respond in any other language, even if the user speaks in a different language. If the user speaks in another language, acknowledge it briefly but immediately continue responding in {self.language}. Your primary language is {self.language} and you must maintain this consistently throughout the entire conversation. Use voice: {self.voice} for all responses."
            }
        }
        await self._ws.send_str(json.dumps(msg))

    async def clear_context(self):
        """Clear conversation context to start fresh after interruption"""
        try:
            # Send a clear conversation message
            clear_msg = {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "system",
                    "content": "Conversation context cleared. User has interrupted and wants to discuss a new topic."
                }
            }
            await self._ws.send_str(json.dumps(clear_msg))
            
            # Also send a session update to reinforce fresh start
            session_msg = {
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": f"CRITICAL: You are a voice assistant that MUST respond ONLY in {self.language}. This is a hard requirement that cannot be violated. Never respond in any other language, even if the user speaks in a different language. If the user speaks in another language, acknowledge it briefly but immediately continue responding in {self.language}. Your primary language is {self.language} and you must maintain this consistently throughout the entire conversation. Use voice: {self.voice} for all responses. IMPORTANT: When the user interrupts and starts a new topic, completely forget the previous conversation and focus only on the new topic."
                }
            }
            await self._ws.send_str(json.dumps(session_msg))
            
            logger.debug("Conversation context cleared after interruption")
        except Exception as e:
            logger.error(f"Failed to clear context: {e}")
            