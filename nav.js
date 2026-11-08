"use strict";
// Shared sidebar: put <aside class="side" id="navmount" data-active="overview|report|session|engine"></aside> on a page and include this script.
(function () {
  const items = [["overview", "Overview", "index.html", "↘"], ["triage", "Patients", "triage.html", "→"], ["report", "Doctor report", "compare.html", "→"], ["engine", "Data engine", "engine.html", "→"]];
  const el = document.getElementById("navmount"); if (!el) return;
  const act = el.dataset.active, pt = new URLSearchParams(location.search).get("patient"), q = pt ? "?patient=" + encodeURIComponent(pt) : "";
  const keep = el.innerHTML;   // anything already inside the mount (e.g. a bottom card) is kept below the nav
  el.innerHTML = `<div class="logo">✺ NeuroMotion</div><nav>` + items.map(i => `<a class="${i[0] === act ? "on" : ""}" href="${i[2]}${q}">${i[1]} <span>${i[0] === act ? "↘" : "→"}</span></a>`).join("") + `</nav>` + (keep.trim() ? `<div class="side-bottom">${keep}</div>` : "");
})();
