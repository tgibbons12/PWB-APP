"""
takeoff_perf_core.py

Pure computation/generation layer extracted from TAKEOFF_PERF.py.
All tkinter GUI code (AppWindow and the tkinter-based select_output_folder)
has been removed. Every one of the 20 functions below is unchanged from the
original file except select_output_folder(), which no longer opens a folder
picker — see the bottom of this file for the replacement.

Requires SPEEDOTHER.py, TRIMSETTING.py, and ENGINEFAILPROC.py to be present
alongside this file (same as the original script). These were not provided
during extraction, so this module raises a clear ImportError at import time
until they're added, rather than failing deep inside generate_tps().
"""

import xml.etree.ElementTree as ET
import json
from datetime import datetime
import random
import pytz
import urllib.request
import urllib.error
import ssl
import os
import re
import textwrap

try:
    from SPEEDOTHER import get_speed_other, get_reduced_thrust_n1
    from TRIMSETTING import get_trim_setting
    from ENGINEFAILPROC import get_airport_specific_altitudes
except ImportError as e:
    raise ImportError(
        "takeoff_perf_core.py requires SPEEDOTHER.py, TRIMSETTING.py, and "
        "ENGINEFAILPROC.py in the same directory. Copy them in from the "
        f"original TAKEOFF_PERF.py project before starting the server. ({e})"
    ) from e

# Config file to store last used folder
CONFIG_FILE = "takeoff_perf_config.json"
REVISION_FILE = "takeoff_perf_revisions.json"

# OOOI log path (written by flight_logger.lua)
OOOI_LOG_PATH = os.path.expanduser("~/Dropbox/ACARS/oooi_log.txt")

def parse_oooi_text(text):
    """
    Parse oooi_log.txt CONTENT (not a path) and return off_block time,
    total_fuel_lbs, and zfw_lbs. Split out from read_oooi_log() so the
    server can parse text handed to it by a browser (which has direct
    access to the user's local oooi_log.txt via the File System Access
    API folder handle) without needing filesystem access to a path that
    only exists on someone's local machine.
    """
    result = {"off_block": None, "total_fuel_lbs": None, "zfw_lbs": None}
    if not text:
        return result

    # Off Block time
    m = re.search(r"Off Block:\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", text)
    if m:
        result["off_block"] = m.group(1)

    # Total fuel — matches "Total:    7403 lbs" under the Fuel section
    m = re.search(r"Fuel\s*\n-+\nTotal:\s+(\d+)\s+lbs", text)
    if m:
        result["total_fuel_lbs"] = float(m.group(1))

    # ZFW cross-check — matches "ZFW:      125824 lbs"
    m = re.search(r"ZFW:\s+(\d+)\s+lbs", text)
    if m:
        result["zfw_lbs"] = float(m.group(1))

    return result


def read_oooi_log(path=OOOI_LOG_PATH):
    """
    Read oooi_log.txt from a local filesystem path and parse it.
    Only meaningful when this process can see that path directly (e.g.
    running on the same machine as the Dropbox folder) — on a server
    deployment, that path doesn't exist and this always returns empty
    values. Use parse_oooi_text() instead when the file's content is
    already available (e.g. read client-side and sent to the server).
    """
    if not os.path.exists(path):
        return {"off_block": None, "total_fuel_lbs": None, "zfw_lbs": None}
    with open(path) as f:
        text = f.read()
    return parse_oooi_text(text)

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_config(data):
    try:
        existing = load_config()
        existing.update(data)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(existing, f)
    except Exception as e:
        print(f"Error saving config: {e}")

# ====================================================================================
# TLR RAW-TEXT PARSER & INTERPOLATION ENGINE
#
# Parses the full multi-weight performance tables out of the raw TLR text block
# (the text that accompanies the <tlr_section> XML).  Tables look like:
#
#   ---- DRY RWY - PTOW - CALM WIND ----
#   RWY  MTOW  MT  CONFIG  FLP  V1  VR  V2  LIMIT
#   08R  1763  45  D-TO1 - BLEEDS ON  5  147  148  155  CLB
#   ...
#   ---- DRY RWY - PTOW PLUS 4000 - CALM WIND ----
#   ...
#   ---- WET RWY - PTOW - CALM WIND ----
#   ...
#
# After parsing, call interpolate_tlr_speeds(tlr_tables, runway_id, surface, tow_lbs)
# to get interpolated V1/VR/V2/MTOW for any arbitrary TOW.
# ====================================================================================

# (re is imported at the top of this file now, alongside the other stdlib imports)

def parse_tlr_raw_text(raw_text):
    """
    Parse the raw TLR text block into a nested dict:

        tlr_tables[surface][condition][runway_id] = list of row dicts
        
    Where:
        surface    : 'DRY' | 'WET'
        condition  : 'PTOW' | 'PTOW+4000'   (the two weight columns)
        runway_id  : e.g. '08R', '27', etc.
        row dict   : { 'mtow': float (lbs),  # MTOW in lbs (raw value × 1000)
                       'mt':   int,           # assumed/flex temp
                       'config': str,
                       'flaps': str,
                       'v1': int, 'vr': int, 'v2': int,
                       'limit': str }

    The MTOW column in the TLR is in thousands of lbs (e.g. 1763 → 1,763,000 lbs).
    We keep it in those units to match the rest of the script (weights in lbs × 1000).
    """
    if not raw_text:
        return {}

    tables = {}

    # Section header patterns:
    # "DRY RWY - PTOW - CALM WIND"
    # "DRY RWY - PTOW PLUS 4000 - CALM WIND"
    # "WET RWY - PTOW - CALM WIND"
    # "WET RWY - PTOW PLUS 4000 - CALM WIND"
    section_re = re.compile(
        r'-+\s*(DRY|WET)\s+RWY\s*[-–]\s*PTOW(\s+PLUS\s+4000)?\s*[-–]\s*CALM\s+WIND\s*-+',
        re.IGNORECASE
    )

    # Data row pattern — runway id followed by numeric columns then a limit code word
    # RWY  MTOW  MT  CONFIG (may include "- BLEEDS ON")  FLP  V1  VR  V2  LIMIT
    # Example: "08R  1763  45  D-TO1 - BLEEDS ON  5  147  148  155  CLB"
    row_re = re.compile(
        r'^(\w{2,3})\s+'          # runway id (e.g. 08R, 27)
        r'(\d{3,4})\s+'           # MTOW (thousands lbs)
        r'(\d{1,3})\s+'           # MT (assumed temp)
        r'(FLEX|TOGA|D-TO\d?|TO\d?)'   # config base (FLEX, TOGA, D-TO, D-TO1, TO …)
        r'(\s*-\s*BLEEDS\s+ON)?'  # optional "- BLEEDS ON" (captured as group)
        r'\s+(\d{1,2})\s+'        # flaps
        r'(\d{2,3})\s+'           # V1
        r'(\d{2,3})\s+'           # VR
        r'(\d{2,3})\s+'           # V2
        r'(\w+)',                  # LIMIT code
        re.IGNORECASE
    )

    lines = raw_text.splitlines()
    current_surface = None
    current_condition = None

    for line in lines:
        line = line.strip()

        # Check for section header
        m = section_re.search(line)
        if m:
            current_surface = m.group(1).upper()          # 'DRY' or 'WET'
            current_condition = 'PTOW+4000' if m.group(2) else 'PTOW'

            # Ensure nested dicts exist
            tables.setdefault(current_surface, {})
            tables[current_surface].setdefault(current_condition, {})
            continue

        if current_surface is None:
            continue

        # Try to match a data row
        m = row_re.match(line)
        if m:
            rwy_id     = m.group(1).upper()
            mtow_raw   = int(m.group(2))
            mt         = int(m.group(3))
            config     = m.group(4).upper()
            bleeds_on  = m.group(5) is not None
            flaps      = m.group(6)
            v1         = int(m.group(7))
            vr         = int(m.group(8))
            v2         = int(m.group(9))
            limit      = m.group(10).upper()

            row = {
                'mtow':      mtow_raw,
                'mt':        mt,
                'config':    config,
                'bleeds_on': bleeds_on,
                'flaps':     flaps,
                'v1':        v1,
                'vr':        vr,
                'v2':        v2,
                'limit':     limit,
            }

            tables[current_surface][current_condition].setdefault(rwy_id, []).append(row)

    return tables


def interpolate_tlr_speeds(tlr_tables, runway_id, surface, tow, force_condition=None):
    """
    Interpolate V1/VR/V2 and pick the right config/limit for a given TOW.

    Args:
        tlr_tables  : dict returned by parse_tlr_raw_text()
        runway_id   : e.g. '08R'
        surface     : 'DRY' or 'WET'  (case-insensitive)
        tow         : planned takeoff weight in the SAME units as MTOW in the table
                      (i.e. the raw 4-digit value, e.g. 1538 for 1,538,000 lb)

    Returns:
        dict with keys: v1, vr, v2, mtow, config, flaps, limit, mt, condition
        or None if lookup fails.

    Logic:
        1.  Try 'PTOW' table first (planned weight baseline).
        2.  If tow > PTOW MTOW for that runway, try 'PTOW+4000' table.
        3.  Within the chosen table, sort rows by MTOW and interpolate linearly
            between the two rows that bracket the requested TOW.
        4.  If TOW is below the lowest table entry, use the lowest row (conservative).
        5.  If TOW exceeds the highest table entry MTOW, flag but still return
            the highest-weight row (crew/dispatcher will see MTOW exceeded).
    """
    if not tlr_tables:
        return None

    surface = surface.upper()
    runway_id = runway_id.upper()

    surface_data = tlr_tables.get(surface)
    if not surface_data:
        # Fallback: try DRY if WET not found (or vice-versa)
        surface_data = tlr_tables.get('DRY') or tlr_tables.get('WET')
    if not surface_data:
        return None

    def _lookup(condition_key):
        cond_data = surface_data.get(condition_key, {})
        rows = cond_data.get(runway_id)
        if not rows:
            # Try stripping leading zeros: '08R' vs '8R'
            for key in cond_data:
                if key.lstrip('0') == runway_id.lstrip('0'):
                    rows = cond_data[key]
                    break
        return rows

    def _interpolate_rows(rows, tow_val):
        """Linear interpolation across sorted rows keyed on MTOW."""
        rows_sorted = sorted(rows, key=lambda r: r['mtow'])

        # Below lowest — clamp to first row
        if tow_val <= rows_sorted[0]['mtow']:
            result = dict(rows_sorted[0])
            result['_extrapolated'] = False
            return result

        # Above highest — clamp to last row (over-weight situation)
        if tow_val >= rows_sorted[-1]['mtow']:
            result = dict(rows_sorted[-1])
            result['_over_mtow'] = (tow_val > rows_sorted[-1]['mtow'])
            result['_extrapolated'] = False
            return result

        # Find bracketing pair
        for i in range(len(rows_sorted) - 1):
            lo = rows_sorted[i]
            hi = rows_sorted[i + 1]
            if lo['mtow'] <= tow_val <= hi['mtow']:
                # Interpolation fraction
                span = hi['mtow'] - lo['mtow']
                frac = (tow_val - lo['mtow']) / span if span else 0.0

                def interp_int(key):
                    return int(round(lo[key] + frac * (hi[key] - lo[key])))

                # For non-numeric fields, pick the hi row values
                # (conservative — higher weight row)
                result = {
                    'mtow':      tow_val,
                    'mt':        interp_int('mt'),
                    'config':    hi['config'],
                    'bleeds_on': hi.get('bleeds_on', True),
                    'flaps':     hi['flaps'],
                    'v1':        interp_int('v1'),
                    'vr':        interp_int('vr'),
                    'v2':        interp_int('v2'),
                    'limit':     hi['limit'],
                    '_extrapolated': False,
                    '_over_mtow': False,
                }
                return result

        return None  # should not reach here

    # --- Main selection logic ---
    ptow_rows  = _lookup('PTOW')
    ptow4_rows = _lookup('PTOW+4000')

    chosen_rows = None
    chosen_condition = None

    if force_condition:
        # Explicit scenario — use that specific table directly
        forced_rows = _lookup(force_condition)
        if forced_rows:
            chosen_rows = forced_rows
            chosen_condition = force_condition
        else:
            chosen_rows = ptow_rows or ptow4_rows
            chosen_condition = 'PTOW' if ptow_rows else 'PTOW+4000'
    elif ptow_rows:
        # Auto-select: PTOW preferred, fall back if TOW exceeds its MTOW
        max_ptow_mtow = max(r['mtow'] for r in ptow_rows)
        if tow <= max_ptow_mtow:
            chosen_rows = ptow_rows
            chosen_condition = 'PTOW'
        elif ptow4_rows:
            chosen_rows = ptow4_rows
            chosen_condition = 'PTOW+4000'
        else:
            chosen_rows = ptow_rows
            chosen_condition = 'PTOW'
    elif ptow4_rows:
        chosen_rows = ptow4_rows
        chosen_condition = 'PTOW+4000'

    if not chosen_rows:
        return None

    result = _interpolate_rows(chosen_rows, tow)
    if result:
        result['condition'] = chosen_condition
        result['surface']   = surface
        result['runway']    = runway_id
    return result


def get_tlr_speeds_for_runway(tlr_tables, runway_id, surface, tow, force_condition=None):
    """
    Convenience wrapper used by generate_combined_output().
    Returns a dict ready to plug into the runway dict fields (v1/vr/v2/max_weight/limit_code),
    or None if the TLR tables are empty / the runway is not found.

    The caller should use this to OVERRIDE the SimBrief XML speeds whenever TLR data
    is available and the user changes the takeoff weight.
    """
    result = interpolate_tlr_speeds(tlr_tables, runway_id, surface, tow, force_condition=force_condition)
    if result is None:
        return None

    # Warn about over-MTOW situation
    if result.get('_over_mtow'):
        print(f"[TLR] WARNING: TOW {tow} exceeds highest MTOW in {surface} {result['condition']} "
              f"table for runway {runway_id}. Using max-weight row — verify with dispatch.")

    return {
        'v1':         result['v1'],
        'vr':         result['vr'],
        'v2':         result['v2'],
        'max_weight': result['mtow'],
        'limit_code': result['limit'],
        'flex':       str(result['mt']),       # assumed temp goes into flex field
        'flaps':      result['flaps'],
        'config':     result['config'],
        'thr':        result['config'],        # derate label used by thrust lookup
        'bleed':      'ON' if result.get('bleeds_on', True) else 'OFF',
        '_tlr_condition': result['condition'],
        '_tlr_surface':   result['surface'],
    }

def safe_float(value, default=0.0):
    try:
        return float(value) if value else default
    except (ValueError, TypeError):
        return default

def sanitize_for_imessage(text):
    """Strip characters that break the iMessage/ACARS print pipeline (ported as-is from AERODATA.py)."""
    replacements = {
        '’': "'", '‘': "'",
        '“': '"', '”': '"',
        '–': '-', '—': '-',
        '°': 'deg',
        'é': 'e', 'è': 'e',
        'à': 'a', 'â': 'a',
        'ô': 'o',
        '•': '*',
        '±': '+/-',
        '→': '->',
        '\xa0': ' ',
    }
    for orig, repl in replacements.items():
        text = text.replace(orig, repl)
    return text.encode('ascii', errors='replace').decode('ascii').replace(b'?'.decode(), '?')


# ====================================================================================
# RUNWAY INDEX — intersection data from runway_index.dat
# Format: ICAO;RWY[_TXWY];TORA_m;TODA_m;ASDA_m;LDA_m;elev;slope
# ====================================================================================

_runway_index_cache = None

def load_runway_index():
    """Load runway_index.dat from script directory. Cached after first load."""
    global _runway_index_cache
    if _runway_index_cache is not None:
        return _runway_index_cache

    dat_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runway_index.dat')
    index = {}  # (icao, rwy_base) -> list of {'taxiway': str, 'tora_ft': float}

    if not os.path.exists(dat_path):
        print(f"[INTXN] runway_index.dat not found at {dat_path}")
        _runway_index_cache = index
        return index

    with open(dat_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(';')
            if len(parts) < 4:
                continue
            icao     = parts[0].upper()
            rwy_raw  = parts[1].upper()
            try:
                tora_m = float(parts[2])
            except ValueError:
                continue
            tora_ft = tora_m * 3.28084

            if '_' in rwy_raw:
                rwy_base, taxiway = rwy_raw.split('_', 1)
            else:
                rwy_base  = rwy_raw
                taxiway   = None   # full-length entry — skip, SimBrief provides this

            if taxiway is None:
                continue

            key = (icao, rwy_base)
            index.setdefault(key, []).append({'taxiway': taxiway, 'tora_ft': tora_ft})

    print(f"[INTXN] Loaded runway_index.dat: {len(index)} runway entries")
    _runway_index_cache = index
    return index


def reset_runway_index_cache():
    """
    Clear the cached runway index so the next load_runway_index() call
    re-reads runway_index.dat from disk. Needed after an admin uploads a
    replacement file — without this, the old in-memory index would keep
    being served until the process restarts (Railway doesn't restart the
    dyno on its own just because a file on disk changed).
    """
    global _runway_index_cache
    _runway_index_cache = None


def get_intersection_groups(icao, rwy_id, full_tora_ft, distance_reject_ft, index_data):
    """
    Return up to 3 intersection groups (X/Y/Z) for a runway.

    Filtering : intersection tora_ft >= distance_reject_ft
    Grouping  : 10% bands of full_tora_ft, most restrictive (min tora) per band
    Sorting   : descending tora (X = longest remaining)
    Returns   : list of dicts:
                  { 'suffix': 'X'|'Y'|'Z',
                    'id':     rwy_id + suffix  e.g. '31LX',
                    'tora_ft': float,           # min tora in group (most restrictive)
                    'taxiways': ['JA','JB','Y'] }
    """
    if not index_data or full_tora_ft <= 0:
        return []

    # Strip any intersection suffix from rwy_id to get base (e.g. '27LX' -> '27L')
    rwy_base = rwy_id.upper()

    entries = index_data.get((icao.upper(), rwy_base), [])
    if not entries:
        return []

    # Log all entries, flagging those below the reject distance (informational only — all are shown)
    print(f"[INTXN] {icao} {rwy_id}: {len(entries)} raw entries, dist_reject={distance_reject_ft:.0f}ft")
    for e in sorted(entries, key=lambda x: x['tora_ft'], reverse=True):
        flag = "SHORT" if e['tora_ft'] < distance_reject_ft else "OK"
        print(f"[INTXN]   {flag}  {e['taxiway']:6s}  {e['tora_ft']:.0f}ft")
    valid = entries  # show all intersections regardless of reject distance

    # Group into 10%-TORA bands, max 2 intersections per band.
    # Matches AAL published grouping: band ceiling fixed at first entry,
    # new band when gap > 10% of full TORA OR band already has 2 entries.
    # e.g. JFK 31L: JA/JB/Y share a band (all within 10%) but cap=2 forces
    # Y into band 1... actually cap=2 would split JA/JB | Y/K | KD/KE.
    # AAL result (JA/JB/Y | K/KD | KE) requires cap=3 on band 0 (within 10%
    # of 14111) but cap=2 on band 1 (K/KD/KE span 872ft < 10%).
    # Simplest faithful rule: 10% band, max 3 per band, but also break when
    # gap to NEXT entry > gap to PREVIOUS entry by >50% (outlier gap detection).
    # For 31L: K→KD=452, KD→KE=420 — no outlier. Falls back to max-3 → 2 groups.
    #
    # The only rule that mechanically produces AAL's exact result:
    # cap=3 entries per band AND break if intra-band gap > 500ft.
    # JFK 31L gaps: JA→JB=325, JB→Y=676>500 → would break JB/Y. Still wrong.
    #
    # Conclusion: use 10% band + cap=3. Accept that KE groups with K/KD (2 groups).
    # To force 3 groups, override: if the resulting Y band has 3 entries AND
    # the last entry's gap from the 2nd entry > 400ft, split it off to Z.
    band_width = full_tora_ft * 0.10
    MAX_PER_BAND = 3
    SPLIT_GAP_FT = 400   # split last entry of a full band into new band if gap > this
    valid_sorted = sorted(valid, key=lambda e: e['tora_ft'], reverse=True)

    bands = []   # list of lists
    for entry in valid_sorted:
        placed = False
        for band in bands:
            band_ceil = band[0]['tora_ft']
            if (band_ceil - entry['tora_ft']) <= band_width and len(band) < MAX_PER_BAND:
                band.append(entry)
                placed = True
                break
        if not placed:
            bands.append([entry])

    # Post-process: if a band has MAX_PER_BAND entries and the gap between
    # entries [-2] and [-1] exceeds SPLIT_GAP_FT, split the last entry off.
    final_bands = []
    for band in bands:
        if len(band) == MAX_PER_BAND:
            gap = band[-2]['tora_ft'] - band[-1]['tora_ft']
            if gap > SPLIT_GAP_FT:
                final_bands.append(band[:-1])
                final_bands.append([band[-1]])
                continue
        final_bands.append(band)
    bands = final_bands

    # Take top 3 bands
    bands = bands[:3]
    print(f"[INTXN] {len(bands)} bands after grouping (max 3 per band):")
    for i, band in enumerate(bands):
        print(f"[INTXN]   band {i}: {[e['taxiway'] for e in band]}")
    suffixes = ['X', 'Y', 'Z']

    groups = []
    for i, band in enumerate(bands):
        most_restrictive = min(e['tora_ft'] for e in band)
        taxiways = [e['taxiway'] for e in sorted(band, key=lambda e: e['tora_ft'], reverse=True)]
        groups.append({
            'suffix':   suffixes[i],
            'id':       rwy_base + suffixes[i],
            'tora_ft':  most_restrictive,
            'taxiways': taxiways,
            'valid':    most_restrictive >= distance_reject_ft,
        })

    return groups

def save_last_folder(folder):
    """Save the last used folder to config file."""
    save_config({'last_folder': folder})

def get_next_revision(flight_number, origin, dest, date):
    """Get the next revision number for a flight and increment it."""
    flight_key = f"{flight_number}_{origin}_{dest}_{date}"
    
    revisions = {}
    if os.path.exists(REVISION_FILE):
        try:
            with open(REVISION_FILE, 'r') as f:
                revisions = json.load(f)
        except Exception as e:
            print(f"Error reading revisions: {e}")
    
    # Get current revision (default to 0)
    current_revision = revisions.get(flight_key, 0)
    
    # Increment for next use
    revisions[flight_key] = current_revision + 1
    
    # Save updated revisions
    try:
        with open(REVISION_FILE, 'w') as f:
            json.dump(revisions, f, indent=2)
    except Exception as e:
        print(f"Error saving revisions: {e}")
    
    return current_revision

def select_output_folder():
    """
    Server version: no folder picker (there's no user sitting at this process).
    Returns a fixed, writable output directory, creating it if needed.
    Set OUTPUT_DIR env var to override; defaults to ./generated_output next
    to this file, which works both locally and on Railway (ephemeral but
    writable container filesystem — see app.py for why that's fine here:
    every generated file is read back and returned in the response, not
    relied upon to persist between requests).
    """
    folder = os.environ.get(
        "OUTPUT_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated_output")
    )
    os.makedirs(folder, exist_ok=True)
    return folder

def fetch_xml_from_api(username):
    """Fetch XML data from SimBrief API."""
    url = f"https://www.simbrief.com/api/xml.fetcher.php?username={username}"
    
    # Create unverified context
    context = ssl._create_unverified_context()
    
    try:
        with urllib.request.urlopen(url, context=context) as response:
            return ET.parse(response)
    except urllib.error.URLError as e:
        print(f"Error fetching data: {e}")
        return None
    except ET.ParseError as e:
        print(f"Error parsing XML: {e}")
        return None

def get_xml_value(element, default="0"):
    """Safely extract integer value from XML element."""
    return int(element.text) if element is not None and element.text.isdigit() else int(default)

def is_valid_runway(runway):
    v1 = runway.findtext('speeds_v1', '')
    vr = runway.findtext('speeds_vr', '')
    v2 = runway.findtext('speeds_v2', '')
    max_weight = runway.findtext('max_weight', '0')
    
    try:
        weight = float(max_weight) if max_weight else 0
        return True  # Accept all runways
    except ValueError:
        return False

def calculate_weights(oew, pax_count, pax_weight, cargo, plan_ramp, enroute_burn):
    """Calculate basic weight values."""
    zfw = oew + (pax_count * pax_weight) + cargo
    tow = zfw + plan_ramp
    ldw = tow - enroute_burn
    return zfw, tow, ldw

def calculate_availability(actual, maximum):
    """Calculate available margin."""
    return maximum - actual if maximum > actual else 0

def calculate_cargo_distribution(total_cargo):
    """Calculate forward and aft cargo distribution."""
    cargo_per_section = round(total_cargo / 2 / 200) * 200
    fwd_cargo = cargo_per_section + random.choice([-200, 0, 200])
    aft_cargo = total_cargo - fwd_cargo
    return fwd_cargo, aft_cargo

def get_utc_time():
    """Get current time in UTC."""
    return datetime.now(pytz.UTC).strftime('%H:%M UTC')

def extract_text(xml_root, tag, default=None):
    elem = xml_root.find(tag)
    if elem is not None and elem.text is not None:
        return elem.text.strip()
    return default

def safe_int(val, default=0):
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


# ====================================================================================
# XML RAW PARSER — pure data extraction, no UI
# ====================================================================================

def parse_xml_raw(xml_root, date, aircraft_type):
    """Extract all raw values from SimBrief XML. No dialog, no weight calculation."""

    def get_text(parent, tag, default='0'):
        el = parent.find(tag) if parent is not None else None
        return el.text.strip() if el is not None and el.text else default

    def safe_int(val, default=0):
        try: return int(val)
        except: return default

    general     = xml_root.find('general')
    fuel        = xml_root.find('fuel')
    weights     = xml_root.find('weights')
    destination = xml_root.find('destination')
    alternate   = xml_root.find('alternate')
    aircraft    = xml_root.find('aircraft')
    conditions  = xml_root.find('.//conditions')

    # TLR raw text
    tlr_section_elem = xml_root.find('.//tlr_section')
    tlr_raw = tlr_section_elem.text.strip() if tlr_section_elem is not None and tlr_section_elem.text else ""
    if tlr_raw:
        print(f"[TLR] Found raw TLR text in XML ({len(tlr_raw)} chars)")
    else:
        print("[TLR] No <tlr_section> element found in XML")

    # XML planned values
    pax_count_xml  = safe_int(get_text(weights, 'pax_count'))
    pax_weight     = safe_int(get_text(weights, 'pax_weight', '190'))
    cargo_xml      = safe_int(get_text(weights, 'cargo'))
    plan_ramp_xml  = safe_int(get_text(fuel, 'plan_ramp'))
    taxi_fuel      = safe_int(get_text(fuel, 'taxi'))
    oew            = safe_int(get_text(weights, 'oew', '0'))
    enroute_burn   = safe_int(get_text(fuel, 'enroute_burn'))
    max_zfw        = safe_int(get_text(weights, 'max_zfw'))
    max_tow        = safe_int(get_text(weights, 'max_tow'))
    max_ldw        = safe_int(get_text(weights, 'max_ldw'))
    max_tow_struct = safe_int(get_text(weights, 'max_tow_struct'))
    est_tow_xml    = safe_int(get_text(weights, 'est_tow'))
    est_zfw_xml    = safe_int(get_text(weights, 'est_zfw'))
    plan_takeoff   = safe_int(get_text(fuel, 'plan_takeoff'))

    # Anti-ice
    first_runway = xml_root.find('.//tlr/takeoff//runway')
    anti_ice_setting = 'OFF'
    if first_runway is not None:
        ai_elem = first_runway.find('anti_ice_setting')
        if ai_elem is not None and ai_elem.text:
            anti_ice_setting = ai_elem.text.strip().upper()
    anti_ice_on = (anti_ice_setting not in ('OFF', ''))

    # Surface / conditions
    surface_condition = get_text(conditions, 'surface_condition', 'dry').lower()

    # Engine
    acdata_parsed = xml_root.find('.//api_params/acdata_parsed')
    # The element can EXIST but be empty (<acdata_parsed/>), in which case
    # .text is None — the old `is not None` check only guarded against the
    # element being absent, so an empty one crashed on .strip(). It can also
    # contain something that isn't valid JSON. Neither is fatal: engine_type
    # falls back to UNKNOWN, so degrade rather than failing the whole parse.
    acdata = {}
    if acdata_parsed is not None and acdata_parsed.text and acdata_parsed.text.strip():
        try:
            acdata = json.loads(acdata_parsed.text.strip())
        except (ValueError, TypeError) as _e:
            print(f"[WARN] acdata_parsed is not valid JSON, ignoring: {_e}", flush=True)
            acdata = {}
    engine_type = acdata.get('comments', 'UNKNOWN') if isinstance(acdata, dict) else 'UNKNOWN'

    # Runways
    icaocode_early = get_text(aircraft, 'icaocode', aircraft_type)
    valid_runways = []
    for runway in xml_root.findall('.//tlr/takeoff//runway'):
        if is_valid_runway(runway):
            def get_val(tag, default='0', _rwy=runway):
                elem = _rwy.find(tag)
                return elem.text.strip() if elem is not None and elem.text is not None else default
            try:
                hd_value = float(get_val('headwind_component', '0'))
            except (ValueError, TypeError):
                hd_value = 0.0

            # v_other / v_other_id: SimBrief XML sometimes omits these — fall
            # back to SPEEDOTHER.get_speed_other() the same way AERODATA.py does.
            v_other    = get_val('v_other', None)
            v_other_id = get_val('v_other_id', None)
            if not v_other or v_other == '0' or v_other == 'None':
                try:
                    speed_result = get_speed_other(icaocode_early, weight=est_tow_xml)
                    if speed_result and isinstance(speed_result, dict):
                        v_other_id = speed_result.get('name', 'VFS')
                        v_other    = str(speed_result.get('speed', 'XXX'))
                    else:
                        v_other_id = 'VFS'
                        v_other    = 'XXX'
                except (TypeError, ValueError, AttributeError) as e:
                    print(f"[WARNING] SPEEDOTHER.py failed for {icaocode_early}: {e}")
                    v_other_id = 'VFS'
                    v_other    = 'XXX'
            v_other    = str(v_other)    if v_other    else 'XXX'
            v_other_id = str(v_other_id) if v_other_id else 'VFS'

            valid_runways.append({
                'id':               get_val('identifier', 'XX'),
                'slope':            get_val('gradient', '0'),
                'flaps':            get_val('flap_setting', ''),
                'v1':               get_val('speeds_v1', '0'),
                'vr':               get_val('speeds_vr', '0'),
                'v2':               get_val('speeds_v2', '0'),
                'v_other':          v_other,
                'v_other_id':       v_other_id,
                'vfs':              v_other,
                'headwind':         get_val('headwind_component', '0'),
                'crosswind':        get_val('crosswind_component', '0'),
                'wind_dir':         get_val('wind_direction', '0'),
                'thr':              get_val('thrust_setting', 'xxx'),
                'flex':             get_val('flex_temperature', 'XXX'),
                'length':           get_val('length', '0'),
                'bleed':            get_val('bleed_setting', 'ON'),
                'max_weight':       int(float(get_val('max_weight', '0')) / 1000),
                'max_tow_struct':   max_tow_struct / 1000,
                'elevation':        float(get_val('elevation', '0')),
                'limit_code':       get_val('limit_code', ''),
                'HD':               hd_value,
                'magnetic_course':  get_val('magnetic_course', '0'),
                'internal_code':    get_val('limit_code', 'A'),
                'distance_reject':  safe_int(get_val('distance_reject', '0')),
            })

    # Crew count
    crew_section = xml_root.find('crew')
    crew_count = 0
    if crew_section is not None:
        for et in ['cpt', 'fo', 'fa']:
            crew_count += len(crew_section.findall(et))
    if crew_count == 0:
        crew_count = 6

    # TLR tables
    tlr_tables = parse_tlr_raw_text(tlr_raw)
    if tlr_tables:
        total = sum(len(rd) for s in tlr_tables.values() for rd in s.values())
        print(f"[TLR] Parsed performance tables: {total} runways across surfaces {list(tlr_tables.keys())}")
    else:
        print("[TLR] No raw TLR text tables found — SimBrief XML speeds used as-is.")

    # Origin / destination
    origin_element      = xml_root.find('origin')
    destination_element = xml_root.find('destination')
    alternate_element   = xml_root.find('alternate')
    origin_icao  = get_text(origin_element, 'icao_code', 'XXX')
    origin_iata  = get_text(origin_element, 'iata_code', 'XXX')
    plan_rwy     = get_text(origin_element, 'plan_rwy', '')
    dest_icao    = get_text(destination_element, 'icao_code', 'XXX')
    dest_iata    = get_text(destination_element, 'iata_code', 'XXX')
    altn_icao    = get_text(alternate_element, 'icao_code', 'XXX')
    alternate_burn = safe_int(get_text(fuel, 'alternate_burn'))
    reserve        = safe_int(get_text(fuel, 'reserve'))

    xml_data = {
        # identity
        'flight_number': get_text(general, 'flight_number', 'UNKNOWN'),
        'icao_airline': get_text(general, 'icao_airline', ''),
        'RLS': get_text(general, 'release', 'UNKNOWN'),
        'date': date,
        'aircraft_type': aircraft_type,
        'icaocode':   get_text(aircraft, 'icaocode'),
        'base_type':  get_text(aircraft, 'base_type', 'XXX'),
        'AC_name':    get_text(aircraft, 'name', 'XXX'),
        'registration': get_text(aircraft, 'reg', 'UNKNOWN'),
        'fin':          get_text(aircraft, 'fin', 'UNKNOWN'),
        'engine_type':  engine_type,
        # airports
        'origin_icao': origin_icao,
        'origin_iata': origin_iata,
        'plan_rwy':    plan_rwy,
        'dest_icao':   dest_icao,
        'dest_iata':   dest_iata,
        'altn_icao':   altn_icao,
        # weights (XML planned)
        'pax_count_xml':  pax_count_xml,
        'pax_weight':     pax_weight,
        'cargo_xml':      cargo_xml,
        'plan_ramp_xml':  plan_ramp_xml,
        'taxi_fuel':      taxi_fuel,
        'oew':            oew,
        'enroute_burn':   enroute_burn,
        'max_zfw':        max_zfw,
        'max_tow':        max_tow,
        'max_ldw':        max_ldw,
        'max_tow_struct': max_tow_struct,
        'est_tow_xml':    est_tow_xml,
        'est_zfw_xml':    est_zfw_xml,
        'plan_takeoff':   plan_takeoff,
        # conditions
        'surface': surface_condition,
        'temp':    get_text(conditions, 'temperature', '0'),
        'qnh':     get_text(conditions, 'altimeter', '0'),
        'wind':    f"{get_text(conditions,'wind_direction')}/{get_text(conditions,'wind_speed')}",
        'airport_iata': get_text(conditions, 'airport_iata', 'XXXX'),
        # nav/routing
        'cruise_fl':     safe_int(get_text(general, 'initial_altitude')) // 100,
        'cost_index':    safe_int(get_text(general, 'costindex')),
        'route':         get_text(general, 'route', ''),
        'avg_temp_dev':  get_text(general, 'avg_temp_dev', 'xx'),
        'altn_fuel':     alternate_burn,
        'reserve_fuel':  alternate_burn + reserve,
        'final_reserve': reserve,
        'mtof':          safe_int(get_text(fuel, 'min_takeoff')),
        # runtime
        'anti_ice_on':  anti_ice_on,
        'valid_runways': valid_runways,
        'tlr_tables':    tlr_tables,
        'crew_count':    crew_count,
        # Destination landing data — see LANDING_PERF_DESIGN.md. Purely
        # additive: nothing in the takeoff path reads this.
        'landing':       _parse_landing_block(xml_root),
    }
    return xml_data


def _parse_landing_block(xml_root):
    """
    Extract <tlr><landing> from the SimBrief OFP.

    Gives the destination's runway geometry (LDA, gradient, wind components,
    max landing weight) plus SimBrief's own planned VREF and dry/wet distances.
    Those distances are for the ONE weight/condition SimBrief planned — they are
    a cross-check, not a substitute for a real landing calculation, which is why
    the CDU computes its own figures and shows these alongside.

    Returns {} when the OFP carries no landing block rather than raising: a
    missing landing section must never break the takeoff path.
    """
    landing = xml_root.find('.//tlr/landing')
    if landing is None:
        return {}

    def txt(node, tag, default=''):
        if node is None:
            return default
        el = node.find(tag)
        return el.text.strip() if el is not None and el.text is not None else default

    def num(node, tag, default=None):
        raw = txt(node, tag, '')
        try:
            return float(raw)
        except (TypeError, ValueError):
            return default

    def distance_set(tag):
        d = landing.find(tag)
        if d is None:
            return {}
        return {
            'weight':           num(d, 'weight'),
            'flap_setting':     txt(d, 'flap_setting'),
            'brake_setting':    txt(d, 'brake_setting'),
            'reverser_credit':  txt(d, 'reverser_credit'),
            'vref':             num(d, 'speeds_vref'),
            'actual_distance':  num(d, 'actual_distance'),
            'factored_distance': num(d, 'factored_distance'),
        }

    cond = landing.find('conditions')
    runways = []
    for r in landing.findall('runway'):
        rid = txt(r, 'identifier')
        if not rid:
            continue
        runways.append({
            'id':              rid,
            'length':          num(r, 'length'),
            # LDA is the number that matters for landing — NOT tora/toda.
            'lda':             num(r, 'length_lda'),
            'elevation':       num(r, 'elevation'),
            'gradient':        num(r, 'gradient'),
            'magnetic_course': num(r, 'magnetic_course'),
            'headwind':        num(r, 'headwind_component'),
            'crosswind':       num(r, 'crosswind_component'),
            'ils':             txt(r, 'ils_frequency'),
            'max_weight_dry':  num(r, 'max_weight_dry'),
            'max_weight_wet':  num(r, 'max_weight_wet'),
        })

    return {
        'airport':           txt(cond, 'airport_icao'),
        'planned_runway':    txt(cond, 'planned_runway'),
        'planned_weight':    num(cond, 'planned_weight'),
        'flap_setting':      txt(cond, 'flap_setting'),
        'wind_direction':    num(cond, 'wind_direction'),
        'wind_speed':        num(cond, 'wind_speed'),
        'temperature':       num(cond, 'temperature'),
        'altimeter':         txt(cond, 'altimeter'),
        'surface_condition': txt(cond, 'surface_condition'),
        'distance_dry':      distance_set('distance_dry'),
        'distance_wet':      distance_set('distance_wet'),
        'runways':           runways,
    }


def build_weights(xml_data, pax_count, cargo, plan_ramp, cg_percent, zfw_override=None):
    """Compute ZFW/TOW/LDW from user inputs (or XML planned if no overrides)."""
    oew        = xml_data['oew']
    pax_weight = xml_data['pax_weight']
    taxi_fuel  = xml_data['taxi_fuel']
    enroute_burn = xml_data['enroute_burn']
    max_zfw    = xml_data['max_zfw']
    max_tow    = xml_data['max_tow']
    max_ldw    = xml_data['max_ldw']

    if zfw_override is not None:
        zfw = zfw_override
    else:
        zfw = oew + (pax_count * pax_weight) + cargo

    tow = zfw + (plan_ramp - taxi_fuel)
    ldw = tow - enroute_burn

    lap_infants = random.randint(int(pax_count * 0.03), int(pax_count * 0.04))
    fwd_cargo, aft_cargo = calculate_cargo_distribution(cargo)

    # XML planned for delta comparison
    zfw_xml = xml_data['oew'] + (xml_data['pax_count_xml'] * pax_weight) + xml_data['cargo_xml']
    tow_xml = zfw_xml + (xml_data['plan_ramp_xml'] - taxi_fuel)

    print(f"\n=== CALCULATED WEIGHTS ===")
    print(f"ZFW: {zfw} (was {zfw_xml})")
    print(f"TOW: {tow} (was {tow_xml})")
    print(f"LDW: {ldw}")
    print(f"==================\n")

    uplink_data = {
        'flight_number': xml_data['flight_number'],
        'icao_airline':  xml_data['icao_airline'],
        'date':          xml_data['date'],
        'origin_icao':   xml_data['origin_icao'],
        'origin_iata':   xml_data['origin_iata'],
        'destination':   xml_data['dest_icao'],
        'dest_icao':     xml_data['dest_icao'],
        'dest_iata':     xml_data['dest_iata'],
        'altn':          xml_data['altn_icao'],
        'AC_name':       xml_data['AC_name'],
        'base_type':     xml_data.get('base_type', 'XXX'),
        'aircraft_type': xml_data['aircraft_type'],
        'registration':  xml_data['registration'],
        'icaocode':      xml_data['icaocode'],
        'cost_index':    xml_data['cost_index'],
        'cruise_fl':     xml_data['cruise_fl'],
        'ats_route':     xml_data['route'],
        'tc_oat':        xml_data['avg_temp_dev'],
        'taxi_fuel':     taxi_fuel,
        'trip_fuel':     enroute_burn,
        'altn_fuel':     xml_data['altn_fuel'],
        'reserve_fuel':  xml_data['reserve_fuel'],
        'final_reserve': xml_data['final_reserve'],
        'block_fuel':    plan_ramp,
        'ptof':          xml_data['plan_takeoff'],
        'mtof':          xml_data['mtof'],
        'ptow':          tow,
        'pzfw':          zfw,
        'pldw':          ldw,
        'airport':       xml_data['airport_iata'],
        'engine':        xml_data['engine_type'],
        'temp':          xml_data['temp'],
        'qnh':           xml_data['qnh'],
        'wind':          xml_data['wind'],
        'surface':       xml_data['surface'],
    }

    loadsheet_data = {
        'Time Generated': get_utc_time(),
        'Flight Number':  xml_data['flight_number'],
        'Ship Number':    xml_data['fin'],
        'RLS':            xml_data.get('RLS', 'UNKNOWN'),
        'origin':         xml_data['origin_icao'],
        'origin_iata':    xml_data['origin_iata'],
        'Destination':    xml_data['dest_icao'],
        'destination_iata': xml_data['dest_iata'],
        'TOW':            tow,
        'MAX TOW':        max_tow,
        'MAX TOW STRUCT': xml_data['max_tow_struct'],
        'FOB':            plan_ramp - taxi_fuel,
        'ZFW':            zfw,
        'OEW':            oew,
        'Passengers':     pax_count,
        'LAP':            lap_infants,
        'FWD Cargo':      fwd_cargo,
        'AFT Cargo':      aft_cargo,
        'Total Cargo':    cargo,
        'ZFW AVAIL':      max_zfw - zfw,
        'TOW AVAIL':      max_tow - tow,
        'LDW AVAIL':      max_ldw - ldw,
        'PTOW':           xml_data['est_tow_xml'],
        'ZFW Change':     zfw - zfw_xml,
        'TOW Change':     tow - tow_xml,
        'PAX Change':     pax_count - xml_data['pax_count_xml'],
        'FUEL Change':    plan_ramp - xml_data['plan_ramp_xml'],
        'CARGO Change':   cargo - xml_data['cargo_xml'],
        'MAX ZFW':        max_zfw,
        'LDW':            ldw,
        'MAX LDW':        max_ldw,
        'Enroute Burn':   enroute_burn,
        'Passenger Weight': pax_weight,
        'Crew Count':     xml_data['crew_count'],
    }

    return uplink_data, loadsheet_data


# ====================================================================================
# GENERATE TPS — writes takeoff performance page only
# ====================================================================================

def generate_tps(loadsheet_data, uplink_data, valid_runways, anti_ice_on, output_folder, cg_percent, tlr_tables=None, label_suffix="", tlr_scenario_active=False, force_tlr_condition=None, new_tps_warning=False, revision_number=None):
    """Write the TPS takeoff file. Returns filepath."""
    from TRIMSETTING import get_trim_setting
    from ENGINEFAILPROC import get_airport_specific_altitudes
    from SPEEDOTHER import get_speed_other, get_reduced_thrust_n1

    tow_for_interp = loadsheet_data.get("TOW", 0)
    surface_for_interp = uplink_data.get("surface", "dry").upper()
    tow_scaled = tow_for_interp / 100.0
    print(f"[TLR] TOW lookup: raw={tow_for_interp} lbs → scaled={tow_scaled:.1f} (hundreds), surface={surface_for_interp}")

    if tlr_tables:
        # Debug: show MTOW range in table so we can verify unit scale matches tow_scaled
        try:
            sample_surface = list(tlr_tables.keys())[0]
            sample_cond    = list(tlr_tables[sample_surface].keys())[0]
            sample_rwy     = list(tlr_tables[sample_surface][sample_cond].keys())[0]
            sample_mtows   = sorted(r['mtow'] for r in tlr_tables[sample_surface][sample_cond][sample_rwy])
            if sample_mtows:
                print(f"[TLR] Table sample ({sample_surface}/{sample_cond}/{sample_rwy}): MTOW range {sample_mtows[0]}–{sample_mtows[-1]}")
            else:
                print(f"[TLR] Table sample ({sample_surface}/{sample_cond}/{sample_rwy}): no rows parsed — check TLR row format/regex")
        except (IndexError, KeyError) as _e:
            print(f"[TLR] Table structure debug skipped: {_e}")
        updated_runways = []
        for rwy in valid_runways:
            rwy_id = rwy.get("id", "")
            tlr_override = get_tlr_speeds_for_runway(tlr_tables, rwy_id, surface_for_interp, tow_scaled, force_condition=force_tlr_condition)
            if tlr_override:
                merged = dict(rwy)
                merged["v1"]         = tlr_override["v1"]
                merged["vr"]         = tlr_override["vr"]
                merged["v2"]         = tlr_override["v2"]
                merged["max_weight"] = tlr_override["max_weight"] / 10.0
                merged["limit_code"] = tlr_override["limit_code"]
                merged["flaps"]      = tlr_override["flaps"]
                merged["flex"]       = tlr_override["flex"]
                merged["thr"]        = tlr_override["thr"]
                merged["bleed"]      = tlr_override["bleed"]
                merged["_tlr_condition"] = tlr_override.get("_tlr_condition", "")
                merged["_tlr_surface"]   = tlr_override.get("_tlr_surface", "")
                cond = tlr_override.get('_tlr_condition', '?')
                print(f"[TLR] RWY {rwy_id}: TLR interpolated ({surface_for_interp}/{cond}): "
                      f"V1={tlr_override['v1']} VR={tlr_override['vr']} V2={tlr_override['v2']} "
                      f"MTOW={tlr_override['max_weight']} LIMIT={tlr_override['limit_code']}")
                # Re-apply any widget overrides — user edits win over TLR table values.
                # _widget_overrides is set by _get_selected_runways; flex='' means TOGA.
                for _wk, _wv in rwy.get('_widget_overrides', {}).items():
                    merged[_wk] = _wv
                    print(f"[TLR] RWY {rwy_id}: widget override {_wk}={_wv!r} applied over TLR")
                updated_runways.append(merged)
            elif rwy.get('_full_tora_ft') is not None:
                # This runway entry is an INTERSECTION takeoff (app.py set
                # _full_tora_ft when substituting the reduced TORA — see
                # /api/generate). SimBrief's XML-provided V1/VR/V2 are
                # computed for the FULL-length runway, not this shortened
                # distance. Takeoff performance (V-speeds and MTOW) is
                # runway-remaining-dependent — that's the whole reason TLR
                # tables publish separate rows per intersection — so falling
                # back to full-length speeds for a shorter runway would
                # silently understate required V-speeds / overstate MTOW.
                # There is no other runway-remaining-based performance
                # source in this codebase to correct for that safely, so
                # this must hard-stop rather than guess.
                raise ValueError(
                    f"No TLR data found for intersection takeoff at {rwy_id}. "
                    f"Takeoff performance depends on runway remaining, and only "
                    f"full-length speeds are available for this runway — select "
                    f"FULL or a different intersection with published TLR data."
                )
            else:
                print(f"[TLR] RWY {rwy_id}: no TLR table match — keeping SimBrief XML speeds.")
                updated_runways.append(rwy)
        valid_runways = updated_runways

    # ---- E-JET RULES (E170 / E175 / E190 / E195 / E290 family) ----
    # SimBrief never provides TO2 data; we apply it manually when conditions allow.
    # TO2 is permitted ONLY when ALL of the following are true:
    #   - Full-length runway (id does not end in X/Y/Z)
    #   - No tailwind > 5 kt  (HD < -5)
    #   - Flap setting is not 4
    #   - Limit code is not performance-limiting (FLD, OBS, PDR, AFM)
    # Otherwise TO1 is kept.
    EJET_ICAOS = {'E170', 'E175', 'E190', 'E195', 'E290', 'E295', 'E17X', 'E19X'}
    _ejet_icao = uplink_data.get('icaocode', '').upper()
    # SimBrief reports this airframe's ICAO code as E75L/E75S/E75W (and
    # E70x/E90x/E95x for the others) — none of which start "E1"/"E2", so the
    # old check made is_ejet FALSE for every real E175 flight and skipped the
    # TO1/TO2 thrust logic entirely. base_type carries the clean family code
    # ("E175"), so test that too rather than trying to enumerate every variant.
    _ejet_base = str(uplink_data.get('base_type', '') or '').upper()
    is_ejet = (
        _ejet_icao in EJET_ICAOS
        or _ejet_base in EJET_ICAOS
        or bool(re.match(r'^E(7[05][A-Z]|9[05][A-Z]|1[79]\d|2[9]\d)$', _ejet_icao))
    )

    if is_ejet:
        import re as _re_ejet
        tow_lbs_check = loadsheet_data.get('TOW', 0)
        updated_ejet = []
        for rwy in valid_runways:
            rwy = dict(rwy)
            rwy_id = rwy.get('id', '')

            if str(rwy.get('thr', '')).upper().strip() in ('TO1', 'D-TO1'):
                # Evaluate each inhibiting condition
                is_intersection = bool(_re_ejet.search(r'[XYZ]$', rwy_id.upper()))

                hd = 0.0
                try: hd = float(rwy.get('HD', 0))
                except: pass
                has_tailwind = hd < -5.0

                try:
                    flap_val = int(float(str(rwy.get('flaps', '0')).strip()))
                except: flap_val = 0
                is_flap4 = (flap_val == 4)

                raw_limit = rwy.get('limit_code', '').upper().strip()
                LIMITING_CODES = {'FLD', 'OBS', 'PDR', 'AFM'}
                is_limited = raw_limit in LIMITING_CODES

                if is_intersection or has_tailwind or is_flap4 or is_limited:
                    reasons = []
                    if is_intersection: reasons.append('intersection')
                    if has_tailwind:    reasons.append(f'tailwind {abs(hd):.0f}kt')
                    if is_flap4:        reasons.append('flap 4')
                    if is_limited:      reasons.append(f'limit={raw_limit}')
                    print(f"[EJET] RWY {rwy_id} : TO1 kept — {', '.join(reasons)}")
                else:
                    rwy['thr'] = 'TO2'
                    print(f"[EJET] RWY {rwy_id} : TO1 → TO2 (favorable conditions)")

            # Log 90% MTOW check
            rwy_mtow_lbs = float(rwy.get('max_weight', 0)) * 1000.0
            if rwy_mtow_lbs > 0 and tow_lbs_check >= rwy_mtow_lbs * 0.90:
                print(f"[EJET] RWY {rwy_id} : TOW {tow_lbs_check} >= 90% of MTOW {rwy_mtow_lbs:.0f} — flagging")
                rwy['_ejet_weight_warn'] = True

            updated_ejet.append(rwy)
        valid_runways = updated_ejet

    speed_other_data = None
    n1_pack_on = "XXX"
    n1_pack_off = "XXX"
    reduced_n1 = "XXX"
    reduced_n1_pack_off = "XXX"
    epr_max = "XXX"
    epr_takeoff = "XXX"
    alt_val = 0
    reduced_n1_valid = False

    def safe_weight(weight):
        try: return float(weight) / 1000.0
        except (ValueError, TypeError): return 0.0

    def safe_int_local(val):
        try:
            if val is None or val == "": return 0
            return int(float(val))
        except Exception: return 0

    base_filename = (
        f"{loadsheet_data['Flight Number']}_{uplink_data['origin_icao']}"
        f"_{datetime.now().strftime('%Y%m%d')}{label_suffix}_TAKEOFF.txt"
    )
    takeoff_file = os.path.join(output_folder, base_filename)
    icaocode     = uplink_data.get("icaocode", "XXXX")
    trim_data    = get_trim_setting(icaocode, cg_percent)

    if revision_number is None:
        revision_number = get_next_revision(
            loadsheet_data['Flight Number'],
            uplink_data.get('origin_icao', 'XXX'),
            uplink_data.get('dest_icao', 'XXX'),
            datetime.now().strftime('%Y%m%d')
        )
    print(f"📋 Revision number for this TPS: {revision_number:02d}")

    cg_display = f"{cg_percent:.1f}" if cg_percent is not None else ""

    # ---- FUEL VARIANCE CHECK ----
    # Skip this check when a TLR scenario is active — the scenario intentionally
    # changes the fuel baseline (e.g. PTOW+4000), so the delta is expected.
    if not tlr_scenario_active:
        try:
            fuel_change = abs(float(loadsheet_data.get('FUEL Change', 0)))
            if fuel_change > 2000:
                with open(takeoff_file, 'w') as file:
                    orig_icao_rej    = uplink_data.get('origin_icao', '')
                    registration_rej = uplink_data.get('registration', 'UNKNOWN')
                    icao_airline_rej = uplink_data.get('icao_airline', '')
                    flt_num_rej_raw  = loadsheet_data.get('Flight Number', '')
                    try:
                        flt_num_rej = str(int(flt_num_rej_raw)).zfill(4)
                    except (ValueError, TypeError):
                        flt_num_rej = flt_num_rej_raw
                    now_utc_rej  = datetime.now(pytz.UTC)
                    hdr_date_rej = now_utc_rej.strftime('%d%b%y').upper()
                    hdr_time_rej = now_utc_rej.strftime('%H%M') + 'Z'
                    header_line_rej = f".{registration_rej} {orig_icao_rej} {icao_airline_rej}{flt_num_rej}".ljust(26) + f"{hdr_date_rej} {hdr_time_rej}"
                    file.write(f"{header_line_rej}\n")
                    file.write("**** THIS TPS DOES NOT SATISFY THE ****\n")
                    file.write("*** REQUIREMENTS OF A LOAD CLOSEOUT ***\n\n")
                    file.write("*** NOTIFICATION MESSAGE ***\n")
                    file.write("TAKEOFF DATA REJECTED BY FMC, ACTUAL FUEL\n")
                    file.write("ONBOARD DIFFERS FROM PLANNED AND EXCEEDS\n")
                    file.write("TOLERANCES. REQUEST TAKEOFF DATA WHEN\n")
                    file.write("FUELING IS COMPLETE\n")
                    file.write("AUTOMATED FLT OPS MESSAGE\n\n")
                print(f"⚠️  FUEL VARIANCE EXCEEDS 2000 LBS")
                return takeoff_file
        except (ValueError, TypeError) as e:
            print(f"[DEBUG] Fuel variance check skipped: {e}")

    with open(takeoff_file, 'w') as file:
        flt_num      = loadsheet_data.get('Flight Number', '')
        orig_iata    = uplink_data.get('origin_iata', '')
        dest_iata    = uplink_data.get('dest_iata', '')
        orig_icao    = uplink_data.get('origin_icao', '')
        registration = uplink_data.get('registration', 'XXXXX')
        icao_airline = uplink_data.get('icao_airline', '')

        # zero-pad flight number to 4 digits (also reused below for the FLT lines)
        try:
            flt_num_display = str(int(flt_num)).zfill(4)
        except (ValueError, TypeError):
            flt_num_display = flt_num

        # ACARS-style tail/station/callsign/date-time header — comes before everything else.
        # Format: ".{TAIL} {ICAO} {AIRLINE}{FLT}    {DDMONYY} {HHMMZ}"  (UTC, generated now)
        now_utc   = datetime.now(pytz.UTC)
        hdr_date  = now_utc.strftime('%d%b%y').upper()
        hdr_time  = now_utc.strftime('%H%M') + 'Z'
        header_line = f".{registration} {orig_icao} {icao_airline}{flt_num_display}".ljust(26) + f"{hdr_date} {hdr_time}"
        file.write(f"{header_line}\n")

        file.write(f"FLT {flt_num_display} {orig_iata}-{dest_iata}\n")
        file.write(f"FLT {flt_num_display} {orig_iata}-{dest_iata}\n")
        file.write("\n")
        file.write("**** THIS TPS DOES NOT SATISFY THE ****\n")
        file.write("*** REQUIREMENTS OF A LOAD CLOSEOUT ***\n\n")

        tow      = loadsheet_data.get('TOW', 0)
        max_tow  = loadsheet_data.get('MAX TOW', 0)
        zfw      = loadsheet_data.get('ZFW', 0)
        max_zfw  = loadsheet_data.get('MAX ZFW', 0)
        ldw      = loadsheet_data.get('LDW', 0)
        max_ldw  = loadsheet_data.get('MAX LDW', 0)

        tow_avail = max_tow - tow
        zfw_avail = max_zfw - zfw
        ldw_avail = max_ldw - ldw
        tow_margin = tow_avail - 2000
        zfw_margin = zfw_avail - 1000
        ldw_margin = ldw_avail - 1000

        print(f"\n=== WEIGHT MARGINS DEBUG ===")
        print(f"TOW Available: {tow_avail} lbs (need 2000 margin)")
        print(f"ZFW Available: {zfw_avail} lbs (need 1000 margin)")
        print(f"LDW Available: {ldw_avail} lbs (need 1000 margin)")
        print(f"TOW Margin: {tow_margin}")
        print(f"ZFW Margin: {zfw_margin}")
        print(f"LDW Margin: {ldw_margin}")
        print(f"===========================")

        # Determine limiting restriction.
        # max_tow from SimBrief is the PERFORMANCE max TOW (not structural).
        # If tow > max_tow → performance MTOW-L is the binding limit.
        # Structural TOW/ZFW/LDW are checked separately via their own fields.
        weight_restricted = False
        limiting_restriction = ""
        _max_tow_perf = loadsheet_data.get('MAX TOW', 0)       # performance MTOW from SimBrief
        _max_tow_struct = loadsheet_data.get('MAX TOW STRUCT', 0)  # structural MTOW
        _mtow_perf_margin = _max_tow_perf - tow - 2000 if _max_tow_perf > 0 else 9999
        _zfw_struct_margin = loadsheet_data.get('MAX ZFW', 0) - zfw - 1000
        _ldw_struct_margin = loadsheet_data.get('MAX LDW', 0) - ldw - 1000
        _tow_struct_margin = _max_tow_struct - tow - 2000 if _max_tow_struct > 0 else 9999
        print(f"[RESTRICTION] perf_mtow={_max_tow_perf} tow={tow} perf_margin={_mtow_perf_margin}")
        print(f"[RESTRICTION] struct_tow_margin={_tow_struct_margin} zfw_margin={_zfw_struct_margin} ldw_margin={_ldw_struct_margin}")
        # Performance MTOW-L fires first; then structural limits
        if _mtow_perf_margin < 0:
            weight_restricted = True
            limiting_restriction = "MTOW-L"
        else:
            struct_margins = {"TOW": _tow_struct_margin, "ZFW": _zfw_struct_margin, "LDW": _ldw_struct_margin}
            worst = min(struct_margins, key=struct_margins.get)
            if struct_margins[worst] < 0:
                weight_restricted = True
                limiting_restriction = worst

        if weight_restricted:
            # Fixed-width 39-char box (including the * borders)
            BOX = "***************************************"
            def _boxline(text):
                # centre text in 37 chars, odd space always goes LEFT (before text)
                import math as _m
                pad_total = 37 - len(text)
                pad_left  = _m.ceil(pad_total / 2)
                pad_right = pad_total - pad_left
                return f"*{' ' * pad_left}{text}{' ' * pad_right}*\n"

            file.write(_boxline("****** WEIGHT RESTRICTED FLIGHT *****"))
            file.write(_boxline(f"LIMITING RESTRICTION -- {limiting_restriction}"))
            file.write(_boxline("PLEASE UPDATE ACTUAL FOB IMMEDIATELY"))
            file.write(_boxline("AFTER FUELING VIA ACARS"))
            file.write(_boxline("OR CONTACT LOAD AGENT"))
            file.write(f"***************************************\n\n")

        sta      = uplink_data.get('origin_iata', 'XXXX')
        _flt_raw = uplink_data.get('flight_number', 'ERR')
        try:
            flt_dte = str(int(_flt_raw)).zfill(4)
        except (ValueError, TypeError):
            flt_dte = _flt_raw
        airpl    = loadsheet_data.get('Ship Number', 'ERR')
        dte_time = loadsheet_data.get('Time Generated', 'ERR')
        surface  = uplink_data.get('surface', 'dry').upper()
        temp     = uplink_data.get('temp', 'XX')
        alt      = valid_runways[0].get('elevation', 0) if valid_runways else 0

        try:
            qnh = float(uplink_data.get('qnh', 29.92))
        except (ValueError, TypeError):
            qnh = 29.92
        pressure_alt = int(alt + (29.92 - qnh) * 1000)

        date_str   = datetime.now().strftime("%d")
        time_parts = dte_time.replace(' UTC', '').replace(':', '')

        file.write(f"STA  PRESALT  FLT/DTE  AIRPL  DTE/TIME\n")
        file.write(f"{sta:<4} {pressure_alt:<8} {flt_dte}/{date_str:<2}  {airpl:<5} {date_str}/{time_parts}Z\n\n")

        weight = loadsheet_data.get("TOW", 0)

        ac_name    = uplink_data.get("AC_name", "")
        engine_name = uplink_data.get("engine", "")
        is_sfp = (icaocode == "B738") and ("SFP" in ac_name.upper() or "SFP" in engine_name.upper())
        sfp_bump = False

        speed_other_data = None
        n1_pack_on = "XXX"; n1_pack_off = "XXX"
        reduced_n1 = "XXX"; reduced_n1_pack_off = "XXX"
        epr_max = "XXX"; epr_takeoff = "XXX"
        thrust_rating = 26; thrust_label = "26K"
        reduced_n1_valid = False

        if valid_runways:
            try: alt_val = float(valid_runways[0].get('elevation', 0))
            except: alt_val = 0

        is_737_ng    = icaocode in ['B736', 'B737', 'B738', 'B739']
        is_737_max   = icaocode == 'B38M'
        is_boeing_737 = is_737_ng or is_737_max
        is_md83       = icaocode == 'MD83'
        ERJ_TYPES     = {'E135', 'E140', 'E145', 'E45X'}
        is_erj        = icaocode in ERJ_TYPES

        if alt_val <= 8000:   pack_off_adj = 0.8
        elif alt_val <= 9000: pack_off_adj = 0.9
        else:                 pack_off_adj = 1.0

        rwy = valid_runways[0] if valid_runways else {}
        derate_label = rwy.get('thr', '').upper().strip()

        if is_sfp:
            sfp_bump = derate_label in ('TO-B', 'BUMP')

        THRUST_TABLE = {
            "B736": {"D-TO": 22, "D-TO1": 20, "D-TO2": 18},
            "B737": {"D-TO": 24, "D-TO1": 22, "D-TO2": 20},
            "B738": {"D-TO": 26, "D-TO1": 24, "D-TO2": 22},
            "B739": {"D-TO": 27, "D-TO1": 25, "D-TO2": 23},
            "B38M": {"TO": 26, "TO1": 24, "TO2": 22},
        }

        if is_boeing_737 and icaocode in THRUST_TABLE:
            key = derate_label.replace("D-", "") if is_737_max else derate_label
            effective_thrust = THRUST_TABLE[icaocode].get(key) or list(THRUST_TABLE[icaocode].values())[0]
            if sfp_bump:
                effective_thrust = 27; thrust_label = "27K BUMP"
            elif is_737_max:
                thrust_label = key if key in ["TO", "TO1", "TO2"] else "TO"
            else:
                thrust_label = f"{effective_thrust}K"
        else:
            effective_thrust = None; thrust_label = "N/A"

        if is_md83:
            epr_max_data = get_speed_other(icaocode, oat=temp, altitude=alt_val)
            if epr_max_data and 'epr' in epr_max_data:
                epr_max = epr_max_data['epr']
            flex_temp = rwy.get('flex')
            if flex_temp and str(flex_temp).strip() not in ['', 'XX', 'XXX']:
                try:
                    ft_int = int(flex_temp)
                    etd = get_speed_other(icaocode, oat=temp, altitude=alt_val, assumed_temp=ft_int)
                    epr_takeoff = etd['epr'] if etd and 'epr' in etd else epr_max
                except: epr_takeoff = epr_max
            else:
                epr_takeoff = epr_max
            speed_other_data = get_speed_other(icaocode, weight=weight)

        elif is_boeing_737:
            speed_other_data = get_speed_other(icaocode, oat=temp, altitude=alt_val, weight=weight,
                                               thrust_rating=effective_thrust if effective_thrust else 26)
            n1_pack_on  = speed_other_data.get('n1', 'XXX') if speed_other_data else "XXX"
            n1_pack_off = speed_other_data.get('n1_pack_off', 'XXX') if speed_other_data else "XXX"
            flex_temp = rwy.get('flex')
            if sfp_bump:
                reduced_n1 = n1_pack_on; reduced_n1_pack_off = n1_pack_off; reduced_n1_valid = False
            elif flex_temp and str(flex_temp).strip() not in ['', 'XX', 'XXX']:
                try:
                    ft_int = int(flex_temp)
                    rnd = get_reduced_thrust_n1(icaocode, effective_thrust, ft_int, alt_val)
                    if rnd and 'n1' in rnd:
                        reduced_n1 = rnd['n1']
                        reduced_n1_pack_off = round(float(reduced_n1) - pack_off_adj, 1)
                        reduced_n1_valid = True
                    else:
                        reduced_n1 = n1_pack_on; reduced_n1_pack_off = n1_pack_off
                except: reduced_n1 = n1_pack_on; reduced_n1_pack_off = n1_pack_off
        else:
            speed_other_data = get_speed_other(icaocode, weight=weight)

        if is_boeing_737:
            engine_display = f"{engine_name} {thrust_label}"
        elif is_md83:
            engine_display = engine_name
        else:
            engine_display = engine_name

        line = f"*** {engine_display} {surface} ***"
        file.write(f"{line.center(40)}\n\n")

        tow_lbs = loadsheet_data.get('TOW', 0)
        zfw_lbs = loadsheet_data.get('ZFW', 0)
        fob_lbs = loadsheet_data.get('FOB', 0)
        taxi_fuel_value = uplink_data.get('taxi_fuel', 0)
        tow_t  = round(tow_lbs / 1000.0, 1)
        zfw_t  = round(zfw_lbs / 1000.0, 1)
        atow_t = round(tow_t + 2.0, 1)
        rls_fuel_lbs   = uplink_data.get('block_fuel', fob_lbs + taxi_fuel_value)
        takeoff_fuel_t = round(rls_fuel_lbs / 1000.0, 1)
        taxi_fuel_t    = round(taxi_fuel_value / 1000.0, 1)

        # --- Pre-compute MTOW-L so ATOW can be corrected before printing ---
        _max_ldw_lbs  = loadsheet_data.get('MAX LDW', 0)
        _enroute_burn = loadsheet_data.get('Enroute Burn', 0)
        _ldg_fuel_lbs = fob_lbs - taxi_fuel_value - _enroute_burn
        _plw_lbs      = zfw_lbs + max(_ldg_fuel_lbs, 0)
        _ldw_buffer   = _max_ldw_lbs - _plw_lbs
        _landing_limited = _max_ldw_lbs > 0 and _ldw_buffer < 2000
        if _landing_limited:
            _struct_lbs_full = float(loadsheet_data.get('MAX TOW STRUCT', 0))
            _mtow_l_lbs = _max_ldw_lbs + _enroute_burn
            _atow_lbs_capped = min(tow_lbs + 2000, _mtow_l_lbs)
            atow_t = round(_atow_lbs_capped / 1000.0, 1)
            print(f"[MTOW-L] Landing limited: PLW={_plw_lbs} MLW={_max_ldw_lbs} buffer={_ldw_buffer} → ATOW capped to {atow_t}")

        # --- ATOW cap: if any limiting MTOW < ATOW, clamp ATOW down to MTOW ---
        if valid_runways:
            _rwy0 = valid_runways[0]
            _mtow_pre = float(_rwy0.get('max_weight', 0))   # already in thousands
            if _mtow_pre > 0 and _mtow_pre < atow_t:
                print(f"[ATOW] MTOW {_mtow_pre} < ATOW {atow_t} → clamping ATOW to {_mtow_pre}")
                atow_t = _mtow_pre

        file.write(f"   TEMP    PTOW    ATOW    ZFW     FUEL\n")
        file.write(f"   {temp+'C':<8}{tow_t:<8.1f}{atow_t:<8.1f}{zfw_t:<8.1f}{takeoff_fuel_t:.1f}P\n\n")
        file.write(f" TXI FUEL\n")
        file.write(f"{str(taxi_fuel_t).center(len(' TXI FUEL'))}\n\n")
        file.write("*********** THRUST / V-SPEED **********\n")
        if anti_ice_on:
            file.write("  *****************\n")
            file.write("   * ANTI-ICE ON *\n")
            file.write("  *****************\n")
        file.write("\n")

        AIRBUS_TYPES = {'A318', 'A319', 'A320', 'A20N', 'A321', 'A21N', 'A332', 'A333', 'A339', 'A346'}
        is_airbus = icaocode.upper() in AIRBUS_TYPES

        if is_md83:
            if trim_data:
                trim_display = trim_data.get('trim', 'X.X')
                file.write(f"         *MAX* EPR    TOW CG  STAB\n")
                epr_max_str = f"{epr_max:.2f}" if isinstance(epr_max, (int, float)) else epr_max
                file.write(f"      A/C ON  {epr_max_str}    {cg_display:<6}     {trim_display}\n")
                try:
                    epr_packs_off = round(float(epr_max) + 0.02, 2)
                    file.write(f"      A/C OFF {epr_packs_off:.2f}\n\n")
                except: file.write(f"      A/C OFF XXX\n\n")
            else:
                epr_max_str = f"{epr_max:.2f}" if isinstance(epr_max, (int, float)) else epr_max
                file.write(f"         *MAX* EPR     TOW CG\n")
                file.write(f"      A/C ON  {epr_max_str}    {cg_display}\n")
                try:
                    epr_packs_off = round(float(epr_max) + 0.02, 2)
                    file.write(f"      A/C OFF {epr_packs_off:.2f}\n\n")
                except: file.write(f"      A/C OFF XXX\n\n")
            if speed_other_data and isinstance(speed_other_data.get('speed'), dict):
                vsr_val = speed_other_data['speed'].get('VsR', 'XXX')
                vmm_val = speed_other_data['speed'].get('VMM', 'XXX')
                file.write(f"      O/RET   MM\n")
                file.write(f"      {vsr_val:<6} {vmm_val}\n\n")

        elif icaocode in ['A319', 'A320', 'A321', 'A21N'] and speed_other_data and isinstance(speed_other_data.get('speed'), dict):
            if trim_data:
                file.write(f"      TOW CG       STAB\n")
                file.write(f"       {cg_display:<10} {trim_data.get('trim','X.X')}\n")
            else:
                file.write(f"      TOW CG\n")
                file.write(f"       {cg_display}\n")
            f_val  = speed_other_data['speed'].get('F', 'XXX')
            s_val  = speed_other_data['speed'].get('S', 'XXX')
            gd_val = speed_other_data['speed'].get('GRN DOT', 'XXX')
            file.write(f"       F     S    GRN DOT\n")
            file.write(f"      {f_val:<5} {s_val:<5} {gd_val:^8}\n\n")

        elif is_boeing_737:
            if trim_data:
                file.write(f"*MAX*    N1      TOW CG    STAB\n")
                file.write(f"BLD ON   {n1_pack_on:<6}   {cg_display:<6}  {trim_data.get('trim','X.X')}\n")
                file.write(f"BLD OFF  {n1_pack_off}\n\n")
            else:
                file.write(f"*MAX*    N1      TOW CG\n")
                file.write(f"BLD ON   {n1_pack_on:<6}   {cg_display}\n")
                file.write(f"BLD OFF  {n1_pack_off}\n\n")

        elif not is_erj and speed_other_data and 'name' in speed_other_data and 'speed' in speed_other_data:
            if trim_data:
                file.write(f"      {speed_other_data['name']} {speed_other_data['speed']}   TOW CG  {cg_display}   STAB {trim_data.get('trim','X.X')}\n\n")
            else:
                file.write(f"      {speed_other_data['name']} {speed_other_data['speed']}   TOW CG  {cg_display}\n")

        SPECIAL_AIRPORTS = {"SNA", "SJO", "EGE", "JAC", "GUC", "DRO",
                            "JNU", "WRG", "PSG", "TGU", "SXM", "STT", "EYW", "ASE"}
        is_airbus = icaocode.upper() in AIRBUS_TYPES
        flap_label = "CONF" if is_airbus else "FLAP"
        ac_label   = "APU"  if is_airbus else ("" if is_erj else "BLD")

        # Format flap setting with leading zero if single digit
        def _fmt_flap(f):
            try:
                n = int(float(str(f).strip()))
                return f"{n:02d}" if 0 < n < 10 else str(n)
            except Exception:
                return str(f)

        if valid_runways:
            # Wind annotation — derived from first runway (applies to all)
            _rwy0  = valid_runways[0]
            HD_val = 0
            try: HD_val = float(_rwy0.get('HD', '0'))
            except: pass
            if abs(HD_val) >= 5 and not tlr_scenario_active:
                hd_text = (f"   ***** {int(round(HD_val))} KT HEADWIND APPLIED *****"
                           if HD_val > 0 else
                           f"   ***** {abs(int(round(HD_val)))} KT TAILWIND APPLIED *****")
                file.write(f"{hd_text}\n\n")

            # Determine column label once (same for all runways)
            if is_md83:
                thr_column_label = "EPR"
            elif is_boeing_737:
                thr_column_label = "N1"
            else:
                thr_column_label = "THR"

            if is_erj:
                file.write(f"RWY  {flap_label}  V1   VR   V2  V215  VFS\n")
            else:
                file.write(f"RWY  {flap_label}  {ac_label}   {thr_column_label}   V1   VR   V2\n")

            sta_upper = uplink_data.get('origin_iata', '').upper()

            # ---- Per-runway loop ----
            for rwy in valid_runways:
                v1_str = str(safe_int_local(rwy.get('v1'))) if safe_int_local(rwy.get('v1')) > 0 else "XXX"
                vr_str = str(safe_int_local(rwy.get('vr'))) if safe_int_local(rwy.get('vr')) > 0 else "XXX"
                v2_str = str(safe_int_local(rwy.get('v2'))) if safe_int_local(rwy.get('v2')) > 0 else "XXX"

                mtow_val   = float(rwy.get('max_weight', 0))
                limit_code = {'CLB': 'T', 'OBS': 'T', 'PDR': 'T', 'AFM': 'S', 'FLD': 'X'}.get(
                    rwy.get('limit_code', '').upper(), rwy.get('limit_code', ''))

                # --- MTOW-L: dynamic landing weight limit check ---
                try:
                    landing_limited = _landing_limited
                    if landing_limited:
                        _struct_lbs_full = float(loadsheet_data.get('MAX TOW STRUCT', 0))
                        mtow_l_t = min(_mtow_l_lbs / 1000.0, _struct_lbs_full / 1000.0, mtow_val)
                        mtow_val = round(mtow_l_t, 1)
                        limit_code = 'L'
                except Exception as _e:
                    print(f"[MTOW-L] runway block calc error: {_e}")
                    landing_limited = False

                at_raw = rwy.get('flex', '')
                at_override_occurred = False
                try:
                    at_numeric = float(at_raw)
                    if at_numeric < (float(temp) + 5) or at_numeric > 99:
                        at_numeric = None
                except: at_numeric = None

                if is_md83:
                    if sta_upper in SPECIAL_AIRPORTS:        at_display = "MAX-SPCL"; at_override_occurred = True
                    elif at_numeric is None:                 at_display = "MAX-TEMP"; at_override_occurred = True
                    elif epr_takeoff == "XXX" or epr_takeoff == epr_max:
                                                             at_display = "MAX-WT";   at_override_occurred = True
                    else:                                    at_display = f"{int(at_numeric)}C"
                elif is_boeing_737:
                    if sta_upper in SPECIAL_AIRPORTS:        at_display = "MAX-SPCL"; at_override_occurred = True
                    elif not reduced_n1_valid:               at_display = "MAX-WT";   at_override_occurred = True
                    elif at_numeric is None:                 at_display = "MAX-TEMP"; at_override_occurred = True
                    else:                                    at_display = f"{int(at_numeric)}C"
                elif is_airbus:
                    if sta_upper in SPECIAL_AIRPORTS:        at_display = "MAX-SPCL"; at_override_occurred = True
                    elif at_numeric is None:                 at_display = "MAX-TEMP"; at_override_occurred = True
                    else:                                    at_display = f"{int(at_numeric)}C"
                else:
                    if sta_upper in SPECIAL_AIRPORTS:        at_display = "MAX-SPCL"; at_override_occurred = True
                    elif at_numeric is None:                 at_display = "MAX-TEMP"; at_override_occurred = True
                    else:                                    at_display = f"{int(at_numeric)}C"

                bleed = rwy.get('bleed', 'ON')
                apu_status = ('OFF' if bleed.upper() == 'ON' else 'ON') if is_airbus else bleed

                if is_md83:
                    thr_display = (f"{epr_max:.2f}" if isinstance(epr_max, (int, float)) else str(epr_max)) if at_override_occurred else \
                                  (f"{epr_takeoff:.2f}" if isinstance(epr_takeoff, (int, float)) else str(epr_takeoff))
                elif is_boeing_737:
                    thr_display = str(n1_pack_on) if at_override_occurred else str(reduced_n1)
                elif is_airbus:
                    thr_display = "TOGA" if (at_override_occurred or at_display.startswith("MAX")) else "FLEX"
                elif is_erj:
                    _ERJ_THR_MAP = {
                        'TO':       'TO1',
                        'ATO':      'TO1',
                        'ALT TO-1': 'ATO',
                        'ALT TO1':  'ATO',
                        'ALT TO':   'ATO',
                        'TO-1':     'TO1',
                        'TO1':      'TO1',
                        'TO-2':     'TO2',
                        'TO2':      'TO2',
                    }
                    _raw_thr = str(rwy.get('thr', '')).upper().strip()
                    thr_display = _ERJ_THR_MAP.get(_raw_thr, _raw_thr or 'TO1')
                else:
                    thr_display = rwy.get('thr', '') if rwy.get('thr', '') else "TOGA"

                if is_erj:
                    # Compute V215 and VFS
                    try:
                        v215_str = str(int(v2_str) + 15)
                    except (ValueError, TypeError):
                        v215_str = "XXX"
                    from SPEEDOTHER import get_speed_other as _gso
                    _vfs_data = _gso(icaocode, weight=float(loadsheet_data.get('TOW', 0)))
                    vfs_str = str(_vfs_data['speed']) if _vfs_data and 'speed' in _vfs_data else "XXX"
                    mtow_str = f"{mtow_val:.1f}{limit_code}"
                    file.write(f"{rwy['id']:<4} {_fmt_flap(rwy.get('flaps','')):<5} {v1_str:<4} {vr_str:<4} {v2_str:<4} {v215_str:<5} {vfs_str}\n")
                    file.write(f"     {thr_column_label:<8} MTOW\n")
                    file.write(f"     {thr_display:<8} {mtow_str}\n")
                else:
                    file.write(f"{rwy['id']:<4} {_fmt_flap(rwy.get('flaps','')):<5} {apu_status:<4} {thr_display:<6}{v1_str:<4} {vr_str:<4} {v2_str:<4}\n")
                    file.write(f"     AT       MTOW\n")
                    file.write(f"     {at_display:<8} {mtow_val:.1f}{limit_code}\n")
        origin_icao = uplink_data.get('origin_icao', 'XXXX')
        max_elevation = max((r.get('elevation', 0) for r in valid_runways), default=0)
        airport_altitudes = get_airport_specific_altitudes(origin_icao, max_elevation)

        if airport_altitudes and airport_altitudes.get('EFP'):
            efp_text = airport_altitudes['EFP']
            if efp_text.strip():
                file.write("\n")
                file.write("************ AIRPORT NOTES ************\n")
                import textwrap
                for line in textwrap.fill(efp_text, width=34).splitlines():
                    file.write(f" {line}\n")

        # Intersection group listing — appended to AIRPORT NOTES (no duplicate banner)
        # Suppressed for E-jet family (no intersection takeoffs permitted)
        if valid_runways and not is_ejet:
            _rwy0        = valid_runways[0]
            _rwy_base_id = _rwy0.get('id', '')
            import re as _re
            _rwy_base    = _re.sub(r'[XYZ]$', '', _rwy_base_id)
            _full_tora   = float(_rwy0.get('_full_tora_ft', _rwy0.get('length', 0)))
            _dist_reject = int(_rwy0.get('distance_reject', 0))
            _index_data  = load_runway_index()
            _groups      = get_intersection_groups(
                origin_icao, _rwy_base, _full_tora, _dist_reject, _index_data
            )
            if _groups:
                # If EFP was written, continue in same block with "." separator
                # If no EFP, open the banner fresh
                if airport_altitudes and airport_altitudes.get('EFP', '').strip():
                    file.write(" .\n")
                else:
                    file.write("\n")
                    file.write("************ AIRPORT NOTES ************\n")
                file.write(f" RWY {_rwy_base} INTXN TAKEOFFS...\n \n")
                for g in _groups:
                    txwy_str = '/'.join(g['taxiways'])
                    file.write(f"         {g['id']} FROM TXWY {txwy_str}.\n")
                file.write("\n")


        if valid_runways:
            import math as _math

            struct_wt = safe_weight(loadsheet_data.get('MAX TOW STRUCT', 0))
            # Full-width (38 char) layout when anti-ice is ON
            if anti_ice_on:
                SEP     = "--------------------------------------\n"
                DIV     = "  - - - - - - - - - - - - - - - - - - \n"
                RWY_COL = 5
                ROW_PAD = " "   # trailing space to reach 38
            else:
                SEP     = "---------------------------\n"
                DIV     = "  - - - - - - - - - - - - -\n"
                RWY_COL = 4
                ROW_PAD = ""

            FULL_SEP     = "--------------------------------------\n"
            TEMP_PENALTY = 0.3
            APU_ON_BOOST = 0.022
            try:
                oat_base = int(float(temp))
            except Exception:
                oat_base = 15
            try:
                oat_val = int(float(temp))
            except Exception:
                oat_val = 99

            # A/I sub value is aircraft-wide (structural weight), computed once
            try:
                struct_lbs = float(loadsheet_data.get('MAX TOW STRUCT', 0))
                ai_val = round(struct_lbs * 0.003 / 1000, 1)
            except Exception:
                ai_val = 0.0
            ai_fmt = f"{ai_val:.1f}".lstrip('0') or '.0'

            # --- STRUCT WT — printed once before the per-runway tables ---
            file.write("****** AIRPORT ANALYSIS DATA **********\n\n")
            file.write(f"   STRUCT WT LIMIT {struct_wt:.1f}\n\n")

            # ---- Per-runway CONF table loop ----
            for rwy in valid_runways:
                rwy_id   = rwy['id']
                flap_str = _fmt_flap(rwy.get('flaps', ''))

                # Re-derive mtow_val per runway (may differ between runways)
                rwy_mtow_val   = float(rwy.get('max_weight', 0))
                rwy_limit_code = {'CLB': 'T', 'OBS': 'T', 'PDR': 'T', 'AFM': 'S', 'FLD': 'X'}.get(
                    rwy.get('limit_code', '').upper(), rwy.get('limit_code', ''))
                try:
                    if _landing_limited:
                        _struct_lbs_full = float(loadsheet_data.get('MAX TOW STRUCT', 0))
                        mtow_l_t = min(_mtow_l_lbs / 1000.0, _struct_lbs_full / 1000.0, rwy_mtow_val)
                        rwy_mtow_val = round(mtow_l_t, 1)
                except Exception:
                    pass

                # --- CONF table header ---
                # Fixed column positions (monospace):
                # pos 0-3  : FLAP label / flap value
                # pos 4-7  : BLD label / ac_state
                # pos 8-14 : CLIMB/LIMIT (right-aligned in 6, preceded by 1 space)
                # pos 15-19: TEMP/C      (right-aligned in 4, preceded by 2 spaces)
                # pos 20+  : RWY id / weight value (preceded by 2 spaces)
                h1 = f"{'':4} {'':3} {'CLIMB':>6}  {'TEMP':>4}  RWY{ROW_PAD}"
                h2 = f"{flap_label:<4} {ac_label:<3} {'LIMIT':>6}  {'C':>4}  {rwy_id}{ROW_PAD}"
                file.write(h1 + "\n")
                file.write(h2 + "\n")
                file.write(SEP)

                # --- CONF table rows: OFF×2 then ON×2 ---
                try:
                    mw = float(rwy_mtow_val)
                except Exception:
                    mw = 0.0

                for ac_state, boost in [('OFF', 0.0), ('ON', APU_ON_BOOST)]:
                    for t_off in [0, 2]:
                        oat_disp  = oat_base + t_off - 1
                        mw_adj    = round(min(max(0.0, mw * (1 + boost) - TEMP_PENALTY * t_off), struct_wt), 1)
                        climb_lim = round(min(mw_adj - 0.1 * t_off, struct_wt), 1)
                        flap_col  = f" {flap_str}" if t_off == 0 else "    "
                        file.write(f"{flap_col:<4} {ac_state:<3} {climb_lim:>6.1f}  {oat_disp:>4}  {mw_adj:.1f}{ROW_PAD}\n")

                # --- HDWND / TLWND ---
                try:
                    mtow_lbs   = rwy_mtow_val * 1000.0
                    atow_lbs   = float(tow_for_interp) + 2000.0
                    margin_lbs = max(0.0, mtow_lbs - atow_lbs)
                    wt_frac    = margin_lbs / mtow_lbs if mtow_lbs > 0 else 0.0
                    hw_lbs = 0 if wt_frac < 0.20 else int(round(mtow_lbs * 0.00224 * (wt_frac - 0.20) * 5 / 50.0)) * 50
                    tw_lbs = int(round(mtow_lbs * 0.00224 / 10.0)) * 10 * 2
                except Exception:
                    hw_lbs = 0
                    tw_lbs = 0

                file.write(f"      {'HDWND ADD / KT':<14}   {hw_lbs:>{RWY_COL}} \n")
                file.write(f"      {'TLWND SUB / KT':<14}   {tw_lbs:>{RWY_COL}} \n")
                file.write(DIV)

                # --- E/O ACCEL ---
                if airport_altitudes:
                    eo_acc_afl = airport_altitudes.get('eo_acc', '0')
                    try:
                        elev = float(rwy.get('elevation') or 0)
                        if elev <= 0:
                            elev = float(max_elevation)
                    except Exception:
                        elev = float(max_elevation)
                    eo_acc_msl = int(_math.ceil((elev + float(eo_acc_afl)) / 10.0)) * 10
                    file.write(f"  {'E/O ACCEL /AFL/ FT':<20} {int(eo_acc_afl):>{RWY_COL}} \n")
                    file.write(f"  {'          /MSL/ FT':<20} {eo_acc_msl:>{RWY_COL}} \n")
                file.write(SEP)

                # --- LENGTH / SLOPE ---
                length_val = int(rwy.get('length', 0))
                slope_str = ".0"
                try:
                    slope_val = rwy.get('slope', rwy.get('gradient', None))
                    if slope_val is not None and str(slope_val).strip() != "":
                        sf = float(slope_val)
                        if abs(sf) >= 0.05:   # treat anything < 0.05 as flat (covers -0.0, 0.0, -0.04)
                            formatted = f"{sf:.1f}"
                            # strip leading zero but preserve negative sign: -0.3 → -.3, 0.3 → .3
                            slope_str = formatted.replace('-0.', '-.').replace('0.', '.')
                except: slope_str = "x.x"
                file.write(f"    {'LENGTH - FT':<18}{length_val:>{RWY_COL}} \n")
                file.write(f"    {'SLOPE  - PCT':<18} {slope_str:>{RWY_COL}} \n")

                # --- A/I ON SUB — only when OAT ≤ 15°C, always full-width SEP ---
                if oat_val <= 15:
                    file.write(FULL_SEP)
                    file.write(f"A/I ON SUB FROM    CLB {ai_fmt:>4}   RWY {ai_fmt:>4}\n")
                    file.write(FULL_SEP)
                else:
                    file.write(SEP)

    print(f"Takeoff data generated: {takeoff_file}")
    return takeoff_file


# ====================================================================================
# GENERATE CLOSEOUT — writes load closeout file only
# ====================================================================================

def generate_closeout(loadsheet_data, uplink_data, output_folder, cg_percent, tlr_tables=None, revision_number=None):
    """Write the closeout file. Returns filepath."""
    from TRIMSETTING import get_trim_setting

    icaocode    = uplink_data.get("icaocode", "XXXX")
    trim_data   = get_trim_setting(icaocode, cg_percent)
    cg_display  = f"{cg_percent:.1f}" if cg_percent is not None else ""

    if revision_number is None:
        revision_number = get_next_revision(
            loadsheet_data['Flight Number'],
            uplink_data.get('origin_icao', 'XXX'),
            uplink_data.get('dest_icao', 'XXX'),
            datetime.now().strftime('%Y%m%d')
        )

    base_filename = (
        f"{loadsheet_data['Flight Number']}_{uplink_data['origin_icao']}"
        f"_{datetime.now().strftime('%Y%m%d')}_CLOSEOUT.txt"
    )
    closeout_file = os.path.join(output_folder, base_filename)

    with open(closeout_file, 'w') as file:
        sections = [
            ("HEADER", [
                f"LOAD CLOSEOUT RVSN {revision_number:02d} {loadsheet_data['Time Generated']}",
                f"{loadsheet_data['Flight Number']} {loadsheet_data['origin_iata']}-{loadsheet_data['destination_iata']} N{loadsheet_data['Ship Number']}",
                "",
            ]),
            ("WEIGHTS", [
                f"TOW {loadsheet_data['TOW']}",
                f"FOB {loadsheet_data['FOB']}A",
                f"ZFW {loadsheet_data['ZFW']}",
                f"STAB {trim_data['trim'] if trim_data else ''}",
                "R/A F-NO M-NO A-NO",
                "L/A F-1 M-0 A-0",
                f"TOW CG {cg_display}",
                f"PSGR {loadsheet_data['Passengers']} W0 X0",
                f"LAP {loadsheet_data['LAP']}",
                f"CREW {loadsheet_data['Crew Count']}",
                "---------",
                f"TSOB {int(loadsheet_data['Passengers']) + int(loadsheet_data['LAP']) + int(loadsheet_data['Crew Count'])}",
                f"PSGR WGT {int(loadsheet_data['Passengers']) * int(loadsheet_data['Passenger Weight'])}",
                f"CGO WGT {loadsheet_data['Total Cargo']}",
                f"EOW {loadsheet_data['OEW']}",
                "SECOK\n",
            ]),
        ]
        for _, lines in sections:
            for line in lines:
                file.write(f"{line}\n")

    print(f"Closeout data generated: {closeout_file}")
    return closeout_file


# ====================================================================================
# GENERATE COMBINED OUTPUT — AERODATA.py's original single-file ACARS printout
# (TAKEOFF DATA + loadsheet summary combined) — ported from AERODATA.py, not
# derived from generate_tps()/generate_closeout() above. This is the format
# PWB's CDU targets; those two functions are left in place for reference /
# backward compatibility but are not called by the PWB API route.
# ====================================================================================

def generate_combined_output(loadsheet_data, uplink_data, valid_runways, anti_ice_on,
                              output_folder, cg_percent, tlr_tables=None,
                              tlr_scenario_active=False, force_tlr_condition=None, sc_extra_fuel=0):
    """
    Write the single COMBINED takeoff+loadsheet ACARS-style file, exactly as
    AERODATA.py's generate_combined_output() does. Returns
    (combined_file_path, runway_results) where runway_results is a list of
    per-runway dicts — {runway, v1, vr, v2, flex, flaps, thr, acc_alt, tr_alt,
    eo_alt, trim_stab, mrtw, n1} — computed during the same pass that writes
    the file, so the CDU can show authoritative values directly as JSON
    instead of re-parsing the printed text.

    On a fuel-variance rejection, the file contains the ACARS rejection
    notice (matching the original) and runway_results is [].
    """

    def safe_val(val, default="---"):
        try:
            return str(int(float(val)))
        except (ValueError, TypeError):
            return default

    # ── TLR interpolation (applied before writing) ──────────────────────────
    tow_for_interp     = loadsheet_data.get("TOW", 0) + sc_extra_fuel
    surface_for_interp = uplink_data.get("surface", "dry").upper()
    tow_scaled         = tow_for_interp / 100.0

    if tlr_tables and tlr_scenario_active:
        updated_runways = []
        for rwy in valid_runways:
            rwy_id = rwy.get("id", "")
            tlr_override = get_tlr_speeds_for_runway(
                tlr_tables, rwy_id, surface_for_interp, tow_scaled,
                force_condition=force_tlr_condition
            )
            if tlr_override:
                merged = dict(rwy)
                merged["v1"]         = tlr_override["v1"]
                merged["vr"]         = tlr_override["vr"]
                merged["v2"]         = tlr_override["v2"]
                merged["max_weight"] = tlr_override["max_weight"] / 100.0
                merged["limit_code"] = tlr_override["limit_code"]
                merged["flaps"]      = tlr_override["flaps"]
                merged["flex"]       = tlr_override["flex"]
                merged["thr"]        = tlr_override["thr"]
                merged["bleed"]      = tlr_override["bleed"]
                updated_runways.append(merged)
                print(f"[TLR] RWY {rwy_id}: V1={tlr_override['v1']} VR={tlr_override['vr']} "
                      f"V2={tlr_override['v2']} MTOW={tlr_override['max_weight']} "
                      f"LIMIT={tlr_override['limit_code']}")
            else:
                print(f"[TLR] RWY {rwy_id}: no TLR match — keeping SimBrief XML speeds.")
                updated_runways.append(rwy)
        valid_runways = updated_runways

    # Create file path
    base_filename = (
        f"{loadsheet_data['Flight Number']}_{uplink_data['origin_icao']}"
        f"_{datetime.now().strftime('%Y%m%d')}_COMBINED.txt"
    )
    combined_file = os.path.join(output_folder, base_filename)

    icaocode    = uplink_data.get("icaocode", "XXXX")
    trim_data   = get_trim_setting(icaocode, cg_percent)
    cg_display  = f"{cg_percent:.1f}" if cg_percent is not None else ""

    # Fuel variance check — tolerance comes from the PTOW+N offset in TLR tables
    try:
        fuel_change = abs(float(loadsheet_data.get('FUEL Change', 0)))
        _fuel_tol = 2000
        if tlr_tables:
            _surface_data = tlr_tables.get('DRY') or tlr_tables.get('WET') or {}
            _ptow_key = next((k for k in _surface_data if k.startswith('PTOW+')), None)
            if _ptow_key:
                try:
                    _fuel_tol = int(_ptow_key.split('+')[1])
                except (IndexError, ValueError):
                    pass
        _fuel_tol = max(_fuel_tol, 1000)
        if fuel_change > _fuel_tol:
            with open(combined_file, 'w') as file:
                file.write("**** THIS TPS DOES NOT SATISFY THE ****\n")
                file.write("*** REQUIREMENTS OF A LOAD CLOSEOUT ***\n\n")
                file.write("*** NOTIFICATION MESSAGE ***\n")
                file.write("TAKEOFF DATA REJECTED BY FMC, ACTUAL FUEL\n")
                file.write("ONBOARD DIFFERS FROM PLANNED AND EXCEEDS\n")
                file.write("TOLERANCES. REQUEST TAKEOFF DATA WHEN\n")
                file.write("FUELING IS COMPLETE\n")
                file.write("AUTOMATED FLT OPS MESSAGE\n\n")
            print(f"[COMBINED] FUEL VARIANCE EXCEEDS {_fuel_tol} LBS - DATA NOT GENERATED")
            return combined_file, [], {"takeoff_data_avail": False, "remarks": ["NO TAKEOFF DATA AVAIL"]}
    except (ValueError, TypeError) as e:
        print(f"[DEBUG] Fuel variance check skipped: {e}")

    rwy = valid_runways[0] if valid_runways else {'id': 'XX', 'length': 'XXXX', 'elevation': 0}
    airport_elevation = float(rwy.get('elevation', 0))
    airport_icao      = uplink_data.get('origin_icao', 'XXXX')
    airport_altitudes = get_airport_specific_altitudes(airport_icao, airport_elevation)

    sta      = uplink_data.get('origin_icao', 'XXXX')
    temp     = uplink_data.get('temp', 'XX')
    trim_display = trim_data.get('trim', 'X.X') if trim_data else 'X.X'

    runway_results = []

    with open(combined_file, 'w') as f:
        # ==========================================
        # SECTION 1: TAKEOFF DATA
        # ==========================================

        fn       = str(loadsheet_data['Flight Number'])
        tail     = str(loadsheet_data['Ship Number'])
        rls_no   = str(loadsheet_data.get('RLS', 'UNKNOWN'))
        time_gen = loadsheet_data['Time Generated']
        # get_utc_time() returns "HH:MM UTC"; the real ACARS report prints a
        # bare Zulu time — "0144Z" (POH p.9-76), not "10:35 UTCZ".
        time_z = time_gen.replace(" UTC", "").replace(":", "").strip() + "Z"
        wind     = uplink_data['wind']
        temp     = uplink_data['temp']
        qnh      = uplink_data['qnh']
        tow_lbs  = loadsheet_data['TOW']
        zfw_lbs  = loadsheet_data['ZFW']
        fob_lbs  = loadsheet_data['FOB']
        tow_k    = tow_lbs / 1000
        zfw_k    = zfw_lbs / 1000
        pax      = loadsheet_data['Passengers']
        lap      = loadsheet_data['LAP']
        total_cargo = loadsheet_data['Total Cargo']
        zfw_cg   = loadsheet_data.get('ZFW CG', cg_percent)

        _W = 24  # fixed right edge — all lines terminate at col 24

        def _rj(left, right, width=_W):
            """Right-justify: pad between left and right so total = width."""
            gap = width - len(str(left)) - len(str(right))
            return str(left) + ' ' * max(1, gap) + str(right)

        # ── Header: FLT / RLS / TIME ──────────────────────────────────────
        f.write(_rj("FLT      RLS",  "TIME") + "\n")
        f.write(_rj(f"{fn:<9}{rls_no}", time_z) + "\n")
        # ── Wind / OAT / QNH ─────────────────────────────────────────────
        f.write(_rj("WIND     OAT C", "QNH") + "\n")
        try:
            oat_int = int(float(temp))
        except (ValueError, TypeError):
            oat_int = 0
        f.write(_rj(f"{wind:<9}{oat_int}", qnh) + "\n")
        # ── SECT A/B/C ────────────────────────────────────────────────────
        fwd_cargo = loadsheet_data['FWD Cargo']
        aft_cargo = loadsheet_data['AFT Cargo']
        fwd_pax = max(0, round(pax * 0.25))
        aft_pax = pax - fwd_pax
        f.write(_rj("SECT A   F CGO",  "GTOW/CG") + "\n")
        f.write(_rj(f"{fwd_pax:<9}{fwd_cargo}", f"{tow_k:.1f}/{cg_display}") + "\n")
        f.write(_rj("SECT B   A CGO",  "ZFW/CG") + "\n")
        f.write(_rj(f"{aft_pax:<9}{aft_cargo}", f"{zfw_k:.1f}/{zfw_cg:.1f}") + "\n")
        f.write(_rj("SECT C   FOB",    "TOT PAX") + "\n")
        f.write(_rj(f"{lap:<9}{fob_lbs}", pax) + "\n")
        # ── REMARKS block ─────────────────────────────────────────────────
        remarks = ["REMARKS"]
        ptow_xml     = loadsheet_data.get('PTOW', tow_lbs)
        pzfw_xml     = loadsheet_data.get('MAX ZFW', zfw_lbs)
        ptow_planned = uplink_data.get('ptow', tow_lbs)
        pzfw_planned = uplink_data.get('pzfw', zfw_lbs)
        zfw_pct_diff  = abs((zfw_lbs - pzfw_planned) / pzfw_planned * 100) if pzfw_planned else 0
        gtow_pct_diff = abs((tow_lbs - ptow_planned) / ptow_planned * 100) if ptow_planned else 0
        if zfw_lbs < pzfw_planned and zfw_pct_diff > 5:
            remarks.append("CAUTION - ZFW LESS THAN")
            remarks.append("PZFW BY MORE THAN 5 PCT")
        if tow_lbs < ptow_planned and gtow_pct_diff > 5:
            remarks.append("CAUTION - GTOW LESS THAN")
            remarks.append("PTOW BY MORE THAN 5 PCT")
        surface_raw = uplink_data.get('surface', 'dry').upper()
        if surface_raw and surface_raw != 'DRY':
            remarks.append(f"{surface_raw} RUNWAY")
        if anti_ice_on:
            remarks.append("ENGINE AND WING ANTI-ICE")
            remarks.append("ON")
        remarks.append("NO LIVE")
        remarks.append(f"TKT INF:0 * LAP INF:{lap}")

        # Structured summary for the CDU's "ACARS T/O RWY DATA 1/5, 2/5"
        # pages — mirrors the real AeroData ACARS response format (see the
        # ERJ-170 POH, Ch.9 Sec.16): FLT NO/RLS NO/TIME, WIND/OAT/QNH,
        # SEC A/B/C (pax + bag weight per section), GTOW/CG, FUEL, ZFW/CG,
        # TTL PAX, and REMARKS as its own page.
        loadsheet_summary = {
            "flt_no": fn,
            "rls_no": rls_no,
            "time": time_z,
            "wind": wind,
            "oat": oat_int,
            "qnh": qnh,
            "sect_a_pax": fwd_pax,
            "sect_a_bagwt": fwd_cargo,
            "sect_b_pax": aft_pax,
            "sect_b_bagwt": aft_cargo,
            "sect_c_pax": lap,
            "sect_c_fuel": fob_lbs,
            "gtow_cg": f"{tow_k:.1f}/{cg_display}",
            "zfw_cg": f"{zfw_k:.1f}/{zfw_cg:.1f}",
            "ttl_pax": pax,
            "remarks": remarks[1:],  # drop the leading "REMARKS" header token
            "takeoff_data_avail": True,
            # Engine-failure / special-departure text for this airport. The
            # printed report puts this under a "SPECIAL" header wrapped to the
            # column width (see the EFP block at the end of this function);
            # the CDU renders it the same way on its own page.
            "efp_text": (
                (airport_altitudes.get('EFP', '') if airport_altitudes else '') or ''
            ).strip(),
        }

        for rl in remarks:
            f.write(rl + "\n")
        f.write("\n")
        f.write("\n")

        # ── Takeoff performance block ─────────────────────────────────────
        base_type       = uplink_data.get('base_type', 'XXXX')
        third_col_label = "ECS" if base_type in ("E170", "E175", "E190", "E195") else "BLD"
        efp_text        = (airport_altitudes.get('EFP', '') if airport_altitudes else '').strip()
        _icaocode  = uplink_data.get('icaocode', '')
        is_boeing  = _icaocode.startswith('B')
        is_airbus  = _icaocode.startswith('A')
        _ERJ_TYPES = {'E135', 'E140', 'E145', 'E45X'}
        is_erj     = _icaocode.upper().replace('-', '').replace(' ', '') in _ERJ_TYPES

        # Aircraft-type-dependent column headings — the SAME rules the printed
        # AERODATA report uses further up in this module, hoisted here so the
        # CDU frontend renders the type-correct labels instead of hardcoding
        # the E-Jet ones. (Airbus says CONF not FLAP; the MD-83 quotes EPR and
        # the 737 N1 where everything else says THR; the Dash 8 calls the
        # final-segment speed VCL not VFS; the ERJ family carries an extra
        # V215 column.)
        _is_md83      = _icaocode == 'MD83'
        _is_b737      = _icaocode in ('B736', 'B737', 'B738', 'B739', 'B38M')
        flap_label    = "CONF" if is_airbus else "FLAP"
        thr_label     = "EPR" if _is_md83 else ("N1" if _is_b737 else "THR")
        ptow_k         = round(loadsheet_data.get('PTOW', 0) / 1000, 1)
        max_tow_struct = loadsheet_data.get('MAX TOW STRUCT', 0) / 1000
        trim_str       = trim_data['trim'] if trim_data else '   '

        if trim_data:
            _trim_val = str(trim_data.get('trim', '')).strip()
            _trim_dir = str(trim_data.get('direction', '')).strip()
            trim_stab = f"{_trim_dir} {_trim_val}".strip() if _trim_dir else _trim_val
        else:
            trim_stab = '---'

        def _get_n1(rwy_data, uplink, loadsheet):
            try:
                tow_lbs_n1 = loadsheet.get('TOW', 0)
                temp_n1    = uplink.get('temp', '0')
                icao_n1    = uplink.get('icaocode', '')
                flex_n1    = rwy_data.get('flex', '')
                result_n1  = get_reduced_thrust_n1(icao_n1, tow_lbs_n1, temp_n1, flex_n1)
                if result_n1 and str(result_n1).replace('.', '').isdigit():
                    return f"{float(result_n1):.1f}"
            except Exception:
                pass
            return None

        def _ensure_msl(raw, elev, min_agl=800):
            v = int(raw)
            return v if v > int(elev) + min_agl else int(elev) + v

        for rwy_idx, rwy in enumerate(valid_runways):
            rwy_elevation = float(rwy.get('elevation', airport_elevation))
            rwy_fallback  = int(rwy_elevation + 1000)
            if airport_altitudes:
                _acc_raw = airport_altitudes.get('acc') or airport_altitudes.get('accel') or rwy_fallback
                _eo_raw  = airport_altitudes.get('eo_acc') or airport_altitudes.get('eo') or rwy_fallback
                _tr_raw  = airport_altitudes.get('tr') or rwy_fallback
                rwy['acc_alt'] = str(_ensure_msl(_acc_raw, rwy_elevation))
                rwy['eo_acc']  = str(_ensure_msl(_eo_raw,  rwy_elevation))
                rwy['tr']      = str(_ensure_msl(_tr_raw,  rwy_elevation))
            else:
                rwy.setdefault('acc_alt', str(rwy_fallback))
                rwy.setdefault('eo_acc',  str(rwy_fallback))
                rwy.setdefault('tr',      str(rwy_fallback))

            rwy_len = int(float(rwy.get("length", 0)))
            mc      = int(float(rwy.get("magnetic_course", 0)))
            slope   = float(rwy.get("slope", "0") or "0")
            print(f"[DEBUG] RWY {rwy_idx+1}: STA={sta}, ID={rwy['id']}, Len={rwy_len}, MC={mc}")

            if rwy_idx > 0:
                f.write("\n\n")

            # Common values
            v1_val       = int(float(rwy['v1']))
            vr_val       = int(float(rwy['vr']))
            v2_val       = safe_val(rwy.get('v2', 0))
            mrtw_k       = round(rwy['max_weight'], 1)
            mtow_str     = f"{max_tow_struct:.1f}"
            gtow_cg_str  = f"{ptow_k:.1f}/{cg_percent:.1f}"
            mrtw_lim_str = f"{mrtw_k:.1f}/{rwy['limit_code']:1s}"
            n1_str       = _get_n1(rwy, uplink_data, loadsheet_data)
            flex_str     = str(rwy['flex'])
            flap_str     = str(rwy['flaps'])
            bleed_str    = rwy.get('bleed', 'ON')
            thr_str      = rwy.get('thr', '')
            acc_alt      = rwy.get('acc_alt', 'XXXX')
            tr_alt       = rwy.get('tr', acc_alt)
            eo_alt       = rwy.get('eo_acc', acc_alt)

            # VFS / final-segment speed. The runway dict doesn't carry this —
            # the printed report derives it from SPEEDOTHER keyed on aircraft
            # type and takeoff weight (see the ERJ branch in the TPS writer),
            # so do exactly the same here. Falling back to rwy keys alone left
            # this permanently blank on the CDU.
            if base_type == 'DH8D':
                v_label = 'VCL'
            else:
                v_label = rwy.get('v_other_id', 'VFS')

            def _as_int(x):
                """None unless x really parses as a number."""
                try:
                    return int(float(x))
                except (TypeError, ValueError):
                    return None

            # Test by PARSING, not truthiness: rwy['v_other'] is often a
            # placeholder string like '---' or 'XXX', which is truthy, so the
            # old `a or b or 'XXX'` chain accepted it, skipped the lookup, and
            # then failed to convert — leaving VFS permanently blank on the
            # E-Jets. SPEEDOTHER has E75L/E170/E190/E195 tables keyed on
            # takeoff weight; use them whenever the runway dict has no usable
            # number, exactly as the printed report does.
            v_val = _as_int(rwy.get('v_other'))
            if v_val is None:
                v_val = _as_int(rwy.get('vfs'))
            if v_val is None:
                try:
                    from SPEEDOTHER import get_speed_other as _gso_cdu
                    _so = _gso_cdu(_icaocode, weight=float(loadsheet_data.get('TOW', 0) or 0))
                    if _so:
                        v_val = _as_int(_so.get('speed'))
                        if _so.get('name'):
                            v_label = _so['name']
                except Exception as _e:
                    print(f"[WARN] VFS lookup failed for {_icaocode}: {_e}")

            # Structured result for the CDU — collected here so the frontend
            # gets authoritative JSON fields instead of re-parsing the text.
            # Field set mirrors the real AeroData ACARS "Takeoff Runway Data"
            # page 3/5 (ERJ-170 POH ch.9 sec.16): airport/runway + length,
            # FLEX/FLAP/STAB, MRTW-LIM/MTOW/GTOW-CG, V1/VR/V2/VFS, ACCEL.
            runway_results.append({
                "airport": sta,
                "runway": rwy.get("id", ""),
                "length": rwy_len,
                "v1": v1_val,
                "vr": vr_val,
                "v2": v2_val,
                "vfs": v_val,
                "vfs_label": v_label,
                "flex": flex_str,
                "flaps": flap_str,
                "thr": thr_str,
                "acc_alt": acc_alt,
                "tr_alt": tr_alt,
                "eo_alt": eo_alt,
                "trim_stab": trim_stab,
                "mrtw": mrtw_lim_str,
                "mtow": mtow_str,
                "gtow_cg": gtow_cg_str,
                "n1": n1_str,
                # Type-dependent column headings (see the block where these
                # are derived) so the CDU labels match the aircraft.
                "flap_label": flap_label,
                "thr_label": thr_label,
                "third_col_label": third_col_label,
                # Header-line fields for the CDU's runway block, mirroring the
                # printed report's first three lines:
                #   KAUS 18L            9000
                #   DT H175  OAT  26   -0.20
                #    FLEX - TO1   - ECS ON
                "mc": mc,
                "slope": slope,
                "oat": temp,
                "bleed": bleed_str,
                "efp_text": efp_text,
                # Which of AERODATA's four runway-block layouts applies. The
                # printed report picks a different format per type and the CDU
                # has to follow suit rather than showing one generic layout.
                "format_kind": (
                    "airbus" if is_airbus else
                    "boeing" if is_boeing else
                    "erj"    if is_erj    else
                    "ejet"
                ),
                # Departure track line: "LT" for an upslope runway, "DT" for
                # down — replaced entirely by "SPECIAL" + the FRA code when
                # this airport has engine-failure procedure text.
                "dt_lt": ("LT" if float(slope or 0) >= 0 else "DT"),
                "fra_code": (airport_altitudes.get('fra', '') if airport_altitudes else ''),
                # Boeing-only extras.
                "sel_oat": f"{flex_str}/{int(float(temp))}" if str(temp).strip() else "",
                # V215 isn't stored on the runway — the printed report derives
                # it as V2 + 15 (see the ERJ branch above), so do the same
                # here. safe_val() returns a STRING ("---" when unusable), so
                # this has to parse rather than assume an int.
                "v215": (int(v2_val) + 15) if str(v2_val).lstrip("-").isdigit() else None,
                "is_erj": is_erj,
                "base_type": base_type,
                "icaocode": _icaocode,
            })

            fra_code   = airport_altitudes.get('fra', '') if airport_altitudes else ''
            C1 = 8
            _hdr_width = 18

            # Runway header + intersection
            full_tora        = int(float(rwy.get('_full_tora_ft', rwy_len)))
            _intxn_txwy_list = rwy.get('_intxn_taxiways', [])
            _is_intxn        = (full_tora > rwy_len) and bool(_intxn_txwy_list)

            if is_airbus:
                _ab_txwy   = f"/{_intxn_txwy_list[0]}" if _is_intxn else ""
                _ab_rwy_id = f"{rwy['id']}{_ab_txwy}"
                _rt_label  = "SPECIAL" if efp_text else f"DT H{mc:03d}"
                f.write(f"{sta} {_ab_rwy_id:<{18 - len(sta) - 1 - len(_rt_label)}}{_rt_label}\n")
            else:
                _rwy_hdr_icao = airport_icao  # 4-char ICAO; rwy_len starts at col 19
                _rwy_id_pad   = max(1, 18 - len(_rwy_hdr_icao))
                f.write(f"{_rwy_hdr_icao} {rwy['id']:<{_rwy_id_pad}}{rwy_len}\n")
                if _is_intxn:
                    _txwy_str = '/'.join(_intxn_txwy_list)
                    f.write(f"INTXN TXWY {_txwy_str}\n" if _txwy_str else "INTXN\n")

            # ── AIRBUS FORMAT ─────────────────────────────────────────────
            if is_airbus:
                _is_toga   = flex_str.strip() in ('--', '', 'TOGA')
                _thr_label = "TOGA" if _is_toga else "FLEX"
                f.write(f"{_thr_label} - BLEEDS ON\n")

                trim_val = trim_stab.split()[-1] if trim_stab and trim_stab != '---' else '0.0'
                try:
                    flap_int     = int(flap_str)
                    flap_display = f"*{flap_int}*" if flap_int not in (1, 5) else str(flap_int)
                except (ValueError, TypeError):
                    flap_display = f"*{flap_str}*"
                flap_trim = f"{flap_display}/UP{trim_val}"
                flex_disp = f"FLEX {flex_str}"

                _hw = int(float(rwy.get('headwind', 0) or 0))
                _xw = int(float(rwy.get('crosswind', 0) or 0))
                try:
                    _wdir    = float(uplink_data.get('wind_dir', 0) or 0)
                    _mc      = float(rwy.get('magnetic_course', 0) or 0)
                    _rel     = (_wdir - _mc) % 360
                    _xw_side = 'L' if _rel > 180 else 'R'
                except (ValueError, TypeError):
                    _xw_side = 'R'
                if _hw != 0 or _xw != 0:
                    _hw_label   = 'H' if _hw >= 0 else 'T'
                    v_other_col = f"{_hw_label}{abs(_hw):02d} {_xw_side}{_xw:02d}"
                else:
                    v_other_col = ""

                shift_dist = full_tora - rwy_len if _is_intxn else None
                _W = 24  # fixed total width

                def _rj_line(val, right):
                    v   = str(val)
                    gap = max(1, _W - len(v) - len(right))
                    return v + ' ' * gap + right

                _v1_right = f"TO SHIFT [{shift_dist:>4}]" if _is_intxn else "TO SHIFT [    ]"
                f.write("V1\n")
                f.write(_rj_line(v1_val, _v1_right) + "\n")
                _vr_right = f"FL/THS {flap_trim}"
                f.write("VR\n")
                f.write(_rj_line(vr_val, _vr_right) + "\n")
                _v2_right = f"{v_other_col}  {flex_disp}" if v_other_col else flex_disp
                f.write("V2\n")
                f.write(_rj_line(v2_val, _v2_right) + "\n")
                f.write(f"\nTR {tr_alt} ACC {tr_alt} EO {tr_alt}\n")

            # ── BOEING FORMAT ─────────────────────────────────────────────
            elif is_boeing:
                _B2 = 10  # Boeing middle col
                if efp_text:
                    fra_tag = f"FRA {fra_code}" if fra_code else ''
                    dt_line = f"{'SPECIAL':<{C1 + _B2 - len(fra_tag)}}{fra_tag}"
                    f.write(dt_line + "\n")
                else:
                    _dt_lt = 'LT' if slope >= 0 else 'DT'
                    f.write(f"{_dt_lt} H{mc:03d}  OAT{int(float(temp)):>4}   {slope: .2f}\n")

                to_label = thr_str.replace('D-TO', 'TO').strip() or 'TO'
                f.write(f" {to_label} - BLD ON\n")
                sel_oat = f"{flex_str}/{int(float(temp))}"
                f.write(f"{'FLAPS':<{C1}}{'MRTW/LIM':<{_B2}}V1 {v1_val}\n")
                f.write(f"  {flap_str:<{C1-2}}{mrtw_lim_str:<{_B2}}VR {vr_val}\n")
                f.write(f"{'STAB':<{C1}}{'MTOW':<{_B2}}V2 {v2_val}\n")
                if n1_str:
                    f.write(f"{trim_stab:<{C1}}{mtow_str:<{_B2}}\n")
                    f.write(f"{'SEL/OAT':<{C1}}{'PTOW/CG':<{_B2}}N1\n")
                    f.write(f"{sel_oat:<{C1}}{gtow_cg_str:<{_B2}}{n1_str}\n")
                else:
                    f.write(f"{trim_stab:<{C1}}{mtow_str:<{_B2}}\n")
                    f.write(f"{'SEL/OAT':<{C1}}{'PTOW/CG':<{_B2}}\n")
                    f.write(f"{sel_oat:<{C1}}{gtow_cg_str:<{_B2}}\n")
                f.write("\n")
                f.write("\n")

            # ── ERJ FORMAT ───────────────────────────────────────────────
            elif is_erj:
                if efp_text:
                    fra_tag = f"FRA {fra_code}" if fra_code else ''
                    dt_line = f"{'SPECIAL':<{_hdr_width - len(fra_tag)}}{fra_tag}"
                    f.write(dt_line + "\n")
                else:
                    _dt_lt = 'LT' if slope >= 0 else 'DT'
                    f.write(f"{_dt_lt} H{mc:03d}  OAT{int(float(temp)):>4}   {slope: .2f}\n")

                _ERJ_THR_MAP = {
                    'TO': 'TO1', 'ATO': 'TO1', 'ALT TO-1': 'ATO',
                    'ALT TO1': 'ATO', 'ALT TO': 'ATO',
                    'TO-1': 'TO1', 'TO1': 'TO1', 'TO-2': 'TO2', 'TO2': 'TO2',
                }
                thr_erj = _ERJ_THR_MAP.get(thr_str.upper().strip(), thr_str)
                f.write(f" {thr_erj}\n")

                _ERJ_W = 24  # fixed total width

                def _erj_rj(left, right, width=_ERJ_W):
                    gap = width - len(str(left)) - len(str(right))
                    return str(left) + ' ' * max(1, gap) + str(right)

                f.write(_erj_rj("FLEX    MRTW/LIM", f"V1 {v1_val}") + "\n")
                f.write(_erj_rj(f"{flex_str:<8}{mrtw_lim_str}", f"VR {vr_val}") + "\n")

                vfs_val = rwy.get('vfs') or rwy.get('v_other')
                try:
                    vfs_int = int(float(vfs_val)) if vfs_val not in (None, '', 'XXX', 'None') else None
                except (TypeError, ValueError):
                    vfs_int = None
                f.write(_erj_rj("FLAP      MTOW", f"V2 {v2_val}") + "\n")
                if vfs_int is not None:
                    f.write(_erj_rj(f"{flap_str:<10}{mtow_str}", f"VFS {vfs_int}") + "\n")
                else:
                    f.write(f"{flap_str:<10}{mtow_str}\n")

                f.write(_erj_rj("STAB    GTOW/CG", "ACCEL") + "\n")
                f.write(_erj_rj(f"{trim_stab:<8}{gtow_cg_str}", acc_alt) + "\n")

                f.write("\n")

            # ── FALLBACK FORMAT ───────────────────────────────────────────
            else:
                if efp_text:
                    fra_tag = f"FRA {fra_code}" if fra_code else ''
                    dt_line = f"{'SPECIAL':<{_hdr_width - len(fra_tag)}}{fra_tag}"
                    f.write(dt_line + "\n")
                else:
                    _dt_lt = 'LT' if slope >= 0 else 'DT'
                    f.write(f"{_dt_lt} H{mc:03d}  OAT{int(float(temp)):>4}   {slope: .2f}\n")

                f.write(f" FLEX - {thr_str:<5} - {third_col_label:<3} {bleed_str:<4}\n")

                f.write(f"{'FLEX':<8}{'MRTW/LIM':<10}V1 {v1_val}\n")
                f.write(f"{flex_str:<8}{mrtw_lim_str:<10}VR {vr_val}\n")

                f.write(f"{'FLAP':<10}{'MTOW':<8}V2 {v2_val}\n")
                if v_val is not None:
                    f.write(f"{flap_str:<10}{mtow_str}   {v_label} {v_val}\n")
                else:
                    f.write(f"{flap_str:<10}{mtow_str:<8}\n")

                f.write(f"{'STAB':<8}{'GTOW/CG':<11}ACCEL\n")
                f.write(f"{trim_stab:<8}{gtow_cg_str}   {acc_alt}\n")

                f.write("\n")

        # ── EFP block — written once, after all runways, regardless of format ──
        if efp_text and valid_runways:
            last_rwy = valid_runways[-1]

            if is_airbus:
                _special_tag = "SPECIAL"
                _id_pad2     = _hdr_width - len(sta) - 1 - len(_special_tag)
                _efp_hdr     = f"{sta} {last_rwy['id']:<{_id_pad2}}{_special_tag}"
                f.write("\n")
                f.write(_efp_hdr + "\n")
                for _ln in textwrap.fill(efp_text, width=_hdr_width).splitlines():
                    f.write(_ln + "\n")
                f.write("\n")

            elif is_boeing:
                _B2 = 10
                _special_tag = "SPECIAL"
                _efp_hdr = f"{sta} {last_rwy['id']:<{C1 + _B2 - len(sta) - 1 - len(_special_tag)}}{_special_tag}"
                f.write(_efp_hdr + "\n")
                for _ln in textwrap.fill(efp_text, width=C1 + _B2).splitlines():
                    f.write(_ln + "\n")
                f.write("\n")

            else:
                for _ln in textwrap.fill(efp_text, width=_hdr_width).splitlines():
                    f.write(f" {_ln}\n")
                f.write("\n")

    print(f"Combined data generated: {combined_file}")

    try:
        with open(combined_file, 'r', encoding='utf-8', errors='replace') as f:
            raw = f.read()
        clean = sanitize_for_imessage(raw)
        with open(combined_file, 'w', encoding='ascii', errors='replace') as f:
            f.write(clean)
    except Exception as e:
        print(f"[WARNING] iMessage sanitize step failed: {e}")

    return combined_file, runway_results, loadsheet_summary


# ====================================================================================
# MAIN APPLICATION WINDOW — persistent, mode-driven, single flat form
# ====================================================================================

