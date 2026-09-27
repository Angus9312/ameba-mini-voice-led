"""僅綁定 Mac loopback 的網站 + Whisper 本機辨識。錄音只存在記憶體。"""
from pathlib import Path
import argparse
import io
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
MAX_AUDIO_BYTES = 2_000_000
model = None
model_state = "loading"
model_error = ""
model_name = "small"
inference_lock = threading.Lock()


def load_model():
    global model, model_state, model_error
    try:
        from faster_whisper import WhisperModel
        cache = ROOT / ".models"
        cache.mkdir(exist_ok=True)
        options = dict(device="cpu", compute_type="int8", cpu_threads=4,
                       download_root=str(cache))
        try:
            model = WhisperModel(model_name, local_files_only=True, **options)
        except Exception:
            print("首次使用：下載本機語音模型，請等待。", flush=True)
            model = WhisperModel(model_name, **options)
        model_state = "ready"
        print("Whisper 模型就緒；錄音只在本機辨識。", flush=True)
    except Exception as exc:
        model_error = str(exc)
        model_state = "error"
        print(f"模型載入失敗：{exc}", flush=True)


def transcribe_audio(data):
    import numpy as np
    from faster_whisper.audio import decode_audio
    audio = decode_audio(io.BytesIO(data), sampling_rate=16000)
    duration = len(audio) / 16000
    if not 0.25 <= duration <= 12.5:
        raise ValueError("請錄製 0.25～12 秒的語音。")
    if not np.isfinite(audio).all():
        raise ValueError("錄音資料無效。")
    # 靜音不交給模型，避免短片段產生不可靠文字。
    if float(np.sqrt(np.mean(audio ** 2))) < 0.003:
        return {"text": "", "reliable": False, "reason": "沒有偵測到清楚語音"}
    segments, _ = model.transcribe(
        audio, language="zh", beam_size=5, temperature=0,
        condition_on_previous_text=False, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        no_speech_threshold=0.5, log_prob_threshold=-0.8,
    )
    segments = list(segments)
    text = "".join(segment.text for segment in segments).strip()
    reliable = bool(text and segments and all(
        segment.avg_logprob >= -0.8 and segment.no_speech_prob < 0.5
        and segment.compression_ratio < 2.4 for segment in segments))
    return {"text": text, "reliable": reliable,
            "reason": "" if reliable else "辨識不夠清楚，未執行控制"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
        super().end_headers()

    def valid_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.valid_host():
            return self.json_response(403, {"error": "僅允許本機存取"})
        path = urlsplit(self.path).path
        if path == "/api/health":
            return self.json_response(200, {"state": model_state, "model": model_name, "error": model_error})
        if path not in {"/", "/index.html", "/app.js", "/protocol.mjs", "/audio-worklet.js", "/style.css", "/favicon.svg"}:
            return self.json_response(404, {"error": "找不到頁面"})
        super().do_GET()

    def do_POST(self):
        origin = self.headers.get("Origin")
        if not self.valid_host() or origin not in {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}:
            return self.json_response(403, {"error": "請從本機控制網頁操作"})
        if self.path != "/api/transcribe":
            return self.json_response(404, {"error": "找不到服務"})
        if model_state != "ready":
            return self.json_response(503, {"error": "模型尚未就緒，請查看畫面上方狀態"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_AUDIO_BYTES:
            return self.json_response(413, {"error": "錄音太大或無內容"})
        if not inference_lock.acquire(blocking=False):
            return self.json_response(409, {"error": "正在辨識上一段語音，請稍候"})
        try:
            self.connection.settimeout(15)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("錄音傳輸不完整")
            result = transcribe_audio(data)
            self.json_response(200, result)
        except ValueError as exc:
            self.json_response(400, {"error": str(exc)})
        except Exception as exc:
            print(f"辨識錯誤：{exc}", flush=True)
            self.json_response(500, {"error": "本機辨識失敗，請重試或查看終端機"})
        finally:
            inference_lock.release()


def main():
    global model_name
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", choices=["tiny", "base", "small", "medium"], default="small")
    args = parser.parse_args()
    model_name = args.model
    # 所有下載快取均放在專案內，之後會優先離線載入。
    os.environ.setdefault("HF_HOME", str(ROOT / ".models" / "hf"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"控制台：http://127.0.0.1:{args.port}", flush=True)
    threading.Thread(target=load_model, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
