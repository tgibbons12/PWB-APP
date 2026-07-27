import { useState, useCallback, useEffect, useRef } from "react";
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
// placeholder ("----"). Navigation between pages is by the PREV/NEXT/PERF/
// MENU keys and by named menu lines (e.g. "<PERF/W&B"); there are no generic
// "<RETURN>" lines.
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
//        - a field marked `selectable: true` (a menu line such as
//          "<PERF/W&B" or "SEND*") fires, same mechanism as cycling —
//          see onFieldCommit's null arg.
//        - otherwise the LSK is a no-op (matches real CDU: empty
//          scratchpad + LSK = page navigation, not applicable here).
//   4. Invalid entries show "INVALID ENTRY" (or whatever message
//      onFieldCommit returns) in the scratchpad instead of committing,
//      and the scratchpad is NOT cleared so the pilot can see what they
//      typed and correct it.
//   5. CLR deletes one character at a time from the scratchpad. DEL loads
//      the scratchpad with "*DELETE*" (matches real CDU hardware); pressing
//      an LSK next with that in the scratchpad clears/resets THAT field
//      rather than committing literal text — same "type then press an LSK"
//      pattern as any other entry, just with a delete payload instead of a
//      typed value.
//   6. PREV/NEXT are wired to real page navigation via the onPrev/onNext
//      props (optional — falls back to "NOT AVAIL" if the caller doesn't
//      supply them, e.g. before a flight plan is loaded).

// Scratchpad content when DEL has been pressed — matches the real CDU's
// "*DELETE*" prompt, which stays in the scratchpad until an LSK targets it.
export const DELETE_TOKEN = "*DELETE*";

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
function CduLine({ label, value, side, editable, small, error, cyclable, tight, dim, tone, boxes }) {
  // Empty-field placeholder follows the real convention (and the POH colour
  // note): a MANDATORY entry shows amber entry boxes, an OPTIONAL entry shows
  // cyan dashes. `boxes` is how many characters the field expects; the "/"
  // in a slashed field is kept literal so the shape of the entry is obvious.
  const placeholder = tone === "amber"
    ? String(boxes || "----").replace(/[^/]/g, "▯")
    : "----";
  const displayValue = value
    ? `${cyclable && editable ? "↓" : ""}${value}`
    : (editable ? placeholder : " ");
  // Explicit `tone` wins; otherwise fall back to the old editable=green rule.
  const toneClass = dim ? "cdu-dim" : tone ? `cdu-tone-${tone}` : editable ? "cdu-editable" : "";
  return (
    <div className={`cdu-line cdu-line-${side} ${tight ? "cdu-line-tight" : ""}`}>
      {label && <div className={`cdu-line-label ${dim ? "cdu-dim" : ""}`}>{label}</div>}
      <div className={`cdu-line-value ${toneClass} ${small ? "cdu-line-small" : ""} ${error ? "cdu-line-error" : ""} ${editable ? "cdu-line-sel" : ""}`}>
        {displayValue}
      </div>
    </div>
  );
}

// Packed row — two label/value pairs side-by-side on ONE physical text row,
// the same space-saving technique the real AeroData printout uses (it packs
// 2-3 values per line rather than one value per line). Center-column-only
// (no LSK binding), used to keep dense report pages from overflowing the
// fixed-height screen and forcing a scroll — real CDU hardware never scrolls.
function CduPackLine({ pack, tight }) {
  return (
    <div className={`cdu-line cdu-line-pack ${tight ? "cdu-line-tight" : ""}`}>
      {pack.map((p, i) => (
        <div className="cdu-pack-item" key={i}>
          {p.label && <div className="cdu-line-label">{p.label}</div>}
          <div className="cdu-line-value">{p.value || " "}</div>
        </div>
      ))}
    </div>
  );
}

// Left/right LSK row y-centers as % of the whole chassis image height —
// eyeballed from the image, evenly spaced starting just below the screen.
const LSK_ROW_Y = [15.1, 20.4, 25.8, 31.2, 36.6, 43.0];

// Function-key rows (PERF..CB / MENU..RADIO) and the BRT/DIM stack, in the
// same percent-of-chassis space as the keypad grid below — measured off the
// WebFMC reference screenshots, whose row pitch matches ALPHA_ROW_Y's.
// Re-measured from the hotspot-overlay screenshots: every keypad and
// function-key target was sitting ~2.5-3% high, straddling the top edge of
// its button. The screen rect (a known 6.1%/41.1% box) was used as the
// reference to convert screenshot pixels back into chassis percentages.
const FUNC_ROW_Y = [56.5, 62.5];
const FUNC_COL_X = [8.0, 19.9, 31.7, 43.7, 55.6, 67.6, 79.4];
// BRT/DIM sit in their own tighter stack, not on the two function rows.
const BRT_DIM_X = 93.1;
const BRT_Y = 53.6;
const DIM_Y = 58.1;

// Screen box geometry, as % of the chassis image (must match .cdu-screen).
const SCREEN_TOP = 6.1;
const SCREEN_HEIGHT = 41.1;

// Each text row is pinned to its OWN LSK's y-coordinate, expressed as a
// percentage of the screen box. Letting flexbox space the six rows evenly
// instead made the error accumulate down the page — row 1 looked fine and
// row 6 was a whole line out, because the body's height never exactly
// matched the LSK span. Deriving the positions from LSK_ROW_Y means they
// can't drift, and re-measuring the chassis only means editing LSK_ROW_Y.
const ROW_Y_IN_SCREEN = LSK_ROW_Y.map(
  (y) => ((y - SCREEN_TOP) / SCREEN_HEIGHT) * 100
);

// Alpha/numeric keypad grid — also eyeballed as % of chassis width/height.
const ALPHA_ROW_Y = [70.6, 77.2, 83.8, 90.4, 97.0];
const ALPHA_COL_X = [6.5, 16.3, 26.1, 35.9, 45.7, 55.5];
const NUM_COL_X = [66.9, 75.9, 84.8, 93.7];

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
  onDlk,           // optional: DLK function key (repurposed as "send ACARS request" — same trigger as EXEC, matches the real workflow where DLK sends the datalink request; on the MENU page it's repurposed again as "enter the ACARS app")
  onMenu,          // optional: MENU function key — real hardware always jumps to the top-level MENU page from anywhere
  message,         // optional: { text, error } system message (e.g. "TAKEOFF DATA AVAIL"). Real CDUs post these to the scratchpad, not as a screen line, and the crew clears them with CLR/DEL.
}) {
  const [scratchpad, setScratchpad] = useState("");
  const [scratchIsError, setScratchIsError] = useState(false);

  // Debug overlay: outlines every hit-target so a screenshot shows exactly
  // where the clickable areas sit relative to the chassis artwork. Toggled by
  // the hidden spot on the bottom-left corner screw — invisible in normal use.
  const [showHotspots, setShowHotspots] = useState(false);

  // Screen text used to be sized in `cqw` (container query units), but those
  // need Safari 16+. An iPad Air 2 tops out at iPadOS 15, so every font-size
  // was simply dropped there and the text fell back to the browser default —
  // hence wildly different sizes between an Air 2 and a Pro. Measuring the
  // screen width here and exposing it as a plain px custom property gives the
  // same proportional scaling on anything with ResizeObserver (iOS 13.4+).
  const screenRef = useRef(null);
  const [screenW, setScreenW] = useState(0);
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    // Must be the CONTENT box, not the border box: `cqw` was resolved against
    // the content box, and .cdu-screen carries 4% padding either side. Using
    // getBoundingClientRect() made --u ~9% too large and the text overflowed
    // its column. Derived from computed padding rather than a hardcoded
    // factor so it stays correct if that padding ever changes.
    const measure = () => {
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0);
      setScreenW(Math.max(0, el.clientWidth - pad));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // System messages land in the scratchpad exactly like the real unit. They
  // clear on a SINGLE CLR or DEL press (they aren't typed text, so
  // backspacing through them character by character would be wrong).
  const [scratchIsSystem, setScratchIsSystem] = useState(false);
  const msgText = message?.text || "";
  useEffect(() => {
    if (!msgText) return;
    setScratchpad(msgText);
    setScratchIsError(!!message?.error);
    setScratchIsSystem(true);
  }, [msgText, message?.error]);

  const appendChar = useCallback((ch) => {
    setScratchIsError(false);
    // Typing over a posted system message replaces it rather than appending.
    setScratchpad((s) => (scratchIsSystem ? ch : (s + ch).slice(0, 24)));
    setScratchIsSystem(false);
  }, [scratchIsSystem]);

  const handleClr = useCallback(() => {
    setScratchIsError(false);
    // A system message and *DELETE* are both inserted as single units (not
    // typed char-by-char), so one CLR press clears either outright rather
    // than backspacing through them one character at a time.
    if (scratchIsSystem) { setScratchpad(""); setScratchIsSystem(false); return; }
    setScratchpad((s) => (s === DELETE_TOKEN ? "" : s.slice(0, -1)));
  }, [scratchIsSystem]);

  // Real Honeywell/AeroData CDU convention: DEL does NOT erase the
  // scratchpad. It loads the scratchpad with the "*DELETE*" prompt; the
  // pilot then presses the LSK next to the field they want cleared, and
  // THAT commits the delete to that specific line (reverting it to its
  // default/blank state). This lets one DEL press target any field, same
  // as typing a value and pressing an LSK.
  const handleDel = useCallback(() => {
    setScratchIsError(false);
    // With a system message posted, DEL just dismisses it (one press).
    if (scratchIsSystem) { setScratchpad(""); setScratchIsSystem(false); return; }
    setScratchpad(DELETE_TOKEN);
  }, [scratchIsSystem]);

  const handleLsk = useCallback((field) => {
    if (!field) return; // clicked an LSK with nothing bound on that line

    // Greyed-out lines — drawn so each page matches the real screen
    // line-for-line, but inert. Pressing one does nothing at all.
    if (field.dim) return;

    if (!scratchpad) {
      if (field.editable && (field.cyclable || field.selectable)) {
        const result = onFieldCommit?.(field.key, null); // null = "cycle to next option" / "return" / "select"
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

    if (scratchpad === DELETE_TOKEN) {
      const result = onFieldCommit?.(field.key, DELETE_TOKEN); // reset this line to default
      if (result && result.error) {
        setScratchpad(result.error);
        setScratchIsError(true);
        return;
      }
      setScratchpad("");
      setScratchIsError(false);
      return;
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
    setScratchIsSystem(false);
  }, [scratchpad, onFieldCommit]);

  // Unbound MCDU function keys (NAV, PROG, RTE, CB, TRS, RADIO, and PERF —
  // which belongs to the MCDU, not this app) simply do nothing, like a real
  // key with no page behind it. They used to post "X NOT AVAIL" to the
  // scratchpad, which read like an error the crew had caused.
  const handleUnimplemented = useCallback(() => {}, []);

  const leftFields   = fields.filter(f => f.side === "L");
  const rightFields  = fields.filter(f => f.side === "R");
  const centerFields = fields.filter(f => f.side === "C");

  // The real screen is a 6-row x 3-column grid: an LSK-addressable field on
  // the left and right of each row, and an optional middle value on the SAME
  // row (POH p.9-76 shows FLT NO / RLS NO / TIME all on row 1). Previously
  // every centre field was stacked underneath the L/R block, which made the
  // middle column look "sunken" and pushed content past the screen. A centre
  // field now opts into a row via `row: <0-5>`; anything without one still
  // stacks below.
  const ROW_COUNT = 6;
  const rowedCenter = centerFields.filter(f => Number.isInteger(f.row));
  const looseCenter = centerFields.filter(f => !Number.isInteger(f.row));

  // Left/right fields honour an explicit `row` too, not just their position
  // in the array. Without this a page that reserves rows 0-1 for full-width
  // header text still had its first L/R field land on row 0, colliding with
  // the header and squeezing it back into a third of the width.
  function placeSide(fields) {
    const slots = new Array(ROW_COUNT).fill(undefined);
    const rest = [];
    for (const f of fields) {
      if (Number.isInteger(f.row) && f.row < ROW_COUNT && !slots[f.row]) slots[f.row] = f;
      else rest.push(f);
    }
    let next = 0;
    for (const f of rest) {
      while (next < ROW_COUNT && slots[next]) next++;
      if (next >= ROW_COUNT) break;
      slots[next++] = f;
    }
    return slots;
  }
  const leftSlots = placeSide(leftFields);
  const rightSlots = placeSide(rightFields);
  const gridRows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    L: leftSlots[i],
    C: rowedCenter.find(f => f.row === i),
    R: rightSlots[i],
  }));
  const renderCell = (f, side) => f
    ? <CduLine key={f.key} label={f.label} value={f.value} side={side} editable={f.editable}
        small={f.small} error={f.error} cyclable={f.cyclable}
        tight={f.tight} dim={f.dim} tone={f.tone} boxes={f.boxes} />
    : null;

  return (
    <div className="cdu-body">
      <style>{CDU_CSS}</style>

      <div className={`cdu-unit ${showHotspots ? "cdu-debug" : ""}`}>
        {/* Real <img>, not a CSS background — lets the browser size the
            container from the file's actual pixel dimensions instead of a
            guessed aspect-ratio, so the photo can't come out stretched or
            letterboxed if that guess were wrong. */}
        <img className="cdu-unit-img" src={ejetChassis} alt="" />
        {/* ── Screen (positioned over the image's black screen rect) ── */}
        <div className="cdu-screen" ref={screenRef} style={{ "--u": `${screenW}px` }}>
          <div className="cdu-screen-header">
            <span>{title}</span>
            <span className="cdu-page-num">{pageNum}</span>
          </div>

          <div className="cdu-screen-body">
            {gridRows.map((r, i) => (
              // A centre field marked `span` takes the whole row instead of
              // the middle third — needed for header text like
              // "KBOS 15R  10081FT", which a one-third column truncates.
              r.C?.span && !r.L && !r.R ? (
                <div className="cdu-row cdu-row-span" key={i} style={{ top: `${ROW_Y_IN_SCREEN[i]}%` }}>
                  {renderCell(r.C, "C")}
                </div>
              ) : (
                <div className="cdu-row" key={i} style={{ top: `${ROW_Y_IN_SCREEN[i]}%` }}>
                  <div className="cdu-cell">{renderCell(r.L, "L")}</div>
                  <div className="cdu-cell">{renderCell(r.C, "C")}</div>
                  <div className="cdu-cell">{renderCell(r.R, "R")}</div>
                </div>
              )
            ))}
            {looseCenter.length > 0 && (
              <div className="cdu-loose">
                {looseCenter.map((f, i) => (
                  f.pack
                    ? <CduPackLine key={f.key || i} pack={f.pack} tight={f.tight} />
                    : <div key={f.key || i} className={f.wide ? "cdu-wide" : ""}>
                        <CduLine label={f.label} value={f.value} side="C" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} tight={f.tight} dim={f.dim} tone={f.tone} boxes={f.boxes} />
                      </div>
                ))}
              </div>
            )}
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

        {/* ── Function keys — the chassis image's own labels ARE the correct
            E-Jet set (PERF/NAV/PREV/FPL/PROG/RTE/CB and MENU/DLK/NEXT/[blank]
            /TRS/RADIO), so these are transparent hit-targets over the photo,
            exactly like the alpha/numeric keypad below — no drawn-on panel.
            The 4th key of row 2 is unlabelled on the real unit; it's bound to
            EXEC here since this app needs a send key and the authentic path
            (DATALINK SEND* at LSK 6R) is also wired. ── */}
        {[
          { label: "PERF", fn: onPerf },
          { label: "NAV",  fn: null },
          { label: "PREV", fn: onPrev },
          { label: "FPL",  fn: onFpl },
          { label: "PROG", fn: null },
          { label: "RTE",  fn: null },
          { label: "CB",   fn: null },
        ].map((k, i) => (
          <button key={k.label} className="cdu-key cdu-key-func"
            style={{ top: `${FUNC_ROW_Y[0]}%`, left: `${FUNC_COL_X[i]}%` }}
            aria-label={k.label}
            onClick={() => (k.fn ? k.fn() : handleUnimplemented(k.label))} />
        ))}
        {[
          { label: "MENU", fn: onMenu },
          { label: "DLK",  fn: onDlk },
          { label: "NEXT", fn: onNext },
          // 4th key is physically blank on this unit — there is no EXEC key.
          // Sending is done the real way, via DATALINK SEND* at LSK 6R.
          { label: "",     fn: null, blank: true },
          { label: "TRS",  fn: null },
          { label: "RADIO",fn: null },
        ].map((k, i) => (
          <button key={k.label || `blank${i}`}
            className="cdu-key cdu-key-func"
            style={{ top: `${FUNC_ROW_Y[1]}%`, left: `${FUNC_COL_X[i]}%` }}
            aria-label={k.label || "blank"}
            onClick={() => (k.blank ? null : k.fn ? k.fn() : handleUnimplemented(k.label))} />
        ))}

        {/* ── BRT/DIM — image's own labels already match, just a transparent hit target ── */}
        <button className="cdu-key cdu-key-func cdu-key-brt" style={{ top: `${BRT_Y}%`, left: `${BRT_DIM_X}%` }} aria-label="BRT" onClick={() => {}} />
        <button className="cdu-key cdu-key-func cdu-key-brt" style={{ top: `${DIM_Y}%`, left: `${BRT_DIM_X}%` }} aria-label="DIM" onClick={() => {}} />

        {/* ── Keypad — image already shows correct labels (A-Z, 0-9, DEL, CLR,
            +/-, /, SP, .), so these are transparent click targets only ── */}
        {"ABCDEF".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[0]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"GHIJKL".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[1]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"MNOPQR".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[2]}%`, left: `${ALPHA_COL_X[i]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {/* Rows 3-4 have only 5 items (not 6 like A-F/G-L/M-R), and on the
            real image they sit right-shifted within the 6-column grid
            rather than starting at column 0 — hence the "+ i + 1" offset. */}
        {"STUVW".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${ALPHA_COL_X[i + 1]}%` }} onClick={() => appendChar(ch)} />
        ))}
        {"XYZ".split("").map((ch, i) => (
          <button key={ch} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[i + 1]}%` }} onClick={() => appendChar(ch)} />
        ))}
        <button className="cdu-key cdu-key-wide" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[4]}%` }} onClick={handleDel}>DEL</button>
        <button className="cdu-key cdu-key-wide" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${ALPHA_COL_X[5]}%` }} onClick={handleClr}>CLR</button>

        {["1", "2", "3", "+/-"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[1]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v === "+/-" ? "+/-" : v)} />
        ))}
        {["4", "5", "6", "/"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[2]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v)} />
        ))}
        {["7", "8", "9"].map((v, i) => (
          <button key={v} className="cdu-key" style={{ top: `${ALPHA_ROW_Y[3]}%`, left: `${NUM_COL_X[i]}%` }} onClick={() => appendChar(v)} />
        ))}
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${NUM_COL_X[0]}%` }} onClick={() => appendChar(" ")} />
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${NUM_COL_X[1]}%` }} onClick={() => appendChar("0")} />
        <button className="cdu-key" style={{ top: `${ALPHA_ROW_Y[4]}%`, left: `${NUM_COL_X[2]}%` }} onClick={() => appendChar(".")} />

        {/* Hidden debug toggle — bottom-left corner screw. Outlines every
            hit-target so a screenshot shows where they sit against the
            artwork. Deliberately unlabelled and invisible until pressed. */}
        <button
          className="cdu-debug-toggle"
          aria-label="toggle hotspot overlay"
          onClick={() => setShowHotspots(v => !v)}
        />
      </div>
    </div>
  );
}

const CDU_CSS = `
/* Screen face, served from frontend/public/ (NOT imported) so a missing file
   just 404s and falls back to the stack below rather than breaking the build.
   Filename case must match EXACTLY — macOS is case-insensitive but the Linux
   host serving this is not, so "anyocr.ttf" would 404 in production while
   appearing to work locally. */
/* VCR OSD Mono — the blocky dot-matrix face used on the E-Jet CDU. Closer to
   the real screen than B612 Mono, which is cockpit-designed but too clean. */
@font-face {
  font-family: "CduScreen";
  src: url("/VCROSDMono-xcrafts.ae7bac6d.ttf") format("truetype");
  font-display: swap;
}

/* Lock the page down: a hardware panel shouldn't scroll or bounce. The
   wrapper alone isn't enough — Safari rubber-bands the document itself, so
   html/body have to be pinned too. */
html, body, #root {
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-overflow-scrolling: auto;
}
body { margin: 0; }

.cdu-body { display: flex; justify-content: center; align-items: center; padding: 12px; background: transparent;
  max-width: 100%; max-height: 100%; }
.cdu-unit {
  position: relative;
  display: inline-block;
  /* Fills the available screen (phone or iPad) without ever stretching:
     width and height both come from the <img> below, which always scales
     by its own intrinsic aspect ratio, so the photo can't be distorted.
     NOTE: do NOT put container-type here — inline-size containment stops
     this box from shrink-wrapping the image, so it takes the parent's full
     width and every absolutely-positioned overlay (screen, LSKs, keypad)
     detaches from the chassis. The container lives on .cdu-screen instead,
     which has an explicit size and so is safe to contain. */
  max-width: 96vw;
  max-height: 96vh;
  filter: drop-shadow(0 10px 24px rgba(0,0,0,0.5));
  font-family: "Segoe UI", Helvetica, Arial, sans-serif;
}
.cdu-unit-img {
  display: block;
  width: auto;
  height: auto;
  max-width: 96vw;
  max-height: 96vh;
  user-select: none;
  pointer-events: none;
}

/* Screen — positioned over the image's black rect. */
/* All screen type is sized from --u (this box's width in px, measured in JS)
   rather than container-query units, which need Safari 16+ and silently
   dropped every font-size on older iPads. */
.cdu-screen {
  position: absolute; left: 15.0%; top: 6.1%; width: 69.4%; height: 41.1%;
  background: #050505; border-radius: 3px; padding: 4% 4%; box-sizing: border-box;
  display: flex; flex-direction: column;
  /* Share Tech Mono — the closest match to the real screen face. The rest are
     the widest, squarest monospaces commonly installed, used if it's absent. */
  font-family: "CduScreen","Andale Mono","Lucida Console","DejaVu Sans Mono",
               "Liberation Mono","Courier New",monospace;
  overflow: hidden; }
/* Title line is the SAME size as the body text on the real unit — having it
   smaller was part of what made the rows look mis-spaced against the LSKs. */
.cdu-screen-header { display: flex; align-items: center; justify-content: space-between; color: #f2f2f2;
  font-size: calc(var(--u) * 0.045); font-weight: 400; letter-spacing: calc(var(--u) * 0.0022);
  padding-bottom: 1%; border-bottom: 1px solid #333; flex-shrink: 0; }
.cdu-page-num { color: #f2f2f2; font-weight: 400; }
/* Spans the whole screen box so row positions can be expressed directly in
   screen-box percentages (see ROW_Y_IN_SCREEN). */
.cdu-screen-body { position: absolute; left: 4%; right: 4%; top: 0; bottom: 0;
  overflow: hidden; pointer-events: none; }
.cdu-screen-body > * { pointer-events: auto; }
/* One row per LSK, absolutely pinned to that LSK's y-coordinate. The -69%
   shift centres the VALUE line (not the label above it) on the button, which
   is how the real screen lines up. */
.cdu-row { position: absolute; left: 0; right: 0; transform: translateY(-69%);
  display: grid; grid-template-columns: 1fr 1fr 1fr; column-gap: 1%; }
.cdu-cell { min-width: 0; overflow: hidden; }
/* Full-width row — one value across all three columns. */
.cdu-row-span { display: block; }
/* Monospace report pages (LAND RWY DATA, REMARKS, SPECIAL/EFP) flow from just
   under the header rather than being pinned to LSKs. Line height is tightened
   so a full 11-line report block fits at NORMAL text size — shrinking the
   text to fit instead is what made these unreadable. */
.cdu-loose { position: absolute; left: 0; right: 0; top: 13%;
  display: flex; flex-direction: column; align-items: stretch; }
.cdu-loose .cdu-line { line-height: 1.0; }
.cdu-loose .cdu-line-value { font-size: calc(var(--u) * 0.040); }
/* Monospace text blocks (the runway data block, REMARKS, SPECIAL) rely on
   column alignment, so spaces must be preserved verbatim. */
.cdu-wide .cdu-line-value { font-variant-numeric: tabular-nums; }
/* Full-width free text (REMARKS, SPECIAL/EFP) — left aligned and allowed to
   use the whole screen width instead of being boxed into one grid column. */
.cdu-wide .cdu-line-value, .cdu-wide .cdu-line-label { text-align: left; white-space: pre-wrap; }

.cdu-line { display: flex; flex-direction: column; justify-content: center; line-height: 1.05; }
.cdu-line-tight { line-height: 1; }
.cdu-line-tight .cdu-line-label { font-size: calc(var(--u) * 0.028); }
.cdu-line-tight .cdu-line-value { font-size: calc(var(--u) * 0.036); }
/* Labels are WHITE on the real screen, same as the title — not cyan. */
/* The real Honeywell face sets characters noticeably wider apart than any
   web mono — see the cockpit photos, where "ACARS T/O CONDITION" spans most
   of the screen. Extra tracking gets much closer with the fonts available. */
.cdu-line-label { color: #f2f2f2; font-size: calc(var(--u) * 0.030); letter-spacing: calc(var(--u) * 0.0016); white-space: nowrap; }
/* Read-only values sit a step DOWN from line-selectable ones. Done this way
   round deliberately: 0.045u is the widest that fits a third-width column, so
   enlarging the selectable lines instead pushed values like "LOADSHEET>" past
   the cell edge and clipped them. */
.cdu-line-value { color: #f2f2f2; font-size: calc(var(--u) * 0.040); font-weight: 400; letter-spacing: calc(var(--u) * 0.0022); white-space: nowrap; }
.cdu-line-value.cdu-line-small { font-size: calc(var(--u) * 0.035); font-weight: 400; }
/* Line-selectable values — the reference size, which fits the column. */
.cdu-line-value.cdu-line-sel { font-size: calc(var(--u) * 0.045); }
.cdu-line-R .cdu-line-label, .cdu-line-R .cdu-line-value { text-align: right; }
.cdu-line-C .cdu-line-label, .cdu-line-C .cdu-line-value { text-align: center; }
.cdu-line-pack { display: flex; flex-direction: row; line-height: 1.05; }
.cdu-line-pack.cdu-line-tight { line-height: 1; }
.cdu-pack-item { flex: 1; text-align: center; }
.cdu-editable { color: #35d6ff; }
/* Colour scheme from the WebFMC reference screens (same source as the chassis
   image), which matches the POH's description in ch.9 sec.16: labels and menu
   lines WHITE, optional/entered values CYAN, AeroData outputs GREEN, mandatory
   entries AMBER, V-speeds occasionally magenta. An earlier pass made the whole
   screen monochrome green off a couple of green-looking cockpit photos — that
   was wrong; those were a tinted photo of a different unit. */
.cdu-tone-white { color: #f2f2f2; }
.cdu-tone-cyan  { color: #35d6ff; }
.cdu-tone-green { color: #4dff7c; }
.cdu-tone-amber { color: #ffb020; }
.cdu-tone-magenta { color: #ff6ee0; }
.cdu-dim { color: #5a5a5a; }
/* No red anywhere on screen — a field flagged in error stays amber (the
   mandatory-entry colour) rather than turning red. */
.cdu-line-error { color: #ffb020; }
/* Pinned to the bottom of the screen box — the body is absolutely positioned
   over the whole box now, so the scratchpad can't rely on flow order. */
.cdu-scratchpad { position: absolute; left: 4%; right: 4%; bottom: 2%;
  color: #fff; font-size: calc(var(--u) * 0.045); font-weight: 400; letter-spacing: calc(var(--u) * 0.0022);
  padding-top: 1%; min-height: calc(var(--u) * 0.049);
  white-space: nowrap; overflow: hidden; }
/* Scratchpad messages are ALWAYS white — the real unit never shows red here,
   including for rejected entries. Kept as a class so the distinction still
   exists in the markup without any colour difference. */
.cdu-scratch-error { color: #fff; }

/* LSK hit-targets — transparent, sit right on top of the image's own button
   graphics. Width/height are generous (wider than the visible button) so a
   slightly-off estimate still catches clicks near the real button. */
.cdu-lsk { position: absolute; width: 11%; height: 3%; transform: translateY(-50%);
  background: transparent; border: none; cursor: pointer; padding: 0; }
.cdu-lsk-left { left: 0%; }
.cdu-lsk-right { right: 0%; }
.cdu-lsk:active { background: rgba(255,255,255,0.08); }

/* Keypad AND function keys — transparent hit targets positioned over the
   image's own labeled buttons. Every label the image already carries is
   correct (A-Z, 0-9, +/-, /, SP, ., DEL, CLR, and the PERF..CB /
   MENU..RADIO function rows), so nothing is drawn on top of the photo. */
.cdu-key { position: absolute; width: 7.5%; height: 4.8%; transform: translate(-50%, -50%);
  background: transparent; border: none; color: transparent; cursor: pointer; padding: 0; }
.cdu-key-wide { width: 9%; }
/* Function keys are wider and shorter than the round keypad buttons. */
.cdu-key-func { width: 10%; height: 4.2%; }
/* BRT and DIM are a tight stack — shorter so they don't overlap each other. */
.cdu-key-brt { width: 8%; height: 3.4%; }
.cdu-key:active { background: rgba(255,255,255,0.1); border-radius: 4px; }
/* ── Hotspot debug overlay ────────────────────────────────────────────────
   Hidden toggle sits on the bottom-left corner screw. When on, every hit
   target is outlined and tinted so a screenshot shows exactly how the
   clickable areas line up against the chassis photo. Colour-coded: cyan for
   LSKs, magenta for keypad, amber for function keys. */
.cdu-debug-toggle { position: absolute; left: 1%; bottom: 0.5%; width: 7%; height: 4%;
  background: transparent; border: none; cursor: pointer; padding: 0; z-index: 5; }
.cdu-debug .cdu-key { background: rgba(255,0,255,0.22); outline: 1px solid #f0f; }
.cdu-debug .cdu-key-func { background: rgba(255,176,32,0.22); outline: 1px solid #ffb020; }
.cdu-debug .cdu-lsk { background: rgba(53,214,255,0.25); outline: 1px solid #35d6ff; }
.cdu-debug .cdu-screen { outline: 1px solid #4dff7c; }
.cdu-debug .cdu-row { outline: 1px dashed rgba(77,255,124,0.5); }

/* EXEC armed — a glow over the image's own (unlabelled) key. */
.cdu-exec-active { background: rgba(60,255,140,0.18); border-radius: 4px;
  box-shadow: 0 0 8px rgba(60,255,140,0.6); }
`;
