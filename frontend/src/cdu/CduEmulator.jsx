import { useState, useCallback } from "react";
import ejetChassis from "./ejet.453de855.png";

// ─── CDU EMULATOR ───────────────────────────────────────────────────────────
// Generic Honeywell-style CDU "hardware" shell: screen, LSKs, function keys,
// alpha/numeric keypad. Knows nothing about takeoff performance — the page
// content (fields, validation, what EXEC does) is entirely supplied by the
// caller (see CduApp.jsx), so this same component is reused for every CDU
// page (IDENT / ACARS TO CONDITIONS 1-2 / ACARS T/O RWY DATA / TPS PRINT).
//
// The chassis is the actual WebFMC E-Jet CDU photo/render (ejet.453de855.png)
// used as a background image, with the screen text, LSK buttons, and keypad
// keys as transparent absolutely-positioned overlays on top of it — not a
// hand-drawn CSS chassis. The image's own alpha/numeric keypad and BRT/DIM
// labels already match what this app needs, so those are just transparent
// click targets over the image; the image's PERF/PREV/NEXT/FPL/PROG/DIR/EXEC
// and AIRP/VOR/NDB/FIX/LAT-LON/RADIO function-row labels do NOT match the
// real Honeywell ACARS function keys, so that whole region is covered with
// an opaque panel and redrawn with the correct labels.
//
// All overlay positions below are percentages estimated by eye from the
// image (no pixel-measurement tooling was available to derive them
// precisely) — expect them to need a round of nudging against a real
// screenshot rather than being exact on the first try.
//
// Function key row and screen conventions match the real Honeywell CDU used
// on E170/175/190/195 (reference: real cockpit "ACARS TO CONDITIONS 1/2,
// 2/2" footage):
//   PERF NAV PREV FPL PROG RTE CB
//   MENU DLK NEXT EXEC TRS RADIO
// and on-screen: a down-arrow (↓) prefixes any field with a fixed set of
// pilot-selectable options, unset free-entry fields show as a dashed
// placeholder ("----"), and a sub-page can offer a <RETURN> line to go back
// up a menu level.
//
// Real CDU interaction pattern this replicates:
//   1. Typing on the keypad appends characters to the SCRATCHPAD (bottom
//      line of the screen) — nothing on the page changes yet.
//   2. Pressing an LSK takes whatever's in the scratchpad and commits it
//      into that line's field, IF the scratchpad has content and the
//      value validates for that field (validation lives in the caller —
//      onFieldCommit returns { error } to reject).
//   3. If the scratchpad is EMPTY when an LSK is pressed:
//        - a field marked `cyclable: true` cycles to its next option
//          (this is a deliberate web-UI affordance for fields with a
//          small fixed set of choices — RUNWAY, SURFACE, ANTI-ICE — so
//          the pilot isn't forced to type an exact string on every
//          change; it is NOT how real CDU hardware behaves).
//        - a field marked `returnLine: true` (a "<RETURN>" line) navigates
//          back, same mechanism as cycling — see onFieldCommit's null arg.
//        - otherwise the LSK is a no-op (matches real CDU: empty
//          scratchpad + LSK = page navigation, not applicable here).
//   4. Invalid entries show "INVALID ENTRY" (or whatever message
//      onFieldCommit returns) in the scratchpad instead of committing,
//      and the scratchpad is NOT cleared so the pilot can see what they
//      typed and correct it.
//   5. CLR deletes one character at a time from the scratchpad; DEL
//      clears it entirely.
//   6. PREV/NEXT are wired to real page navigation via the onPrev/onNext
//      props (optional — falls back to "NOT AVAIL" if the caller doesn't
//      supply them, e.g. before a flight plan is loaded).

// Runway entries match the real AeroData ACARS convention: a runway id,
// optionally with "/INTXN" for an intersection takeoff (e.g. "32L/T10").
const RUNWAY_RE = /^[0-9]{1,2}[LRC]?[XYZ]?(\/[A-Z0-9]{1,6})?$/i;

const FIELD_VALIDATORS = {
  rwy1: (v) => RUNWAY_RE.test(v) ? v.toUpperCase() : null,
  rwy2: (v) => RUNWAY_RE.test(v) ? v.toUpperCase() : null,
  rwy3: (v) => RUNWAY_RE.test(v) ? v.toUpperCase() : null,
  oatqnh: (v) => /^-?\d{1,3}\/\d{1,2}\.\d{1,2}$/.test(v) ? v : null,
  simbrief: (v) => /^[A-Za-z0-9_\-.]{1,24}$/.test(v) ? v : null,
};

function validateField(fieldKey, raw) {
  const validator = FIELD_VALIDATORS[fieldKey];
  if (!validator) return raw; // no specific rule — accept as-is (caller may still reject)
  return validator(raw);
}

// One line-pair: a label line (small, dim) and a data line (large, bright).
// side: "L" | "R" | "C" (center, no LSK)
function CduLine({ label, value, side, editable, small, error, cyclable, returnLine, returnLabel }) {
  const displayValue = returnLine
    ? (returnLabel || "<RETURN>")
    : value
      ? `${cyclable && editable ? "↓" : ""}${value}`
      : (editable ? "----" : " ");
  return (
    <div className={`cdu-line cdu-line-${side} ${returnLine ? "cdu-line-return-wrap" : ""}`}>
      {label && <div className="cdu-line-label">{label}</div>}
      <div className={`cdu-line-value ${editable ? "cdu-editable" : ""} ${small ? "cdu-line-small" : ""} ${error ? "cdu-line-error" : ""} ${returnLine ? "cdu-return-line" : ""}`}>
        {displayValue}
      </div>
    </div>
  );
}

// Left/right LSK row y-centers as % of the whole chassis image height —
// eyeballed from the image, evenly spaced starting just below the screen.
const LSK_ROW_Y = [15.6, 21.0, 26.4, 31.8, 37.2, 42.6];

// Alpha/numeric keypad grid — also eyeballed as % of chassis width/height.
const ALPHA_ROW_Y = [70.0, 76.6, 83.2, 89.8, 96.4];
const ALPHA_COL_X = [7.1, 16.8, 26.5, 36.3, 46.0, 55.8];
const NUM_COL_X = [67.5, 76.1, 84.7, 93.3];

export default function CduEmulator({
  title = "PERF TAKEOFF",
  pageNum = "1/1",
  fields,          // array of { key, label, value, side: 'L'|'R'|'C', editable, cyclable, small, returnLine }
  onFieldCommit,   // (fieldKey, value|null) => void|{error}. value is scratchpad text, or null for a "cycle" (empty-scratchpad LSK press on a cyclable/returnLine field).
  execAvailable = false,
  onExec,
  onPrev,          // optional: PREV function key
  onNext,          // optional: NEXT function key
  onPerf,          // optional: PERF function key
  onFpl,           // optional: FPL function key (repurposed as PRINT/DOWNLOAD on the TPS print page)
  onDlk,           // optional: DLK function key (repurposed as "send ACARS request" — same trigger as EXEC, matches the real workflow where DLK sends the datalink request)
}) {
  const [scratchpad, setScratchpad] = useState("");
  const [scratchIsError, setScratchIsError] = useState(false);

  const appendChar = useCallback((ch) => {
    setScratchIsError(false);
    setScratchpad((s) => (s + ch).slice(0, 24)); // real CDU scratchpad is line-length limited
  }, []);

  const handleClr = useCallback(() => {
    setScratchIsError(false);
    setScratchpad((s) => s.slice(0, -1));
  }, []);

  const handleDel = useCallback(() => {
    setScratchIsError(false);
    setScratchpad("");
  }, []);

  const handleLsk = useCallback((field) => {
    if (!field) return; // clicked an LSK with nothing bound on that line

    if (!scratchpad) {
      if (field.editable && (field.cyclable || field.returnLine)) {
        const result = onFieldCommit?.(field.key, null); // null = "cycle to next option" / "return"
        if (result && result.error) {
          setScratchpad(result.error);
          setScratchIsError(true);
        }
      }
      return; // empty scratchpad + LSK on a plain field = no-op
    }

    if (!field.editable) {
      setScratchIsError(true);
      return; // can't overwrite a computed/display-only field
    }

    const validated = validateField(field.key, scratchpad);
    if (validated === null) {
      setScratchIsError(true);
      return;
    }

    const result = onFieldCommit?.(field.key, validated);
    if (result && result.error) {
      setScratchpad(result.error);
      setScratchIsError(true);
      return;
    }

    setScratchpad("");
    setScratchIsError(false);
  }, [scratchpad, onFieldCommit]);

  const handleUnimplemented = useCallback((label) => {
    setScratchIsError(false);
    setScratchpad(`${label} NOT AVAIL`);
    setScratchIsError(true);
  }, []);

  const leftFields   = fields.filter(f => f.side === "L");
  const rightFields  = fields.filter(f => f.side === "R");
  const centerFields = fields.filter(f => f.side === "C");

  return (
    <div className="cdu-body">
      <style>{CDU_CSS}</style>

      <div className="cdu-unit">
        {/* Real <img>, not a CSS background — lets the browser size the
            container from the file's actual pixel dimensions instead of a
            guessed aspect-ratio, so the photo can't come out stretched or
            letterboxed if that guess were wrong. */}
        <img className="cdu-unit-img" src={ejetChassis} alt="" />
        {/* ── Screen (positioned over the image's black screen rect) ── */}
        <div className="cdu-screen">
          <div className="cdu-screen-header">
            <span>{title}</span>
            <span className="cdu-page-num">{pageNum}</span>
          </div>

          <div className="cdu-screen-body">
            <div className="cdu-screen-top">
              <div className="cdu-col cdu-col-left">
                {leftFields.map((f, i) => (
                  <CduLine key={f.key || i} label={f.label} value={f.value} side="L" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} returnLabel={f.returnLabel} />
                ))}
              </div>
              <div className="cdu-col cdu-col-right">
                {rightFields.map((f, i) => (
                  <CduLine key={f.key || i} label={f.label} value={f.value} side="R" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} returnLabel={f.returnLabel} />
                ))}
              </div>
            </div>
            <div className="cdu-col cdu-col-center">
              {centerFields.map((f, i) => (
                <CduLine key={f.key || i} label={f.label} value={f.value} side="C" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} returnLabel={f.returnLabel} />
              ))}
            </div>
          </div>

          <div className={`cdu-scratchpad ${scratchIsError ? "cdu-scratch-error" : ""}`}>
            {scratchpad || " "}
          </div>
        </div>

        {/* ── LSK hit-targets — transparent, positioned over the image's own button graphics ── */}
        {LSK_ROW_Y.map((y, i) => (
          <button key={`L${i}`} className="cdu-lsk cdu-lsk-left" style={{ top: `${y}%` }}
            onClick={() => handleLsk(leftFields[i])} aria-label={`LSK L${i + 1}`} />
        ))}
        {LSK_ROW_Y.map((y, i) => (
          <button key={`R${i}`} className="cdu-lsk cdu-lsk-right" style={{ top: `${y}%` }}
            onClick={() => handleLsk(rightFields[i])} aria-label={`LSK R${i + 1}`} />
        ))}

        {/* ── Function keys — the image's own labels here (PERF/PREV/NEXT/FPL/
            PROG/DIR/EXEC, AIRP/VOR/NDB/FIX/LAT-LON/RADIO) don't match the real
            Honeywell ACARS function keys, so this panel is opaque and covers
            that whole region instead of relying on the image underneath. ── */}
        <div className="cdu-func-panel">
          <div className="cdu-func-row">
            <button className="cdu-func-key" onClick={() => (onPerf ? onPerf() : handleUnimplemented("PERF"))}>PERF</button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("NAV")}>NAV</button>
            <button className="cdu-func-key" onClick={() => (onPrev ? onPrev() : handleUnimplemented("PREV"))}>PREV</button>
            <button className="cdu-func-key" onClick={() => (onFpl ? onFpl() : handleUnimplemented("FPL"))}>FPL</button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("PROG")}>PROG</button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("RTE")}>RTE</button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("CB")}>CB</button>
          </div>
          <div className="cdu-func-row">
            <button className="cdu-func-key" onClick={() => handleUnimplemented("MENU")}>MENU</button>
            <button className={`cdu-func-key ${onDlk && execAvailable ? "cdu-exec-active" : ""}`} onClick={() => (onDlk ? onDlk() : handleUnimplemented("DLK"))}>DLK</button>
            <button className="cdu-func-key" onClick={() => (onNext ? onNext() : handleUnimplemented("NEXT"))}>NEXT</button>
            <button
              className={`cdu-func-key cdu-exec-key ${execAvailable ? "cdu-exec-active" : ""}`}
              onClick={() => execAvailable && onExec?.()}
            >
              EXEC
            </button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("TRS")}>TRS</button>
            <button className="cdu-func-key" onClick={() => handleUnimplemented("RADIO")}>RADIO</button>
          </div>
        </div>

        {/* ── BRT/DIM — image's own labels already match, just a transparent hit target ── */}
        <div className="cdu-brt-dim">
          <button className="cdu-brt-key" onClick={() => {}} aria-label="BRT" />
          <button className="cdu-brt-key" onClick={() => {}} aria-label="DIM" />
        </div>

        {/* ── Keypad — image already shows correct labels (A-Z, 0-9, DEL, CLR,
            +/-, /, SP, .), so these are transparent click targets only ── */}
        {"ABCDEF".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[0]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"GHIJK".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[1]}%`, left: `${ALPHA_COL_X[i + 1]}%` }} onClick={() => appendChar(ch)} />
        ))}
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[1]}%`, left: `${ALPHA_COL_X[5]}%` }} onClick={() => appendChar("L")} />
        {"MNOPQR".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[2]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"STUVW".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"XYZ".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        <button className="cdu-key cdu-key-wide" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[3]}%` }} onClick={handleDel}>DEL</button>
        <button className="cdu-key cdu-key-wide" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[4]}%` }} onClick={handleClr}>CLR</button>

        {["1", "2", "3", "+/-"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[0]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v === "+/-" ? "+/-" : v)} />
        ))}
        {["4", "5", "6", "/"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[1]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v)} />
        ))}
        {["7", "8", "9"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[2]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v)} />
        ))}
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${NUM_COL_X[0]}%` }} onClick={() => appendChar(" ")} />
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${NUM_COL_X[1]}%` }} onClick={() => appendChar("0")} />
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${NUM_COL_X[2]}%` }} onClick={() => appendChar(".")} />
      </div>
    </div>
  );
}

const CDU_CSS = `
.cdu-body { display: flex; justify-content: center; padding: 12px; background: transparent; }
.cdu-unit {
  position: relative;
  width: 460px;
  filter: drop-shadow(0 10px 24px rgba(0,0,0,0.5));
  font-family: "Segoe UI", Helvetica, Arial, sans-serif;
}
.cdu-unit-img { display: block; width: 100%; height: auto; user-select: none; pointer-events: none; }

/* Screen — positioned over the image's black rect. */
.cdu-screen { position: absolute; left: 15.5%; top: 6.2%; width: 69%; height: 43.5%;
  background: #050505; border-radius: 3px; padding: 4% 4%; box-sizing: border-box;
  display: flex; flex-direction: column; font-family: "Menlo","Courier New",monospace;
  overflow: hidden; }
.cdu-screen-header { display: flex; align-items: center; justify-content: space-between; color: #eaeaea;
  font-size: 11px; font-weight: 700; letter-spacing: 1px; padding-bottom: 3%; border-bottom: 1px solid #333; flex-shrink: 0; }
.cdu-page-num { color: #7fd0ff; font-weight: 400; }
.cdu-screen-body { flex: 1; display: flex; flex-direction: column; padding-top: 3%; overflow-y: auto; min-height: 0; }
.cdu-screen-top { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; flex-shrink: 0; }
.cdu-col { display: flex; flex-direction: column; gap: 4px; }
.cdu-col-center { padding-top: 6px; }
.cdu-line-return-wrap { margin-top: 10px; }

.cdu-line { display: flex; flex-direction: column; justify-content: center; min-height: 22px; line-height: 1.1; }
.cdu-line-label { color: #7fd0ff; font-size: 8.5px; letter-spacing: 0.4px; }
.cdu-line-value { color: #f2f2f2; font-size: 12px; font-weight: 600; min-height: 13px; }
.cdu-line-value.cdu-line-small { font-size: 10px; font-weight: 400; }
.cdu-line-R .cdu-line-label, .cdu-line-R .cdu-line-value { text-align: right; }
.cdu-line-C .cdu-line-label, .cdu-line-C .cdu-line-value { text-align: center; }
.cdu-editable { color: #7fff9e; }
.cdu-line-error { color: #ff5c4d; }
.cdu-return-line { color: #f2f2f2; }
.cdu-scratchpad { color: #fff; font-size: 12px; font-weight: 700; letter-spacing: 0.5px;
  border-top: 1px solid #333; margin-top: 4px; padding-top: 4px; min-height: 14px; flex-shrink: 0; }
.cdu-scratch-error { color: #ff5c4d; }

/* LSK hit-targets — transparent, sit right on top of the image's own button
   graphics. Width/height are generous (wider than the visible button) so a
   slightly-off estimate still catches clicks near the real button. */
.cdu-lsk { position: absolute; width: 11%; height: 3%; transform: translateY(-50%);
  background: transparent; border: none; cursor: pointer; padding: 0; }
.cdu-lsk-left { left: 0%; }
.cdu-lsk-right { right: 0%; }
.cdu-lsk:active { background: rgba(255,255,255,0.08); }

/* Function key panel — OPAQUE, covers the image's PERF/PREV/.../RADIO row
   (whose labels don't match) and redraws it with the real ACARS keys. */
.cdu-func-panel { position: absolute; left: 2%; top: 51.5%; width: 96.5%; height: 14.5%;
  background: #8b9198; border-radius: 6px; padding: 3%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 4%; }
.cdu-func-row { display: flex; gap: 3%; flex: 1; }
.cdu-func-key { flex: 1; background: linear-gradient(180deg, #2b2b2e, #101012); color: #eee;
  border: 1px solid #000; border-radius: 4px; font-size: 9.5px; font-weight: 600; padding: 0 2px;
  cursor: pointer; box-shadow: 0 2px 2px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1); line-height: 1.1; }
.cdu-func-key:active { transform: translateY(1px); }
.cdu-exec-key { opacity: 0.45; }
.cdu-exec-active { opacity: 1; box-shadow: 0 0 8px #3f8, inset 0 1px 0 rgba(255,255,255,0.2); }

/* BRT/DIM — transparent hit targets, image already shows the correct labels. */
.cdu-brt-dim { position: absolute; right: 1%; top: 51.5%; width: 11%; height: 14.5%;
  display: flex; flex-direction: column; }
.cdu-brt-key { flex: 1; background: transparent; border: none; cursor: pointer; padding: 0; }

/* Keypad keys — transparent hit targets positioned over the image's own
   labeled buttons (A-Z, 0-9, +/-, /, SP, ., DEL, CLR all already correct). */
.cdu-key { position: absolute; width: 7.5%; height: 4.8%; transform: translate(-50%, -50%);
  background: transparent; border: none; color: transparent; cursor: pointer; padding: 0; }
.cdu-key-wide { width: 9%; }
.cdu-key:active { background: rgba(255,255,255,0.1); border-radius: 4px; }
`;
