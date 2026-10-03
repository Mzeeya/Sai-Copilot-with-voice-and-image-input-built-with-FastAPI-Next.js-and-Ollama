from fastapi import APIRouter, UploadFile, File
from app.services.speech import transcribe_audio

router = APIRouter()

@router.post("/transcribe")
def transcribe(audio: UploadFile = File(...)):
    return {"text": transcribe_audio(audio.file.read())}