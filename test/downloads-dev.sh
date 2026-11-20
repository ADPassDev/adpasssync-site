#!/usr/bin/env bash
# End-to-end checks of byte-range handling on /downloads/* under `wrangler dev`.
#
#   npm run test:dev                 (listens on 127.0.0.1:8799; PORT=... to change)
#
# Generates a random 16 MiB stand-in for hashdb.bin plus .sha256/.json
# sidecars, seeds them into a throwaway local R2 state directory (your
# .wrangler/state and remote buckets are not touched), starts its own
# `wrangler dev`, and checks the responses with curl: 206 and 416 with
# Content-Range, `curl -C -` resumes, HEAD, Accept-Ranges, If-Range, 304s for
# conditional requests, and revalidation and If-Range after the object is
# replaced in place. Prints PASS/FAIL per check
# and exits non-zero if any failed. Needs `npm install` first.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
B=http://127.0.0.1:$PORT/downloads
WRANGLER=./node_modules/.bin/wrangler
# Must match wrangler.jsonc: HASHDB_BUCKET's bucket_name and the HASHDB_*_KEY vars.
BUCKET=adpasssync-hashdb
BLOOM_KEY=current/hashdb.bin
SHA_KEY=current/hashdb.sha256
META_KEY=current/hashdb.json
export WRANGLER_SEND_METRICS=false

[[ -x $WRANGLER ]] || { echo "wrangler not found; run npm install first" >&2; exit 1; }

WORK=$(mktemp -d)
D=$WORK/data
T=$WORK/t
mkdir -p "$D" "$T"
WRANGLER_PID=
cleanup() {
  if [[ -n $WRANGLER_PID ]]; then
    kill -TERM -- "-$WRANGLER_PID" 2>/dev/null # its whole process group, workerd included
    wait "$WRANGLER_PID" 2>/dev/null
  fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

fsize() { wc -c <"$1" | tr -d ' '; }
r2put() { # key file
  "$WRANGLER" r2 object put "$BUCKET/$1" --file "$2" --local --persist-to "$WORK/state" \
    >"$WORK/put.log" 2>&1 || { cat "$WORK/put.log" >&2; exit 1; }
}

# --- fixtures ----------------------------------------------------------------
V1=$D/bloom-v1.bin # the published build
V2=$D/bloom-v2.bin # a different build, published over V1 near the end
head -c $((16 * 1024 * 1024)) /dev/urandom >"$V1"
head -c $((12 * 1024 * 1024)) /dev/urandom >"$V2"
SIZE=$(fsize "$V1")
node -e 'const c = require("crypto"), fs = require("fs");
  process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex") + "\n")' \
  "$V1" >"$D/hashdb.sha256"
printf '{"version":"test-1","built_at":"2026-11-19T00:00:00Z","hash_count":1,"file_size":%s,"sha256":"%s"}\n' \
  "$SIZE" "$(tr -d '\n' <"$D/hashdb.sha256")" >"$D/hashdb.json"
echo "seeding local R2..."
r2put "$BLOOM_KEY" "$V1"
r2put "$SHA_KEY" "$D/hashdb.sha256"
r2put "$META_KEY" "$D/hashdb.json"

# --- wrangler dev, in its own process group so cleanup stops workerd too ----
echo "starting wrangler dev on port $PORT..."
set -m
"$WRANGLER" dev --ip 127.0.0.1 --port "$PORT" --persist-to "$WORK/state" \
  --show-interactive-dev-session=false >"$WORK/wrangler.log" 2>&1 &
WRANGLER_PID=$!
set +m
if ! curl -sf -o /dev/null --retry 60 --retry-delay 1 --retry-connrefused --retry-all-errors \
  "http://127.0.0.1:$PORT/api/health"; then
  echo "wrangler dev did not come up; its log:" >&2
  cat "$WORK/wrangler.log" >&2
  exit 1
fi

# --- helpers -----------------------------------------------------------------
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n      %s\n' "$1" "$2"; fails=$((fails + 1)); }
check() { # name actual expected
  if [[ $2 == "$3" ]]; then pass "$1"; else fail "$1" "got [$2] want [$3]"; fi
}
req() { # name url [curl args...]  ->  $T/name.h (headers), $T/name.body
  local n=$1 u=$2
  shift 2
  : >"$T/$n.body" # curl writes no file for an empty body, e.g. a 304
  curl -sS -D "$T/$n.hdr" -o "$T/$n.body" "$@" "$u"
  tr -d '\r' <"$T/$n.hdr" >"$T/$n.h"
}
status() { head -1 "$T/$1.h" | awk '{print $2}'; }
hdr() { grep -i "^$2:" "$T/$1.h" | head -1 | cut -d' ' -f2-; }
nbytes() { fsize "$T/$1.body"; }
slice_of() { # name offset length  ->  "same" if the body equals that slice of V1
  if cmp -s "$T/$1.body" <(tail -c +$(($2 + 1)) "$V1" | head -c "$3"); then echo same; else echo DIFFERENT; fi
}

curl -sS -I "$B/hashdb.bin" | tr -d '\r' >"$T/head.h"
ETAG=$(grep -i '^etag:' "$T/head.h" | cut -d' ' -f2-)
LASTMOD=$(grep -i '^last-modified:' "$T/head.h" | cut -d' ' -f2-)
echo "object: $SIZE bytes, ETag $ETAG, Last-Modified $LASTMOD"

# --- ranges ------------------------------------------------------------------
req r0_99 "$B/hashdb.bin" -r 0-99
check "curl -r 0-99 -> 206" "$(status r0_99)" 206
check "curl -r 0-99 -> Content-Range" "$(hdr r0_99 content-range)" "bytes 0-99/$SIZE"
check "curl -r 0-99 -> Content-Length 100" "$(hdr r0_99 content-length)" 100
check "curl -r 0-99 -> the object's first 100 bytes" "$(nbytes r0_99) $(slice_of r0_99 0 100)" "100 same"

req r100 "$B/hashdb.bin" -r 100-
check "curl -r 100- -> 206" "$(status r100)" 206
check "curl -r 100- -> Content-Range" "$(hdr r100 content-range)" "bytes 100-$((SIZE - 1))/$SIZE"
check "curl -r 100- -> Content-Length" "$(hdr r100 content-length)" $((SIZE - 100))
check "curl -r 100- -> the rest of the object" "$(slice_of r100 100 $((SIZE - 100)))" same

req past "$B/hashdb.bin" -r "$SIZE-"
check "range starting at the end -> 416 + bytes */SIZE" "$(status past) $(hdr past content-range)" "416 bytes */$SIZE"
req past2 "$B/hashdb.bin" -r 99999999999-100000000000
check "range far past the end -> 416" "$(status past2)" 416

req suf "$B/hashdb.bin" -H 'Range: bytes=-100'
check "bytes=-100 -> 206, last 100 bytes" "$(status suf) $(hdr suf content-range) $(slice_of suf $((SIZE - 100)) 100)" \
  "206 bytes $((SIZE - 100))-$((SIZE - 1))/$SIZE same"
req sufbig "$B/hashdb.bin" -H 'Range: bytes=-999999999999'
check "suffix longer than the object -> 206, whole object" "$(status sufbig) $(hdr sufbig content-range) $(nbytes sufbig)" \
  "206 bytes 0-$((SIZE - 1))/$SIZE $SIZE"
req clamp "$B/hashdb.bin" -H "Range: bytes=$((SIZE - 16))-999999999999"
check "last-pos past the end is clamped" "$(status clamp) $(hdr clamp content-range) $(slice_of clamp $((SIZE - 16)) 16)" \
  "206 bytes $((SIZE - 16))-$((SIZE - 1))/$SIZE same"
req one "$B/hashdb.bin" -H 'Range: bytes=0-0'
check "bytes=0-0 -> 1 byte" "$(status one) $(hdr one content-length) $(slice_of one 0 1)" "206 1 same"
req lastb "$B/hashdb.bin" -H "Range: bytes=$((SIZE - 1))-"
check "last byte only" "$(status lastb) $(hdr lastb content-range)" "206 bytes $((SIZE - 1))-$((SIZE - 1))/$SIZE"
req uc "$B/hashdb.bin" -H 'Range: Bytes=10-19'
check "unit is case-insensitive" "$(status uc) $(hdr uc content-range)" "206 bytes 10-19/$SIZE"
req trail "$B/hashdb.bin" -H 'Range: bytes=10-19,'
check "trailing empty list element" "$(status trail) $(hdr trail content-range)" "206 bytes 10-19/$SIZE"
for spec in 'bytes=-0' 'bytes=5-2' 'bytes=abc' 'bytes=' 'bytes=-' 'bytes=1-2-3' 'bytes=+1-2'; do
  req inv "$B/hashdb.bin" -H "Range: $spec"
  check "malformed '$spec' -> 416 + bytes */SIZE" "$(status inv) $(hdr inv content-range)" "416 bytes */$SIZE"
done
for spec in 'items=0-5' 'bytes 0-5' 'garbage'; do
  req unk "$B/hashdb.bin" -H "Range: $spec"
  check "non-bytes Range '$spec' ignored -> 200 full" "$(status unk) $(nbytes unk)" "200 $SIZE"
done
req multi "$B/hashdb.bin" -H 'Range: bytes=0-1,5-6'
check "multi-range -> 200 full, no Content-Range" "$(status multi) $(nbytes multi) $(hdr multi content-range)" "200 $SIZE "

# --- resume with curl -C - ---------------------------------------------------
head -c 5000000 "$V1" >"$T/resume.bin"
code=$(curl -sS -C - -o "$T/resume.bin" -w '%{http_code}' "$B/hashdb.bin")
rc=$?
check "curl -C - on a 5,000,000-byte partial -> 206, exit 0" "$code $rc" "206 0"
check "curl -C - -> resumed file equals the object" "$(cmp -s "$T/resume.bin" "$V1" && echo same || echo DIFFERENT)" same
code=$(curl -sS -C - -o "$T/resume.bin" -w '%{http_code}' "$B/hashdb.bin")
rc=$?
check "curl -C - on a complete file -> 416, exit 0, file intact" \
  "$code $rc $(cmp -s "$T/resume.bin" "$V1" && echo same || echo DIFFERENT)" "416 0 same"

# --- HEAD and plain GET ------------------------------------------------------
check "curl -I -> 200" "$(head -1 "$T/head.h" | awk '{print $2}')" 200
check "curl -I -> Accept-Ranges: bytes" "$(grep -i '^accept-ranges:' "$T/head.h" | cut -d' ' -f2-)" bytes
check "curl -I -> full Content-Length" "$(grep -i '^content-length:' "$T/head.h" | cut -d' ' -f2-)" "$SIZE"
check "curl -I -> Content-Disposition" "$(grep -i '^content-disposition:' "$T/head.h" | cut -d' ' -f2-)" \
  'attachment; filename="hashdb.bin"'
curl -sS -I -H 'Range: bytes=0-99' "$B/hashdb.bin" | tr -d '\r' >"$T/headr.h"
check "HEAD ignores Range -> 200, full length" \
  "$(head -1 "$T/headr.h" | awk '{print $2}') $(grep -i '^content-length:' "$T/headr.h" | cut -d' ' -f2-)" "200 $SIZE"

req full "$B/hashdb.bin"
check "plain GET -> 200 with the whole object" "$(status full) $(cmp -s "$T/full.body" "$V1" && echo same)" "200 same"
check "plain GET -> Accept-Ranges, no Content-Range" "$(hdr full accept-ranges)|$(hdr full content-range)" "bytes|"
check "plain GET -> Cache-Control: public, no-cache" "$(hdr full cache-control)" 'public, no-cache'
check "plain GET -> ETag and Last-Modified match HEAD" "$(hdr full etag) $(hdr full last-modified)" "$ETAG $LASTMOD"

# --- If-Range ----------------------------------------------------------------
req ifr_ok "$B/hashdb.bin" -H 'Range: bytes=100-199' -H "If-Range: $ETAG"
check "If-Range current ETag -> 206" "$(status ifr_ok) $(hdr ifr_ok content-range)" "206 bytes 100-199/$SIZE"
req ifr_bad "$B/hashdb.bin" -H 'Range: bytes=100-199' -H 'If-Range: "0000"'
check "If-Range other ETag -> 200 full" "$(status ifr_bad) $(nbytes ifr_bad)" "200 $SIZE"
req ifr_weak "$B/hashdb.bin" -H 'Range: bytes=100-199' -H "If-Range: W/$ETAG"
check "If-Range weak ETag -> 200 full" "$(status ifr_weak) $(nbytes ifr_weak)" "200 $SIZE"
req ifr_date "$B/hashdb.bin" -H 'Range: bytes=100-199' -H "If-Range: $LASTMOD"
check "If-Range equal to Last-Modified -> 206" "$(status ifr_date)" 206
req ifr_old "$B/hashdb.bin" -H 'Range: bytes=100-199' -H 'If-Range: Wed, 21 Oct 2015 07:28:00 GMT'
check "If-Range older date -> 200 full" "$(status ifr_old) $(nbytes ifr_old)" "200 $SIZE"
req ifr_junk "$B/hashdb.bin" -H 'Range: bytes=100-199' -H 'If-Range: not-a-validator'
check "If-Range junk -> 200 full" "$(status ifr_junk) $(nbytes ifr_junk)" "200 $SIZE"
req ifr_norange "$B/hashdb.bin" -H "If-Range: $ETAG"
check "If-Range without Range -> 200 full" "$(status ifr_norange) $(nbytes ifr_norange)" "200 $SIZE"
req ifr_inv_stale "$B/hashdb.bin" -H 'Range: bytes=5-2' -H 'If-Range: "0000"'
check "malformed Range + stale If-Range -> 200 (Range ignored)" "$(status ifr_inv_stale)" 200
req ifr_inv_ok "$B/hashdb.bin" -H 'Range: bytes=5-2' -H "If-Range: $ETAG"
check "malformed Range + current If-Range -> 416" "$(status ifr_inv_ok)" 416

# --- conditional requests (cache revalidation) --------------------------------
req inm "$B/hashdb.bin" -H "If-None-Match: $ETAG"
check "If-None-Match current ETag -> 304, no body" "$(status inm) $(nbytes inm)" "304 0"
check "304 carries ETag and Cache-Control" "$(hdr inm etag)|$(hdr inm cache-control)" "$ETAG|public, no-cache"
req inm_other "$B/hashdb.bin" -H 'If-None-Match: "0000"'
check "If-None-Match other ETag -> 200 full" "$(status inm_other) $(nbytes inm_other)" "200 $SIZE"
req ims "$B/hashdb.bin" -H "If-Modified-Since: $LASTMOD"
check "If-Modified-Since equal to Last-Modified -> 304" "$(status ims) $(nbytes ims)" "304 0"
req inm_range "$B/hashdb.bin" -r 0-99 -H "If-None-Match: $ETAG"
check "current If-None-Match wins over Range -> 304" "$(status inm_range)" 304
curl -sS -I -H "If-None-Match: $ETAG" "$B/hashdb.bin" | tr -d '\r' >"$T/head304.h"
check "HEAD with current If-None-Match -> 304" "$(head -1 "$T/head304.h" | awk '{print $2}')" 304

# --- sidecar files -----------------------------------------------------------
for f in hashdb.sha256 hashdb.json; do
  n=${f//./_}
  fs=$(fsize "$D/$f")
  req "$n" "$B/$f" -r 0-9
  check "$f -r 0-9 -> 206 with its first 10 bytes" \
    "$(status "$n") $(hdr "$n" content-range) $(cmp -s "$T/$n.body" <(head -c 10 "$D/$f") && echo same)" "206 bytes 0-9/$fs same"
  curl -sS -I "$B/$f" | tr -d '\r' >"$T/$n-head.h"
  check "$f HEAD -> Accept-Ranges" "$(grep -i '^accept-ranges:' "$T/$n-head.h" | cut -d' ' -f2-)" bytes
  req "${n}_past" "$B/$f" -r "$fs-"
  check "$f past the end -> 416" "$(status "${n}_past") $(hdr "${n}_past" content-range)" "416 bytes */$fs"
done

# --- the publisher overwrites hashdb.bin in place -----------------------------
r2put "$BLOOM_KEY" "$V2"
SIZE2=$(fsize "$V2")
NEW_ETAG=$(curl -sS -I "$B/hashdb.bin" | tr -d '\r' | grep -i '^etag:' | cut -d' ' -f2-)
check "after publish: ETag changed" "$([[ -n $NEW_ETAG && $NEW_ETAG != "$ETAG" ]] && echo changed)" changed
req stale "$B/hashdb.bin" -r 5000000- -H "If-Range: $ETAG"
check "after publish: old ETag in If-Range -> 200 with the whole new build" \
  "$(status stale) $(hdr stale etag) $(cmp -s "$T/stale.body" "$V2" && echo same)" "200 $NEW_ETAG same"
req reval "$B/hashdb.bin" -H "If-None-Match: $ETAG"
check "after publish: revalidating with the old ETag -> 200 with the new build" \
  "$(status reval) $(hdr reval etag) $(cmp -s "$T/reval.body" "$V2" && echo same)" "200 $NEW_ETAG same"
req fresh "$B/hashdb.bin" -r 0-99 -H "If-Range: $NEW_ETAG"
check "after publish: new ETag in If-Range -> 206" "$(status fresh) $(hdr fresh content-range)" "206 bytes 0-99/$SIZE2"
head -c 5000000 "$V1" >"$T/stale-resume.bin"
curl -sS -C - -H "If-Range: $ETAG" -o "$T/stale-resume.bin" "$B/hashdb.bin" 2>/dev/null
rc=$?
check "after publish: curl -C - with the old ETag refuses to splice (exit 33), partial kept" \
  "$rc $(cmp -s "$T/stale-resume.bin" <(head -c 5000000 "$V1") && echo kept)" "33 kept"

echo "== $fails failure(s)"
exit $((fails > 0))
