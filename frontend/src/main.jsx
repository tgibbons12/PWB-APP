import React from "react";
import ReactDOM from "react-dom/client";
import CduApp from "./cdu/CduApp.jsx";

// PWB is the standalone MCDU app — no classic-UI toggle here (that lives in
// the separate TPS repo). See cdu/CduApp.jsx for the page flow.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CduApp />
  </React.StrictMode>
);
