# backend/app/config.py
import os
from dotenv import load_dotenv

# load .env file automatically
load_dotenv()

class Settings:
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
    OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-realtime-preview")
    OPENAI_API_HOST = os.environ.get("OPENAI_API_HOST", "https://api.openai.com")
    HOST = os.environ.get("HOST", "0.0.0.0")
    PORT = int(os.environ.get("PORT", 8080))
    LOG_LEVEL = os.environ.get("LOG_LEVEL", "info")

settings = Settings()