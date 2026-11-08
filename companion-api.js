"use strict";
// Browser client for the companion: save readings, record the mic, fetch summaries.
// Saves go to /api/measurements (server.js). If the API is unreachable (e.g. static hosting) it falls back to the older local/Supabase store (labs.js).
(function (root) {
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error((j && j.error) || "request failed (" + r.status + ")"), { status: r.status });
    return j;
  }
  // values: {metric_id: number}. Returns {saved, rejected, via}. Throws on a rejected request (bad value / unknown code).
  async function save(patient, values, opts = {}) {
    try { const j = await post("/api/measurements", { patient, values, source: opts.source || "companion", quality: opts.quality, t: opts.t }); return { ...j, via: "api" }; }
    catch (e) {
      if (e.status) throw e;                                            // server answered: show its message
      if (!root.Labs) throw new Error("Cannot reach the server and no local store is available");
      await root.Labs.addResults(patient, values); return { saved: Object.keys(values).length, rejected: [], via: "local" };
    }
  }
  async function summary(patient) { const r = await fetch("/api/summary?patient=" + encodeURIComponent(patient)); if (!r.ok) throw new Error("summary " + r.status); return r.json(); }
  // Record mono audio for `seconds`. Turns off browser voice processing so loudness bursts are not flattened. onLevel(0..1) for a live meter.
  // opts: {deviceId} to pick a microphone, {agc:false} to switch the browser's automatic gain control off. Echo cancellation and noise suppression stay off so syllable bursts are not flattened;
  // gain control stays ON by default because without it many laptop mics are too quiet to analyse.
  async function recordMic(seconds, onLevel, abort, opts = {}) {   // abort: optional {stop:true} to end early
    const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: opts.agc !== false };
    if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio }), label = (stream.getAudioTracks()[0] || {}).label || "";
    const ctx = new (root.AudioContext || root.webkitAudioContext)(); if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }   // a suspended context delivers no audio at all
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), chunks = []; let peak = 0;
    proc.onaudioprocess = e => { const d = new Float32Array(e.inputBuffer.getChannelData(0)); chunks.push(d); let s = 0; for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; const a = Math.abs(d[i]); if (a > peak) peak = a; } if (onLevel) onLevel(Math.min(1, Math.sqrt(s / d.length) * 14)); };
    src.connect(proc); proc.connect(ctx.destination);
    await new Promise(r => { const t0 = Date.now(), iv = setInterval(() => { if ((abort && abort.stop) || Date.now() - t0 >= seconds * 1000) { clearInterval(iv); r(); } }, 100); });
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); const sampleRate = ctx.sampleRate; await ctx.close();
    const n = chunks.reduce((a, c) => a + c.length, 0), samples = new Float32Array(n); let o = 0; for (const c of chunks) { samples.set(c, o); o += c.length; }
    return { samples, sampleRate, peak, label, frames: chunks.length };
  }
  // microphones the browser can see (names appear once the page has been given permission)
  async function audioInputs() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId); } catch (e) { return []; } }
  root.Companion = { save, summary, recordMic, audioInputs, post };
})(typeof window !== "undefined" ? window : globalThis);
