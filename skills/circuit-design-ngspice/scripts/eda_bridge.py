#!/usr/bin/env python3
"""Bridge manifest management and EDA peer push/pull orchestration."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eda_export import (
    SYMBOL_MAP_SCHEMA,
    _kicad_page_offset,
    _kicad_page_paper,
    _safe_name,
    _write_json,
    _write_kicad,
    build_eda_ir,
    connectivity_hash,
)
from eda_jlceda_export import write_jlceda_package
from eda_jlceda_import import import_jlceda_peer
from eda_kicad_import import import_kicad_peer
from eda_symbols import resolve_symbol_map


BRIDGE_SCHEMA = "actoviq.bridge.v1"
PEER_KINDS = ("kicad", "jlceda")
POLICIES = ("layout_wins", "connectivity_wins", "manual_review")
SYNC_DIRNAME = "actoviq-sync"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"bridge manifest must be a JSON object: {path}")
    return payload


def _write_bridge(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def bridges_dir(project_root: Path) -> Path:
    return Path(project_root).expanduser().resolve() / "bridges"


def bridge_path(project_root: Path, peer_kind: str) -> Path:
    kind = str(peer_kind).strip().casefold()
    if kind not in PEER_KINDS:
        raise ValueError(f"unsupported peer_kind: {peer_kind}")
    return bridges_dir(project_root) / f"{kind}.bridge.json"


def _default_manifest(peer_kind: str, peer_root: Path, policy: str) -> dict[str, Any]:
    return {
        "schema": BRIDGE_SCHEMA,
        "peer_root": str(peer_root.resolve()),
        "peer_kind": peer_kind,
        "policy": policy,
        "id_map": {},
    }


def _load_manifest(project_root: Path, peer_kind: str) -> dict[str, Any]:
    path = bridge_path(project_root, peer_kind)
    if not path.is_file():
        raise ValueError(f"bridge is not linked for peer_kind={peer_kind}: {path}")
    manifest = _read_json(path)
    if manifest.get("schema") != BRIDGE_SCHEMA:
        raise ValueError(f"unsupported bridge schema: {manifest.get('schema')}")
    if manifest.get("peer_kind") != peer_kind:
        raise ValueError(f"bridge peer_kind mismatch: expected {peer_kind}, got {manifest.get('peer_kind')}")
    return manifest


def list_bridges(project_root: Path) -> list[dict[str, Any]]:
    root = Path(project_root).expanduser().resolve()
    results: list[dict[str, Any]] = []
    directory = bridges_dir(root)
    if not directory.is_dir():
        return results
    for path in sorted(directory.glob("*.bridge.json")):
        try:
            manifest = _read_json(path)
        except (OSError, json.JSONDecodeError, ValueError):
            continue
        if manifest.get("schema") != BRIDGE_SCHEMA:
            continue
        results.append({**manifest, "_path": str(path)})
    return results


def bridge_status(project_root: Path, peer_kind: str | None = None) -> dict[str, Any]:
    root = Path(project_root).expanduser().resolve()
    if peer_kind:
        path = bridge_path(root, peer_kind)
        if not path.is_file():
            return {"ok": False, "linked": False, "peer_kind": peer_kind, "path": str(path)}
        manifest = _read_json(path)
        peer_root = Path(str(manifest.get("peer_root", ""))).expanduser()
        return {
            "ok": True,
            "linked": True,
            "peer_kind": peer_kind,
            "path": str(path),
            "peer_root": str(peer_root),
            "peer_root_exists": peer_root.is_dir(),
            "policy": manifest.get("policy", "manual_review"),
            "last_push_at": manifest.get("last_push_at", ""),
            "last_push_hash": manifest.get("last_push_hash", ""),
            "last_pull_hash": manifest.get("last_pull_hash", ""),
            "id_map_count": len(manifest.get("id_map") or {}),
        }
    entries = [bridge_status(root, kind) for kind in PEER_KINDS if bridge_path(root, kind).is_file()]
    return {"ok": True, "bridges": entries}


def link_bridge(
    project_root: Path,
    peer_kind: str,
    peer_root: str | Path,
    policy: str = "manual_review",
) -> dict[str, Any]:
    root = Path(project_root).expanduser().resolve()
    kind = str(peer_kind).strip().casefold()
    if kind not in PEER_KINDS:
        raise ValueError(f"unsupported peer_kind: {peer_kind}")
    if policy not in POLICIES:
        raise ValueError(f"unsupported bridge policy: {policy}")
    resolved_peer = Path(peer_root).expanduser().resolve()
    resolved_peer.mkdir(parents=True, exist_ok=True)
    manifest = _default_manifest(kind, resolved_peer, policy)
    path = bridge_path(root, kind)
    _write_bridge(path, manifest)
    return {"ok": True, "path": str(path), "manifest": manifest}


def unlink_bridge(project_root: Path, peer_kind: str) -> dict[str, Any]:
    path = bridge_path(project_root, peer_kind)
    if not path.is_file():
        return {"ok": False, "removed": False, "path": str(path), "error": "bridge not linked"}
    path.unlink()
    return {"ok": True, "removed": True, "path": str(path)}


def peer_sync_root(peer_root: Path) -> Path:
    return Path(peer_root).expanduser().resolve() / SYNC_DIRNAME


def _coordinate_transform(ir: dict[str, Any]) -> dict[str, Any]:
    pages: dict[str, Any] = {}
    for page in ir.get("pages", []) or []:
        page_id = str(page.get("id", ""))
        offset_x, offset_y = _kicad_page_offset(page)
        pages[page_id] = {
            "offset_internal": {"x": offset_x, "y": offset_y},
            "paper": _kicad_page_paper(page, offset_x, offset_y),
        }
    return {"schema": "actoviq.bridge-coordinate-transform.v1", "kicad_pages": pages}


def _component_key(component: dict[str, Any]) -> str:
    stable = str(component.get("stable_id", "")).strip()
    if stable:
        return stable
    return str(component.get("id", "")).strip()


def _build_id_map(ir: dict[str, Any], peer_kind: str) -> dict[str, dict[str, Any]]:
    mapping: dict[str, dict[str, Any]] = {}
    for page in ir.get("pages", []) or []:
        page_id = str(page.get("id", ""))
        for component in page.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            key = _component_key(component)
            eda = component.get("eda") or {}
            mapping[key] = {
                "peer_kind": peer_kind,
                "page_id": page_id,
                "component_id": str(component.get("id", "")),
                "refdes": str(eda.get("refdes") or component.get("name", "")),
            }
    return mapping


def _hash_paths(root: Path, patterns: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    files: list[Path] = []
    for pattern in patterns:
        files.extend(sorted(root.glob(pattern)))
    for path in files:
        if not path.is_file():
            continue
        if path.suffix.lower() in {".kicad_pcb", ".brd"}:
            continue
        digest.update(str(path.relative_to(root)).replace("\\", "/").encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


_CONNECTIVITY_HEADS = ("wire", "label", "global_label", "hierarchical_label")


def _sexpression_blocks(text: str, heads: tuple[str, ...]) -> list[str]:
    positions: list[int] = []
    for head in heads:
        needle = f"({head}"
        start = 0
        while True:
            idx = text.find(needle, start)
            if idx < 0:
                break
            positions.append(idx)
            start = idx + len(needle)
    blocks: list[str] = []
    for idx in sorted(set(positions)):
        depth = 0
        end = idx
        while end < len(text):
            char = text[end]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end += 1
                    break
            end += 1
        blocks.append(" ".join(text[idx:end].split()))
    return sorted(blocks)


def _wire_graph_hash(root: Path) -> str:
    """Order-insensitive hash of connectivity-bearing s-expressions in peer schematics.

    Component positions move freely without changing this hash; editing, adding,
    or removing wires/labels does.
    """
    digest = hashlib.sha256()
    if not root.is_dir():
        return digest.hexdigest()
    for path in sorted(root.glob("*.kicad_sch")):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for block in _sexpression_blocks(text, _CONNECTIVITY_HEADS):
            digest.update(block.encode("utf-8"))
            digest.update(b"\x00")
    return digest.hexdigest()


def _push_kicad(
    peer_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    document_hash: str,
) -> tuple[str, dict[str, dict[str, Any]], list[str]]:
    sync_root = peer_sync_root(peer_root)
    sync_root.mkdir(parents=True, exist_ok=True)
    ir, _quality = build_eda_ir(
        project,
        modules,
        scope="project",
        module_id=None,
        view="design",
        document_hash=document_hash,
    )
    symbol_map = resolve_symbol_map("", ir["pages"], ["kicad"], SYMBOL_MAP_SCHEMA)
    project_name = _safe_name(project.get("name", project["project_id"]))
    _write_kicad(sync_root, project_name, ir, symbol_map)
    _write_json(sync_root / "ir" / "project.eda.json", ir)
    _write_json(sync_root / "coordinate-transform.json", _coordinate_transform(ir))
    package_root = sync_root / "kicad"
    content_hash = _hash_paths(package_root, ("*.kicad_sch", "*.kicad_sym", "*.kicad_pro", "sym-lib-table", "connectivity.json"))
    return content_hash, _build_id_map(ir, "kicad"), [str(path.relative_to(peer_root)).replace("\\", "/") for path in sorted(package_root.rglob("*")) if path.is_file()]


def _push_jlceda(
    peer_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    document_hash: str,
) -> tuple[str, dict[str, dict[str, Any]], list[str]]:
    ir, _quality = build_eda_ir(
        project,
        modules,
        scope="project",
        module_id=None,
        view="design",
        document_hash=document_hash,
    )
    package = write_jlceda_package(ir, peer_root)
    package_root = Path(package["package_root"])
    content_hash = _hash_paths(package_root, ("*.json", "*.md"))
    return content_hash, _build_id_map(ir, "jlceda"), package.get("files", [])


def push_bridge(
    project_root: Path,
    peer_kind: str,
    *,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    document_hash: str,
    source_revision: int | None = None,
) -> dict[str, Any]:
    manifest = _load_manifest(project_root, peer_kind)
    if source_revision is not None and int(source_revision) != int(project["revision"]):
        raise ValueError(f"stale source revision: requested {source_revision}, current {project['revision']}")
    peer_root = Path(str(manifest["peer_root"])).expanduser().resolve()
    peer_root.mkdir(parents=True, exist_ok=True)

    if peer_kind == "kicad":
        content_hash, id_map, files = _push_kicad(peer_root, project, modules, document_hash=document_hash)
        manifest["last_push_wire_hash"] = _wire_graph_hash(peer_sync_root(peer_root) / "kicad")
    elif peer_kind == "jlceda":
        content_hash, id_map, files = _push_jlceda(peer_root, project, modules, document_hash=document_hash)
    else:
        raise ValueError(f"unsupported peer_kind: {peer_kind}")

    manifest["last_push_at"] = _utc_now()
    manifest["last_push_hash"] = content_hash
    manifest["id_map"] = id_map
    _write_bridge(bridge_path(project_root, peer_kind), manifest)
    return {
        "ok": True,
        "peer_kind": peer_kind,
        "peer_root": str(peer_root),
        "last_push_hash": content_hash,
        "id_map": id_map,
        "files": files,
        "connectivity_hash": connectivity_hash(project, modules),
    }


def pull_bridge(
    project_root: Path,
    peer_kind: str,
    *,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    policy: str | None = None,
) -> dict[str, Any]:
    manifest = _load_manifest(project_root, peer_kind)
    effective_policy = policy or str(manifest.get("policy", "manual_review"))
    if effective_policy not in POLICIES:
        raise ValueError(f"unsupported bridge policy: {effective_policy}")
    peer_root = Path(str(manifest["peer_root"])).expanduser().resolve()
    if not peer_root.is_dir():
        raise ValueError(f"peer root does not exist: {peer_root}")

    if peer_kind == "kicad":
        result = import_kicad_peer(peer_root, modules, project=project, policy=effective_policy)
        content_hash = _hash_paths(peer_sync_root(peer_root) / "kicad", ("*.kicad_sch",)) if (peer_sync_root(peer_root) / "kicad").is_dir() else _hash_paths(peer_root, ("*.kicad_sch",))
    elif peer_kind == "jlceda":
        result = import_jlceda_peer(peer_root, modules, project=project, policy=effective_policy)
        package_root = peer_sync_root(peer_root) / "jlceda"
        content_hash = _hash_paths(package_root, ("*.json",)) if package_root.is_dir() else _hash_paths(peer_root, ("*.json",))
    else:
        raise ValueError(f"unsupported peer_kind: {peer_kind}")

    manifest["last_pull_hash"] = content_hash
    if result.get("id_map"):
        merged = dict(manifest.get("id_map") or {})
        merged.update(result["id_map"])
        manifest["id_map"] = merged
    _write_bridge(bridge_path(project_root, peer_kind), manifest)

    if effective_policy == "layout_wins" and result.get("conflicts"):
        result["ok"] = True
    if effective_policy == "manual_review" and result.get("conflicts"):
        result = {
            **result,
            "ok": True,
            "requires_review": True,
            "proposed_applied": list(result.get("applied") or []),
            "applied": [],
            "updated_modules": {},
        }

    connectivity_drift = False
    if peer_kind == "kicad":
        pushed_wire_hash = str(manifest.get("last_push_wire_hash") or "")
        peer_wire_hash = _wire_graph_hash(peer_sync_root(peer_root) / "kicad")
        if pushed_wire_hash and peer_wire_hash and peer_wire_hash != pushed_wire_hash:
            connectivity_drift = True
            warnings = list(result.get("warnings") or [])
            warnings.append(
                {
                    "code": "connectivity_drift",
                    "message": (
                        "Peer schematic connectivity changed since the last push. "
                        "Pull reconciles only component layout/properties of known components; "
                        "connectivity edits made in the peer are NOT reconstructed."
                    ),
                }
            )
            result["warnings"] = warnings
            result["requires_review"] = True

    return {
        **result,
        "peer_kind": peer_kind,
        "peer_root": str(peer_root),
        "policy": effective_policy,
        "last_pull_hash": content_hash,
        "connectivity_drift": connectivity_drift,
    }
