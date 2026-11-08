"use strict";
// "Dictate results" panel for the console. Two ways in, one confirm card:
//   1) talk to the ElevenLabs agent: it calls the client tool record_measurement(metric, value) -> rows appear on the confirm card
//   2) type or paste what you would say ("grip left 28 right 31, FVC sitting 74") -> parsed locally by dictation.js
// Nothing is saved until the clinician presses Save. Needs measures.js, dictation.js, companion-api.js.
(function (root) {
  const SDK = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.31.0/+esm";
  const CSS = `
  .dlg-back{position:fixed;inset:0;background:rgba(20,28,22,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
  .dlg{width:min(640px,100%);max-height:92vh;overflow:auto;padding:22px;border-radius:26px;background:var(--card-solid,#f4f6f3);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.3)}
  .dlg h2{font-size:20px;margin:0 0 4px} .dlg h4{font:500 12px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:18px 0 8px}
  .dlg .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .dlg input,.dlg textarea{font:inherit;color:var(--ink);background:rgba(255,255,255,.7);border:1px solid var(--line);border-radius:12px;padding:8px 10px}
  .dlg textarea{width:100%;min-height:62px;resize:vertical} .dlg input.n{width:90px}
  .dlg .st{font-size:13px;color:var(--mute);min-height:1.4em} .dlg .st.bad{color:var(--bad)} .dlg .st.ok{color:var(--ok)}
  .dlg .tr{max-height:110px;overflow:auto;font-size:13px;background:rgba(255,255,255,.5);border-radius:12px;padding:8px 10px;margin-top:8px} .dlg .tr:empty{display:none}
  .dlg .tr b{color:var(--sage-d)} .dlg table{width:100%;border-collapse:collapse;font-size:14px} .dlg td{padding:6px 4px;border-bottom:1px solid var(--line)}
  .dlg .x{background:none;border:0;color:var(--mute);cursor:pointer;font-size:16px} .dlg .live{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d0574b;margin-right:6px;animation:pl 1s infinite} @keyframes pl{50%{opacity:.3}}
  `;
  let el = null, conv = null, items = {}, ctx = {};
  const M = () => root.Measures.METRICS, lab = k => M()[k].label + (/_r$/.test(k) ? " (right)" : /_l$/.test(k) ? " (left)" : "");
  const $ = s => el.querySelector(s);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function build() {
    if (!document.getElementById("dlg-css")) { const s = document.createElement("style"); s.id = "dlg-css"; s.textContent = CSS; document.head.appendChild(s); }
    el = document.createElement("div"); el.className = "dlg-back"; el.hidden = true;
    el.innerHTML = `<div class="dlg glass" role="dialog" aria-modal="true" aria-label="Dictate results">
      <div style="display:flex;justify-content:space-between;align-items:start"><div><h2>Clinic visit</h2><div class="mute" style="font-size:13px">Speak or type the results, then check them before saving.</div></div><button class="x" id="d-close" aria-label="Close">&#10005;</button></div>
      <h4>Patient</h4><div class="row"><input id="d-pt" size="14" autocomplete="off"><span class="mute" style="font-size:12px">de-identified code only</span></div>
      <h4>Talk to the assistant</h4><div class="row"><button class="btn" id="d-talk">Start talking</button><button class="btn ghost" id="d-stop" hidden>End conversation</button><span class="st" id="d-vst"></span></div><div class="row" style="margin-top:8px"><select id="d-dev" style="max-width:260px;font:inherit;border:1px solid var(--line);border-radius:12px;padding:6px 8px;background:rgba(255,255,255,.7);color:var(--ink)"><option value="">Default microphone</option></select><button class="btn ghost" id="d-mic">Test microphone</button><div style="flex:1;min-width:90px;height:10px;border-radius:6px;background:var(--line);overflow:hidden" aria-hidden="true"><i id="d-lvl" style="display:block;height:100%;width:0;background:var(--sage-d)"></i></div></div><div class="st" id="d-mst"></div><div class="st" id="d-vad"></div><div class="tr" id="d-tr"></div>
      <h4>Or type what you would say</h4><textarea id="d-txt" placeholder="grip left 28 right 31, FVC sitting 74 supine 61, SNIP 52, 10 meter walk 14.2"></textarea><div class="row" style="margin-top:6px"><button class="btn ghost" id="d-read">Read it</button><span class="st" id="d-tst"></span></div>
      <h4>Check before saving</h4><table id="d-tbl"></table><div class="st" id="d-cst"></div>
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" id="d-cancel">Cancel</button><button class="btn" id="d-save" disabled>Save to record</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener("mousedown", e => { if (e.target === el) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.hidden) close(); });
    $("#d-close").onclick = $("#d-cancel").onclick = close; $("#d-talk").onclick = talk; $("#d-mic").onclick = testMic; $("#d-stop").onclick = stopTalk; $("#d-read").onclick = readText; $("#d-save").onclick = save;
  }

  let lvlTimer = null, peak = 0, vadMax = 0, heardUser = false, statusLog = [];
  const setLvl = v => { $("#d-lvl").style.width = Math.min(100, Math.round(v * 100)) + "%"; };
  async function listDevices() {
    try { const ds = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId), sel = $("#d-dev"), cur = sel.value;
      sel.innerHTML = '<option value="">Default microphone</option>' + ds.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || "Microphone")}</option>`).join(""); sel.value = cur; } catch (e) {}
  }
  async function testMic() {
    const st = $("#d-mst"); st.className = "st"; st.textContent = "Asking for microphone permission...";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.className = "st bad"; st.textContent = "This page can't use the microphone (it needs https or localhost)."; return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $("#d-dev").value ? { exact: $("#d-dev").value } : undefined } }); }
    catch (e) { st.className = "st bad"; st.textContent = e.name === "NotAllowedError" ? "Microphone is blocked. Click the lock/camera icon in the address bar, allow the microphone, then reload." : e.name === "NotFoundError" ? "No microphone found." : "Could not open the microphone: " + e.message; return; }
    await listDevices(); const track = stream.getAudioTracks()[0], ac = new (root.AudioContext || root.webkitAudioContext)(), an = ac.createAnalyser(), buf = new Uint8Array(an.fftSize); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an);
    st.textContent = `Say something. Using: ${track.label || "microphone"}${track.muted ? " (the browser reports it muted)" : ""}`; let pk = 0; const t0 = Date.now();
    const iv = setInterval(() => { an.getByteTimeDomainData(buf); let m = 0; for (const b of buf) m = Math.max(m, Math.abs(b - 128) / 128); pk = Math.max(pk, m); setLvl(m * 3);
      if (Date.now() - t0 > 4000) { clearInterval(iv); stream.getTracks().forEach(t => t.stop()); ac.close(); setLvl(0); st.className = "st " + (pk > .03 ? "ok" : "bad");
        st.textContent = pk > .03 ? `Microphone works (${track.label || "default"}). Peak level ${Math.round(pk * 100)}%.` : `No sound heard from "${track.label || "default microphone"}". Pick a different microphone above, check it isn't muted, and check Windows Settings > Sound > Input.`; } }, 50);
  }
  function add(metric, value) { items[metric] = Number(value); renderTable(); }
  function renderTable() {
    const ks = Object.keys(items), fs = root.Measures.fromSession($("#d-pt").value.trim() || "X", items, {}), bad = new Set(fs.errors.map(e => e.split(":")[0]));
    $("#d-tbl").innerHTML = ks.length ? ks.map(k => `<tr><td>${esc(lab(k))}</td><td><input class="n" data-k="${k}" type="number" step="any" value="${items[k]}"></td><td class="mute">${esc(M()[k].unit)}</td><td style="color:var(--bad);font-size:12px">${bad.has(k) ? "outside plausible range" : ""}</td><td><button class="x" data-r="${k}" aria-label="Remove">&#10005;</button></td></tr>`).join("") : `<tr><td class="mute">Nothing yet.</td></tr>`;
    $("#d-tbl").querySelectorAll("input[data-k]").forEach(i => i.onchange = () => { items[i.dataset.k] = Number(i.value); renderTable(); });
    $("#d-tbl").querySelectorAll("[data-r]").forEach(b => b.onclick = () => { delete items[b.dataset.r]; renderTable(); });
    $("#d-save").disabled = !ks.length || bad.size > 0 || !$("#d-pt").value.trim();
  }
  function readText() {
    const r = root.Dictation.parse($("#d-txt").value), n = Object.keys(r.values).length;
    for (const [k, v] of Object.entries(r.values)) add(k, v);
    $("#d-tst").className = "st " + (n ? "ok" : "bad"); $("#d-tst").textContent = n ? `Added ${n} value${n > 1 ? "s" : ""}.${r.notes.length ? " " + r.notes.join("; ") + "." : ""}` : "I didn't hear any results in that. Try: grip left 28 right 31.";
  }
  const say = (who, t) => { const d = document.createElement("div"); d.innerHTML = `<b>${who}:</b> ${esc(t)}`; $("#d-tr").appendChild(d); $("#d-tr").scrollTop = 1e6; };
  async function talk() {
    const st = $("#d-vst"); st.className = "st"; st.textContent = "Connecting...";
    try {
      const h = await (await fetch("/api/health")).json();
      if (!h.elevenlabs) { st.className = "st bad"; st.textContent = "Voice assistant isn't set up: add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to .env and restart the server. You can type instead."; return; }
      const s = await fetch("/api/eleven-session"); const j = await s.json(); if (!s.ok) throw new Error(j.error || "could not start a session");
      const { Conversation } = await import(SDK);
      peak = 0; vadMax = 0; heardUser = false; statusLog = []; $("#d-vad").textContent = ""; await listDevices();
      conv = await Conversation.startSession({
        signedUrl: j.signedUrl, ...($("#d-dev").value ? { inputDeviceId: $("#d-dev").value } : {}),
        clientTools: { record_measurement: async p => {
          const metric = String(p.metric || "").trim(), value = Number(p.value);
          if (!M()[metric]) return `Unknown metric "${metric}". Valid metrics: ${Object.keys(M()).filter(k => !/^(grip|foot)_(rate|speed|decrement)|^ddk|^gait|^mpt/.test(k)).join(", ")}.`;
          if (!isFinite(value)) return "The value must be a number. Ask the clinician again.";
          add(metric, value); say("Added", `${lab(metric)} ${value} ${M()[metric].unit}`);
          return `Added ${lab(metric)} ${value} ${M()[metric].unit} to the confirm card. The clinician will review and save it on screen. Ask if there is anything else.`; } },
        onConnect: () => { listDevices(); const t0 = Date.now(); clearInterval(lvlTimer); lvlTimer = setInterval(() => { let v = 0; try { v = conv ? conv.getInputVolume() : 0; } catch (e) {} peak = Math.max(peak, v); setLvl(v * 3); if (conv && Date.now() - t0 > 6000 && peak < 0.02 && !$("#d-mst").textContent.startsWith("The assistant")) { $("#d-mst").className = "st bad"; $("#d-mst").textContent = "The assistant is hearing no sound from your microphone. Use Test microphone, pick a different input above, then start again."; } }, 100); st.className = "st ok"; st.innerHTML = '<span class="live"></span>Listening: speak the results'; $("#d-talk").hidden = true; $("#d-stop").hidden = false; },
        onDisconnect: d => { console.log("[elevenlabs] disconnected", d); if (vadMax > .5 && !heardUser) { $("#d-mst").className = "st bad"; $("#d-mst").textContent = "ElevenLabs detected your voice but returned no transcript. Check the agent settings: language, and that user_transcript events are enabled."; } else if (peak > .02 && vadMax <= .5) { $("#d-mst").className = "st bad"; $("#d-mst").textContent = "Your browser captured sound but ElevenLabs did not detect voice. Check the console (F12) for [elevenlabs] errors."; } conv = null; clearInterval(lvlTimer); setLvl(0); st.className = "st"; st.textContent = "Conversation ended."; $("#d-talk").hidden = false; $("#d-stop").hidden = true; },
        onDebug: d => console.debug("[elevenlabs]", d), onError: m => { console.error("[elevenlabs] error", m); st.className = "st bad"; st.textContent = "Voice error: " + (m && m.message || m); },
        onMessage: m => { if (m && m.source === "user") heardUser = true; if (m && m.message) say(m.source === "user" ? "You" : "Assistant", m.message); },
        onVadScore: v => { const sc = (v && (v.vadScore ?? v)) || 0; vadMax = Math.max(vadMax, sc); $("#d-vad").className = "st " + (sc > .5 ? "ok" : ""); $("#d-vad").textContent = `ElevenLabs hears voice: ${sc > .5 ? "YES" : "no"} (score ${Number(sc).toFixed(2)}, best so far ${vadMax.toFixed(2)})`; },
        onStatusChange: v => console.log("[elevenlabs] status", v), onModeChange: m => { if (conv && m && m.mode) st.innerHTML = `<span class="live"></span>${m.mode === "speaking" ? "Assistant is speaking" : "Listening"}`; },
      });
    } catch (e) { conv = null; st.className = "st bad"; st.textContent = "Could not start voice: " + (e && e.message || e) + ". You can type instead."; }
  }
  async function stopTalk() { clearInterval(lvlTimer); try { setLvl(0); if (conv) await conv.endSession(); } catch (e) {} conv = null; $("#d-talk").hidden = false; $("#d-stop").hidden = true; }
  async function save() {
    const pt = $("#d-pt").value.trim(), st = $("#d-cst"); st.className = "st"; st.textContent = "Saving...";
    try { const r = await root.Companion.save(pt, items, { source: "clinic" }); st.className = "st ok"; st.textContent = `Saved ${r.saved} value${r.saved > 1 ? "s" : ""}.`; await stopTalk(); const cb = ctx.onSaved; setTimeout(() => { close(); cb && cb(pt); }, 600); }
    catch (e) { st.className = "st bad"; st.textContent = "Could not save: " + e.message; }
  }
  function close() { stopTalk(); if (el) el.hidden = true; }
  function open(o = {}) {
    if (!el) build(); ctx = o; items = {}; $("#d-pt").value = o.patient || ""; $("#d-pt").oninput = renderTable; $("#d-txt").value = ""; $("#d-tr").innerHTML = ""; $("#d-vst").textContent = ""; $("#d-mst").textContent = ""; $("#d-tst").textContent = ""; $("#d-cst").textContent = "";
    $("#d-talk").hidden = false; $("#d-stop").hidden = true; renderTable(); el.hidden = false; setTimeout(() => $("#d-txt").focus(), 50);
  }
  root.Dictate = { open, close };
})(window);
