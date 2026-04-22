#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Usage:
#   ./run-3-local-shards.sh WRO0873000 100000
# Splits total count into 3 shards and runs them in parallel on same machine.

START_REGNO="${1:-WRO0873000}"
TOTAL_COUNT="${2:-100000}"
CONCURRENCY_PER_WORKER="${CSV_CONCURRENCY_PER_WORKER:-60}"
OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/output/shards}"

mkdir -p "$OUT_DIR"

prefix="${START_REGNO%%[0-9]*}"
start_num="${START_REGNO#$prefix}"

if [[ ${#start_num} -ne 7 ]]; then
  echo "Invalid START_REGNO: $START_REGNO (expected like WRO0873000)"
  exit 1
fi

c1=$(( TOTAL_COUNT / 3 ))
c2=$(( TOTAL_COUNT / 3 ))
c3=$(( TOTAL_COUNT - c1 - c2 ))

s1=$start_num
s2=$(( start_num + c1 ))
s3=$(( start_num + c1 + c2 ))

r1="${prefix}$(printf '%07d' $s1)"
r2="${prefix}$(printf '%07d' $s2)"
r3="${prefix}$(printf '%07d' $s3)"

echo "Launching 3 local shards"
echo "Shard1: $r1 count=$c1"
echo "Shard2: $r2 count=$c2"
echo "Shard3: $r3 count=$c3"

env CSV_START_REGNO="$r1" CSV_TOTAL_COUNT="$c1" CSV_CONCURRENCY="$CONCURRENCY_PER_WORKER" CSV_OUTPUT_FILE="$OUT_DIR/shard1.csv" node "$SCRIPT_DIR/download-student-cards-to-csv-ultra.js" > "$OUT_DIR/shard1.log" 2>&1 &
p1=$!

env CSV_START_REGNO="$r2" CSV_TOTAL_COUNT="$c2" CSV_CONCURRENCY="$CONCURRENCY_PER_WORKER" CSV_OUTPUT_FILE="$OUT_DIR/shard2.csv" node "$SCRIPT_DIR/download-student-cards-to-csv-ultra.js" > "$OUT_DIR/shard2.log" 2>&1 &
p2=$!

env CSV_START_REGNO="$r3" CSV_TOTAL_COUNT="$c3" CSV_CONCURRENCY="$CONCURRENCY_PER_WORKER" CSV_OUTPUT_FILE="$OUT_DIR/shard3.csv" node "$SCRIPT_DIR/download-student-cards-to-csv-ultra.js" > "$OUT_DIR/shard3.log" 2>&1 &
p3=$!

echo "PIDs: $p1 $p2 $p3"

wait $p1 || true
wait $p2 || true
wait $p3 || true

echo "All shard processes finished."
echo "Merging CSVs..."
node "$SCRIPT_DIR/merge-shards.js" "$OUT_DIR/shard1.csv" "$OUT_DIR/shard2.csv" "$OUT_DIR/shard3.csv" "$OUT_DIR/final_merged.csv"

echo "Merged output: $OUT_DIR/final_merged.csv"
