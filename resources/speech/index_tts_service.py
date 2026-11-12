import argparse
import gc
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


MAXIMUM_REQUEST_BYTES = 64 * 1024
MODEL_DIRECTORY = "IndexTTS-2"
SUPPORTED_LANGUAGES = ["Auto", "Chinese", "English"]


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class ModelRegistry:
    def __init__(self, model_root):
        self.model_root = Path(model_root)
        self.model = None
        self.mode = None
        self.torch = None
        self.lock = threading.RLock()

    def capabilities(self, mode):
        self.validate_mode(mode)
        with self.lock:
            self.load_locked(mode)
            return {"speakers": [], "languages": list(SUPPORTED_LANGUAGES)}

    def generate(self, payload):
        mode = self.validate_generate_payload(payload)
        with self.lock:
            model = self.load_locked(mode)
            instruct = payload.get("instruct", "") if mode == "custom" else ""
            descriptor, output_path = tempfile.mkstemp(suffix=".wav")
            os.close(descriptor)
            Path(output_path).unlink()
            try:
                model.infer(
                    spk_audio_prompt=payload["ref_audio"],
                    text=payload["text"],
                    output_path=output_path,
                    use_emo_text=bool(instruct.strip()),
                    emo_text=instruct.strip() or None,
                    use_random=False,
                    verbose=False,
                )
                output = Path(output_path)
                if not output.is_file() or output.stat().st_size == 0:
                    raise RuntimeError("IndexTTS2 did not produce an audio file")
                return output.read_bytes()
            finally:
                Path(output_path).unlink(missing_ok=True)

    def close(self):
        with self.lock:
            self.release_locked()

    @staticmethod
    def validate_mode(mode):
        if mode not in {"custom", "clone"}:
            raise RequestError(400, "voiceMode must be custom or clone")

    @staticmethod
    def validate_generate_payload(payload):
        if not isinstance(payload, dict):
            raise RequestError(400, "The JSON body must be an object")
        mode = payload.get("voice_mode")
        ModelRegistry.validate_mode(mode)
        common_fields = {"voice_mode", "text", "language", "ref_audio"}
        mode_fields = {"instruct"} if mode == "custom" else set()
        if payload.get("ref_audio") is None:
            raise RequestError(400, "ref_audio is required")
        if set(payload) != common_fields | mode_fields:
            raise RequestError(400, "The request contains missing or unsupported fields")
        for field in ("text", "language"):
            if not isinstance(payload.get(field), str) or not payload[field].strip():
                raise RequestError(400, f"{field} must be a non-empty string")
        reference_audio = payload.get("ref_audio")
        if not isinstance(reference_audio, str) or not Path(reference_audio).is_absolute():
            raise RequestError(400, "ref_audio must be an absolute local path")
        if not Path(reference_audio).is_file():
            raise RequestError(400, "ref_audio must name an existing audio file")
        if mode == "custom" and not isinstance(payload.get("instruct"), str):
            raise RequestError(400, "instruct must be a string")
        return mode

    def load_locked(self, mode):
        if self.model is not None and self.mode == mode:
            return self.model
        if self.model is not None:
            # Both UI modes use the same model and can share the loaded instance.
            self.mode = mode
            return self.model
        self.release_locked()
        try:
            self.ensure_huggingface_references()
            import torch
            from indextts.infer_v2 import IndexTTS2

            model_path = self.model_root / MODEL_DIRECTORY
            config_path = model_path / "config.yaml"
            if not model_path.is_dir() or not config_path.is_file():
                raise FileNotFoundError("The IndexTTS2 model is not installed")
            self.torch = torch
            self.model = IndexTTS2(
                cfg_path=str(config_path),
                model_dir=str(model_path),
                use_fp16=torch.cuda.is_available(),
                use_cuda_kernel=False,
                use_deepspeed=False,
            )
            self.mode = mode
            return self.model
        except Exception:
            self.model = None
            self.mode = None
            self.collect_cuda_garbage()
            raise

    def ensure_huggingface_references(self):
        config_path = Path(__file__).with_name("index_tts_models.json")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        repositories = config.get("repositories", {})
        for repository, revision in repositories.items():
            if not isinstance(revision, str) or len(revision) != 40:
                raise ValueError("IndexTTS2 dependency revision is invalid")
            repository_directory = repository.replace("/", "--")
            references = (
                self.model_root
                / "checkpoints"
                / "hf_cache"
                / f"models--{repository_directory}"
                / "refs"
            )
            references.mkdir(parents=True, exist_ok=True)
            reference_path = references / "main"
            if not reference_path.exists():
                reference_path.write_text(f"{revision}\n", encoding="ascii")

    def release_locked(self):
        previous = self.model
        self.model = None
        self.mode = None
        del previous
        self.collect_cuda_garbage()

    def collect_cuda_garbage(self):
        gc.collect()
        if self.torch is not None and self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()


class SpeechHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, registry):
        self.registry = registry
        super().__init__(("127.0.0.1", 0), SpeechRequestHandler)


class SpeechRequestHandler(BaseHTTPRequestHandler):
    server_version = "SMOIndexTTS/1.0"
    sys_version = ""

    def log_message(self, format, *args):
        # Request bodies and model errors can contain private narration text.
        return

    def do_GET(self):
        try:
            parsed = urlsplit(self.path)
            if parsed.path == "/health" and not parsed.query:
                self.send_json(200, {"ok": True})
                return
            if parsed.path == "/capabilities":
                query = parse_qs(parsed.query, keep_blank_values=True)
                if set(query) != {"voiceMode"} or len(query["voiceMode"]) != 1:
                    raise RequestError(400, "capabilities requires one voiceMode")
                capabilities = self.server.registry.capabilities(query["voiceMode"][0])
                self.send_json(200, capabilities)
                return
            raise RequestError(404, "Not found")
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except Exception:
            self.send_json(500, {"error": "Speech capability query failed"})

    def do_POST(self):
        try:
            parsed = urlsplit(self.path)
            if parsed.path == "/shutdown" and not parsed.query:
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if parsed.path != "/generate" or parsed.query:
                raise RequestError(404, "Not found")
            payload = self.read_json_body()
            audio = self.server.registry.generate(payload)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
        except Exception:
            self.send_json(500, {"error": "Speech generation failed"})

    def read_json_body(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type.lower() != "application/json":
            raise RequestError(415, "Content-Type must be application/json")
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "Transfer-Encoding is not supported")
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            size = int(content_length)
        except ValueError:
            raise RequestError(400, "Content-Length is invalid") from None
        if size < 0 or size > MAXIMUM_REQUEST_BYTES:
            raise RequestError(400, "The request body has an invalid size")
        body = self.rfile.read(size)
        if len(body) != size:
            raise RequestError(400, "The request body is incomplete")
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RequestError(400, "The request body must be valid JSON") from None
        if not isinstance(payload, dict):
            raise RequestError(400, "The JSON body must be an object")
        return payload

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    arguments = parser.parse_args()
    registry = ModelRegistry(arguments.model_root)
    server = SpeechHTTPServer(registry)
    print(
        f"SMO_SPEECH_URL=http://127.0.0.1:{server.server_address[1]}",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        registry.close()


if __name__ == "__main__":
    main()
