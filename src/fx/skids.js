import * as THREE from 'three';

const WORLD = 320;      // metres of ground the decal window covers — the whole playable island
const RES = 1024;       // canvas resolution → 3.2 px per metre; a 0.24 m track is still 0.8 px wide

// Tyre marks are painted once into a canvas that spans the entire island, so the ink is welded
// to world coordinates and never needs to scroll or be wiped. Old tracks fade out via a
// destination-out pass, which lowers alpha without tinting the untouched sand.
export function createSkidMarks(scene) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = RES;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  // A CanvasTexture defaults to a full mipmap chain, and three regenerates all 11 levels on every
  // upload. This texture uploads every third frame, so the chain rebuild — not the drawing, not
  // the 4 MB bus transfer — was the periodic 50 ms stall that made driving feel like it lurched.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD, WORLD).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -4, opacity: 0.62,
    })
  );
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const k = RES / WORLD;
  const toPx = (x, z) => [(x + WORLD / 2) * k, (z + WORLD / 2) * k];

  const stamp = (x, z, r, yaw, len) => {
    const [px, py] = toPx(x, z);
    if (px < -8 || py < -8 || px > RES + 8 || py > RES + 8) return;
    g.save();
    g.translate(px, py);
    g.rotate(-yaw);
    g.fillStyle = 'rgba(30,12,6,0.55)';
    g.beginPath();
    g.ellipse(0, 0, r * k, len * k, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };

  let frame = 0;
  const FADE = 118 * k;   // px across the window that gets the per-tick fade
  return {
    update(dt, wheels, slip, yaw) {
      // the canvas is 1024² — uploading it every frame would cost ~4 MB of bus traffic, so the
      // fade (and therefore the upload) runs at a third of the frame rate
      if (++frame % 3) return;
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = 'rgba(0,0,0,0.018)';
      // Only the neighbourhood the rover could still look back at fades every tick. A full-canvas
      // pass touches a million pixels three times a second to change nothing on the far side of
      // the island; a slow global sweep every ~4 s still guarantees old ink eventually clears.
      if (wheels.length) {
        let cx = 0, cz = 0;
        for (const p of wheels) { cx += p.x; cz += p.z; }
        const [px, py] = toPx(cx / wheels.length, cz / wheels.length);
        g.fillRect(px - FADE / 2, py - FADE / 2, FADE, FADE);
        if (frame % 90 < 3) g.fillRect(0, 0, RES, RES);
      } else {
        g.fillRect(0, 0, RES, RES);
      }
      g.globalCompositeOperation = 'source-over';
      if (slip > 1.5) {
        const w = Math.min(1, slip / 6);
        for (const p of wheels) stamp(p.x, p.z, 0.24 + w * 0.16, yaw, 0.4 + w * 0.55);
      }
      tex.needsUpdate = true;
    },
  };
}
