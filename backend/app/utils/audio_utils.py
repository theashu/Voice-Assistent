import base64

def b64_encode_bytes(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")

def b64_decode_str(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))