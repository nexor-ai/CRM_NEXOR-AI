#!/usr/bin/env python3
"""Separate bounded transcription worker. Does not load Whisper until a job is claimed."""
from __future__ import annotations
import argparse, json, os, tempfile, time, urllib.error, urllib.parse, urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

class Adapter(Protocol):
    name: str
    def transcribe(self, media: Path) -> tuple[str, str | None, dict]: ...

class FasterWhisperAdapter:
    name = "faster-whisper/cpu-int8"
    def __init__(self, model: str = "small") -> None:
        from faster_whisper import WhisperModel  # lazy: tests/fake never load model
        self.model = WhisperModel(model, device="cpu", compute_type="int8")
    def transcribe(self, media: Path) -> tuple[str, str | None, dict]:
        segments, info = self.model.transcribe(str(media), vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return text, getattr(info, "language", None), {"language_probability": getattr(info, "language_probability", None)}

class FakeAdapter:
    name = "fake"
    def transcribe(self, media: Path) -> tuple[str, str | None, dict]:
        return f"Transcrição fake ({media.stat().st_size} bytes)", "pt", {"fake": True}

@dataclass(frozen=True)
class Settings:
    url: str
    key: str
    limit: int = 1

def _request(settings: Settings, path: str, payload: dict | None = None, method: str = "POST") -> object:
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(settings.url.rstrip("/") + path, data=body, method=method,
        headers={"apikey": settings.key, "Authorization": f"Bearer {settings.key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

def claim(settings: Settings) -> list[dict]:
    result = _request(settings, "/rest/v1/rpc/claim_transcription_jobs", {"p_worker_limit": settings.limit})
    return result if isinstance(result, list) else []

def download(settings: Settings, storage_key: str, output: Path) -> None:
    safe = "/".join(urllib.parse.quote(part, safe="") for part in storage_key.lstrip("/").split("/"))
    req = urllib.request.Request(settings.url.rstrip("/") + "/storage/v1/object/chat-media/" + safe,
        headers={"apikey": settings.key, "Authorization": f"Bearer {settings.key}"})
    with urllib.request.urlopen(req, timeout=120) as response: output.write_bytes(response.read())

def sanitize(error: Exception) -> str:
    text = str(error).replace(os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "__unset__"), "[redacted]")
    return text[:240]

def process_job(settings: Settings, adapter: Adapter, job: dict) -> None:
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="nexor-transcription-") as folder:
            media = Path(folder) / "audio"
            download(settings, str(job["storage_key"]), media)
            transcript, language, enrichment = adapter.transcribe(media)
        _request(settings, "/rest/v1/rpc/finish_transcription_job", {
            "p_job_id": job["id"], "p_lease_token": job["lease_token"], "p_transcript": transcript,
            "p_language": language, "p_model_name": adapter.name,
            "p_processing_ms": int((time.monotonic()-started)*1000), "p_enrichment": enrichment,
        })
    except Exception as error:
        _request(settings, "/rest/v1/rpc/fail_transcription_job", {"p_job_id": job["id"], "p_lease_token": job["lease_token"], "p_error_code": type(error).__name__[:80], "p_error_message": sanitize(error)})

def main() -> int:
    parser=argparse.ArgumentParser(description="Worker assíncrono de transcrição NEXOR")
    parser.add_argument("--adapter", choices=("faster-whisper","fake"), default="faster-whisper")
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL","small")); parser.add_argument("--limit",type=int,default=1); parser.add_argument("--once",action="store_true")
    args=parser.parse_args(); url=os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL"); key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key: parser.error("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios")
    settings=Settings(url,key,max(1,min(args.limit,5))); adapter:Adapter=FakeAdapter() if args.adapter=="fake" else FasterWhisperAdapter(args.model)
    while True:
        jobs=claim(settings)
        for job in jobs: process_job(settings,adapter,job)
        if args.once:return 0
        if not jobs:time.sleep(5)
if __name__=="__main__": raise SystemExit(main())
