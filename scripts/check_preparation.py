"""Check simple local Markdown links and sensitive filenames, without dependencies.

This is NOT a secret-content scanner or a product test suite.
"""
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
errors = []
documents = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]
for document in documents:
    if not document.is_file():
        errors.append(f"Missing document: {document.relative_to(ROOT)}")
        continue
    # Covers this kit's inline links; deliberately ignores fenced code examples.
    content = re.sub(r"```.*?```", "", document.read_text(encoding="utf-8"), flags=re.S)
    for link in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", content):
        target = link.strip().strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        resolved = (document.parent / unquote(parsed.path)).resolve()
        if not resolved.is_relative_to(ROOT) or not resolved.exists():
            errors.append(f"Broken local link: {document.relative_to(ROOT)} -> {target}")

# Only inspect this repo's tracked files, never a surrounding repository.
if (ROOT / ".git").exists():
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    )
    for name in result.stdout.decode().split("\0"):
        path = Path(name)
        if not name:
            continue
        if ((path.name == ".env" or path.name.startswith(".env."))
                and path.name != ".env.example") or path.suffix in {".pem", ".key"} \
                or path.name == "credentials.json" or ".aws" in path.parts \
                or ".tfstate" in path.name:
            errors.append(f"Review potentially sensitive tracked file: {name}")
else:
    print("Git is not initialized here; tracked-filename check skipped.")

for error in errors:
    print(error, file=sys.stderr)
if errors:
    sys.exit(1)
print(f"PASS: local links in {len(documents)} documents; no flagged tracked filenames.")
