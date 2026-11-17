#!/usr/bin/env bash
# load-env.sh — parse .env.local into the environment WITHOUT executing it.
#
# M-7 fix (audit 18 Nov 2026): run-tests.sh used to `source` .env.local,
# so any shell metacharacter in a stored value would execute. This loader
# treats the file as DATA: it only accepts lines of the form KEY=value
# (KEY = [A-Z0-9_]+), strips one layer of matching single/double quotes
# from the value, and exports the result. Command substitution, comments
# after values, multi-line values, and anything else are NOT interpreted
# — a value containing $(...) stays literal text.
#
# Usage: eval "$(bash scripts/load-env.sh [path-to-env-file])"
# Default file: app/.env.local (relative to the repo root).
# The output is a series of `export KEY='value'` lines with values
# single-quote-escaped, so eval is safe for any value the parser accepts.
# Lines that do not match KEY=value (comments, blanks, garbage) are
# skipped silently. Values are never echoed except into the export
# lines themselves, which the caller evals — do not run this script
# bare in a terminal where the output would be visible.
set -euo pipefail
ENV_FILE="${1:-$(dirname "$0")/../app/.env.local}"
[ -f "$ENV_FILE" ] || exit 0
while IFS= read -r line || [ -n "$line" ]; do
  # Skip blanks and full-line comments.
  case "$line" in ''|'#'*) continue;; esac
  # Strip an optional leading `export `.
  case "$line" in export\ *) line="${line#export }";; esac
  # Only KEY=value lines are accepted.
  case "$line" in *=*) ;; *) continue;; esac
  key="${line%%=*}"
  value="${line#*=}"
  # KEY must be [A-Z0-9_]+ (leading/trailing spaces trimmed).
  key="$(printf '%s' "$key" | tr -d ' \t')"
  case "$key" in ''|*[!A-Z0-9_]*|*[^A-Z0-9_]*) continue;; esac
  # Trim surrounding whitespace from the value.
  value="$(printf '%s' "$value" | sed -e 's/^[ \t]*//' -e 's/[ \t]*$//')"
  # Strip one layer of matching quotes (dotenv convention).
  case "$value" in
    \'*\') value="${value:1:${#value}-2}" ;;
    \"*\") value="${value:1:${#value}-2}" ;;
  esac
  # Emit a safely single-quoted export: ' becomes '\''.
  escaped="$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
  printf "export %s='%s'\n" "$key" "$escaped"
done < "$ENV_FILE"
