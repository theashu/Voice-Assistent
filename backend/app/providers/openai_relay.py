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
    def __init__(self, session_id: str, on_event):
        self.session_id = session_id
        self.on_event = on_event
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
                "audio": {"voice": "alloy", "format": "wav", "sample_rate": 16000},
                "conversation": {"memory": "ephemeral"}
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

    async def response_create(self, text: str):
        msg = {"type":"response.create","response":{"instructions":text,}}
        await self._ws.send_str(json.dumps(msg))

    async def cancel(self):
        await self._ws.send_str(json.dumps({"type":"response.cancel"}))

    async def close(self):
        if self._ws:
            await self._ws.close()
        if self._session:
            await self._session.close()