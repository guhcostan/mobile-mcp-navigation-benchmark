#!/usr/bin/env python3
"""Persistent local CLEF-Flash scorer for the Mobile MCP Jev-style loop."""

from __future__ import annotations

import json
import sys
import time
import traceback
import contextlib
from pathlib import Path
from typing import Any

import torch

MODEL_DIR = Path.home() / "clef-flash-test" / "model"
MODEL_DIR = Path(__import__("os").environ.get("CLEF_MODEL_DIR", str(MODEL_DIR))).expanduser()
MODEL = None
PROCESSOR = None
LOAD_SECONDS = 0.0
DEVICE = torch.device("mps")
MAX_LENGTH = 2048
ENCODE_SAFETY_LIMIT = MAX_LENGTH + 1
MAX_STATE_CHARS = 12000
MAX_RECORD_CHARS = 32000
MAX_QUESTIONS = 8
MAX_OPTIONS = 24


def _load_model() -> None:
    global MODEL, PROCESSOR, LOAD_SECONDS
    if not torch.backends.mps.is_available():
        raise RuntimeError("PyTorch MPS is unavailable; refusing CPU fallback")
    if not MODEL_DIR.is_dir():
        raise FileNotFoundError(f"CLEF model directory not found: {MODEL_DIR}")

    sys.path.insert(0, str(MODEL_DIR))
    from joint_schema_model import load_release_model

    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        MODEL, PROCESSOR = load_release_model(
            MODEL_DIR,
            device=DEVICE,
            dtype=torch.bfloat16,
        )
    torch.mps.synchronize()
    LOAD_SECONDS = time.perf_counter() - started


def _validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    if not isinstance(record.get("model"), str) or "state" not in record:
        raise ValueError("record requires string model and state")
    if not isinstance(record["state"], (str, dict, list)):
        raise ValueError("state must be text, a JSON object, or a JSON array")
    state_text = json.dumps(record["state"], ensure_ascii=False, separators=(",", ":"))
    if len(state_text) > MAX_STATE_CHARS:
        raise ValueError(f"state exceeds the {MAX_STATE_CHARS}-character safety limit")
    if len(json.dumps(record, ensure_ascii=False, separators=(",", ":"))) > MAX_RECORD_CHARS:
        raise ValueError(f"record exceeds the {MAX_RECORD_CHARS}-character safety limit")
    if record.get("images") or record.get("videos"):
        raise ValueError("this mobile benchmark accepts text/accessibility state only")

    questions = record.get("questions")
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        raise ValueError(f"record.questions must contain 1..{MAX_QUESTIONS} questions")
    for qid, question in questions.items():
        if not isinstance(question, dict) or question.get("type") not in {"noul", "choice", "score"}:
            raise ValueError(f"{qid}: unsupported question type")
        question_type = question["type"]
        if question_type == "noul":
            continue
        criteria = question.get("criteria")
        if question_type == "choice":
            if not isinstance(criteria, dict) or not criteria:
                raise ValueError(f"{qid}: choice requires non-empty criteria")
            if len(criteria) > MAX_OPTIONS:
                raise ValueError(f"{qid}: choice exceeds {MAX_OPTIONS} options")
        elif not isinstance(criteria, list) or not criteria:
            raise ValueError(f"{qid}: score requires a non-empty criteria list")
    return record


def _score(record: dict[str, Any]) -> dict[str, Any]:
    if MODEL is None or PROCESSOR is None:
        raise RuntimeError("CLEF model was not initialized")

    from joint_schema_model import collate_records, encode_record, render, systemone_answer

    encode_started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        encoded = encode_record(
            PROCESSOR.tokenizer,
            record,
            max_length=MAX_LENGTH,
            processor=PROCESSOR,
        )
    # encode_record truncates state to fit max_length; reject truncation by
    # comparing the expected rendered-state token count with the input layout.
    state_tokens = PROCESSOR.tokenizer(render(record["state"]), add_special_tokens=False).input_ids
    non_state_record = {**record, "state": ""}
    with contextlib.redirect_stdout(sys.stderr):
        empty_state_encoded = encode_record(
            PROCESSOR.tokenizer,
            non_state_record,
            max_length=MAX_LENGTH,
            processor=PROCESSOR,
        )
    fixed_length = len(empty_state_encoded.input_ids)
    available_state_tokens = MAX_LENGTH - fixed_length
    if len(state_tokens) > available_state_tokens:
        raise ValueError(
            f"state needs {len(state_tokens)} tokens but only {available_state_tokens} fit within {MAX_LENGTH}"
        )
    if len(encoded.input_ids) != fixed_length + len(state_tokens):
        raise ValueError("encoded input length differs from expected state plus schema length")
    encode_seconds = time.perf_counter() - encode_started

    batch = collate_records([encoded], PROCESSOR.tokenizer.pad_token_id, DEVICE)
    torch.mps.synchronize()
    inference_started = time.perf_counter()
    with torch.inference_mode():
        logits = MODEL(batch)[0]
    torch.mps.synchronize()
    inference_seconds = time.perf_counter() - inference_started

    answers: dict[str, Any] = {}
    for question, question_logits in zip(encoded.questions, logits):
        probabilities = question_logits.float().softmax(-1).tolist()
        answers[question.question_id] = systemone_answer(
            record["questions"][question.question_id],
            dict(zip(question.option_ids, probabilities)),
        )
    return {
        "model": record["model"],
        "answers": answers,
        "usage": {"input_tokens": len(encoded.input_ids), "output_tokens": 0},
    }, encode_seconds, inference_seconds


def _handle_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    request_id = request.get("id")
    record = _validate_record(request.get("record"))
    response, encode_seconds, inference_seconds = _score(record)
    return {
        "id": request_id,
        "response": response,
        "timing": {
            "encode_seconds": encode_seconds,
            "inference_seconds": inference_seconds,
            "model_load_seconds": LOAD_SECONDS,
        },
    }


def main() -> int:
    try:
        _load_model()
        print(
            json.dumps(
                {"ready": True, "device": str(DEVICE), "model_load_seconds": LOAD_SECONDS},
                separators=(",", ":"),
            ),
            flush=True,
        )
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}), flush=True)
        traceback.print_exc(file=sys.stderr)
        return 1

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        request_id = None
        try:
            request = json.loads(raw)
            if isinstance(request, dict):
                request_id = request.get("id")
            response = _handle_request(request)
            print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
        except Exception as exc:
            print(
                json.dumps({"id": request_id, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")),
                flush=True,
            )
            traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
