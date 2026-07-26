import { useState } from "react";
import App from "./App.jsx";
import CduApp from "./cdu/CduApp.jsx";

// Lets you flip between the original iOS-style panel UI and the new MCDU
// emulator without deleting either one. Defaults to the CDU since that's
// the interface being built out now, but the classic UI is one tap away
// and nothing about it changed.
const MODE_KEY = "tps_ui_mode";

export default function Root() {
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) || "cdu");

  function toggle() {
    const next = mode === "cdu" ? "classic" : "cdu";
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  }

  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      {mode === "cdu" ? <CduApp /> : <App />}
      <button
        onClick={toggle}
        style={{
          position: "fixed", top: 8, right: 8, zIndex: 999,
          background: "rgba(0,0,0,0.55)", color: "#fff", border: "none",
          borderRadius: 8, fontSize: 11, fontFamily: "inherit",
          padding: "6px 10px", cursor: "pointer",
        }}
      >
        {mode === "cdu" ? "Classic UI" : "MCDU"}
      </button>
    </div>
  );
}
