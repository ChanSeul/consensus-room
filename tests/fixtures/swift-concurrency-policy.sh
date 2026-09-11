#!/usr/bin/env bash

set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import re
import sys

pattern = re.compile(r"try\?\s+await")
violations = []

for root in (Path("Modules"), Path("SampleApp")):
  for path in root.rglob("*.swift"):
    relative = path
    if relative.parts[:2] == ("Modules", "Tests") or "Generated" in relative.parts:
      continue
    text = path.read_text(encoding="utf-8")
    for match in pattern.finditer(text):
      line = text.count("\n", 0, match.start()) + 1
      violations.append(f"{relative}:{line}: raw 'try? await'는 CancellationError까지 지웁니다.")

if violations:
  print("\n".join(violations), file=sys.stderr)
  sys.exit(1)
PY
