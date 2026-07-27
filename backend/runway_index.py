"""
Global runway index — fallback runway data for airports outside the OFP.

Backs the LANDING CONDITIONS "AIRPORT" field (POH p.9-83: "A new airport may
be entered in case of a diversion"), which otherwise has nothing to work with
because SimBrief only supplies runways for the planned origin and destination.

────────────────────────────────────────────────────────────────────────────
UNITS — the file is MIXED, verified against known airports:

    TORA/TODA/ASDA/LDA  metres   KDEN 16R = 4882 -> 16,017 ft (actual 16,000)
                                 KJFK 04L = 3684 -> 12,087 ft (actual 12,079)
    ELEV                FEET     KDEN 5434 ft, KASE 7835 ft, KJFK 13 ft
                                 (as metres these would be 17,828 / 25,705 ft)

Distances are converted to feet on load; elevation is passed through.

────────────────────────────────────────────────────────────────────────────
KNOWN LIMITATIONS — why this is a FALLBACK, not a replacement for the OFP:

1. NO TRUE LDA. TORA/TODA/ASDA/LDA are identical in 41,534 of 41,536 rows, so
   displaced thresholds are not represented. KSDF 17L reads 8,589 ft here but
   its real LDA is 7,800 ft — a ~790 ft overstatement, in the UNSAFE
   direction. The value is therefore exposed as `length_ft`, never as `lda`,
   and callers must treat it as runway length.

2. SLOPE IS UNVERIFIED. This file gives -1.41 for KSDF 17L where the SimBrief
   TLR gives -0.33. The convention doesn't match and couldn't be determined,
   so slope is NOT returned. Callers should assume zero rather than feed an
   unverified gradient into a performance calculation.

3. NO MAGNETIC COURSE, so no headwind component. The runway identifier gives
   an approximate heading (RWY 20 -> 200 deg magnetic) which is good enough to
   resolve a wind entry, and that is what `heading_deg` provides.

Consequently: prefer SimBrief's landing block whenever it covers the airport.
"""

import os
from functools import lru_cache

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runway_index.dat")

M_TO_FT = 3.28084


@lru_cache(maxsize=1)
def _load():
    """
    Parse the index once into {ICAO: [runway, ...]}.

    ~41k rows / 1.6 MB, so this is a few tens of milliseconds and a couple of
    MB resident — cheap enough to hold for the life of the process, and it
    avoids re-reading per request.
    """
    index = {}
    try:
        with open(_PATH, "r", encoding="utf-8", errors="replace") as fh:
            header = fh.readline()  # ICAO;RWY;TORA;TODA;ASDA;LDA;ELEV;SLOPE
            if not header:
                return index
            for line in fh:
                parts = line.rstrip("\n").split(";")
                if len(parts) < 7:
                    continue
                icao, rwy = parts[0].strip().upper(), parts[1].strip().upper()
                if not icao or not rwy:
                    continue
                try:
                    tora_m = float(parts[2])
                    elev_ft = float(parts[6])
                except (TypeError, ValueError):
                    continue
                index.setdefault(icao, []).append({
                    "id": rwy,
                    # Runway LENGTH, not LDA — see limitation 1 above.
                    "length_ft": int(round(tora_m * M_TO_FT)),
                    "elevation": int(round(elev_ft)),
                    # "04L_C" style suffixes are intersection departures.
                    "is_intersection": "_" in rwy,
                    "heading_deg": _heading_from_id(rwy),
                })
    except FileNotFoundError:
        print("[WARN] runway_index.dat not found — diversion lookup disabled", flush=True)
    except Exception as e:
        print(f"[WARN] runway_index.dat could not be parsed: {e}", flush=True)
    return index


def _heading_from_id(rwy):
    """Approximate magnetic heading from the runway number ("20" -> 200)."""
    digits = ""
    for ch in rwy:
        if ch.isdigit():
            digits += ch
        else:
            break
    try:
        n = int(digits)
    except ValueError:
        return None
    return (n * 10) % 360 if 1 <= n <= 36 else None


def lookup(icao, include_intersections=False):
    """
    Runways for an airport, or [] if unknown.

    Intersections are excluded by default: for a diversion the crew wants the
    full-length options, and an intersection landing isn't a normal case.
    """
    rows = _load().get(str(icao or "").strip().upper(), [])
    if include_intersections:
        return list(rows)
    return [r for r in rows if not r["is_intersection"]]


def has_airport(icao):
    return bool(lookup(icao))


def airport_count():
    return len(_load())
