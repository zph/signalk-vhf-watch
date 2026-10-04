#!/usr/bin/env python3
"""Aggregate ASR quality comparisons without printing transcript text.

Input is JSONL. Accuracy rows have kind=reference plus dataset/system/reference/hypothesis.
Unlabeled paired rows have kind=pair plus dataset/left_system/right_system/left/right.
The program reports counts and edit metrics only; do not use private transcripts in checked-in
fixtures or redirect raw input into shared logs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


def words(text: str) -> list[str]:
    return [match.group(0).casefold().replace("’", "'") for match in WORD.finditer(text)]


def edit_counts(reference: list[str], hypothesis: list[str]) -> tuple[int, int, int]:
    """Return substitutions, deletions, insertions from a deterministic minimum edit path."""
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    costs = [[0] * cols for _ in range(rows)]
    steps = [[""] * cols for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0], steps[i][0] = i, "D"
    for j in range(1, cols):
        costs[0][j], steps[0][j] = j, "I"

    # Prefer a match, then substitution, deletion, insertion on equal-cost paths.
    priority = {"M": 0, "S": 1, "D": 2, "I": 3}
    for i in range(1, rows):
        for j in range(1, cols):
            same = reference[i - 1] == hypothesis[j - 1]
            candidates = [
                (costs[i - 1][j - 1] + (0 if same else 1), "M" if same else "S"),
                (costs[i - 1][j] + 1, "D"),
                (costs[i][j - 1] + 1, "I"),
            ]
            costs[i][j], steps[i][j] = min(candidates, key=lambda item: (item[0], priority[item[1]]))

    substitutions = deletions = insertions = 0
    i, j = len(reference), len(hypothesis)
    while i or j:
        step = steps[i][j]
        if step == "M":
            i -= 1
            j -= 1
        elif step == "S":
            substitutions += 1
            i -= 1
            j -= 1
        elif step == "D":
            deletions += 1
            i -= 1
        elif step == "I":
            insertions += 1
            j -= 1
        else:  # pragma: no cover - protects malformed internal state
            raise RuntimeError("edit alignment failed")
    return substitutions, deletions, insertions


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON on line {line_number}") from exc
            if not isinstance(item, dict):
                raise ValueError(f"line {line_number} must be a JSON object")
            rows.append(item)
    return rows


def require_text(row: dict[str, Any], field: str, line: int) -> str:
    value = row.get(field)
    if not isinstance(value, str):
        raise ValueError(f"line {line}: {field} must be a string")
    return value


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    references: dict[tuple[str, str], list[tuple[int, int, int, int, int]]] = defaultdict(list)
    pairs: dict[tuple[str, str, str], list[tuple[int, int, int]]] = defaultdict(list)
    for index, row in enumerate(rows, 1):
        kind = row.get("kind")
        dataset = row.get("dataset")
        if not isinstance(dataset, str) or not dataset:
            raise ValueError(f"line {index}: dataset must be a non-empty string")
        if kind == "reference":
            system = row.get("system")
            if not isinstance(system, str) or not system:
                raise ValueError(f"line {index}: system must be a non-empty string")
            reference = words(require_text(row, "reference", index))
            hypothesis = words(require_text(row, "hypothesis", index))
            sub, delete, insert = edit_counts(reference, hypothesis)
            references[(dataset, system)].append((len(reference), len(hypothesis), sub, delete, insert))
        elif kind == "pair":
            left_system = row.get("left_system")
            right_system = row.get("right_system")
            if not all(isinstance(value, str) and value for value in (left_system, right_system)):
                raise ValueError(f"line {index}: left_system and right_system are required")
            left = words(require_text(row, "left", index))
            right = words(require_text(row, "right", index))
            sub, delete, insert = edit_counts(left, right)
            pairs[(dataset, left_system, right_system)].append((len(left), len(right), sub + delete + insert))
        else:
            raise ValueError(f"line {index}: kind must be 'reference' or 'pair'")

    output: dict[str, Any] = {
        "normalization": "case-insensitive word tokens; punctuation removed; digit tokens remain distinct from number words",
        "reference_comparisons": [],
        "unlabeled_pairs": [],
    }
    for (dataset, system), values in sorted(references.items()):
        ref_words = sum(value[0] for value in values)
        hyp_words = sum(value[1] for value in values)
        sub = sum(value[2] for value in values)
        delete = sum(value[3] for value in values)
        insert = sum(value[4] for value in values)
        edits = sub + delete + insert
        output["reference_comparisons"].append({
            "dataset": dataset,
            "system": system,
            "samples": len(values),
            "nonempty_outputs": sum(value[1] > 0 for value in values),
            "reference_words": ref_words,
            "hypothesis_words": hyp_words,
            "substitutions": sub,
            "deletions": delete,
            "insertions": insert,
            "wer": (edits / ref_words) if ref_words else None,
        })
    for (dataset, left_system, right_system), values in sorted(pairs.items()):
        exact = sum(value[2] == 0 and value[0] == value[1] for value in values)
        total_left = sum(value[0] for value in values)
        total_right = sum(value[1] for value in values)
        total_edits = sum(value[2] for value in values)
        output["unlabeled_pairs"].append({
            "dataset": dataset,
            "left_system": left_system,
            "right_system": right_system,
            "pairs": len(values),
            "exact_normalized_agreement": exact,
            "left_nonempty": sum(value[0] > 0 for value in values),
            "right_nonempty": sum(value[1] > 0 for value in values),
            "left_words": total_left,
            "right_words": total_right,
            "edit_operations": total_edits,
            "edits_per_left_word": (total_edits / total_left) if total_left else None,
        })
    return output


def self_test() -> None:
    assert words("Ask not, what’s—UP?") == ["ask", "not", "what's", "up"]
    assert edit_counts(["a", "b", "c"], ["a", "x", "c", "d"]) == (1, 0, 1)
    assert edit_counts(["a", "b"], ["b"]) == (0, 1, 0)
    result = summarize([
        {"kind": "reference", "dataset": "fixture", "system": "m", "reference": "a b", "hypothesis": "a c"},
        {"kind": "pair", "dataset": "weather", "left_system": "A", "right_system": "B", "left": "WX test", "right": "wx test"},
    ])
    assert result["reference_comparisons"][0]["wer"] == 0.5
    assert result["unlabeled_pairs"][0]["exact_normalized_agreement"] == 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="private/local JSONL input; output contains aggregates only")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("self-test passed")
        return 0
    if args.input is None:
        parser.error("provide an input JSONL file or --self-test")
    try:
        result = summarize(load_rows(args.input))
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
