import { useState, useCallback } from "react";

// ─── CDU EMULATOR ───────────────────────────────────────────────────────────
// Generic Honeywell-style CDU "hardware" shell: screen, LSKs, function keys,
// alpha/numeric keypad. Knows nothing about takeoff performance — the page
// content (fields, validation, what EXEC does) is entirely supplied by the
// caller (see CduApp.jsx), so this same component is reused for every CDU
// page (IDENT / PERF TAKEOFF 1-2 / TPS PRINT).
//
// Function key row and screen conventions match the real Honeywell CDU used
// on E170/175/190/195 (reference: "ACARS TO CONDITIONS 1/2, 2/2" pages):
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
//          small fixed set of choices — RUNWAY, INTERSECTION, SCENARIO,
//          ANTI-ICE — so the pilot isn't forced to type an exact string
//          on every change; it is NOT how real CDU hardware behaves).
//        - a field marked `returnLine: true` (a "<RETURN>" line) navigates
//          back, same mechanism as cycling — see onFieldCommit's null arg.
//        - otherwise the LSK is a no-op (matches real CDU: empty
//          scratchpad + LSK = page navigation, not applicable here).
//   4. Invalid entries show "INVALID ENTRY" (or whatever message
//      onFieldCommit returns) in the scratchpad instead of committing,
//      and the scratchpad is NOT cleared so the pilot can see what they
//      typed and correct it.
//   5. CLR deletes one character at a time from the scratchpad; DEL
//      clears it entirely (see original notes — no per-page cursor model
//      here, so DEL's real "delete field under cursor" behavior would be
//      meaningless without one).
//   6. PREV/NEXT are wired to real page navigation via the onPrev/onNext
//      props (optional — falls back to "NOT AVAIL" if the caller doesn't
//      supply them, e.g. before a flight plan is loaded).

// Runway entries match the real AeroData ACARS convention: a runway id,
// optionally with "/INTXN" for an intersection takeoff (e.g. "32L/T10" —
// see ERJ-170 POH ch.9 sec.16, ACARS T/O CONDITION page 1/2, LSK 1L-3L).
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
function CduLine({ label, value, side, editable, small, error, cyclable, returnLine }) {
  const displayValue = returnLine
    ? "<RETURN>"
    : value
      ? `${cyclable && editable ? "↓" : ""}${value}`
      : (editable ? "----" : " ");
  return (
    <div className={`cdu-line cdu-line-${side}`}>
      {label && <div className="cdu-line-label">{label}</div>}
      <div className={`cdu-line-value ${editable ? "cdu-editable" : ""} ${small ? "cdu-line-small" : ""} ${error ? "cdu-line-error" : ""} ${returnLine ? "cdu-return-line" : ""}`}>
        {displayValue}
      </div>
    </div>
  );
}

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
        <div className="cdu-screw cdu-screw-tl" />
        <div className="cdu-screw cdu-screw-tr" />
        <div className="cdu-screw cdu-screw-bl" />
        <div className="cdu-screw cdu-screw-br" />

        <div className="cdu-light cdu-light-l" />
        <div className="cdu-light cdu-light-r" />

        <div className="cdu-screen-frame">
          <div className="cdu-screen">
            <div className="cdu-screen-header">
              <span>{title}</span>
              <span className="cdu-page-num">{pageNum}</span>
            </div>

            <div className="cdu-screen-body">
              <div className="cdu-col cdu-col-left">
                {leftFields.map((f, i) => (
                  <CduLine key={f.key || i} label={f.label} value={f.value} side="L" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} />
                ))}
              </div>
              <div className="cdu-col cdu-col-center">
                {centerFields.map((f, i) => (
                  <CduLine key={f.key || i} label={f.label} value={f.value} side="C" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} />
                ))}
              </div>
              <div className="cdu-col cdu-col-right">
                {rightFields.map((f, i) => (
                  <CduLine key={f.key || i} label={f.label} value={f.value} side="R" editable={f.editable} small={f.small} error={f.error} cyclable={f.cyclable} returnLine={f.returnLine} />
                ))}
              </div>
            </div>

            <div className={`cdu-scratchpad ${scratchIsError ? "cdu-scratch-error" : ""}`}>
              {scratchpad || " "}
            </div>
          </div>
        </div>

        <div className="cdu-lsk-col cdu-lsk-col-left">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <button
              key={`L${i}`}
              className="cdu-lsk"
              onClick={() => handleLsk(leftFields[i])}
              aria-label={`LSK L${i + 1}`}
            >
              <span className="cdu-lsk-notch" />
            </button>
          ))}
        </div>

        <div className="cdu-lsk-col cdu-lsk-col-right">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <button
              key={`R${i}`}
              className="cdu-lsk"
              onClick={() => handleLsk(rightFields[i])}
              aria-label={`LSK R${i + 1}`}
            >
              <span className="cdu-lsk-notch" />
            </button>
          ))}
        </div>

        {/* Function key rows — match the real Honeywell E-Jet CDU layout:
            PERF NAV PREV FPL PROG RTE CB / MENU DLK NEXT EXEC TRS RADIO */}
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

        <div className="cdu-brt-dim">
          <button className="cdu-brt-key" onClick={() => {}}>BRT</button>
          <button className="cdu-brt-key" onClick={() => {}}>DIM</button>
        </div>

        <div className="cdu-keypad">
          <div className="cdu-alpha-grid">
            {"ABCDEF GHIJKL MNOPQR STUVW".match(/.{1,6}/g).map((row, ri) => (
              <div className="cdu-key-row" key={ri}>
                {row.split("").map(ch => (
                  <button key={ch} className="cdu-key cdu-alpha-key" onClick={() => appendChar(ch)}>{ch}</button>
                ))}
              </div>
            ))}
            <div className="cdu-key-row">
              <button className="cdu-key cdu-alpha-key" onClick={() => appendChar("X")}>X</button>
              <button className="cdu-key cdu-alpha-key" onClick={() => appendChar("Y")}>Y</button>
              <button className="cdu-key cdu-alpha-key" onClick={() => appendChar("Z")}>Z</button>
              <button className="cdu-key cdu-del-key" onClick={handleDel}>DEL</button>
              <button className="cdu-key cdu-clr-key" onClick={handleClr}>CLR</button>
            </div>
          </div>

          <div className="cdu-num-grid">
            <div className="cdu-key-row">
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("1")}>1</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("2")}>2</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("3")}>3</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("+/-")}>+/-</button>
            </div>
            <div className="cdu-key-row">
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("4")}>4</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("5")}>5</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("6")}>6</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("/")}>/</button>
            </div>
            <div className="cdu-key-row">
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("7")}>7</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("8")}>8</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("9")}>9</button>
            </div>
            <div className="cdu-key-row">
              <button className="cdu-key cdu-num-key" onClick={() => appendChar(" ")}>SP</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar("0")}>0</button>
              <button className="cdu-key cdu-num-key" onClick={() => appendChar(".")}>.</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CDU_CSS = `
.cdu-body { display: flex; justify-content: center; padding: 12px; background: transparent; }
.cdu-unit {
  position: relative;
  width: 460px;
  background: linear-gradient(180deg, #9a9ea3, #7d8186);
  border-radius: 18px;
  padding: 22px 18px 18px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15);
  font-family: "Segoe UI", Helvetica, Arial, sans-serif;
}
.cdu-screw { position: absolute; width: 20px; height: 20px; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #d8d8d8, #8a8a8a 60%, #5a5a5a);
  box-shadow: inset 0 0 0 2px rgba(0,0,0,0.3); }
.cdu-screw::after { content: ""; position: absolute; top: 50%; left: 15%; right: 15%; height: 2px;
  background: rgba(0,0,0,0.4); transform: translateY(-50%) rotate(20deg); }
.cdu-screw-tl { top: 10px; left: 10px; } .cdu-screw-tr { top: 10px; right: 10px; }
.cdu-screw-bl { bottom: 10px; left: 10px; } .cdu-screw-br { bottom: 10px; right: 10px; }

.cdu-light { position: absolute; top: 46px; width: 12px; height: 12px; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #7fffb0, #0a5c2e 70%); box-shadow: 0 0 6px #3f8; }
.cdu-light-l { left: 22px; } .cdu-light-r { right: 22px; }

.cdu-screen-frame { background: #4a4e53; border-radius: 10px; padding: 12px; margin: 30px 4px 14px; }
.cdu-screen { background: #050505; border-radius: 4px; padding: 10px 12px; min-height: 260px;
  display: flex; flex-direction: column; font-family: "Menlo","Courier New",monospace; }
.cdu-screen-header { display: flex; justify-content: space-between; color: #eaeaea;
  font-size: 13px; font-weight: 700; letter-spacing: 1px; padding-bottom: 4px; border-bottom: 1px solid #333; }
.cdu-page-num { color: #7fd0ff; font-weight: 400; }
.cdu-screen-body { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; padding-top: 4px; overflow-y: auto; }
.cdu-col { display: flex; flex-direction: column; gap: 6px; }
.cdu-col-left { grid-column: 1; } .cdu-col-right { grid-column: 2; }
.cdu-col-center { grid-column: 1 / span 2; }

.cdu-line { display: flex; flex-direction: column; line-height: 1.15; }
.cdu-line-label { color: #7fd0ff; font-size: 10.5px; letter-spacing: 0.5px; }
.cdu-line-value { color: #f2f2f2; font-size: 15px; font-weight: 600; min-height: 17px; }
.cdu-line-value.cdu-line-small { font-size: 12.5px; font-weight: 400; }
.cdu-line-R .cdu-line-label, .cdu-line-R .cdu-line-value { text-align: right; }
.cdu-line-C .cdu-line-label, .cdu-line-C .cdu-line-value { text-align: center; }
.cdu-editable { color: #7fff9e; }
.cdu-line-error { color: #ff5c4d; }
.cdu-return-line { color: #f2f2f2; }
.cdu-scratchpad { color: #fff; font-size: 15px; font-weight: 700; letter-spacing: 1px;
  border-top: 1px solid #333; margin-top: 6px; padding-top: 6px; min-height: 18px; }
.cdu-scratch-error { color: #ff5c4d; }

.cdu-lsk-col { position: absolute; top: 92px; display: flex; flex-direction: column; gap: 15px; }
.cdu-lsk-col-left { left: -13px; }
.cdu-lsk-col-right { right: -13px; }
.cdu-lsk { width: 34px; height: 15px; background: linear-gradient(180deg, #333, #111);
  border: 1px solid #000; border-radius: 3px; cursor: pointer; padding: 0;
  box-shadow: 0 2px 3px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.15); }
.cdu-lsk:active { transform: translateY(1px); box-shadow: inset 0 1px 3px rgba(0,0,0,0.8); }
.cdu-lsk-notch { display: block; width: 16px; height: 2px; background: #ccc; margin: 6px auto 0; }

.cdu-func-panel { background: #86898d; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.cdu-func-row { display: flex; gap: 4px; margin-bottom: 4px; }
.cdu-func-row:last-child { margin-bottom: 0; }
.cdu-func-key { flex: 1; background: linear-gradient(180deg, #2b2b2e, #101012); color: #eee;
  border: 1px solid #000; border-radius: 5px; font-size: 11px; font-weight: 600; padding: 8px 2px;
  cursor: pointer; box-shadow: 0 2px 2px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1); line-height: 1.1; }
.cdu-func-key:active { transform: translateY(1px); }
.cdu-exec-key { opacity: 0.45; }
.cdu-exec-active { opacity: 1; box-shadow: 0 0 8px #3f8, inset 0 1px 0 rgba(255,255,255,0.2); }

.cdu-brt-dim { position: absolute; top: 340px; right: -6px; background: #86898d; border-radius: 6px;
  padding: 4px; display: flex; flex-direction: column; gap: 4px; }
.cdu-brt-key { background: linear-gradient(180deg, #2b2b2e, #101012); color: #eee; border: 1px solid #000;
  border-radius: 4px; font-size: 9px; font-weight: 700; padding: 4px 8px; cursor: pointer; }

.cdu-keypad { background: #75787c; border-radius: 8px; padding: 10px; display: flex; gap: 10px; }
.cdu-alpha-grid { flex: 1; display: flex; flex-direction: column; gap: 5px; }
.cdu-num-grid { display: flex; flex-direction: column; gap: 5px; }
.cdu-key-row { display: flex; gap: 5px; }
.cdu-key { background: radial-gradient(circle at 30% 30%, #3a3a3d, #0d0d0f 75%); color: #f0f0f0;
  border: 1px solid #000; border-radius: 6px; font-size: 13px; font-weight: 700;
  width: 32px; height: 32px; cursor: pointer; box-shadow: 0 2px 2px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.12); }
.cdu-key:active { transform: translateY(1px); box-shadow: inset 0 1px 4px rgba(0,0,0,0.8); }
.cdu-num-key { border-radius: 50%; }
.cdu-del-key, .cdu-clr-key { width: 44px; font-size: 10px; }
`;
