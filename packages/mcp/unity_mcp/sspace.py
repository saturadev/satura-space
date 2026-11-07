import os
from pathlib import Path

SSPACE_DIR = ".sspace"
SSPACE_GITIGNORE = "*\n"


def ignores_everything(text: str) -> bool:
    lines = [line.rstrip("\r").strip() for line in text.split("\n")]
    rules = [line for line in lines if line and not line.startswith("#")]
    return "*" in rules and not any(line.startswith("!") for line in rules)


def ensure_sspace_dir(sspace_dir) -> Path:
    d = Path(sspace_dir)
    d.mkdir(parents=True, exist_ok=True)
    gi = d / ".gitignore"
    try:
        current = gi.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        current = None
    except OSError:
        return d
    if current is None or not ignores_everything(current):
        try:
            gi.write_bytes(SSPACE_GITIGNORE.encode("utf-8"))
        except OSError:
            pass
    return d


def ensure_sspace(project_root) -> Path:
    return ensure_sspace_dir(Path(project_root) / SSPACE_DIR)


def ensure_sspace_for(path) -> None:
    p = Path(os.path.abspath(path))
    for parent in (p, *p.parents):
        if parent.name == SSPACE_DIR:
            ensure_sspace_dir(parent)
            return
