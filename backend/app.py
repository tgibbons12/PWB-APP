"""
app.py — Flask API wrapping takeoff_perf_core.py for the TPS/Closeout web UI.

Two endpoints:

  POST /api/flightplan
    Body: raw SimBrief XML as text (Content-Type: application/xml or text/plain)
    Calls parse_xml_raw() directly — no transformation of xml_data's shape.
    Returns xml_data as JSON, AS-IS from the original function, plus one
    added field (`intersections`) computed via get_intersection_groups()
    per runway, since the original xml_data has no such field and the
    frontend needs it for the Intersection dropdown.

  POST /api/generate
    Body: JSON — see GenerateRequest below.
    Calls build_weights() then generate_tps() and/or generate_closeout(),
    in the exact argument order confirmed from the source:
        uplink_data, loadsheet_data = build_weights(...)   # this order
        generate_tps(loadsheet_data, uplink_data, ...)     # swapped here
        generate_closeout(loadsheet_data, uplink_data, ...)
    Both generators write a file and return its path; this route reads
    that file back and returns its text content in the JSON response,
    because the browser (not this server) does the actual saving via
    the File System Access API — see saveFile() in the original mockup.

Nothing in takeoff_perf_core.py's generator logic is modified here.
The /api/flightplan → /api/generate split matches the two-step flow the
mockup already assumes: fetch flightplan once, then generate against it
possibly several times (TPS, then a revised TPS, then closeout, etc.)
without re-parsing the XML each time.
"""

import os
import traceback
import xml.etree.ElementTree as ET
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS

import takeoff_perf_core as core

app = Flask(__name__)
CORS(app)  # dev-friendly default; tighten origins before shipping publicly

OUTPUT_FOLDER = core.select_output_folder()


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _error(message, status=400, detail=None):
    payload = {"error": message}
    if detail is not None:
        payload["detail"] = detail
    return jsonify(payload), status


def _read_generated_file(filepath):
    """
    Both generate_tps() and generate_closeout() write to disk and return
    only the path (confirmed directly from their source — see the closing
    `return takeoff_file` / `return closeout_file` lines). The browser-side
    saveFile() in the frontend expects the actual text content, so we read
    the file straight back here rather than changing either function.
    """
    with open(filepath, "r") as f:
        return f.read()


def _build_intersections(xml_data):
    """
    xml_data['valid_runways'] (from parse_xml_raw) has no 'intxn' field —
    that only exists in the frontend mockup's hardcoded XML object.
    Real intersection data comes from get_intersection_groups(), which
    needs runway_index.dat (loaded once via load_runway_index()) plus a
    distance_reject_ft per runway that parse_xml_raw already extracted
    into each runway dict as 'distance_reject'.

    Returns { runway_id: ["FULL", "<id>X — TXWY ...", ...] } — a list of
    display strings per runway, safe to drop straight into the
    <select> the TpsPanel intersection dropdown already renders.
    """
    index_data = core.load_runway_index()
    icao = xml_data.get("origin_icao", "")
    result = {}

    for rwy in xml_data.get("valid_runways", []):
        rwy_id = rwy.get("id", "")
        try:
            full_tora_ft = float(rwy.get("length", 0))
        except (ValueError, TypeError):
            full_tora_ft = 0.0
        distance_reject_ft = rwy.get("distance_reject", 0)

        groups = core.get_intersection_groups(
            icao, rwy_id, full_tora_ft, distance_reject_ft, index_data
        )

        options = ["FULL"]
        for g in groups:
            txwy_str = "/".join(g["taxiways"])
            options.append(f"{g['id']} — TXWY {txwy_str}")

        result[rwy_id] = options

    return result


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.route("/api/admin/runway-index", methods=["GET"])
def runway_index_status():
    """
    Reports whether runway_index.dat is present and how many entries it
    has, so the frontend's admin panel can show current status without
    needing to re-upload just to check.
    """
    dat_path = os.path.join(os.path.dirname(os.path.abspath(core.__file__)), "runway_index.dat")
    exists = os.path.exists(dat_path)
    entry_count = None
    if exists:
        index_data = core.load_runway_index()
        entry_count = len(index_data)
    return jsonify({
        "exists": exists,
        "entry_count": entry_count,
        "path": dat_path,
    })


@app.route("/api/admin/runway-index", methods=["POST"])
def upload_runway_index():
    """
    Accepts a replacement runway_index.dat as raw text in the request body
    (Content-Type: text/plain) and writes it to the same path
    load_runway_index() reads from, then clears the in-memory cache so the
    new data is used on the very next /api/flightplan call — no server
    restart required.

    IMPORTANT — Railway's filesystem is ephemeral: this file will NOT
    survive the next deploy or dyno restart. Treat this as a way to patch
    runway data for the current running instance (e.g. add a missing
    airport without a full redeploy), not as permanent storage. For a
    permanent change, still commit runway_index.dat to the repo and
    redeploy — this endpoint is the fast/temporary path, not a replacement
    for that.

    No auth is enforced here — this is meant to be called by you directly
    (e.g. via curl), not exposed as a public-facing UI action, since
    anyone who can reach this endpoint can overwrite the runway database.
    """
    raw_text = request.get_data(as_text=True)
    if not raw_text or not raw_text.strip():
        return _error("Empty request body — expected runway_index.dat contents as raw text.")

    # Light format validation: every non-comment, non-blank line must have
    # at least 4 semicolon-separated fields (ICAO;RWY[_TXWY];TORA_m;...),
    # and the TORA_m field must parse as a float — matches what
    # load_runway_index() itself requires, so a malformed upload is caught
    # here with a clear error instead of silently loading zero entries.
    bad_lines = []
    valid_line_count = 0
    for i, line in enumerate(raw_text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split(";")
        if len(parts) < 4:
            bad_lines.append(f"line {i}: expected at least 4 fields, got {len(parts)}")
            continue
        try:
            float(parts[2])
        except ValueError:
            bad_lines.append(f"line {i}: TORA_m field '{parts[2]}' is not a number")
            continue
        valid_line_count += 1

    if bad_lines:
        return _error(
            "runway_index.dat has formatting errors — nothing was written.",
            status=422,
            detail="\n".join(bad_lines[:20]) + ("\n…" if len(bad_lines) > 20 else ""),
        )

    if valid_line_count == 0:
        return _error("File contained no valid data lines — nothing was written.", status=422)

    dat_path = os.path.join(os.path.dirname(os.path.abspath(core.__file__)), "runway_index.dat")
    try:
        with open(dat_path, "w") as f:
            f.write(raw_text)
    except OSError as e:
        return _error("Failed to write runway_index.dat.", status=500, detail=str(e))

    core.reset_runway_index_cache()
    index_data = core.load_runway_index()  # re-load immediately so entry_count is accurate

    return jsonify({
        "status": "ok",
        "valid_data_lines": valid_line_count,
        "entry_count": len(index_data),
        "note": "Written to the running instance's filesystem. This will NOT "
                "survive the next deploy — commit runway_index.dat to the repo "
                "for a permanent change.",
    })


@app.route("/api/oooi/parse", methods=["POST"])
def parse_oooi():
    """
    Accepts oooi_log.txt CONTENT as raw text (Content-Type: text/plain) —
    read by the browser directly from the user's chosen save folder via
    the File System Access API — and returns the parsed off_block time,
    total_fuel_lbs, and zfw_lbs using the same regex rules the original
    desktop app used. The server never touches a local filesystem path
    for this; the browser already has the bytes.
    """
    raw_text = request.get_data(as_text=True)
    if raw_text is None:
        raw_text = ""
    result = core.parse_oooi_text(raw_text)
    return jsonify(result)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


def _parse_and_respond(xml_root, aircraft_type, date):
    """
    Shared tail end of both /api/flightplan and /api/flightplan/simbrief —
    takes an already-parsed ET.Element tree root and does the
    parse_xml_raw() + intersections + validation steps identically for
    either source (pasted XML or SimBrief-fetched XML), so the two routes
    can't drift in behavior.
    """
    try:
        xml_data = core.parse_xml_raw(xml_root, date, aircraft_type)
    except Exception as e:
        # parse_xml_raw is a big function with many XML .find() calls that
        # assume certain elements exist; a malformed-but-valid-XML file
        # (e.g. missing <weights>) can still throw here. Surface it plainly
        # rather than a bare 500.
        return _error(
            "Failed to extract flight data from XML.",
            status=422,
            detail=f"{type(e).__name__}: {e}",
        )

    if not xml_data["valid_runways"]:
        return _error("No valid runway data found in XML.", status=422)

    xml_data["intersections"] = _build_intersections(xml_data)
    return jsonify(xml_data)


@app.route("/api/flightplan", methods=["POST"])
def flightplan():
    """
    Accepts raw SimBrief XML in the request body and returns parsed
    xml_data (parse_xml_raw's output, unmodified) plus a derived
    'intersections' map for the frontend's Intersection dropdown.
    """
    raw_xml = request.get_data(as_text=True)
    if not raw_xml or not raw_xml.strip():
        return _error("Empty request body — expected raw SimBrief XML.")

    try:
        xml_root = ET.fromstring(raw_xml)
    except ET.ParseError as e:
        return _error("Could not parse XML.", detail=str(e))

    aircraft_type = request.args.get("aircraft_type", "B738")
    date = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))

    return _parse_and_respond(xml_root, aircraft_type, date)


@app.route("/api/flightplan/simbrief", methods=["POST"])
def flightplan_simbrief():
    """
    Accepts { "username": "<simbrief username>" } and fetches that pilot's
    most recent OFP directly from SimBrief's public XML API server-side —
    no XML pasting required. Wraps core.fetch_xml_from_api(), which already
    existed for this exact purpose but was never wired to a route.

    SimBrief's xml.fetcher.php endpoint is public and keyed only by
    username (this is the same mechanism EFB/plugin integrations like
    this one have always used) — there is no OAuth/login step to build.
    """
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    if not username:
        return _error("Missing 'username' — provide the pilot's SimBrief username.")

    xml_tree = core.fetch_xml_from_api(username)
    if xml_tree is None:
        return _error(
            "Could not fetch a flight plan from SimBrief for that username.",
            status=422,
            detail="No OFP found, the username may be wrong, or SimBrief's API did not respond.",
        )

    xml_root = xml_tree.getroot()

    aircraft_type = body.get("aircraft_type", "B738")
    date = body.get("date", datetime.now().strftime("%Y-%m-%d"))

    return _parse_and_respond(xml_root, aircraft_type, date)


@app.route("/api/generate", methods=["POST"])
def generate():
    """
    Body (JSON):
      xml_data          : the full object returned by /api/flightplan
                           (sent back verbatim — this route never re-parses
                           the XML, matching how build_weights/generate_tps
                           consume xml_data as a plain dict)
      mode              : "tps" | "closeout" | "all"
      pax, cargo, ramp, cg              : closeout inputs (strings from the UI ok)
      zfwOverride, zfwOverrideVal       : closeout ZFW override
      scenario, condOverride, oat, qnh, wind, antiIce,
      runway, intersection, forceMax,
      speedOverrides (dict: v1/vr/v2/flex/flaps) : TPS-side inputs
      revisionNumber                    : optional int; if provided, used
                                           as-is instead of calling
                                           get_next_revision() again — lets
                                           the frontend keep TPS and
                                           Closeout revision numbers in sync
                                           the same way _on_submit's
                                           shared_revision did
    """
    body = request.get_json(silent=True)
    if body is None:
        return _error("Expected JSON body.")

    xml_data = body.get("xml_data")
    if not xml_data:
        return _error("Missing 'xml_data' — call /api/flightplan first and pass its response here.")

    mode = body.get("mode", "tps")
    if mode not in ("tps", "closeout", "all"):
        return _error("mode must be 'tps', 'closeout', or 'all'.")

    # ---- Parse closeout-side numeric inputs (mirrors _on_submit's int()/float() calls) ----
    try:
        pax_count = int(body.get("pax", xml_data.get("pax_count_xml", 0)))
        cargo = int(body.get("cargo", xml_data.get("cargo_xml", 0)))
        plan_ramp = int(body.get("ramp", xml_data.get("plan_ramp_xml", 0)))
        cg_percent = float(body.get("cg", 25.0))
    except (ValueError, TypeError) as e:
        return _error("Invalid numeric input (pax/cargo/ramp/cg).", detail=str(e))

    zfw_override = None
    if body.get("zfwOverride"):
        try:
            zfw_override = int(body.get("zfwOverrideVal"))
        except (ValueError, TypeError):
            zfw_override = None  # matches _on_submit: bad override value is silently ignored

    # ---- Resolve TLR scenario (mirrors _on_submit lines ~3078-3087) ----
    scenario_key = body.get("scenario", "PLANNED")
    sc_surface = xml_data.get("surface", "dry")
    sc_extra_fuel = 0
    force_condition = None
    tlr_scenario_active = False

    if scenario_key and scenario_key != "PLANNED":
        # scenario_key looks like "DRY_PTOW" or "WET_PTOW+4000" — split once
        # on the first underscore (surface names never contain one; PTOW+4000 might
        # look ambiguous but the '+' means a plain split still lands correctly)
        if "_" in scenario_key:
            surf, cond = scenario_key.split("_", 1)
            sc_surface = surf.lower()
            sc_extra_fuel = 4000 if cond == "PTOW+4000" else 0
            force_condition = cond
            tlr_scenario_active = True

    # ---- build_weights (fuel offset baked into plan_ramp, matching _on_submit) ----
    try:
        uplink_data, loadsheet_data = core.build_weights(
            xml_data, pax_count, cargo, plan_ramp + sc_extra_fuel, cg_percent, zfw_override
        )
    except KeyError as e:
        return _error(
            "xml_data is missing a required field for build_weights().",
            status=422,
            detail=str(e),
        )

    # ---- Conditions override (mirrors _on_submit lines ~3104-3114) ----
    anti_ice_on = bool(body.get("antiIce", False))
    uplink_data["anti_ice_on"] = anti_ice_on
    if body.get("condOverride"):
        for key, body_key in [("temp", "oat"), ("qnh", "qnh"), ("wind", "wind")]:
            val = str(body.get(body_key, "")).strip()
            if val:
                uplink_data[key] = val

    uplink_data["surface"] = sc_surface
    tlr_tables = xml_data.get("tlr_tables")
    tow_lbs = loadsheet_data["TOW"]
    atow_lbs = tow_lbs + 2000

    # ---- Runway selection + manual speed overrides ----
    runway_id = body.get("runway")
    selected_runways = [r for r in xml_data.get("valid_runways", []) if r.get("id") == runway_id]
    if not selected_runways:
        return _error(f"Runway '{runway_id}' not found in xml_data.valid_runways.")

    speed_overrides = body.get("speedOverrides", {})
    if speed_overrides:
        # Applied the same way rwy.get('_widget_overrides', {}) is re-applied
        # inside generate_tps() after TLR interpolation — user edits win last.
        selected_runways = [dict(r, _widget_overrides=speed_overrides) for r in selected_runways]

    force_max = bool(body.get("forceMax", False))
    if force_max:
        for r in selected_runways:
            r["_widget_overrides"] = {k: v for k, v in r.get("_widget_overrides", {}).items() if k != "flex"}

    # ---- Revision number ----
    # _on_submit computed shared_revision ONCE per submit and passed it to
    # both generate_tps() and generate_closeout() so a combined TPS+Closeout
    # request always got the same revision number on both files. If we let
    # each generator call get_next_revision() on its own (by passing None
    # to both), the shared counter in takeoff_perf_revisions.json increments
    # twice per "all" request and the two files end up numbered differently
    # — confirmed this actually happens when testing mode='all' without this
    # fix (TPS got RVSN 00, Closeout got RVSN 01 from the same request).
    revision_number = body.get("revisionNumber")
    if revision_number is None and mode == "all":
        revision_number = core.get_next_revision(
            loadsheet_data["Flight Number"],
            uplink_data.get("origin_icao", "XXX"),
            uplink_data.get("dest_icao", "XXX"),
            datetime.now().strftime("%Y%m%d"),
        )
    # For mode in ("tps", "closeout") alone, revision_number stays None and
    # the single generator being called resolves its own — matching how
    # _on_submit's TPS-only and Closeout-only branches never shared a
    # revision number between separate button presses either.

    response = {}

    try:
        if mode in ("tps", "all"):
            tps_path = core.generate_tps(
                loadsheet_data, uplink_data, selected_runways,
                anti_ice_on, OUTPUT_FOLDER, cg_percent, tlr_tables,
                tlr_scenario_active=tlr_scenario_active,
                force_tlr_condition=force_condition,
                revision_number=revision_number,
            )
            response["tps"] = {
                "content": _read_generated_file(tps_path),
                "filename": os.path.basename(tps_path),
                "atow": atow_lbs,
            }

        if mode in ("closeout", "all"):
            co_path = core.generate_closeout(
                loadsheet_data, uplink_data, OUTPUT_FOLDER, cg_percent, tlr_tables,
                revision_number=revision_number,
            )
            response["closeout"] = {
                "content": _read_generated_file(co_path),
                "filename": os.path.basename(co_path),
            }

    except Exception as e:
        # generate_tps/generate_closeout are ~800 combined lines with many
        # dict[key] lookups (not .get()) against loadsheet_data/uplink_data —
        # a missing field raises KeyError deep inside file-writing code.
        # Surface the traceback rather than a bare 500 so a missing xml_data
        # field is diagnosable from the response instead of only server logs.
        return _error(
            "Generation failed.",
            status=500,
            detail=f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=6)}",
        )

    return jsonify(response)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG", "0") == "1")
