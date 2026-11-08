"use strict";
// Interactive 3D body with clickable, status-tinted regions. Needs THREE r128 + GLTFLoader + MeshoptDecoder (see index.html).
// BodyViewer.mount(el, {onSelect, src}) -> {setStatus({region:'ok'|'warn'|'bad'|'none'}), select(region), ready:Promise}
// The GLB is one fused body mesh, so regions are assigned per vertex from body position (see classify()).
(function (root) {
  const COL = { ok: [.44, .68, .49], warn: [.80, .82, .79], bad: [.82, .34, .29], none: [.80, .82, .79] };
  const REGIONS = { bulbar: "Bulbar / speech", chest: "Respiratory (chest)", handR: "Right hand & forearm", handL: "Left hand & forearm", footR: "Right leg & foot", footL: "Left leg & foot" };
  const NAMES = Object.keys(REGIONS);
  // nx = x / height (signed, +x = model's +x), h = 0 (feet) .. 1 (head top). Tuned for assets/body.glb.
  const CUT = { head: .865, arm: .125, armTop: .82, armBot: .36, leg: .47 };
  const RIGHT_IS_NEG_X = true;   // figure's right arm sits on -x when it faces +z
  function classify(nx, h) {
    if (h > CUT.head) return "bulbar";
    const right = RIGHT_IS_NEG_X ? nx < 0 : nx > 0;
    if (Math.abs(nx) > CUT.arm && h < CUT.armTop && h > CUT.armBot) return right ? "handR" : "handL";
    if (h < CUT.leg) return right ? "footR" : "footL";
    return "chest";
  }
  function mount(el, opts = {}) {
    const T = root.THREE, W = () => el.clientWidth || 300, H = () => el.clientHeight || 420;
    const scene = new T.Scene(), cam = new T.PerspectiveCamera(32, W() / H(), .1, 100);
    const rn = new T.WebGLRenderer({ antialias: true, alpha: true }); rn.setPixelRatio(Math.min(devicePixelRatio, 2)); rn.setSize(W(), H()); el.appendChild(rn.domElement);
    scene.add(new T.HemisphereLight(0xffffff, 0x8aa08a, 1.0)); const dl = new T.DirectionalLight(0xffffff, .75); dl.position.set(2, 4, 5); scene.add(dl);
    const fig = new T.Group(); scene.add(fig); cam.position.set(0, 0, 4.1);
    let mesh = null, regionOf = null, status = {}, sel = null, ry = 0, drag = null, moved = 0, auto = true, resumeAt = 0, phase = 0, last = performance.now();
    const AMP = Math.PI / 3, SPEED = 0.55;   // sway +-60 deg (120 deg sweep) about the front
    function paint() {
      if (!mesh) return; const col = mesh.geometry.attributes.color, n = col.count;
      for (let i = 0; i < n; i++) { const r = NAMES[regionOf[i]], c = COL[status[r] || "none"], k = r === sel ? 1.0 : .88, lift = r === sel ? .12 : 0;
        col.setXYZ(i, Math.min(1, c[0] * k + lift), Math.min(1, c[1] * k + lift), Math.min(1, c[2] * k + lift)); }
      col.needsUpdate = true;
    }
    function build(gltf) {
      gltf.scene.updateMatrixWorld(true);
      let bodyMesh = null, big = 0; const extras = [];
      gltf.scene.traverse(o => { if (!o.isMesh) return; const c = o.geometry.attributes.position.count; if (c > big) { big = c; bodyMesh = o; } });
      gltf.scene.traverse(o => { if (o.isMesh && o !== bodyMesh) extras.push(o); });
      // bake world-space float geometry (the file stores quantised positions)
      const bake = o => { const g = o.geometry, p = g.attributes.position, n = p.count, pos = new Float32Array(n * 3), v = new T.Vector3();
        for (let i = 0; i < n; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pos.set([v.x, v.y, v.z], i * 3); }
        const out = new T.BufferGeometry(); out.setAttribute("position", new T.BufferAttribute(pos, 3)); if (g.index) out.setIndex(g.index.clone()); return out; };
      const bg = bake(bodyMesh), eg = extras.map(bake);
      bg.computeBoundingBox(); const bb = bg.boundingBox, hgt = bb.max.y - bb.min.y, cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2, s = 1.8 / hgt;
      const place = g => { g.translate(-cx, -bb.min.y, -cz); g.scale(s, s, s); g.translate(0, -.9, 0); };
      const P = bg.attributes.position, n = P.count; regionOf = new Uint8Array(n); const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) regionOf[i] = NAMES.indexOf(classify((P.getX(i) - cx) / hgt, (P.getY(i) - bb.min.y) / hgt));
      bg.setAttribute("color", new T.BufferAttribute(colors, 3)); place(bg); bg.computeVertexNormals();
      mesh = new T.Mesh(bg, new T.MeshStandardMaterial({ vertexColors: true, roughness: .6, metalness: .02, side: T.DoubleSide })); fig.add(mesh);
      eg.forEach(g => { place(g); fig.add(new T.Mesh(g, new T.MeshStandardMaterial({ color: 0x2a2f2a, roughness: .3 }))); });
      paint();
    }
    const ready = new Promise((res, rej) => {
      const L = new T.GLTFLoader(); if (root.MeshoptDecoder) L.setMeshoptDecoder(root.MeshoptDecoder);
      const go = () => L.load(opts.src || "assets/body.glb", g => { build(g); res(); }, undefined, e => { console.error("GLB load failed", e); rej(e); });
      root.MeshoptDecoder && root.MeshoptDecoder.ready ? root.MeshoptDecoder.ready.then(go) : go();
    });
    const ray = new T.Raycaster(), ptr = new T.Vector2();
    function pick(e) { if (!mesh) return null; const b = rn.domElement.getBoundingClientRect(); ptr.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1); ray.setFromCamera(ptr, cam);
      const h = ray.intersectObject(mesh)[0]; return h ? NAMES[regionOf[h.face.a]] : null; }
    function select(r) { sel = r; paint(); opts.onSelect && opts.onSelect(r); }
    const cv = rn.domElement; cv.style.cursor = "grab"; cv.style.touchAction = "none";
    cv.onpointerdown = e => { drag = e.clientX; moved = 0; auto = false; resumeAt = Infinity; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; };
    cv.onpointermove = e => { if (drag != null) { const dx = e.clientX - drag; moved += Math.abs(dx); ry += dx * .01; drag = e.clientX; } };
    cv.onpointerup = e => { drag = null; resumeAt = performance.now() + 1800; cv.style.cursor = "grab"; if (moved < 4) select(pick(e)); };
    new ResizeObserver(() => { rn.setSize(W(), H()); cam.aspect = W() / H(); cam.updateProjectionMatrix(); }).observe(el);
    (function loop(now) {
      const dt = Math.min(.05, ((now || last) - last) / 1000); last = now || last;
      if (!auto && resumeAt <= last) { ry = Math.atan2(Math.sin(ry), Math.cos(ry)); ry = Math.max(-AMP, Math.min(AMP, ry)); phase = Math.asin(ry / AMP); auto = true; }
      if (auto) { phase += SPEED * dt; ry = AMP * Math.sin(phase); }
      fig.rotation.y = ry; rn.render(scene, cam); requestAnimationFrame(loop); })();
    return { REGIONS, ready, select, _dbg: () => ({ mesh, regionOf }), setStatus(s) { status = s || {}; paint(); } };
  }
  root.BodyViewer = { mount, REGIONS, classify, CUT };
})(window);
