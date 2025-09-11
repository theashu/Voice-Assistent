from fastapi import FastAPI
from .ws.relay_ws import router as ws_router

app = FastAPI(title="Voice Assistant Relay")
app.include_router(ws_router)

@app.get("/health")
async def health():
    return {"ok": True}