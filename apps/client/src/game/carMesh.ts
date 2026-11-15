import * as THREE from 'three';
import { CAR } from './config';
import type { WheelState } from './physics';

/**
 * Placeholder car built from boxes, in the chassis frame (+Z forward, +Y up).
 * Swapping in a glTF model later only means replacing what `createCarMesh`
 * returns — physics never looks at it.
 */
export interface CarMesh {
  group: THREE.Group;
  /** Front-left, front-right, rear-left, rear-right. */
  setWheels(wheels: readonly WheelState[]): void;
  setBraking(on: boolean): void;
  setBoosting(on: boolean): void;
  dispose(): void;
}

const wheelGeometry = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, CAR.wheelWidth, 20).rotateZ(Math.PI / 2);
const rimGeometry = new THREE.CylinderGeometry(CAR.wheelRadius * 0.58, CAR.wheelRadius * 0.58, CAR.wheelWidth + 0.02, 6).rotateZ(Math.PI / 2);
const tyreMaterial = new THREE.MeshLambertMaterial({ color: 0x14161b });
const rimMaterial = new THREE.MeshLambertMaterial({ color: 0xc7ced9 });
const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.15, metalness: 0.6 });
const trimMaterial = new THREE.MeshLambertMaterial({ color: 0x151922 });

export function createCarMesh(color: string): CarMesh {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.35 });
  const tailMaterial = new THREE.MeshStandardMaterial({ color: 0x5a0a12, emissive: 0xff1a2b, emissiveIntensity: 0.6 });
  const flameMaterial = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85 });

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Body: a low slab, a tapered nose and a cabin set back.
  box(1.9, 0.4, 4.3, 0, -0.22, 0, paint);
  box(1.7, 0.16, 1.5, 0, 0.04, 1.25, paint); // bonnet
  box(1.84, 0.2, 1.3, 0, 0.06, -1.45, paint); // rear deck
  box(1.46, 0.42, 1.75, 0, 0.26, -0.15, glassMaterial); // cabin
  box(1.5, 0.05, 1.3, 0, 0.49, -0.2, paint); // roof
  box(1.96, 0.07, 0.42, 0, -0.42, 2.1, trimMaterial); // splitter
  box(1.96, 0.12, 0.3, 0, -0.4, -2.1, trimMaterial); // diffuser
  // Wing
  box(1.96, 0.06, 0.46, 0, 0.5, -1.95, trimMaterial);
  box(0.07, 0.34, 0.24, 0.62, 0.32, -1.95, trimMaterial);
  box(0.07, 0.34, 0.24, -0.62, 0.32, -1.95, trimMaterial);
  // Lights
  const headMaterial = new THREE.MeshBasicMaterial({ color: 0xfefce8 });
  box(0.42, 0.09, 0.04, 0.62, -0.12, 2.16, headMaterial).castShadow = false;
  box(0.42, 0.09, 0.04, -0.62, -0.12, 2.16, headMaterial).castShadow = false;
  box(1.56, 0.07, 0.04, 0, -0.1, -2.16, tailMaterial).castShadow = false;
  // Boost flames, hidden until used
  const flames = [0.45, -0.45].map((x) => {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.9, 8).rotateX(-Math.PI / 2), flameMaterial);
    flame.position.set(x, -0.34, -2.6);
    flame.visible = false;
    group.add(flame);
    return flame;
  });

  // Wheels: a pivot that steers, holding a tyre that spins.
  const pivots: THREE.Group[] = [];
  const tyres: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    const tyre = new THREE.Group();
    const rubber = new THREE.Mesh(wheelGeometry, tyreMaterial);
    rubber.castShadow = true;
    tyre.add(rubber, new THREE.Mesh(rimGeometry, rimMaterial));
    pivot.add(tyre);
    group.add(pivot);
    pivots.push(pivot);
    tyres.push(tyre);
  }

  return {
    group,
    setWheels(wheels) {
      for (let i = 0; i < 4; i++) {
        const wheel = wheels[i]!;
        pivots[i]!.position.set(wheel.x, wheel.y, wheel.z);
        pivots[i]!.rotation.y = wheel.steer;
        tyres[i]!.rotation.x = wheel.spin;
      }
    },
    setBraking(on) {
      tailMaterial.emissiveIntensity = on ? 3.2 : 0.6;
    },
    setBoosting(on) {
      for (const flame of flames) {
        flame.visible = on;
        if (on) flame.scale.setScalar(0.8 + Math.random() * 0.5);
      }
    },
    dispose() {
      paint.dispose();
      tailMaterial.dispose();
      flameMaterial.dispose();
      headMaterial.dispose();
      group.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry !== wheelGeometry && object.geometry !== rimGeometry) {
          object.geometry.dispose();
        }
      });
    },
  };
}

/** Floating name plate for other players' cars. */
export function createNameTag(name: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'italic 800 54px "Barlow Condensed", "Arial Narrow", sans-serif';
  const label = name.toUpperCase();
  const width = Math.min(360, ctx.measureText(label).width + 56);
  const x = (canvas.width - width) / 2;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
  ctx.beginPath();
  ctx.moveTo(x + 18, 10);
  ctx.lineTo(x + width, 10);
  ctx.lineTo(x + width - 18, 86);
  ctx.lineTo(x, 86);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(x + 12, 78, width - 30, 8);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, 46, 330);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  sprite.scale.set(4.4, 1.1, 1);
  sprite.position.y = 1.9;
  return sprite;
}
