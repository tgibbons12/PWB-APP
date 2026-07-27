"""
ACARS ATS services — D-ATIS and PDC/DCL.

Backs the ATS MENU pages the POH documents but that were previously greyed
out in this app:

    ATIS REQUEST  (POH p.9-66)  -> fetch_atis()
    DCL REQUEST   (POH p.9-67)  -> build_pdc()

Ported from the standalone atis_acars.py and PDC.py tools. Only the data
functions came across; the tkinter UI and local file-writing did not.
"""

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

_HEADERS = {"User-Agent": "PWB-ACARS/1.0"}
_TIMEOUT = 10


# ─── D-ATIS ────────────────────────────────────────────────────────────────

def _fetch_datis(icao):
    """Real-world D-ATIS. Only covers US airports with digital ATIS."""
    try:
        r = requests.get(f"https://datis.clowd.io/api/{icao}", headers=_HEADERS, timeout=_TIMEOUT)
        if r.status_code != 200:
            return ""
        data = r.json()
        if not isinstance(data, list):
            data = [data]
        parts = []
        for entry in data:
            for key in ("datis", "raw", "text", "atis", "message"):
                if entry.get(key):
                    parts.append(entry[key].strip())
                    break
        return "\n\n".join(parts)
    except Exception:
        return ""


def _fetch_vatsim_atis(icao):
    """VATSIM controller ATIS — the relevant source when flying online."""
    try:
        r = requests.get("https://data.vatsim.net/v3/vatsim-data.json", timeout=_TIMEOUT)
        if r.status_code != 200:
            return ""
        out = []
        for entry in r.json().get("atis", []):
            if isinstance(entry, dict) and icao in (entry.get("callsign") or "").upper():
                lines = entry.get("text_atis") or []
                if lines:
                    out.append(" ".join(lines))
        return "\n\n".join(out)
    except Exception:
        return ""


def _fetch_metar(icao):
    """Last resort: raw METAR. Not an ATIS, and labelled as such."""
    try:
        r = requests.get(
            f"https://tgftp.nws.noaa.gov/data/observations/metar/stations/{icao}.TXT",
            headers=_HEADERS, timeout=_TIMEOUT,
        )
        if r.status_code != 200:
            return ""
        lines = r.text.strip().splitlines()
        return lines[1].strip() if len(lines) > 1 else ""
    except Exception:
        return ""


def _atis_letter(text):
    m = re.search(r"\b(?:INFO|ATIS|INFORMATION)\s+([A-Z])\b", text or "", re.IGNORECASE)
    return m.group(1).upper() if m else ""


def fetch_atis(icao, arrival=True):
    """
    ATIS for an airport, trying D-ATIS, then VATSIM, then METAR.

    `source` is always reported so the crew can see which of the three they
    got — a METAR is not an ATIS and shouldn't be presented as one.

    The arrival/departure split (POH p.9-66 LSK 2L/1R) only applies where the
    field publishes separate ATIS; D-ATIS returns both in one message and we
    don't split it, so the flag is echoed back rather than acted on.
    """
    icao = str(icao or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{4}", icao):
        return {"error": "INVALID AIRPORT"}

    text = _fetch_datis(icao)
    source = "D-ATIS"
    if not text:
        text = _fetch_vatsim_atis(icao)
        source = "VATSIM"
    if not text:
        text = _fetch_metar(icao)
        source = "METAR"
    if not text:
        return {"error": "NO ATIS AVAIL"}

    return {
        "airport": icao,
        "source": source,
        "letter": _atis_letter(text),
        "text": " ".join(text.split()),   # collapse whitespace for CDU wrapping
        "arrival": bool(arrival),
        "fetched": datetime.now(timezone.utc).strftime("%H%MZ"),
    }


# ─── PDC / DCL ─────────────────────────────────────────────────────────────

# TYPICAL initial climb altitudes. This is the one SYNTHESISED value in the
# PDC — SimBrief carries no departure clearance limit (atc/initial_alt is the
# cruise level, not a climb restriction), and there is no real controller
# issuing one. Everything else in the message comes from the OFP. The page
# labels the clearance SIMULATED so this isn't mistaken for a real one.
_TYPICAL_INITIAL_ALT = {"KJFK": 5000, "KLGA": 6000, "KEWR": 2500, "KPHL": 5000,
                        "KBOS": 6000, "KDCA": 3000, "KORD": 5000, "KATL": 10000}
_DEFAULT_FLOOR = 5000


# Codes that must never be assigned: emergency (7500 hijack, 7600 radio
# failure, 7700 general), plus the conspicuity/VFR and test codes.
_RESERVED_SQUAWKS = {"7500", "7600", "7700", "7777", "0000", "1200", "2000", "7000"}


def _make_squawk(seed):
    """
    Assign a discrete beacon code.

    Digits are octal (0-7), as real transponder codes are, and reserved codes
    are skipped. Derived from the callsign rather than randomly so the same
    flight keeps its code across repeated requests — re-requesting a PDC
    shouldn't hand you a different squawk, the way a real assignment wouldn't.
    """
    h = 0
    for ch in str(seed or "PWB"):
        h = (h * 31 + ord(ch)) & 0xFFFFFFF
    for _ in range(64):
        code = "".join(str((h >> (3 * i)) & 0b111) for i in range(4))
        # Real discrete codes don't start at 0, which is reserved for
        # non-discrete blocks.
        if code not in _RESERVED_SQUAWKS and code[0] != "0":
            return code
        h += 1
    return "4321"


def _xt(root, *paths):
    for p in paths:
        el = root.find(p)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def _extract_sid(route, origin_icao):
    """
    First route token is normally the SID, sometimes with a transition
    ("BNGOS3.DOLIE"). Returns (sid, transition).
    """
    toks = (route or "").upper().split()
    if toks and (toks[0] == origin_icao or "/" in toks[0]):
        toks = toks[1:]
    if not toks:
        return "", ""
    first = toks[0]
    if "." in first:
        sid, _, trans = first.partition(".")
        return sid, trans
    # A SID ends in a digit ("PHL4"); a plain waypoint doesn't.
    return (first, "") if re.search(r"\d$", first) else ("", "")


def _wrap_route(route, width=24):
    out, cur = [], ""
    for tok in route.split():
        if len(cur) + len(tok) + 1 > width:
            out.append(cur)
            cur = tok
        else:
            cur = f"{cur} {tok}".strip()
    if cur:
        out.append(cur)
    return out


def build_pdc(xml_root, gate=""):
    """
    Assemble a PDC from an already-fetched SimBrief OFP.

    Returns both the structured fields (for the DCL REQUEST page) and the
    formatted message lines (for the response page).

    Departure frequency is NOT looked up: the original tool downloaded and
    cached the OurAirports CSV for it, which needs writable disk that a
    Railway container doesn't keep across deploys. It reads "SEE SID"
    instead of guessing a frequency.
    """
    try:
        orig_icao = _xt(xml_root, ".//origin/icao_code").upper()
        dest_icao = _xt(xml_root, ".//destination/icao_code").upper()
        orig_iata = _xt(xml_root, ".//origin/iata_code").upper() or orig_icao[1:]
        dest_iata = _xt(xml_root, ".//destination/iata_code").upper() or dest_icao[1:]
        flt_num = _xt(xml_root, ".//general/flight_number")
        icao_al = _xt(xml_root, ".//general/icao_airline")
        iata_al = _xt(xml_root, ".//general/airline")
        route = _xt(xml_root, ".//general/route")
        ac_icao = _xt(xml_root, ".//aircraft/icaocode", ".//aircraft/icao_code")
        sched_out = _xt(xml_root, ".//times/sched_out")

        try:
            cruise_ft = int(_xt(xml_root, ".//general/initial_altitude") or 0)
        except ValueError:
            cruise_ft = 0
        cruise = str(cruise_ft // 100) if cruise_ft >= 1000 else "---"

        digits = re.sub(r"\D", "", flt_num) or "0000"
        # SimBrief gives the filed callsign directly under <atc>; only build
        # one from the airline code if that's missing.
        callsign = _xt(xml_root, ".//atc/callsign").upper() or \
            f"{(icao_al or iata_al or 'XXX').upper()}{digits}"

        # SimBrief has no squawk field, so one is assigned here.
        squawk = _xt(xml_root, ".//atc/squawk", ".//general/squawk") or _make_squawk(callsign)

        ptime = ""
        if sched_out and sched_out.isdigit():
            ptime = datetime.fromtimestamp(int(sched_out), tz=timezone.utc).strftime("%H%M")

        # Prefer SimBrief's own SID field; fall back to parsing the route only
        # when it's absent. An empty sid_ident means a DCT departure, so
        # "CLEARED AS FILED" is correct rather than a parsing failure.
        sid = _xt(xml_root, ".//general/sid_ident").upper()
        trans = ""
        if not sid:
            sid, trans = _extract_sid(route, orig_icao)
        cleared = (f"CLEARED {sid} DEPARTURE" + (f" {trans} TRSN" if trans else "")) if sid else "CLEARED AS FILED"
        floor = _TYPICAL_INITIAL_ALT.get(orig_icao, _DEFAULT_FLOOR)

        toks = route.upper().split()
        if toks and (toks[0] == orig_icao or "/" in toks[0]):
            toks = toks[1:]
        route_lines = _wrap_route(f"{orig_icao} {' '.join(toks)}")

        day = datetime.now(timezone.utc).strftime("%d").lstrip("0")
        lines = [
            f"FLIGHT {digits}/{day} {orig_iata}-{dest_iata}",
            "PDC",
            f"{callsign} XPNDR {squawk}",
            f"{ac_icao}/L P{ptime or '----'} {cruise}",
            "",
            *route_lines,
            "",
            cleared,
            "CLIMB VIA SID",
            f"MAINTAIN {floor}FT",
            f"EXP {cruise} 10 MIN AFT DP",
            "DPFRQ SEE SID",
        ]
        if gate:
            lines.insert(3, f"GATE {gate.upper()}")
        lines.append("END")

        return {
            "callsign": callsign, "flight": digits,
            "origin": orig_icao, "dest": dest_icao,
            "squawk": squawk, "sid": sid or "AS FILED", "sid_trans": trans,
            "cruise": cruise, "initial_alt": floor,
            "ptime": ptime, "aircraft": ac_icao, "gate": gate.upper(),
            "lines": lines,
        }
    except Exception as e:
        print(f"[ERROR] build_pdc failed: {type(e).__name__}: {e}", flush=True)
        return {"error": "PDC BUILD FAILED"}
