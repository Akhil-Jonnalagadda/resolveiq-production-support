import json
import math
import re
from urllib import error, request


class EmbeddingUnavailable(RuntimeError):
    pass


class LocalEmbedder:
    def __init__(self, base_url: str, model: str) -> None:
        self.url = base_url.rstrip("/")
        self.model = model

    def embed(self, text: str) -> list[float]:
        body = json.dumps({"model": self.model, "input": text}).encode()
        req = request.Request(
            f"{self.url}/api/embed", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
        except error.HTTPError as exc:
            raise EmbeddingUnavailable(f"Model '{self.model}' unavailable — run: ollama pull {self.model}") from exc
        except (error.URLError, TimeoutError) as exc:
            raise EmbeddingUnavailable("Ollama not reachable for embedding.") from exc
        try:
            return [float(v) for v in data["embeddings"][0]]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise EmbeddingUnavailable("Invalid embedding response from Ollama.") from exc


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def text_similarity(a: str, b: str) -> float:
    ta = set(re.findall(r"[a-z0-9]{3,}", a.lower()))
    tb = set(re.findall(r"[a-z0-9]{3,}", b.lower()))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)
