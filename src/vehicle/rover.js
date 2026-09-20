import * as THREE from 'three';

// Procedural six-wheel Mars rover — gold MLI foil, white deck, mast cam, RTG.
export function createRover(scene) {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a04e, metalness: 0.75, roughness: 0.4, envMapIntensity: 1.1 });
  // painted aluminium, not polished metal: a semi-metallic smooth deck clips to a flat white
  // slab under the sun and hands bloom a hard halo right over the vehicle
  const white = new THREE.MeshStandardMaterial({ color: 0xcfcabf, metalness: 0.05, roughness: 0.66 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.6, roughness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x3b3530, metalness: 0.4, roughness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fd9ff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.65, emissive: 0x113344 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 3.1), gold);
  chassis.position.y = 0.82; g.add(chassis);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 2.7), white);
  deck.position.y = 1.04; g.add(deck);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 2.6), dark);
  belly.position.y = 0.62; g.add(belly);
  // nose slope
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 0.7), gold);
  nose.position.set(0, 0.75, 1.8); nose.rotation.x = -0.35; g.add(nose);
  // RTG
  const rtg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.9, 12), dark);
  rtg.rotation.x = Math.PI / 2; rtg.position.set(0.55, 1.1, -1.75); g.add(rtg);
  for (let i = 0; i < 8; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.85), new THREE.MeshStandardMaterial({ color: 0x666058, metalness: 0.8, roughness: 0.45 }));
    fin.position.set(0.55 + Math.cos(i / 8 * 6.283) * 0.3, 1.1 + Math.sin(i / 8 * 6.283) * 0.3, -1.75);
    fin.lookAt(new THREE.Vector3(0.55, 1.1, -1.75).add(new THREE.Vector3(0, 0, 1)));
    fin.rotation.z = i / 8 * 6.283; g.add(fin);
  }
  // mast + camera head + dish
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 8), white);
  mast.position.set(-0.5, 1.6, 1.15); g.add(mast);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.3), white);
  head.position.set(-0.5, 2.22, 1.15); g.add(head);
  const eyeL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 12), glass);
  eyeL.rotation.x = Math.PI / 2; eyeL.position.set(-0.62, 2.24, 1.32); g.add(eyeL);
  const eyeR = eyeL.clone(); eyeR.position.x = -0.38; g.add(eyeR);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, 6.283, 0, 1.1), white);
  dish.position.set(0.6, 1.5, -1.1); dish.rotation.set(-2.2, 0.4, 0); g.add(dish);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.3, 6), dark);
  ant.position.set(0.85, 1.6, -0.4); g.add(ant);
  // headlights
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe0a0, emissiveIntensity: 1.7 });
  const lampL = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12), lampMat);
  lampL.rotation.x = Math.PI / 2; lampL.position.set(-0.6, 0.92, 1.96); g.add(lampL);
  const lampR = lampL.clone(); lampR.position.x = 0.6; g.add(lampR);
  // narrow cool-white throw — a wide warm cone reads as a glowing puddle on the dune
  const spotL = new THREE.SpotLight(0xfff1e0, 0, 115, 0.33, 0.7, 1.05);
  spotL.position.set(-0.6, 1, 2); spotL.target.position.set(-0.6, -0.9, 34); g.add(spotL, spotL.target);
  const spotR = spotL.clone(); spotR.position.x = 0.6; spotR.target.position.x = 0.6; g.add(spotR, spotR.target);
  g.userData.spots = [spotL, spotR];

  // wheels: rocker arms + mesh-look wheels
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.34, 22, 1, true);
  const hubGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.36, 10);
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);           // 0 front 1 mid 2 rear
    const z = 1.5 - row * 1.5;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.09, 0.16), dark);
    arm.position.set(side * 1.05, 0.72, z); g.add(arm);
    const steerArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.14), dark);
    steerArm.position.set(side * 1.3, 0.5, z + (row === 1 ? 0 : (row === 0 ? 0.35 : -0.35))); g.add(steerArm);
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, rubber);
    tire.rotation.z = Math.PI / 2; wheel.add(tire);
    const hub = new THREE.Mesh(hubGeo, gold); hub.rotation.z = Math.PI / 2; wheel.add(hub);
    for (let s = 0; s < 8; s++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.03, 0.03), dark);
      const a = s / 8 * Math.PI * 2;
      spoke.position.y = 0; spoke.rotation.x = a; wheel.add(spoke);
    }
    const rimF = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.03, 6, 20), dark);
    rimF.rotation.y = Math.PI / 2; rimF.position.x = 0.17; wheel.add(rimF);
    const rimB = rimF.clone(); rimB.position.x = -0.17; wheel.add(rimB);
    wheel.position.set(side * 1.42, 0.46, z);
    wheel.userData.steerable = row !== 1;
    wheel.userData.side = side; wheel.userData.row = row;
    const pivot = new THREE.Group();
    pivot.position.copy(wheel.position); wheel.position.set(0, 0, 0);
    pivot.userData = { row, side, spin: wheel };
    g.add(pivot); pivot.add(wheel); wheels.push(pivot);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(0, 0, 0);
  scene.add(g);
  return { group: g, wheels, lampMat };
}
