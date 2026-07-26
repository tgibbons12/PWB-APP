import { useState, useCallback } from "react";
import CduEmulator, { DELETE_TOKEN } from "./CduEmulator.jsx";
import { apiFlightplanBySimbrief, apiGenerateTps, forceDownloadTxt, ApiError } from "./api.js";

// ─── PWB: STANDALONE MCDU EMULATOR ──────────────────────────────────────────
// Real backend, real data — every value on screen comes from this repo's own
// backend/app.py (/api/flightplan/simbrief and /api/generate routes). Nothing
// here is mocked. PWB runs independently of the TPS repo — separate backend,
// separate deploy, no shared runtime code (App.jsx / Root.jsx from the
// original TPS-derived copy are unused leftovers here and can be deleted).
//
// The backend generates AERODATA.py's original single-file COMBINED output
// (generate_combined_output — ACARS-style TAKEOFF DATA + loadsheet summary
// in one printout), not the later TPS-app's split generate_tps()/
// generate_closeout(). See backend/takeoff_perf_core.py.
//
// Page flow and field layout are confirmed against real E-Jet cockpit
// footage of the Honeywell Primus Epic MCDU running this exact software
// (highest-fidelity source — takes precedence over the ERJ-170 POH excerpt
// and the printed COMBINED.txt sample where they disagree on wording):
//   MENU                 — real top-level MENU page (matches a live WebFMC
//                          screenshot exactly: ◂MISC/◂BKUP RADIO/MCDU
//                          MAINT▸/MCDU STAT▸, none implemented — this app
//                          only covers the ACARS takeoff workflow). This is
//                          the app's starting page; DLK opens the ACARS app.
//   IDENT                — enter a SimBrief username, fetch + parse the OFP
//   ACARS TO CONDITIONS 1/2 — KLAX RWY 1/2/3 (departure ICAO + slot; a bare
//                          runway id, or "RWY/INTXN" for an intersection
//                          takeoff — up to 3 requested runways at once),
//                          SURFACE, WIND, GUST (separate fields), OAT C/QNH
//                          (one combined field), REL VERSION, PTOW
//   ACARS TO CONDITIONS 2/2 — ANTI-ICE (AUTO/ON), FLAPS (OPTIMUM/1/2/4),
//                          THRUST (OPTIMUM/MAX), LLWS ADVISORY (NO/YES,
//                          informational only) — DLK/EXEC sends the
//                          request, same as the real DATALINK SEND* key
//   ACARS T/O RWY DATA   — loadsheet summary (FLT/RLS/SECT A/B/C/GTOW-CG/
//                          ZFW-CG/FOB/TOT PAX), REMARKS, then one TAKEOFF
//                          PERFORMANCE page per requested runway
//   TPS PRINT            — the full generated ACARS text, paginated like a
//                          real CDU TEXT/REPORTS page, with a PRINT key
//
// Known simplifications vs. the real system:
//   - No raw-XML paste fallback — SimBrief username only.
//   - No separate ACARS LOADSHEET request — the backend returns loadsheet
//     summary + takeoff performance together in one call, so there's no
//     standalone "W&B LOADSHEET>" shortcut page.
//   - REL VERSION and PTOW are cosmetic only (not sent to the backend) —
//     REL VERSION's purpose isn't documented anywhere available, and PTOW
//     is discarded by the real system too once real loadsheet data exists,
//     which ours always does.
//   - No contamination depth (LEVEL 1/2/3) for SURFACE — the backend's TLR
//     interpolation only has DRY/WET tables, not compacted-snow/wet-ice.
//   - ANTI-ICE only has AUTO/ON (not AUTO/ON/OFF) and THRUST only has
//     OPTIMUM/MAX — the backend's anti-ice and thrust-mode flags are each
//     a single boolean, so a 3rd state wouldn't do anything different.
//   - LLWS ADVISORY is UI-only — it's an informational flag on the real
//     system too and never affects the computed takeoff numbers.
//   - No Closeout tab — that flow depends on a LOCAL backend running on the
//     ops Mac and doesn't map onto the keypad-driven commit model well.

const SCENARIO_DEFS = [
  { key: "DRY_PTOW", surface: "DRY", cond: "PTOW", label: "DRY" },
  { key: "WET_PTOW", surface: "WET", cond: "PTOW", label: "WET" },
];

function tlrAvail(xmlData, surface, cond) {
  return !!(xmlData?.tlr_tables?.[surface]?.[cond]);
}

// Real ACARS SURFACE field: PLANNED (no override — use computed/XML
// defaults) plus whichever of DRY/WET this flight plan has TLR data for.
function availableSurfaces(xmlData) {
  return ["PLANNED", ...SCENARIO_DEFS.filter(d => tlrAvail(xmlData, d.surface, d.cond)).map(d => d.key)];
}

const SURFACE_LABELS = { PLANNED: "PLANNED", ...Object.fromEntries(SCENARIO_DEFS.map(d => [d.key, d.label])) };
const SURFACE_SHORTHAND = { PLANNED: "PLANNED", DRY: "DRY_PTOW", WET: "WET_PTOW" };

const LINES_PER_PRINT_PAGE = 11;

export default function CduApp() {
  const [page, setPage] = useState("MENU"); // MENU | IDENT | COND1 | COND2 | ACARS | PRINT
  const [acarsPageIndex, setAcarsPageIndex] = useState(0); // 0=summary 1=remarks 2..=perf per runway

  const [xmlData, setXmlData] = useState(null);
  const [simbriefUsername, setSimbriefUsername] = useState(
    () => localStorage.getItem("tps_simbrief_username") || ""
  );
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [identStatus, setIdentStatus] = useState("ENTER SIMBRIEF ID");
  const [identStatusErr, setIdentStatusErr] = useState(false);

  // ACARS TO CONDITIONS 1/2 — KLAX RWY 1/2/3, SURFACE, WIND, GUST, OAT/QNH
  const [runway1, setRunway1] = useState("");
  const [runway2, setRunway2] = useState("");
  const [runway3, setRunway3] = useState("");
  const [surface, setSurface] = useState("PLANNED");
  const [oat, setOat] = useState("");
  const [qnh, setQnh] = useState("");
  const [wind, setWind] = useState("");
  const [gust, setGust] = useState(""); // separate field from WIND on the real screen
  const [relVersion, setRelVersion] = useState(""); // cosmetic only — not wired to the backend
  const [ptow, setPtow] = useState(""); // cosmetic only — real system discards this once real loadsheet data exists, which ours always has

  // ACARS TO CONDITIONS 2/2 — ANTI-ICE, FLAPS, THRUST, LLWS ADVISORY
  const [flapSel, setFlapSel] = useState("OPTIMUM"); // OPTIMUM | 1 | 2 | 4
  const [antiIce, setAntiIce] = useState(false); // AUTO | ON
  const [forceMax, setForceMax] = useState(false); // OPTIMUM (flex) | MAX
  const [llwsAdvisory, setLlwsAdvisory] = useState(false); // NO | YES — advisory only, not sent to the backend

  const [generating, setGenerating] = useState(false);
  const [perfStatus, setPerfStatus] = useState("");
  const [perfStatusErr, setPerfStatusErr] = useState(false);

  const [tpsResult, setTpsResult] = useState(null); // { content, filename, atow, runway_results, loadsheet_summary }
  const [printPageIndex, setPrintPageIndex] = useState(0);

  // ── Data helpers ──────────────────────────────────────────────────────────
  const runwayIds = xmlData?.valid_runways?.map(r => r.id) ?? [];
  const surfaceChoices = availableSurfaces(xmlData);
  const conditionsEdited = !!xmlData && (oat !== xmlData.temp || qnh !== xmlData.qnh || wind !== xmlData.wind);
  // Authoritative post-EXEC results — one entry per requested runway, matches
  // the {airport,runway,length,v1,vr,v2,vfs,flex,flaps,trim_stab,mrtw,mtow,
  // gtow_cg,acc_alt,...} shape computed server-side by generate_combined_output().
  const runwayResults = tpsResult?.runway_results ?? [];
  // Authentic ACARS T/O RWY DATA loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH,
  // SECT A/B/C, GTOW/CG, ZFW/CG, FOB, TOT PAX, REMARKS) — field names and
  // groupings confirmed against a live-generated COMBINED.txt sample.
  const loadsheetSummary = tpsResult?.loadsheet_summary ?? null;

  // ── MENU page — the app's starting page, matches the real Honeywell/
  // WebFMC top-level MENU screen exactly: ◂MISC and ◂BKUP RADIO on the
  // left (rows 1 and 5), MCDU MAINT▸ and MCDU STAT▸ on the right (rows 5
  // and 6). None of those four are implemented (they're not part of the
  // ACARS takeoff workflow this app covers) so their LSKs just report
  // NOT AVAIL, same convention as the unimplemented function keys. The
  // real way into the ACARS app from here is the DLK (datalink) key.
  function handleMenuCommit(key) {
    const labels = { misc: "MISC", bkupradio: "BKUP RADIO", mcdumaint: "MCDU MAINT", mcdustat: "MCDU STAT" };
    if (labels[key]) return { error: `${labels[key]} NOT AVAIL` };
  }

  const menuFields = [
    { key: "misc",      label: "", value: "◂MISC",        side: "L", editable: true, selectable: true },
    { key: "_blank1",   label: "", value: "",              side: "L", editable: false },
    { key: "_blank2",   label: "", value: "",              side: "L", editable: false },
    { key: "_blank3",   label: "", value: "",              side: "L", editable: false },
    { key: "bkupradio", label: "", value: "◂BKUP RADIO",   side: "L", editable: true, selectable: true },
    { key: "_blank4",   label: "", value: "",              side: "R", editable: false },
    { key: "_blank5",   label: "", value: "",              side: "R", editable: false },
    { key: "_blank6",   label: "", value: "",              side: "R", editable: false },
    { key: "_blank7",   label: "", value: "",              side: "R", editable: false },
    { key: "mcdumaint", label: "", value: "MCDU MAINT▸",   side: "R", editable: true, selectable: true },
    { key: "mcdustat",  label: "", value: "MCDU STAT▸",    side: "R", editable: true, selectable: true },
  ];

  // ── IDENT page ─────────────────────────────────────────────────────────────
  const doFetch = useCallback(async (username) => {
    setLoadingPlan(true);
    setIdentStatus("FETCHING OFP...");
    setIdentStatusErr(false);
    try {
      const data = await apiFlightplanBySimbrief(username);
      setXmlData(data);
      localStorage.setItem("tps_simbrief_username", username);
      setSimbriefUsername(username);

      const initRunway = data.valid_runways.some(r => r.id === data.plan_rwy)
        ? data.plan_rwy
        : (data.valid_runways[0]?.id ?? "");
      setRunway1(initRunway);
      setRunway2("");
      setRunway3("");
      setSurface("PLANNED");
      setFlapSel("OPTIMUM");
      setAntiIce(false);
      setForceMax(false);
      setLlwsAdvisory(false);
      setOat(data.temp);
      setQnh(data.qnh);
      setWind(data.wind);
      setGust("");
      setRelVersion("");
      setPtow("");
      setTpsResult(null);
      setPrintPageIndex(0);

      setIdentStatus(`OFP LOADED — FLT ${data.flight_number} ${data.origin_iata}-${data.dest_iata}`);
      setIdentStatusErr(false);
      setPage("COND1");
    } catch (e) {
      setIdentStatus(e instanceof ApiError ? e.message.toUpperCase() : "COULD NOT REACH SERVER");
      setIdentStatusErr(true);
    } finally {
      setLoadingPlan(false);
    }
  }, []);

  function handleIdentCommit(key, value) {
    if (key !== "simbrief" || value === null) return;
    doFetch(value);
  }

  const identFields = [
    { key: "simbrief", label: "SIMBRIEF ID", value: simbriefUsername, side: "L", editable: true },
    { key: "status",   label: "STATUS",      value: identStatus,       side: "C", editable: false, small: true, error: identStatusErr },
    ...(xmlData ? [
      { key: "flt",   label: "FLT NO", value: String(xmlData.flight_number), side: "R", editable: false },
      { key: "rte",   label: "ROUTE",  value: `${xmlData.origin_iata}-${xmlData.dest_iata}`, side: "R", editable: false },
      { key: "ac",    label: "A/C",    value: xmlData.icaocode, side: "R", editable: false },
    ] : []),
  ];

  // ── ACARS TO CONDITIONS 1/2 — KLAX RWY 1/2/3, SURFACE, WIND, GUST, OAT/QNH ──
  // Field set and exact wording confirmed against real E-Jet cockpit footage
  // (Honeywell Primus Epic MCDU, "ACARS TO CONDITIONS 1/2"): "KLAX RWY 1/2/3"
  // (departure ICAO + slot), SURFACE, WIND and GUST as two separate fields
  // (not one combined string), "OAT C/QNH" combined, REL VERSION, PTOW.
  function cycleRunwaySlot(current, setter) {
    const opts = ["", ...runwayIds];
    const idx = opts.indexOf(current);
    setter(opts[(idx + 1) % opts.length]);
  }

  function handleCond1Commit(key, value) {
    if (key === "return") {
      if (value === null) setPage("IDENT");
      return; // DELETE on the return line: not applicable, no-op
    }
    if (key === "rwy1" || key === "rwy2" || key === "rwy3") {
      const setter = key === "rwy1" ? setRunway1 : key === "rwy2" ? setRunway2 : setRunway3;
      const current = key === "rwy1" ? runway1 : key === "rwy2" ? runway2 : runway3;
      if (value === null) { cycleRunwaySlot(current, setter); return; }
      if (value === DELETE_TOKEN) { setter(""); return; } // clear this runway slot
      // Validate the base runway id (before any "/INTXN" suffix) against
      // this flight plan's published runways.
      const [base] = value.split("/");
      if (!runwayIds.includes(base)) return { error: "INVALID ENTRY" };
      setter(value);
      return;
    }
    if (key === "surface") {
      if (value === null) {
        const idx = surfaceChoices.indexOf(surface);
        setSurface(surfaceChoices[(idx + 1) % surfaceChoices.length]);
        return;
      }
      if (value === DELETE_TOKEN) return { error: "NOT ALLOWED" }; // required field
      const mapped = SURFACE_SHORTHAND[value.toUpperCase()];
      if (!mapped || !surfaceChoices.includes(mapped)) return { error: "INVALID ENTRY" };
      setSurface(mapped);
      return;
    }
    if (key === "wind")  { setWind(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "gust")  { setGust(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "relversion") { setRelVersion(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "ptow")  { setPtow(value === DELETE_TOKEN ? "" : value); return; }
    if (key === "oatqnh") {
      if (value === DELETE_TOKEN) return { error: "NOT ALLOWED" }; // required field
      const [o, q] = value.split("/");
      if (o === undefined || q === undefined) return { error: "INVALID ENTRY" };
      setOat(o); setQnh(q);
      return;
    }
  }

  // "KLAX" on the real screen isn't a literal word — it's the departure
  // airport's ICAO code shown above each entry line, confirming which
  // airport RWY 1/2/3 apply to. Render it from the loaded flight plan.
  const depIcao = xmlData?.origin_icao || "----";
  const cond1Fields = xmlData ? [
    { key: "rwy1",       label: `${depIcao} RWY 1`, value: runway1, side: "L", editable: true, cyclable: true },
    { key: "rwy2",       label: `${depIcao} RWY 2`, value: runway2, side: "L", editable: true, cyclable: true },
    { key: "rwy3",       label: `${depIcao} RWY 3`, value: runway3, side: "L", editable: true, cyclable: true },
    { key: "surface",    label: "SURFACE",     value: SURFACE_LABELS[surface] ?? surface, side: "L", editable: true, cyclable: true },
    { key: "wind",       label: "WIND",        value: String(wind), side: "R", editable: true },
    { key: "gust",       label: "GUST",        value: String(gust), side: "R", editable: true },
    { key: "oatqnh",     label: "OAT C/QNH",   value: `${oat}/${qnh}`, side: "R", editable: true },
    { key: "relversion", label: "REL VERSION", value: relVersion, side: "R", editable: true },
    { key: "ptow",       label: "PTOW",        value: ptow, side: "R", editable: true },
    { key: "status",     label: "",            value: perfStatus, side: "C", editable: false, small: true, error: perfStatusErr },
    { key: "return",     label: "",            value: "", side: "C", editable: true, returnLine: true },
  ] : [];

  // ── ACARS TO CONDITIONS 2/2 — ANTI-ICE, FLAPS, THRUST, LLWS ADVISORY ───────
  // Exact field order and wording confirmed against real E-Jet cockpit
  // footage: ANTI-ICE first (not last), "FLAPS" (plural) not "FLAP",
  // "OPTIMUM" (not the abbreviation "OPT"/"NORMAL"), and a fourth field —
  // LLWS ADVISORY — that this app didn't have at all before. All four
  // fields sit in a single left-hand column with nothing on the right,
  // matching the real screen. LLWS ADVISORY is informational only (it
  // doesn't change the takeoff numbers) so it isn't sent to the backend.
  // DELETE on any of these fixed-choice fields resets it to the default
  // (same as what a fresh flight-plan load starts with) — real CDU convention
  // for a field that can't just go blank.
  function handleCond2Commit(key, value) {
    if (key === "flaps") {
      const opts = ["OPTIMUM", "1", "2", "4"];
      if (value === null) {
        const idx = opts.indexOf(flapSel);
        setFlapSel(opts[(idx + 1) % opts.length]);
        return;
      }
      if (value === DELETE_TOKEN) { setFlapSel("OPTIMUM"); return; }
      const v = value.toUpperCase();
      if (!opts.includes(v)) return { error: "INVALID ENTRY" };
      setFlapSel(v);
      return;
    }
    if (key === "antiice") {
      if (value === null) { setAntiIce(a => !a); return; }
      if (value === DELETE_TOKEN) { setAntiIce(false); return; }
      const v = value.toUpperCase();
      if (v === "ON") setAntiIce(true);
      else if (v === "AUTO") setAntiIce(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "thrust") {
      if (value === null) { setForceMax(f => !f); return; }
      if (value === DELETE_TOKEN) { setForceMax(false); return; }
      const v = value.toUpperCase();
      if (v === "MAX") setForceMax(true);
      else if (v === "OPTIMUM") setForceMax(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
    if (key === "llws") {
      if (value === null) { setLlwsAdvisory(a => !a); return; }
      if (value === DELETE_TOKEN) { setLlwsAdvisory(false); return; }
      const v = value.toUpperCase();
      if (v === "YES") setLlwsAdvisory(true);
      else if (v === "NO") setLlwsAdvisory(false);
      else return { error: "INVALID ENTRY" };
      return;
    }
  }

  const cond2Fields = xmlData ? [
    { key: "antiice", label: "ANTI-ICE",     value: antiIce ? "ON" : "AUTO", side: "L", editable: true, cyclable: true },
    { key: "flaps",   label: "FLAPS",        value: flapSel,                 side: "L", editable: true, cyclable: true },
    { key: "thrust",  label: "THRUST",       value: forceMax ? "MAX" : "OPTIMUM", side: "L", editable: true, cyclable: true },
    { key: "llws",    label: "LLWS ADVISORY",value: llwsAdvisory ? "YES" : "NO", side: "L", editable: true, cyclable: true },
    { key: "status",  label: "",             value: perfStatus, side: "C", editable: false, small: true, error: perfStatusErr },
  ] : [];

  async function handleExec() {
    const runways = [runway1, runway2, runway3].map(r => r.trim().toUpperCase()).filter(Boolean);
    if (!xmlData || runways.length === 0) return;
    setGenerating(true);
    setPerfStatus("GENERATING...");
    setPerfStatusErr(false);
    try {
      // GUST is its own field on the real screen, but the backend's "wind"
      // param is a single display string — append it the same way the
      // real printed reports show gust (e.g. "270/15G25").
      const windStr = gust.trim() ? `${wind}G${gust.trim()}` : wind;
      const result = await apiGenerateTps({
        xml_data: xmlData,
        mode: "tps",
        scenario: surface,
        condOverride: conditionsEdited,
        oat, qnh, wind: windStr,
        antiIce,
        runways,
        speedOverrides: flapSel !== "OPTIMUM" ? { flaps: flapSel } : {},
        forceMax,
      });
      setTpsResult(result.tps);
      setPrintPageIndex(0);
      setAcarsPageIndex(0);
      setPerfStatus(`GENERATED — ${result.tps.filename}`);
      setPerfStatusErr(false);
      setPage("ACARS");
    } catch (e) {
      setPerfStatus(e instanceof ApiError ? e.message.toUpperCase() : "GENERATION FAILED");
      setPerfStatusErr(true);
    } finally {
      setGenerating(false);
    }
  }

  // ── ACARS T/O RWY DATA — authentic post-EXEC report ───────────────────────
  // Matches the real Honeywell AeroData ACARS "Takeoff Runway Data" report,
  // confirmed field-for-field against a live-generated COMBINED.txt sample:
  // page 1 = loadsheet summary (FLT/RLS/TIME, WIND/OAT/QNH, SECT A/B/C —
  // pax + F/A CGO weight + GTOW/CG + ZFW/CG + FOB + TOT PAX), page 2 =
  // REMARKS, then ONE TAKEOFF PERFORMANCE page per requested runway (up to
  // 3 — matches the real system's KIND RWY 1/2/3 limit and its "pages 3/5,
  // 4/5, 5/5 are identical, one per runway request" pagination).
  function handleAcarsCommit(key, value) {
    if (key === "return" && value === null) setPage("COND2");
  }

  // Center column is PACKED two-values-per-row (same technique the real
  // AeroData printout uses) instead of one field per line — with all 6 of
  // F CGO/GTOW-CG/A CGO/ZFW-CG/FOB/TOT PAX on their own lines the page ran
  // to ~13 rows and overflowed the fixed-height screen, forcing an internal
  // scroll that real CDU hardware never does and that desynced the LSK
  // hit-targets from their labels. Packed + tight brings it to 9 rows.
  const acarsSummaryFields = loadsheetSummary ? [
    { key: "flt",   label: "FLT",        value: String(loadsheetSummary.flt_no),       side: "L", editable: false, tight: true },
    { key: "rls",   label: "RLS",        value: String(loadsheetSummary.rls_no),       side: "L", editable: false, tight: true },
    { key: "seca",  label: "SECT A",     value: String(loadsheetSummary.sect_a_pax),   side: "L", editable: false, tight: true },
    { key: "secb",  label: "SECT B",     value: String(loadsheetSummary.sect_b_pax),   side: "L", editable: false, tight: true },
    { key: "secc",  label: "SECT C",     value: String(loadsheetSummary.sect_c_pax),   side: "L", editable: false, tight: true },
    { key: "time",  label: "TIME",       value: String(loadsheetSummary.time),         side: "R", editable: false, tight: true },
    { key: "wind",  label: "WIND",       value: String(loadsheetSummary.wind),         side: "R", editable: false, tight: true },
    { key: "oat",   label: "OAT C",      value: String(loadsheetSummary.oat),          side: "R", editable: false, tight: true },
    { key: "qnh",   label: "QNH",        value: String(loadsheetSummary.qnh),          side: "R", editable: false, tight: true },
    { key: "pk1",   side: "C", tight: true, pack: [
        { label: "F CGO",   value: String(loadsheetSummary.sect_a_bagwt) },
        { label: "GTOW/CG", value: String(loadsheetSummary.gtow_cg) },
      ] },
    { key: "pk2",   side: "C", tight: true, pack: [
        { label: "A CGO",   value: String(loadsheetSummary.sect_b_bagwt) },
        { label: "ZFW/CG",  value: String(loadsheetSummary.zfw_cg) },
      ] },
    { key: "pk3",   side: "C", tight: true, pack: [
        { label: "FOB",     value: String(loadsheetSummary.sect_c_fuel) },
        { label: "TOT PAX", value: String(loadsheetSummary.ttl_pax) },
      ] },
    { key: "status",label: "",           value: loadsheetSummary.takeoff_data_avail ? "TAKEOFF DATA AVAIL" : "NO TAKEOFF DATA AVAIL", side: "C", editable: false, small: true, error: !loadsheetSummary.takeoff_data_avail, tight: true },
    { key: "return",label: "",           value: "",                                    side: "C", editable: true, returnLine: true },
  ] : [];

  const acarsRemarksFields = loadsheetSummary ? [
    { key: "hdr", label: "", value: "REMARKS", side: "C", editable: false, small: true, tight: true },
    ...(loadsheetSummary.remarks ?? []).map((rl, i) => ({
      key: `rl${i}`, label: "", value: rl || " ", side: "C", editable: false, small: true, tight: true,
    })),
    { key: "return", label: "", value: "", side: "C", editable: true, returnLine: true },
  ] : [];

  // Field set matches a live-generated TAKEOFF PERFORMANCE block exactly:
  // left = FLEX/FLAP/STAB, right = V1/VR/V2/VFS, center = airport+runway+
  // length, MRTW/LIM, MTOW, GTOW/CG, ACCEL. One of these per runway result.
  // Same packed-row/tight technique as acarsSummaryFields (see comment
  // above it) — keeps this page from overflowing the fixed-height screen.
  function buildPerfFields(rd) {
    return [
      { key: "flex",  label: "FLEX",  value: String(rd.flex),  side: "L", editable: false, tight: true },
      { key: "flap",  label: "FLAP",  value: String(rd.flaps), side: "L", editable: false, tight: true },
      { key: "stab",  label: "STAB",  value: String(rd.trim_stab), side: "L", editable: false, tight: true },
      { key: "v1",    label: "V1",    value: String(rd.v1),    side: "R", editable: false, tight: true },
      { key: "vr",    label: "VR",    value: String(rd.vr),    side: "R", editable: false, tight: true },
      { key: "v2",    label: "V2",    value: String(rd.v2),    side: "R", editable: false, tight: true },
      { key: "vfs",   label: String(rd.vfs_label || "VFS"), value: rd.vfs != null ? String(rd.vfs) : "---", side: "R", editable: false, tight: true },
      { key: "rwy",   label: "RUNWAY / LENGTH", value: `${rd.airport} ${rd.runway}   ${rd.length}FT`, side: "C", editable: false, tight: true },
      { key: "pk1",   side: "C", tight: true, pack: [
          { label: "MRTW/LIM", value: String(rd.mrtw) },
          { label: "MTOW",     value: String(rd.mtow) },
        ] },
      { key: "pk2",   side: "C", tight: true, pack: [
          { label: "GTOW/CG",  value: String(rd.gtow_cg) },
          { label: "ACCEL",    value: String(rd.acc_alt) },
        ] },
      { key: "return",label: "",       value: "",                       side: "C", editable: true, returnLine: true },
    ];
  }

  const perfPages = runwayResults.length
    ? runwayResults.map(rd => ({ title: "ACARS T/O RWY DATA", fields: buildPerfFields(rd) }))
    : [{
        title: "ACARS T/O RWY DATA",
        fields: [
          { key: "none",   label: "", value: "NO TAKEOFF DATA AVAIL", side: "C", editable: false, error: true },
          { key: "return", label: "", value: "", side: "C", editable: true, returnLine: true },
        ],
      }];

  const ACARS_PAGES = [
    { title: "ACARS T/O RWY DATA", fields: acarsSummaryFields },
    { title: "ACARS T/O RWY DATA", fields: acarsRemarksFields },
    ...perfPages,
  ];

  // ── TPS PRINT — paginated read-only text ──────────────────────────────────
  const printLines = tpsResult ? tpsResult.content.replace(/\r/g, "").split("\n") : [];
  const totalPrintPages = Math.max(1, Math.ceil(printLines.length / LINES_PER_PRINT_PAGE));
  const currentPrintLines = printLines.slice(
    printPageIndex * LINES_PER_PRINT_PAGE,
    printPageIndex * LINES_PER_PRINT_PAGE + LINES_PER_PRINT_PAGE
  );
  const printFields = currentPrintLines.map((line, i) => ({
    key: `line${i}`, label: "", value: line || " ", side: "C", editable: false, small: true,
  }));

  function handlePrintPrev() {
    if (printPageIndex > 0) setPrintPageIndex(i => i - 1);
    else { setAcarsPageIndex(ACARS_PAGES.length - 1); setPage("ACARS"); }
  }
  function handlePrintNext() {
    if (printPageIndex < totalPrintPages - 1) setPrintPageIndex(i => i + 1);
  }
  function handlePrintDownload() {
    if (tpsResult) forceDownloadTxt(tpsResult.content, tpsResult.filename);
  }

  // ── Page config dispatch ──────────────────────────────────────────────────
  let cduProps;
  if (page === "MENU") {
    cduProps = {
      title: "MENU", pageNum: "1/1",
      fields: menuFields,
      onFieldCommit: handleMenuCommit,
      execAvailable: false,
      onDlk: () => setPage("IDENT"), // real workflow: DLK opens the datalink/ACARS app
      onPerf: () => setPage(xmlData ? "COND1" : "IDENT"),
    };
  } else if (page === "IDENT") {
    cduProps = {
      title: "IDENT", pageNum: "1/1",
      fields: identFields,
      onFieldCommit: handleIdentCommit,
      execAvailable: !xmlData && !loadingPlan && simbriefUsername.trim().length > 0,
      onExec: () => doFetch(simbriefUsername.trim()),
      onPrev: () => setPage("MENU"),
      onNext: xmlData ? () => setPage("COND1") : undefined,
      onPerf: xmlData ? () => setPage("COND1") : undefined,
    };
  } else if (page === "COND1") {
    cduProps = {
      title: "ACARS TO CONDITIONS", pageNum: "1/2",
      fields: cond1Fields,
      onFieldCommit: handleCond1Commit,
      execAvailable: false,
      onPrev: () => setPage("IDENT"),
      onNext: () => setPage("COND2"),
      onPerf: () => setPage("COND1"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "COND2") {
    cduProps = {
      title: "ACARS TO CONDITIONS", pageNum: "2/2",
      fields: cond2Fields,
      onFieldCommit: handleCond2Commit,
      execAvailable: !!xmlData && [runway1, runway2, runway3].some(r => r.trim()) && !generating,
      onExec: handleExec,
      onDlk: handleExec, // real workflow: DATALINK SEND* sends the ACARS request, same trigger as EXEC
      onPrev: () => setPage("COND1"),
      onNext: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
      onPerf: () => setPage("COND1"),
      onFpl: tpsResult ? () => { setAcarsPageIndex(0); setPage("ACARS"); } : undefined,
    };
  } else if (page === "ACARS") {
    const cur = ACARS_PAGES[acarsPageIndex];
    cduProps = {
      title: cur.title, pageNum: `${acarsPageIndex + 1}/${ACARS_PAGES.length}`,
      fields: cur.fields,
      onFieldCommit: handleAcarsCommit,
      execAvailable: false,
      onPrev: () => {
        if (acarsPageIndex > 0) setAcarsPageIndex(i => i - 1);
        else setPage("COND2");
      },
      onNext: () => {
        if (acarsPageIndex < ACARS_PAGES.length - 1) setAcarsPageIndex(i => i + 1);
        else { setPrintPageIndex(0); setPage("PRINT"); }
      },
      onPerf: () => setPage("COND1"),
      onFpl: handlePrintDownload,
    };
  } else { // PRINT
    cduProps = {
      title: "TPS PRINT", pageNum: `${printPageIndex + 1}/${totalPrintPages}`,
      fields: printFields,
      onFieldCommit: () => {},
      execAvailable: false,
      onPrev: handlePrintPrev,
      onNext: handlePrintNext,
      onPerf: () => setPage("COND1"),
      onFpl: handlePrintDownload, // FPL repurposed as PRINT/DOWNLOAD on this page
    };
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#1c1c1e" }}>
      {/* MENU key always jumps to the top-level MENU page, same on every
          page — set once here rather than repeated in every branch above. */}
      <CduEmulator onMenu={() => setPage("MENU")} {...cduProps} />
    </div>
  );
}
