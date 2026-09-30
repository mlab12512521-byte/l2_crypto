#!/bin/bash
# TeXCollab sandbox entrypoint.
#
#   stdin : tar archive of the project (created by the app from validated paths)
#   stdout: tar archive of whitelisted outputs + status.json
#   args  : <engine> <main-file> <timeout-seconds> [draft]
#
# Everything the user controls is file *content*. Arguments come from the
# compile worker, which validates them; they are re-validated here.
set -u
umask 022

ENGINE=${1:-}
MAIN=${2:-}
TIMEOUT=${3:-60}
DRAFT=${4:-0}

WORK=/work
SRC=$WORK/project
META=$WORK/meta
mkdir -p "$SRC" "$META"

emit() {
  # Write outputs as a tar stream to stdout; only fixed, known file names.
  local files=()
  for f in output.pdf output.log output.synctex.gz output.blg; do
    [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] && files+=("project/$f")
  done
  files+=("meta/status.json")
  [ -f "$META/latexmk.log" ] && files+=("meta/latexmk.log")
  tar -c -f - -C "$WORK" "${files[@]}" 2>/dev/null
}

status() {
  # $1: result, $2: exit code, $3: message
  printf '{"result":"%s","exitCode":%d,"message":"%s"}\n' "$1" "$2" "$3" > "$META/status.json"
}

case "$ENGINE" in
  pdflatex) MODE=-pdf ;;
  xelatex) MODE=-xelatex ;;
  lualatex) MODE=-lualatex ;;
  *) status error 64 "invalid engine"; emit; exit 0 ;;
esac

case "$TIMEOUT" in ''|*[!0-9]*) status error 64 "invalid timeout"; emit; exit 0 ;; esac
if [ "$TIMEOUT" -lt 1 ] || [ "$TIMEOUT" -gt 3600 ]; then status error 64 "invalid timeout"; emit; exit 0; fi

# Main file: relative, no parent references, a .tex file.
case "$MAIN" in
  ''|/*|../*|*/../*|*/..|..|*$'\n'*) status error 64 "invalid main file"; emit; exit 0 ;;
esac
case "$MAIN" in *.tex|*.ltx|*.latex) ;; *) status error 64 "main file must be a .tex file"; emit; exit 0 ;; esac

# Extract the project. GNU tar strips leading "/" and refuses members containing
# "..". Ownership/permissions from the archive are ignored.
if ! tar -x -f - -C "$SRC" --no-same-owner --no-same-permissions --no-overwrite-dir 2> "$META/extract.log"; then
  status error 65 "could not unpack project"
  emit
  exit 0
fi
if [ ! -f "$SRC/$MAIN" ]; then
  status error 66 "main file not found"
  emit
  exit 0
fi

# Defence in depth on top of the container sandbox:
#  - no shell escape at all (not even the restricted list)
#  - "paranoid" file access: no writing/reading outside the project via absolute or ../ paths
#  - writable TeX caches only in /tmp; wide log lines for reliable error parsing
export shell_escape=f
export shell_escape_commands=
export openout_any=p
export openin_any=p
export HOME=/tmp
export TEXMFVAR=/tmp/texmf-var
export TEXMFCONFIG=/tmp/texmf-config
export max_print_line=10000
export error_line=254
export half_error_line=238
export SOURCE_DATE_EPOCH_TEX_PRIMITIVES=0

# luaotfload reads its font-name database from the writable cache only; seed
# it with the copy prebuilt into the image so LuaLaTeX does not spend many
# seconds re-indexing all fonts on every run.
if [ "$ENGINE" = lualatex ]; then
  SYSVAR=$(kpsewhich -var-value TEXMFSYSVAR)
  if [ -d "$SYSVAR/luatex-cache/generic/names" ]; then
    mkdir -p "$TEXMFVAR/luatex-cache/generic"
    cp -R "$SYSVAR/luatex-cache/generic/names" "$TEXMFVAR/luatex-cache/generic/" 2>/dev/null || true
  fi
fi

DRAFT_OPT=()
if [ "$DRAFT" = "1" ]; then
  case "$ENGINE" in
    pdflatex) DRAFT_OPT=(-pdflatex="pdflatex -draftmode %O %S") ;;
  esac
fi

cd "$SRC" || exit 0
timeout --signal=KILL "$TIMEOUT" \
  latexmk -norc -r /etc/texcollab/latexmkrc "$MODE" "${DRAFT_OPT[@]}" \
    -jobname=output -interaction=nonstopmode -file-line-error -synctex=1 -f \
    -no-shell-escape "$MAIN" > "$META/latexmk.log" 2>&1 < /dev/null
CODE=$?

if [ "$CODE" -eq 137 ]; then
  status timeout "$CODE" "compilation exceeded the time limit"
elif [ "$CODE" -eq 0 ]; then
  status success 0 ""
else
  status failure "$CODE" "LaTeX reported errors"
fi
emit
exit 0
