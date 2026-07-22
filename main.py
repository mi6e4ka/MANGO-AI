import base64
import io
import os
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
import torch
from transformers import CLIPProcessor, CLIPModel

# Try to import YOLO; if not available we still define the endpoint but runtime will fail gracefully.
try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional dependency guard
    YOLO = None  # type: ignore[misc,assignment]

from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DETECTION_CONFIDENCE = 0.30
REID_THRESHOLD = 0.88

device = "cuda" if torch.cuda.is_available() else "cpu"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global mongo_client, db
    mongo_client = AsyncIOMotorClient(MONGO_URI)
    db = mongo_client["mango"]
    await db.mangoes.create_index("mango_id", unique=True)
    state = request.app.state
    if not getattr(state, "_models_loaded", False):
        state.detector = YOLO("best.pt").to(device)
        state.clip_model = CLIPModel.from_pretrained(
            "openai/clip-vit-base-patch32",
            local_files_only=True,
        ).to(device)
        state.clip_processor = CLIPProcessor.from_pretrained(
            "openai/clip-vit-base-patch32",
            local_files_only=True,
        )
        state._models_loaded = True
    yield
    mongo_client.close()


app = FastAPI(title="Mango Custom YOLO & Re-ID API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*", "X-Telegram-Id", "X-Telegram-Username"],
)


def to_native(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {k: to_native(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_native(v) for v in value]
    return value


def get_cosine_similarity(v1, v2):
    return float(np.dot(v1, v2))


def encode_image_b64(image: Image.Image, quality: int = 85, max_size: int = 1024) -> str:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _id_str(value):
    if hasattr(value, "hex"):
        return value.hex
    if isinstance(value, str) and value:
        return value
    return ""


def serialize_doc(doc) -> dict:
    if doc is None:
        return None
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def _det_photo_id(det: dict) -> str:
    pid = det.get("photo_id")
    if isinstance(pid, str) and pid:
        return pid
    _id = det.get("_id")
    if _id is not None:
        return _id_str(_id)
    return ""


def summarize_mango_doc(doc, telegram_id: str | None = None) -> dict:
    doc = serialize_doc(doc)
    detections = doc.get("detections", []) or []
    latest_detection = detections[-1] if detections else {}
    is_mine = bool(
        telegram_id
        and any(str(detection.get("telegram_id")) == str(telegram_id) for detection in detections)
    )

    return {
        "mango_id": doc.get("mango_id"),
        "first_seen": doc.get("first_seen"),
        "last_seen": latest_detection.get("created_at") or doc.get("first_seen"),
        "detections_count": len(detections),
        "is_mine": is_mine,
        "found_by": latest_detection.get("username") or latest_detection.get("telegram_id"),
        "photo_id": _det_photo_id(latest_detection),
    }


@app.post("/api/analyze-mango")
async def analyze_mango(
    request: Request,
    file: UploadFile = File(...),
    x_telegram_id: str | None = Header(default=None, alias="X-Telegram-Id"),
    x_telegram_username: str | None = Header(default=None, alias="X-Telegram-Username"),
):
    state = request.app.state

    detector = state.detector
    clip_model = state.clip_model
    clip_processor = state.clip_processor

    try:
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image file")

    results = detector(image, conf=DETECTION_CONFIDENCE, verbose=False)
    boxes = results[0].boxes

    if len(boxes) == 0:
        return {"is_mango": False, "message": "No mango detected in the photo."}

    best_box = boxes[0]
    conf = float(best_box.conf[0].cpu().item())
    img_w, img_h = image.size
    xyxy = best_box.xyxy[0].cpu().numpy().astype(float)
    bbox = [float(xyxy[0] / img_w), float(xyxy[1] / img_h),
            float(xyxy[2] / img_w), float(xyxy[3] / img_h)]

    cropped_mango = image.crop((xyxy[0], xyxy[1], xyxy[2], xyxy[3]))

    inputs = clip_processor(images=cropped_mango, return_tensors="pt").to(device)
    with torch.no_grad():
        image_features = clip_model.get_image_features(**inputs).pooler_output.cpu().numpy()[0]
    image_features = image_features / np.linalg.norm(image_features)
    embedding_list = image_features.tolist()

    photo_b64 = encode_image_b64(image)
    photo_id = str(uuid.uuid4())

    matched_id = None
    max_similarity = -1.0

    cursor = db.mangoes.find({}, {"mango_id": 1, "embedding": 1})
    async for doc in cursor:
        stored_emb = np.array(doc["embedding"])
        sim = get_cosine_similarity(image_features, stored_emb)
        if sim > max_similarity:
            max_similarity = sim
            matched_id = doc["mango_id"]

    now = datetime.now(timezone.utc).isoformat()

    detection = to_native({
        "photo_id": photo_id,
        "photo_b64": photo_b64,
        "bbox": bbox,
        "detection_confidence": conf,
        "similarity_score": float(max_similarity),
        "created_at": now,
        "telegram_id": x_telegram_id,
        "username": x_telegram_username,
    })

    if max_similarity >= REID_THRESHOLD:
        await db.mangoes.update_one(
            {"mango_id": matched_id},
            {"$push": {"detections": detection}},
        )
        return {
            "is_mango": True,
            "is_unique": False,
            "mango_id": matched_id,
            "detection_confidence": conf,
            "similarity_score": float(max_similarity),
            "bbox": bbox,
        }
    else:
        new_id = str(uuid.uuid4())
        await db.mangoes.insert_one({
            "mango_id": new_id,
            "embedding": to_native(embedding_list),
            "first_seen": now,
            "detections": [detection],
        })
        return {
            "is_mango": True,
            "is_unique": True,
            "mango_id": new_id,
            "detection_confidence": conf,
            "similarity_score": float(max_similarity),
            "bbox": bbox,
        }


@app.get("/api/mango/{mango_id}")
async def get_mango(
    mango_id: str,
    x_telegram_id: str | None = Header(default=None, alias="X-Telegram-Id")
):
    doc = await db.mangoes.find_one({"mango_id": mango_id})
    if doc is None:
        raise HTTPException(status_code=404, detail="Mango not found")

    result = serialize_doc(doc)
    detections = result.get("detections", []) or []
    result["detections_count"] = len(detections)
    result["is_mine"] = bool(
        x_telegram_id
        and any(str(detection.get("telegram_id")) == str(x_telegram_id) for detection in detections)
    )
    latest = detections[-1] if detections else None
    result["latest_detection"] = latest
    result["photo_id"] = _det_photo_id(latest) if latest else ""
    for det in detections:
        det["photo_id"] = _det_photo_id(det)
    return result


@app.get("/api/mangoes")
async def list_mangoes(x_telegram_id: str | None = Header(default=None, alias="X-Telegram-Id")):
    items = []
    cursor = db.mangoes.find({}).sort("first_seen", -1)
    async for doc in cursor:
        items.append(summarize_mango_doc(doc, x_telegram_id))
    return items


@app.get("/api/image/{mango_id}/{photo_id}")
async def get_image(mango_id: str, photo_id: str):
    doc = await db.mangoes.find_one({"mango_id": mango_id}, {"detections": 1})
    if doc is None:
        raise HTTPException(status_code=404, detail="Mango not found")
    detections = doc.get("detections", []) or []

    def _id_str_local(det):
        raw = det.get("_id")
        if raw is None:
            return ""
        if hasattr(raw, "hex"):
            return raw.hex()
        return str(raw)

    det = next(
        (d for d in detections if d.get("photo_id") == photo_id or _id_str_local(d) == photo_id),
        None,
    )
    if det is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    b64 = det.get("photo_b64", "")
    if not b64:
        raise HTTPException(status_code=404, detail="No image data")
    raw = base64.b64decode(b64)
    return Response(content=raw, media_type="image/jpeg")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/preload")
async def preload_models(request: Request):
    """Тяжёлые модели загружаются здесь, а не в lifespan."""
    state = request.app.state
    if not getattr(state, "_models_loaded", False):
        state.detector = YOLO("best.pt").to(device)
        state.clip_model = CLIPModel.from_pretrained(
            "openai/clip-vit-base-patch32",
            local_files_only=True,
        ).to(device)
        state.clip_processor = CLIPProcessor.from_pretrained(
            "openai/clip-vit-base-patch32",
            local_files_only=True,
        )
        state._models_loaded = True
    return {"status": "models ready"}
