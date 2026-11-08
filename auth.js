"use strict";
// Clinician sign-in for the console. Node only; no dependencies.
//  * verifyGoogleIdToken: checks a Google Sign-In ID token (RS256 signature against Google's published keys, issuer, audience, expiry, verified email, optional domain/email allow-list).
//  * sessions: a signed, expiring cookie value (HMAC-SHA256). The server keeps no session table, so restarting with a new SESSION_SECRET signs everyone out.
//  * clinician store + audit log: small JSON files next to the data file. Not a clinical-grade store; see README "Sign-in and onboarding".
const crypto = require("crypto"), fs = require("fs"), path = require("path");

const b64u = b => Buffer.from(b).toString("base64url");
const fromB64u = s => Buffer.from(s, "base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- Google ID token -------------------------------------------------------------------------------------------------------------------
let jwksCache = { at: 0, keys: null };
async function fetchGoogleJwks(fetchFn = fetch) {                 // cached for an hour
  if (jwksCache.keys && Date.now() - jwksCache.at < 36e5) return jwksCache.keys;
  const r = await fetchFn("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("could not fetch Google signing keys (" + r.status + ")");
  const keys = (await r.json()).keys; jwksCache = { at: Date.now(), keys }; return keys;
}
// opts: { clientId, jwks (array of JWKs, or async function returning one), allowedDomains: [..]|null, allowedEmails: [..]|null, now (ms) }
async function verifyGoogleIdToken(idToken, opts) {
  const fail = error => ({ ok: false, error });
  try {
    if (!opts.clientId) return fail("Google sign-in is not configured on this server");
    const parts = String(idToken || "").split("."); if (parts.length !== 3) return fail("malformed token");
    const header = JSON.parse(fromB64u(parts[0]).toString()), claims = JSON.parse(fromB64u(parts[1]).toString());
    if (header.alg !== "RS256") return fail("unexpected signing algorithm");
    const keys = typeof opts.jwks === "function" ? await opts.jwks() : opts.jwks || await fetchGoogleJwks(), jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return fail("signing key not recognised");
    const good = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: jwk, format: "jwk" }), fromB64u(parts[2]));
    if (!good) return fail("bad signature");
    const now = Math.floor((opts.now || Date.now()) / 1000);
    if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) return fail("wrong issuer");
    if (claims.aud !== opts.clientId) return fail("token was issued for a different app");
    if (!(claims.exp > now - 30)) return fail("token expired");
    if (claims.iat && claims.iat > now + 120) return fail("token issued in the future");
    if (!claims.sub || !claims.email) return fail("token has no account identity");
    if (claims.email_verified !== true && claims.email_verified !== "true") return fail("Google has not verified this email address");
    const email = String(claims.email).toLowerCase(), domain = email.split("@")[1];
    const doms = (opts.allowedDomains || []).map(d => d.toLowerCase()), mails = (opts.allowedEmails || []).map(d => d.toLowerCase());
    if ((doms.length || mails.length) && !(mails.includes(email) || (doms.includes(domain) && (!claims.hd || doms.includes(String(claims.hd).toLowerCase())))))
      return fail("this account is not on the list of approved clinicians");
    return { ok: true, user: { sub: "google:" + claims.sub, email, name: claims.name || email, picture: claims.picture || null, hd: claims.hd || null } };
  } catch (e) { return fail("could not verify token: " + e.message); }
}

// ---- sessions (signed cookie value) ----------------------------------------------------------------------------------------------------
function makeSessions(secret, ttlMs = 8 * 36e5) {
  const sign = data => crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return {
    ttlMs,
    create(sub, now = Date.now()) { const p = b64u(JSON.stringify({ sub, exp: now + ttlMs })); return p + "." + sign(p); },
    read(token, now = Date.now()) {
      const [p, sig] = String(token || "").split("."); if (!p || !sig || !eq(sig, sign(p))) return null;
      try { const d = JSON.parse(fromB64u(p).toString()); return d.exp > now && d.sub ? d : null; } catch (e) { return null; }
    },
  };
}

// ---- clinician records + audit log -----------------------------------------------------------------------------------------------------
function makeClinicianStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "clinicians.json"), triFile = path.join(dir, "triage.json"), auditFile = path.join(dir, "audit.log");
  const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return f === triFile ? [] : {}; } };
  const write = (f, v) => { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
  return {
    upsert(user, now = Date.now()) {                               // first sign-in creates the record; later sign-ins refresh name/picture only
      const all = read(file), cur = all[user.sub], rec = cur ? { ...cur, name: cur.profileName || user.name, picture: user.picture, lastSignInAt: now } : { sub: user.sub, email: user.email, name: user.name, picture: user.picture, createdAt: now, lastSignInAt: now, onboardedAt: null };
      all[user.sub] = rec; write(file, all); return rec;
    },
    get(sub) { return read(file)[sub] || null; },
    onboard(sub, { name, role, org }, now = Date.now()) { const all = read(file); if (!all[sub]) return null; all[sub] = { ...all[sub], profileName: name, name, role, org, onboardedAt: now }; write(file, all); return all[sub]; },
    addTriage(rec) { const all = read(triFile); all.push(rec); write(triFile, all); return rec; },
    triageFor(patient) { return read(triFile).filter(r => r.patient === patient); },
    allTriage() { return read(triFile); },
    audit(action, user, detail = {}) { try { fs.appendFileSync(auditFile, JSON.stringify({ t: new Date().toISOString(), action, user: user ? user.email : null, ...detail }) + "\n"); } catch (e) { console.error("audit log write failed:", e.message); } },
  };
}

const ROLES = ["Neurologist", "Family physician", "Nurse practitioner", "Physiotherapist", "Occupational therapist", "Speech-language pathologist", "Other clinician"];
const publicUser = rec => rec && ({ email: rec.email, name: rec.name, picture: rec.picture, role: rec.role || null, org: rec.org || null, onboarded: !!rec.onboardedAt });
const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
module.exports = { verifyGoogleIdToken, fetchGoogleJwks, makeSessions, makeClinicianStore, ROLES, publicUser, list, eq };
