#!/usr/bin/env python3
"""Long-lived NDJSON worker for renderer-neutral KiCad symbol IR."""

from __future__ import annotations

import json
import sys
from typing import Any

from kicad_library import build_symbol_ir_bundle, load_index, resolve_lib_root


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_request(index: dict[str, Any], request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    if request.get("method") != "symbol-ir":
        raise ValueError("unsupported worker method")
    symbol_ids = request.get("symbol_ids")
    if not isinstance(symbol_ids, list) or len(symbol_ids) > 256:
        raise ValueError("symbol_ids must be an array containing at most 256 symbols")
    normalized = []
    for value in symbol_ids:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("symbol_ids must contain non-empty strings")
        normalized.append(value.strip())
    result = build_symbol_ir_bundle(index, list(dict.fromkeys(normalized)))
    result["ok"] = not result["diagnostics"]
    return result


def main() -> int:
    try:
        index = load_index(resolve_lib_root())
    except Exception as exc:
        emit({"event": "error", "error": str(exc) or exc.__class__.__name__})
        return 1

    emit({"event": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            if isinstance(request, dict):
                request_id = request.get("id")
            result = handle_request(index, request)
            if not result["ok"]:
                emit({
                    "id": request_id,
                    "ok": False,
                    "error": "KiCad symbol IR resolution produced diagnostics",
                })
                continue
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            emit({
                "id": request_id,
                "ok": False,
                "error": str(exc) or exc.__class__.__name__,
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
