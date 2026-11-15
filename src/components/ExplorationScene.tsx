import { orbitProfiles } from '../systems/engineering';
import { localiseMission } from '../data/missionLocale';
import FullscreenControl from './FullscreenControl';
import { attachRenderQuality } from '../systems/renderQuality';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import type { Mission } from '../data/missions';
import { celestialBodies } from '../data/celestialBodies';
import {
  initialExplorationResources,
  initialLunarProgress,
  getLandingZones,
  loadExplorationResources,
  loadLunarProgress,
  lunarObjectives,
  objectiveCompletion,
  saveExplorationResources,
  saveLunarProgress,
} from '../systems/lunarCampaign';
import type { ExplorationResources, LunarProgress } from '../systems/lunarCampaign';
import { readStorage, writeStorage, removeStorage } from '../systems/storage';
import { awardMission } from '../systems/playerProgress';
import { playSound, startEngine, stopEngine } from '../systems/audio';
import type { ShipId } from '../data/ships';
import { hulls, instruments, radios, type MissionDesign } from '../systems/engineering';
import type { TransitState } from '../systems/transit';
import { createScienceReport, saveReport } from '../systems/science';
import { makeFailedAttempt, saveFailedAttempt } from '../systems/missionAttempts';
import { explorationFailureReason } from '../systems/explorationFailure';
import PlanetaryLab from './PlanetaryLab';
import type { LabReading } from '../data/planetaryLab';
import { loadPlanetTexture } from '../systems/planetTextures';
import { compressedTransmissionSeconds, estimatedSignalSeconds } from '../systems/communications';
import { isSimulatedDustStorm } from '../systems/weather';
import { isEonetTarget, type EonetTarget } from '../systems/eonet';
import { addBufferedData, emptyDataBuffers, totalBuffered, transmitBufferedData, type DataBuffers, type DataKind } from '../systems/dataBuffers';
import { getLiveSnapshot, setLivePose, subscribeLiveSnapshot, type LivePlayer, type LivePose } from '../collaboration/liveSession';
import { createPlayerAvatar, disposeAvatar, type AvatarRig } from './SolarSystemScene';

type Mode = 'flight' | 'orbit' | 'surface';
type PointOfInterest = { object: THREE.Group; kind: 'rock' | 'station'; index: number; name: string; position: THREE.Vector3 };
type BodyRuntime = { data: (typeof celestialBodies)[number]; group: THREE.Group; mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; orbitRadius: number; phase: number; angularSpeed: number };
type TutorialStep = { id: string; title: string; instruction: string };
type OrbitalSurvey = { arrived: boolean; scannedRegions: number[]; transmitted: boolean };
type SurfaceSensor = { x: number; z: number };

type Props = { mission: Mission; onExit: () => void; shipId: ShipId; design: MissionDesign; arrival: TransitState | null; scienceTarget: EonetTarget | null; language: "en" | "es" };

const tutorialOrder = ['travel', 'landing-zone', 'land', 'surface', 'scan', 'sample', 'station', 'recharge', 'analyze', 'antenna', 'transmit', 'complete'];
const emptyOrbitalSurvey: OrbitalSurvey = { arrived: false, scannedRegions: [], transmitted: false };
const orbitalRegions: Record<string, string[]> = {
  mars: ['Antiguo delta', 'Estratos arcillosos', 'Llanura de cráteres'],
  earth: ['Patrón de nubosidad', 'Corriente oceánica', 'Cobertura vegetal'],
  asteroid: ['Ladera metálica', 'Campo de regolito', 'Cráter de impacto'],
  europa: ['Fracturas de hielo', 'Llanura de bandas', 'Terreno caótico'],
  saturn: ['Anillo A', 'División de Cassini', 'Anillo E'],
  jupiter: ['Gran Mancha Roja', 'Banda ecuatorial', 'Tormenta polar'],
  sun: ['Corona solar', 'Arco magnético', 'Eyección de masa coronal'],
  mercury: ['Cráter de impacto', 'Llanura iluminada', 'Región polar en sombra'],
  venus: ['Nubes altas', 'Hemisferio nocturno', 'Patrón atmosférico'],
  titan: ['Nubes de metano', 'Región de lagos', 'Dunas ecuatoriales'],
  uranus: ['Atmósfera polar', 'Nubes altas', 'Entorno magnético'],
  neptune: ['Tormenta oscura', 'Nubes altas', 'Entorno de Tritón'],
};

function loadOrbitalSurvey(missionId: string): OrbitalSurvey {
  try {
    const saved = readStorage(`orbital-command-survey-${missionId}`);
    if (!saved) return { ...emptyOrbitalSurvey };
    const parsed = JSON.parse(saved) as Partial<OrbitalSurvey>;
    const scannedRegions = Array.isArray(parsed.scannedRegions)
      ? [...new Set(parsed.scannedRegions.filter((index) => Number.isInteger(index) && index >= 0 && index < 3))]
      : [];
    return { arrived: parsed.arrived === true, scannedRegions, transmitted: scannedRegions.length === 3 && parsed.transmitted === true };
  } catch {
    return { ...emptyOrbitalSurvey };
  }
}

function loadLabReadings(missionId: string): LabReading[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(`orbital-command-lab-${missionId}`) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LabReading => Boolean(item && typeof item.region === 'string' && typeof item.label === 'string' && typeof item.unit === 'string' && typeof item.value === 'number' && Number.isFinite(item.value))).slice(0, 24);
  } catch { return []; }
}

function loadSurfaceSensors(missionId: string): SurfaceSensor[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(`orbital-command-sensors-${missionId}`) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SurfaceSensor => Boolean(item && typeof item.x === 'number' && typeof item.z === 'number' && Number.isFinite(item.x) && Number.isFinite(item.z) && Math.abs(item.x) <= 42 && Math.abs(item.z) <= 42)).slice(0, 3);
  } catch { return []; }
}
function loadDataBuffers(missionId: string, storage: number, freshArrival: boolean): DataBuffers {
  const fallback = { ...emptyDataBuffers(), telemetry: storage };
  if (freshArrival) return fallback;
  try {
    const saved: unknown = JSON.parse(readStorage(`orbital-command-buffers-${missionId}`) ?? 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    const candidate = saved as Partial<DataBuffers>;
    if (['observations', 'sensors', 'telemetry'].some((key) => {
      const value = candidate[key as DataKind];
      return typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100;
    })) return fallback;
    const buffers = candidate as DataBuffers;
    return Math.abs(totalBuffered(buffers) - storage) < 0.01 ? buffers : fallback;
  } catch { return fallback; }
}
function loadMissionEvents(missionId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(`orbital-command-events-${missionId}`) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
  } catch { return []; }
}

function terrainHeight(x: number, z: number, bodyId = 'moon') {
  if (bodyId === 'mars') return Math.sin(x * 0.12) * 0.9 + Math.sin(z * 0.2) * 0.35 - 2.2 * Math.exp(-((x + z * 0.3) ** 2) / 35);
  if (bodyId === 'titan') return Math.sin(x * 0.2 + z * 0.04) * 0.8 + Math.sin(x * 0.08) * 0.5;
  const craters = bodyId === 'mercury' ? [[-18, -12, 7], [16, -18, 8], [21, 15, 5], [-22, 18, 8], [3, 25, 6], [0, 0, 3], [-8, 9, 4]] : [[-18, -12, 4], [16, -18, 5], [21, 15, 3.5], [-22, 18, 6], [3, 25, 4]];
  let height = Math.sin(x * 0.16) * Math.cos(z * 0.13) * 0.22 + Math.sin((x + z) * 0.31) * 0.08;
  for (const [cx, cz, radius] of craters) {
    const distance = Math.hypot(x - cx, z - cz);
    height -= Math.exp(-((distance - radius) ** 2) / 2.1) * 1.2;
    height += Math.exp(-((distance - radius * 1.18) ** 2) / 1.4) * 0.22;
  }
  return height;
}

function makeTerrainTexture(bodyId: string, color: string) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 8500; i += 1) {
    const shade = Math.random() > 0.5 ? '255,221,179' : '35,18,15';
    context.fillStyle = `rgba(${shade},${0.03 + Math.random() * 0.12})`;
    const size = 0.5 + Math.random() * (bodyId === 'titan' ? 3 : 2);
    context.fillRect(Math.random() * 512, Math.random() * 512, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(4, 4);
  return texture;
}

function createSurface(bodyId: string) {
  const heightAt = (x: number, z: number) => terrainHeight(x, z, bodyId);
  const surfaceColor = bodyId === 'mars' ? '#a84f35' : bodyId === 'mercury' ? '#716861' : bodyId === 'titan' ? '#997041' : '#777a80';
  const root = new THREE.Group();
  const size = 90;
  const segments = 120;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    positions.setZ(i, heightAt(x, y));
  }
  geometry.computeVertexNormals();
  const terrainTexture = makeTerrainTexture(bodyId, surfaceColor);
  const terrainMaterial = new THREE.MeshStandardMaterial({ color: terrainTexture ? '#ffffff' : surfaceColor, map: terrainTexture, roughness: 1, metalness: 0.02 });
  const terrain = new THREE.Mesh(geometry, terrainMaterial);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.y = -0.3;
  terrain.receiveShadow = true;
  root.add(terrain);

  const rockMaterial = new THREE.MeshStandardMaterial({ color: '#99928a', roughness: 1 });
  for (let i = 0; i < 80; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 7 + Math.random() * 37;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + Math.random() * 0.7, 0), rockMaterial);
    rock.position.set(x, heightAt(x, z) + 0.05, z);
    rock.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    rock.scale.set(1 + Math.random(), 0.55 + Math.random() * 0.5, 0.8 + Math.random());
    root.add(rock);
  }

  const points: PointOfInterest[] = [];
  const sampleLocations: Array<[number, number]> = [[-11, -7], [10, -5], [4, 13]];
  sampleLocations.forEach(([x, z], index) => {
    const point = new THREE.Group();
    point.position.set(x, heightAt(x, z), z);
    point.userData.poiIndex = index;
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), new THREE.MeshStandardMaterial({ color: '#8de8ff', emissive: '#12728a', emissiveIntensity: 1.4 }));
    beacon.position.y = 1.35;
    point.add(beacon);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.035, 8, 32), new THREE.MeshBasicMaterial({ color: '#78e5ff', transparent: true, opacity: 0.8 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.15;
    point.add(ring);
    root.add(point);
    const names = bodyId === 'mars' ? ['Estrato sedimentario', 'Afloramiento rojizo', 'Roca del antiguo delta'] : bodyId === 'mercury' ? ['Brecha craterizada', 'Llanura rocosa', 'Regolito polar'] : bodyId === 'titan' ? ['Duna orgánica', 'Canto de hielo', 'Depósito cercano al lago'] : ['Basalto vesicular', 'Brecha de impacto', 'Regolito polar'];
    points.push({ object: point, kind: 'rock', index, name: names[index], position: point.position.clone() });
  });

  const station = new THREE.Group();
  station.userData.poiIndex = 3;
  station.position.set(-1, heightAt(-1, -18), -18);
  const stationBase = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.4, 0.5, 8), new THREE.MeshStandardMaterial({ color: '#d8e6ee', metalness: 0.5, roughness: 0.45 }));
  stationBase.position.y = 0.25;
  station.add(stationBase);
  const stationTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.8, 0.8, 8), new THREE.MeshStandardMaterial({ color: '#5bbfd8', emissive: '#0d3a4b', emissiveIntensity: 0.7 }));
  stationTop.position.y = 0.85;
  station.add(stationTop);
  root.add(station);
  points.push({ object: station, kind: 'station', index: 0, name: 'Estación de análisis', position: station.position.clone() });

  const rover = new THREE.Group();
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.48, 1.65), new THREE.MeshStandardMaterial({ color: '#e1e6e8', metalness: 0.38, roughness: 0.55 }));
  chassis.position.y = 1;
  rover.add(chassis);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.95, 10), new THREE.MeshStandardMaterial({ color: '#a8d7e5', metalness: 0.5 }));
  mast.position.set(0, 1.67, -0.35);
  rover.add(mast);
  const camera = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.33, 0.42), new THREE.MeshStandardMaterial({ color: '#ffcb75', emissive: '#6f3a09', emissiveIntensity: 0.5 }));
  camera.position.set(0, 2.2, -0.35);
  rover.add(camera);
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: '#333b44', metalness: 0.25, roughness: 0.85 });
  for (const side of [-1, 1]) {
    for (const front of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.22, 12), wheelMaterial);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.78, 0.48, front * 0.58);
      rover.add(wheel);
    }
  }
  rover.position.set(0, heightAt(0, 0), 0);
  root.add(rover);
  const astronaut = new THREE.Group();
  const suitMaterial = new THREE.MeshStandardMaterial({ color: '#d9e5e9', roughness: 0.7 });
  const suit = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 4, 10), suitMaterial); suit.position.y = 1; astronaut.add(suit);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 12), new THREE.MeshStandardMaterial({ color: '#e9f2f4', metalness: 0.3, roughness: 0.4 })); helmet.position.y = 1.75; astronaut.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshStandardMaterial({ color: '#d8a449', metalness: 0.8, roughness: 0.2 })); visor.position.set(0, 1.77, -0.19); astronaut.add(visor);
  for (const side of [-1, 1]) { const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.42, 4, 8), suitMaterial); leg.position.set(side * 0.16, 0.36, 0); astronaut.add(leg); }
  astronaut.visible = false; root.add(astronaut);
  if (bodyId === 'titan') {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(7, 40), new THREE.MeshStandardMaterial({ color: '#283943', roughness: 0.2, metalness: 0.15 }));
    lake.rotation.x = -Math.PI / 2; lake.position.set(25, heightAt(25, 20) + 0.05, 20); root.add(lake);
  }
  if (bodyId === 'mars') {
    const dust = new Float32Array(220 * 3);
    for (let i = 0; i < dust.length; i += 3) { dust[i] = (Math.random() - 0.5) * 85; dust[i + 1] = 1 + Math.random() * 8; dust[i + 2] = (Math.random() - 0.5) * 85; }
    const dustGeometry = new THREE.BufferGeometry(); dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust, 3));
    root.add(new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: '#eab18b', size: 0.18, transparent: true, opacity: 0.5 })));
  }
  const setZone = (zoneId: string) => {
    const alternate = ['mare', 'canyon', 'shadow', 'lakes'].includes(zoneId);
    const locations: Array<[number, number]> = alternate
      ? [[-15, -3], [8, -13], [14, 12]]
      : [[-11, -7], [10, -5], [4, 13]];
    locations.forEach(([x, z], index) => {
      const point = points[index];
      point.object.position.set(x, heightAt(x, z), z);
      point.position.copy(point.object.position);
    });
    const stationX = alternate ? 1 : -1;
    const stationZ = alternate ? -20 : -18;
    station.position.set(stationX, heightAt(stationX, stationZ), stationZ);
    points[3].position.copy(station.position);
    rover.position.set(0, heightAt(0, 0), 0);
    terrainMaterial.color.set(terrainTexture ? '#ffffff' : bodyId === 'moon' && zoneId === 'mare' ? '#817565' : surfaceColor);
  };
  return { root, rover, astronaut, points, setZone };
}

function makeShip(shipId: ShipId) {
  const ship = new THREE.Group();
  const hull = new THREE.Mesh(shipId === 'atlas' ? new THREE.CylinderGeometry(0.25, 0.32, 1.35, 10) : new THREE.CylinderGeometry(0.16, 0.23, 1.05, shipId === 'swift' ? 8 : 12), new THREE.MeshStandardMaterial({ color: shipId === 'atlas' ? '#d3a866' : '#dfe9ef', metalness: 0.55, roughness: 0.34 }));
  hull.rotation.x = Math.PI / 2;
  ship.add(hull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.48, 12), new THREE.MeshStandardMaterial({ color: '#63c9e8', metalness: 0.4, roughness: 0.32 }));
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.7;
  ship.add(nose);
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.18, 0.25, 10), new THREE.MeshBasicMaterial({ color: '#ffb463' }));
  engine.rotation.x = Math.PI / 2;
  engine.position.z = 0.61;
  ship.add(engine);
  const panelMaterial = new THREE.MeshStandardMaterial({ color: shipId === 'swift' ? '#34a7bc' : shipId === 'atlas' ? '#9a6739' : '#2476a7', metalness: 0.45, roughness: 0.35, emissive: '#0b2842' });
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(shipId === 'atlas' ? new THREE.BoxGeometry(0.62, 0.26, 0.72) : shipId === 'swift' ? new THREE.ConeGeometry(0.36, 1.3, 4) : new THREE.BoxGeometry(1.05, 0.045, 0.5), panelMaterial);
    panel.position.set(side * (shipId === 'atlas' ? 0.7 : 0.85), shipId === 'atlas' ? 0.06 : 0, 0.08);
    if (shipId === 'swift') { panel.rotation.x = Math.PI / 2; panel.rotation.z = side * -0.4; }
    ship.add(panel);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 6), new THREE.MeshStandardMaterial({ color: '#d2b776', metalness: 0.7 }));
    strut.rotation.z = Math.PI / 2;
    strut.position.set(side * 0.42, 0, 0.08);
    ship.add(strut);
  }
  const trim = new THREE.Mesh(new THREE.TorusGeometry(shipId === 'atlas' ? 0.29 : 0.2, 0.018, 6, 20), new THREE.MeshStandardMaterial({ color: '#d9b878', metalness: 0.7, roughness: 0.3 }));
  trim.position.z = 0.28;
  ship.add(trim);
  const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), new THREE.MeshBasicMaterial({ color: '#82e9ff' }));
  sensor.position.set(0, 0.2, -0.25);
  ship.add(sensor);
  for (const side of [-1, 1]) {
    const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.075, 0.16, 8), new THREE.MeshStandardMaterial({ color: '#aab9c1', metalness: 0.7, roughness: 0.35 }));
    thruster.rotation.x = Math.PI / 2;
    thruster.position.set(side * 0.16, 0, 0.58);
    ship.add(thruster);
  }
  return ship;
}

function getTutorialStep(progress: LunarProgress, mode: Mode, resources: ExplorationResources, atStation: boolean): TutorialStep {
  if (!progress.arrived) return { id: 'travel', title: 'Viaja a la Luna', instruction: 'Pulsa «Iniciar ruta». La nave seguirá el curso y establecerá una órbita segura.' };
  if (!progress.landingZone) return { id: 'landing-zone', title: 'Elige una región', instruction: 'En el selector de la derecha compara los sitios y elige una zona de descenso.' };
  if (!progress.landed) return { id: 'land', title: 'Confirma el aterrizaje', instruction: 'Revisa la zona elegida y pulsa «Aterrizar aquí» para desplegar el rover.' };
  if (mode !== 'surface') return { id: 'surface', title: 'Despliega el rover', instruction: 'Regresa al sitio de aterrizaje para comenzar la exploración de superficie.' };
  if (progress.scannedRocks.length < 3) return { id: 'scan', title: 'Escanea formaciones', instruction: 'Sigue la flecha hasta un beacon cian. Acércate y pulsa E para analizar la roca.' };
  if (progress.collectedSamples.length < 3) return { id: 'sample', title: 'Recolecta las muestras', instruction: 'La formación escaneada está lista. Vuelve a ella y pulsa E para guardar la muestra.' };
  if (!progress.analyzed) {
    if (!atStation) return { id: 'station', title: 'Vuelve al laboratorio', instruction: 'Sigue la flecha hasta la estación de análisis con las tres muestras.' };
    if (resources.energy < 30) return { id: 'recharge', title: 'Recarga el rover', instruction: 'Estás en la estación. Pulsa E para recargar la batería antes del análisis.' };
    return { id: 'analyze', title: 'Analiza las muestras', instruction: 'En la estación, pulsa E o selecciona el laboratorio para procesar las muestras.' };
  }
  if (!progress.transmitted) return atStation
    ? { id: 'transmit', title: 'Envía los resultados', instruction: 'Pulsa «Transmitir resultados» y espera el retraso de señal lunar.' }
    : { id: 'antenna', title: 'Regresa a la antena', instruction: 'Sigue la flecha de navegación hasta la estación para transmitir el informe.' };
  return { id: 'complete', title: 'Misión completada', instruction: 'La ciencia lunar llegó al centro de control. ¡Buen trabajo, comandante!' };
}

export default function ExplorationScene({ mission, onExit, shipId, design, arrival, scienceTarget, language }: Props) {
  const t = (es: string, en: string) => language === "es" ? es : en;
  const supportsSurface = ['moon', 'mars', 'mercury', 'titan'].includes(mission.id);
  const landingZones = getLandingZones(mission.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const failureDialogRef = useRef<HTMLDivElement>(null);
  const cockpitRef = useRef(false);
  const explorationAttemptId = useRef(globalThis.crypto?.randomUUID?.() ?? `exploration-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const resourceWarningRef = useRef(false);
  const [progress, setProgress] = useState<LunarProgress>(() => loadLunarProgress(mission.id));
  const [orbitalSurvey, setOrbitalSurvey] = useState<OrbitalSurvey>(() => loadOrbitalSurvey(mission.id));
  const [samplesJustCompleted, setSamplesJustCompleted] = useState(false);
  const [resources, setResources] = useState<ExplorationResources>(() => arrival ? { fuel: arrival.fuel, energy: arrival.energy, integrity: arrival.integrity, storage: arrival.data, communications: 100, elapsedMinutes: arrival.elapsedDays * 1440 } : loadExplorationResources(mission.id));
  const [buffers, setBuffers] = useState<DataBuffers>(() => loadDataBuffers(mission.id, resources.storage, Boolean(arrival)));
  const [dataPriority, setDataPriority] = useState<DataKind>('observations');
  const [recordedTarget, setRecordedTarget] = useState<EonetTarget | null>(() => { try { const value: unknown = JSON.parse(readStorage(`orbital-command-eonet-scan-${mission.id}`) ?? 'null'); return isEonetTarget(value) ? value : null; } catch { return null; } });
  const [mode, setMode] = useState<Mode>('flight');
  const [landingInProgress, setLandingInProgress] = useState(false);
  const [selectedId, setSelectedId] = useState(mission.targetBodyId);
  const [hazardWarning, setHazardWarning] = useState('');
  const [landingZoneId, setLandingZoneId] = useState(() => loadLunarProgress(mission.id).landingZone ?? landingZones[0].id);
  const [selectedPoi, setSelectedPoi] = useState<{ index: number; kind: 'rock' | 'station'; name: string } | null>(null);
  const [atStation, setAtStation] = useState(false);
  const [transmissionCountdown, setTransmissionCountdown] = useState(0);
  const [windowCooldown, setWindowCooldown] = useState(0);
  const [transmissionType, setTransmissionType] = useState<'lunar' | 'orbital' | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [acquisition, setAcquisition] = useState<{ energy: number; data: number } | null>(null);
  const [firstLook, setFirstLook] = useState(() => Boolean(arrival && mission.id === 'earth' && readStorage('orbital-command-first-look-v1') !== 'done'));
  const [onFoot, setOnFoot] = useState(false);
  const [labReadings, setLabReadings] = useState<LabReading[]>(() => loadLabReadings(mission.id));
  const [photoCount, setPhotoCount] = useState(() => { const saved = Number(readStorage(`orbital-command-photos-${mission.id}`)); return Number.isInteger(saved) && saved >= 0 && saved <= 1000 ? saved : 0; });
  const [sensors, setSensors] = useState<SurfaceSensor[]>(() => loadSurfaceSensors(mission.id));
  const [satelliteDeployed, setSatelliteDeployed] = useState(() => mission.id === 'earth' && readStorage('orbital-command-satellite-earth') === 'done');
  const [dustStorm, setDustStorm] = useState(false);
  const [tutorialDismissed, setTutorialDismissed] = useState(() => readStorage(`orbital-command-tutorial-${mission.id}`) === 'done');
  const [tutorialPointer, setTutorialPointer] = useState<{ x: number; y: number; angle: number; visible: boolean } | null>(null);
  const tutorialDismissedRef = useRef(tutorialDismissed);
  const [distance, setDistance] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [cockpit, setCockpit] = useState(false);
  const [message, setMessage] = useState('Navegación libre activa · selecciona un astro o marca una ruta.');
  const scanEnergy = 5 + instruments[design.instrument].power * 2;
  const scanStorage = instruments[design.instrument].data * orbitProfiles[design.orbit ?? 'balanced'].coverage * 100 / hulls[design.ship].storage;

  const explorationFailure = explorationFailureReason(resources, mode, supportsSurface, progress.transmitted || orbitalSurvey.transmitted);
  useEffect(() => {
    if (!explorationFailure) return;
    const elapsedDays = Math.max(0, resources.elapsedMinutes / 1440);
    const state: TransitState = { elapsedDays, durationDays: Math.max(elapsedDays, arrival?.durationDays ?? elapsedDays), distanceKm: arrival?.distanceKm ?? 0, fuel: resources.fuel, energy: resources.energy, integrity: resources.integrity, data: resources.storage, decision: arrival?.decision ?? 'resolved', choice: arrival?.choice ?? null };
    saveFailedAttempt(makeFailedAttempt(explorationAttemptId.current, mission, design, state, explorationFailure, 'exploration'));
  }, [explorationFailure, mission, design, arrival, resources]);
  useEffect(() => {
    if (!explorationFailure || !failureDialogRef.current) return;
    const panel = failureDialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    buttons[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !buttons.length) return;
      if (event.shiftKey && (document.activeElement === buttons[0] || !panel.contains(document.activeElement))) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
      else if (!event.shiftKey && (document.activeElement === buttons[buttons.length - 1] || !panel.contains(document.activeElement))) { event.preventDefault(); buttons[0].focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [explorationFailure]);
  useEffect(() => { tutorialDismissedRef.current = tutorialDismissed; }, [tutorialDismissed]);
  useEffect(() => {
    if (!firstLook) return;
    const timer = window.setTimeout(() => { writeStorage('orbital-command-first-look-v1', 'done'); setFirstLook(false); }, 6500);
    return () => window.clearTimeout(timer);
  }, [firstLook]);
  useEffect(() => {
    if (windowCooldown <= 0) return;
    const timer = window.setTimeout(() => setWindowCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [windowCooldown]);
  useEffect(() => { window.dispatchEvent(new CustomEvent('orbital-ship-change', { detail: shipId })); }, [shipId]);

  useEffect(() => {
    if (progress.collectedSamples.length < 3) return;
    setSamplesJustCompleted(true);
    const timer = window.setTimeout(() => setSamplesJustCompleted(false), 3500);
    return () => window.clearTimeout(timer);
  }, [progress.collectedSamples.length]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#030811');
    const camera = new THREE.PerspectiveCamera(54, host.clientWidth / host.clientHeight, 0.1, 220);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.className = 'exploration-canvas';
    host.appendChild(renderer.domElement);
    const detachQuality = attachRenderQuality(renderer, host);

    const ambient = new THREE.AmbientLight(0x9eb7d3, 0.62);
    scene.add(ambient);
    const sunLight = new THREE.PointLight(0xffe0b0, 420, 120, 1.5);
    scene.add(sunLight);
    const surfaceLight = new THREE.DirectionalLight(0xd6c6ad, 1.7);
    surfaceLight.position.set(-18, 35, 22);
    surfaceLight.visible = false;
    scene.add(surfaceLight);

    const starCount = 2600;
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      const radius = 70 + Math.random() * 90;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions.set([radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)], i * 3);
      const tint = i % 4 === 0 ? new THREE.Color('#7bb9ff') : new THREE.Color('#e6f4ff');
      starColors.set([tint.r, tint.g, tint.b], i * 3);
    }
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starsGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({ size: 0.18, vertexColors: true, transparent: true, opacity: 0.92, sizeAttenuation: true }));
    scene.add(stars);

    const system = new THREE.Group();
    scene.add(system);
    const SOLAR_EXCLUSION_RADIUS = 6.5;
    const SOLAR_WARNING_RADIUS = 11;
    const sun = new THREE.Mesh(new THREE.SphereGeometry(2.15, 48, 40), new THREE.MeshBasicMaterial({ color: '#ffc86b' }));
    sun.userData.bodyId = 'sun';
    system.add(sun);
    const sunGlow = new THREE.Mesh(new THREE.SphereGeometry(2.48, 32, 24), new THREE.MeshBasicMaterial({ color: '#ff9d45', transparent: true, opacity: 0.17, side: THREE.BackSide }));
    system.add(sunGlow);
    const exclusionPoints: THREE.Vector3[] = [];
    for (let i = 0; i < 160; i += 1) {
      const angle = i / 160 * Math.PI * 2;
      exclusionPoints.push(new THREE.Vector3(Math.cos(angle) * SOLAR_EXCLUSION_RADIUS, 0, Math.sin(angle) * SOLAR_EXCLUSION_RADIUS));
    }
    const solarExclusion = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(exclusionPoints), new THREE.LineDashedMaterial({ color: '#ff8b67', dashSize: 0.38, gapSize: 0.24, transparent: true, opacity: 0.82 }));
    solarExclusion.computeLineDistances();
    system.add(solarExclusion);

    const bodies: BodyRuntime[] = [];
    const clickTargets: THREE.Object3D[] = [sun];
    const orbitMaterial = new THREE.LineBasicMaterial({ color: '#6c8dae', transparent: true, opacity: 0.19 });
    for (const data of celestialBodies) {
      const group = new THREE.Group();
      group.position.set(...data.position);
      const texture = loadPlanetTexture(data.id);
      const material = new THREE.MeshStandardMaterial({ color: texture ? '#ffffff' : data.color, map: texture, roughness: 0.84, metalness: 0.02, emissive: '#000000', emissiveIntensity: 0.7 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(data.radius, 36, 28), material);
      mesh.userData.bodyId = data.id;
      mesh.userData.bodyName = data.name;
      group.add(mesh);
      if (data.id === 'saturn') {
        const ring = new THREE.Mesh(new THREE.RingGeometry(data.radius * 1.28, data.radius * 1.9, 64), new THREE.MeshStandardMaterial({ color: '#d8c49d', side: THREE.DoubleSide, transparent: true, opacity: 0.72, roughness: 0.9 }));
        ring.rotation.x = Math.PI / 2.35;
        group.add(ring);
      }
      if (data.id === 'earth') {
        const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(data.radius * 1.09, 32, 24), new THREE.MeshBasicMaterial({ color: '#58baff', transparent: true, opacity: 0.12, side: THREE.BackSide }));
        group.add(atmosphere);
      }
      system.add(group);
      const orbitRadius = data.parentOrbit ?? Math.hypot(data.position[0], data.position[2]);
      const phase = data.orbitalParent ? 0.5 : Math.atan2(data.position[2], data.position[0]);
      const angularSpeed = (data.orbitalParent ? 0.11 : 0.18) / Math.max(orbitRadius, 1) ** 1.5;
      bodies.push({ data, group, mesh, material, orbitRadius, phase, angularSpeed });
      clickTargets.push(mesh);

      if (data.orbitalParent) {
        const parent = bodies.find((body) => body.data.id === data.orbitalParent);
        if (parent) {
          const points: THREE.Vector3[] = [];
          for (let i = 0; i <= 96; i += 1) {
            const angle = i / 96 * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle) * orbitRadius, 0, Math.sin(angle) * orbitRadius));
          }
          parent.group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitMaterial));
        }
      } else if (orbitRadius > 5) {
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 144; i += 1) {
          const angle = i / 144 * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle) * orbitRadius, 0, Math.sin(angle) * orbitRadius));
        }
        const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitMaterial);
        system.add(orbit);
      }
    }

    const asteroidPositions = new Float32Array(850 * 3);
    for (let i = 0; i < 850; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 23.2 + Math.random() * 1.5;
      asteroidPositions.set([Math.cos(angle) * radius, (Math.random() - 0.5) * 0.8, Math.sin(angle) * radius], i * 3);
    }
    const asteroidGeometry = new THREE.BufferGeometry();
    asteroidGeometry.setAttribute('position', new THREE.BufferAttribute(asteroidPositions, 3));
    system.add(new THREE.Points(asteroidGeometry, new THREE.PointsMaterial({ color: '#b7a17b', size: 0.095, transparent: true, opacity: 0.82 })));

    const satelliteOrbit = new THREE.Group();
    if (mission.id === 'earth') {
      const satellite = new THREE.Group();
      satellite.add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), new THREE.MeshStandardMaterial({ color: '#dbe7ed', metalness: 0.65 })));
      for (const side of [-1, 1]) { const panel = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.025, 0.2), new THREE.MeshStandardMaterial({ color: '#1d6c9b', metalness: 0.4 })); panel.position.x = side * 0.31; satellite.add(panel); }
      satellite.position.set(1.8, 0.4, 0); satelliteOrbit.add(satellite);
      bodies.find((item) => item.data.id === 'earth')?.group.add(satelliteOrbit);
    }
    satelliteOrbit.visible = satelliteDeployed;

    const ship = makeShip(shipId);
    ship.position.set(0, 1.1, 12);
    ship.rotation.order = 'YXZ';
    system.add(ship);
    const onShipChange = (event: Event) => {
      const nextId = (event as CustomEvent<ShipId>).detail;
      ship.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      ship.clear();
      const replacement = makeShip(nextId);
      while (replacement.children.length) ship.add(replacement.children[0]);
      ship.scale.setScalar(nextId === 'swift' ? 0.66 : nextId === 'atlas' ? 0.86 : 0.73);
    };
    window.addEventListener('orbital-ship-change', onShipChange);
    const routeGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const routeLine = new THREE.Line(routeGeometry, new THREE.LineDashedMaterial({ color: '#6be4ff', dashSize: 0.45, gapSize: 0.28, transparent: true, opacity: 0.85 }));
    routeLine.computeLineDistances();
    routeLine.visible = false;
    system.add(routeLine);
    const destinationMarker = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), new THREE.MeshBasicMaterial({ color: '#7deaff' }));
    destinationMarker.visible = false;
    system.add(destinationMarker);

    const surface = supportsSurface ? createSurface(mission.id) : { root: new THREE.Group(), rover: new THREE.Group(), astronaut: new THREE.Group(), points: [] as PointOfInterest[], setZone: (_zoneId: string) => {} };
    surface.setZone(progress.landingZone ?? landingZoneId);
    surface.root.visible = false;
    scene.add(surface.root);
    const teamAvatarLayer = new THREE.Group(); scene.add(teamAvatarLayer);
    const teamAvatars = new Map<string, { rig: AvatarRig; role: string; name: string }>();
    let teamPlayers: LivePlayer[] = [];
    let liveSelfId: string | null = null;
    let interactionUntil = 0;
    const refreshTeamAvatars = () => {
      const live = getLiveSnapshot(); teamPlayers = live.players; liveSelfId = live.selfId;
      teamAvatarLayer.visible = live.connected;
      for (const player of teamPlayers) {
        if (player.userId === liveSelfId || player.pose.mode === 'system') continue;
        let avatar = teamAvatars.get(player.userId);
        if (!avatar || avatar.role !== player.role || avatar.name !== player.displayName) {
          if (avatar) { teamAvatarLayer.remove(avatar.rig.root); disposeAvatar(avatar.rig); }
          const rig = createPlayerAvatar(player); avatar = { rig, role: player.role, name: player.displayName };
          teamAvatars.set(player.userId, avatar); teamAvatarLayer.add(rig.root);
        }
      }
      const connected = new Set(teamPlayers.filter((player) => player.userId !== liveSelfId && player.pose.mode !== 'system').map((player) => player.userId));
      for (const [id, avatar] of teamAvatars) if (!connected.has(id)) { teamAvatarLayer.remove(avatar.rig.root); disposeAvatar(avatar.rig); teamAvatars.delete(id); }
    };
    const unsubscribeTeamPresence = subscribeLiveSnapshot(refreshTeamAvatars);
    refreshTeamAvatars();
    const sensorGroup = new THREE.Group(); surface.root.add(sensorGroup);
    const createSensor = (position: SurfaceSensor) => {
      const sensor = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.2, 10), new THREE.MeshStandardMaterial({ color: '#d5e6ed', metalness: 0.45 })); mast.position.y = 0.6; sensor.add(mast);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshStandardMaterial({ color: '#75e3ee', emissive: '#147b8d', emissiveIntensity: 0.9 })); tip.position.y = 1.3; sensor.add(tip);
      sensor.position.set(position.x, terrainHeight(position.x, position.z, mission.id), position.z); sensorGroup.add(sensor);
    };
    sensors.forEach(createSensor);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const keys = new Set<string>();
    const shipForward = new THREE.Vector3();
    const desiredCamera = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    const orbitCenter = new THREE.Vector3();
    let modeNow: Mode = 'flight';
    let selectedNow = mission.targetBodyId;
    let hovered: BodyRuntime | undefined;
    let dragStart: { x: number; y: number; yaw: number; pitch: number } | undefined;
    let dragged = false;
    let yaw = Math.PI;
    let pitch = 0;
    let orbitYaw = 0.5;
    let orbitPitch = 0.28;
    let orbitDistance = 5;
    let viewDistance = 7;
    let routeTarget: THREE.Vector3 | undefined;
    const routeWaypoints: THREE.Vector3[] = [];
    let routeBody: string | undefined;
    let autopilot = false;
    const flightVelocity = new THREE.Vector3();
    const initialRadial = new THREE.Vector3(ship.position.x, 0, ship.position.z).normalize();
    const initialOrbitalSpeed = Math.sqrt(24 / Math.max(Math.hypot(ship.position.x, ship.position.z), SOLAR_EXCLUSION_RADIUS));
    flightVelocity.set(-initialRadial.z, 0, initialRadial.x).multiplyScalar(initialOrbitalSpeed);
    let currentProgress: LunarProgress = { ...progress };
    let currentSurvey: OrbitalSurvey = { ...orbitalSurvey };
    let currentResources: ExplorationResources = { ...resources };
    let currentRecordedTarget = recordedTarget;
    let currentBuffers: DataBuffers = { ...buffers };
    let currentLabReadings = [...labReadings];
    let currentPhotoCount = photoCount;
    let currentSensors = [...sensors];
    let currentSatelliteDeployed = satelliteDeployed;
    let currentEvents = loadMissionEvents(mission.id);
    let stormNow = false;
    let nextWindowAt = 0;
    let stationNearby = false;
    let onFootNow = false;
    const activeVehicle = () => onFootNow ? surface.astronaut : surface.rover;
    let lastHudUpdate = 0;
    let lastGuideUpdate = 0;
    let currentSpeed = 0;
    let landingSequence: { start: THREE.Vector3; end: THREE.Vector3; elapsed: number; zoneId: string } | null = null;
    let toastTimer = 0;
    let acquisitionTimer = 0;
    const clock = new THREE.Clock();

    const setMessageForSeconds = (text: string) => {
      setMessage(text);
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => setMessage(''), 4300);
    };
    const matchedTarget = () => mission.id === 'earth' && scienceTarget && currentRecordedTarget && scienceTarget.id === currentRecordedTarget.id && scienceTarget.retrievedAt === currentRecordedTarget.retrievedAt ? currentRecordedTarget : null;
    const getRegions = () => { const regions = [...(orbitalRegions[mission.id] ?? ['Sector norte', 'Sector ecuatorial', 'Sector sur'])]; if (mission.id === 'earth' && scienceTarget && (!currentSurvey.scannedRegions.includes(0) || matchedTarget())) regions[0] = `EONET: ${scienceTarget.title}`; return regions; };
    const awardCompletion = () => {
      if (currentResources.integrity <= 0) return;
      const surfaceResults = supportsSurface && currentProgress.transmitted;
      const regions = surfaceResults
        ? currentProgress.scannedRocks.map((index) => surface.points[index].name)
        : currentSurvey.scannedRegions.map((index) => getRegions()[index]);
      const samples = surfaceResults ? currentProgress.collectedSamples.map((index) => surface.points[index].name) : [];
      const saved = saveReport(createScienceReport(mission, design, currentResources, regions, samples, currentLabReadings, arrival?.choice ?? null, currentPhotoCount, currentEvents, currentSurvey.scannedRegions.includes(0) ? matchedTarget() : null));
      if (!saved) setMessageForSeconds('Transmisión completa, pero el navegador no permitió guardar el informe local.');
      const { progress: updated, awarded } = awardMission(mission.id, mission.reward, Math.round(mission.budget * 0.18));
      window.dispatchEvent(new CustomEvent('orbital-commander-transmission', { detail: { id: `complete-${mission.id}`, title: 'TRANSMISIÓN RECIBIDA', text: `Buen trabajo. Los datos de ${mission.destination} han llegado al centro de control. Nuestros equipos internacionales podrán revisar el informe y sus limitaciones.` } }));
      window.dispatchEvent(new CustomEvent('orbital-player-progress', { detail: updated }));
      if (awarded) { playSound('complete'); setMessageForSeconds(`Recompensa acreditada · +${mission.reward} XP · +${Math.round(mission.budget * 0.18)} CR.`); }
    };
    const commitProgress = (patch: Partial<LunarProgress>, notification: string) => {
      const firstSample = currentProgress.collectedSamples.length === 0 && Boolean(patch.collectedSamples?.length);
      currentProgress = { ...currentProgress, ...patch };
      setProgress(currentProgress);
      saveLunarProgress(mission.id, currentProgress);
      setMessageForSeconds(notification);
      if ('scannedRocks' in patch || 'collectedSamples' in patch) playSound('scan');
      if (firstSample) window.dispatchEvent(new CustomEvent('orbital-commander-transmission', { detail: { id: 'first-sample', title: 'EL PRIMER DESCUBRIMIENTO', text: 'Acabas de convertir una pregunta en una oportunidad para aprender. Puede parecer una pequeña roca, pero cada descubrimiento nos acerca a comprender nuestra historia.' } }));
    };
    const commitResources = (patch: Partial<ExplorationResources>) => {
      if (patch.storage !== undefined && patch.storage > currentResources.storage && patch.energy !== undefined) {
        setAcquisition({ energy: currentResources.energy - patch.energy, data: (patch.storage - currentResources.storage) * hulls[design.ship].storage / 100 });
        window.clearTimeout(acquisitionTimer);
        acquisitionTimer = window.setTimeout(() => setAcquisition(null), 4500);
        playSound('scan');
      }
      currentResources = { ...currentResources, ...patch };
      setResources(currentResources);
      saveExplorationResources(mission.id, currentResources);
    };
    const commitBuffers = (next: DataBuffers) => {
      currentBuffers = next;
      setBuffers(next);
      writeStorage(`orbital-command-buffers-${mission.id}`, JSON.stringify(next));
    };
    const bufferData = (kind: DataKind, amount: number) => commitBuffers(addBufferedData(currentBuffers, kind, amount));
    if (arrival) commitBuffers(currentBuffers);
    const commitSurvey = (patch: Partial<OrbitalSurvey>, notification: string) => {
      currentSurvey = { ...currentSurvey, ...patch };
      setOrbitalSurvey(currentSurvey);
      writeStorage(`orbital-command-survey-${mission.id}`, JSON.stringify(currentSurvey));
      setMessageForSeconds(notification);
    };
    const setModeNow = (next: Mode) => {
      if (modeNow === 'surface' && next !== 'surface' && onFootNow) { setMessageForSeconds('Vuelve al rover antes de abandonar la superficie.'); return; }
      if (next === 'surface' && (!supportsSurface || !currentProgress.landed || !currentProgress.roverDeployed || selectedNow !== mission.targetBodyId)) {
        setMessageForSeconds('Descenso bloqueado · establece órbita y selecciona una zona segura para el rover.');
        return;
      }
      const previous = modeNow;
      if (next === 'orbit') stopEngine();
      modeNow = next;
      setMode(next);
      system.visible = next !== 'surface';
      sunLight.visible = next !== 'surface';
      surfaceLight.visible = next === 'surface';
      surface.root.visible = next === 'surface';
      scene.background = new THREE.Color(next === 'surface' && mission.id === 'titan' ? '#5b402c' : next === 'surface' && mission.id === 'mars' ? '#69483e' : '#030811');
      scene.fog = next === 'surface' && mission.id === 'titan' ? new THREE.Fog('#75543a', 12, 65) : next === 'surface' && mission.id === 'mars' ? new THREE.Fog('#69483e', 28, 95) : null;
      routeLine.visible = next === 'flight' && Boolean(routeTarget);
      if (next === 'orbit') {
        const body = bodies.find((item) => item.data.id === selectedNow);
        const center = selectedNow === 'sun' ? sun.position : body?.group.position;
        if (center) {
          orbitCenter.copy(center);
          orbitDistance = selectedNow === 'sun' ? getSafeOrbitRadius('sun') / 0.78 : Math.max(body?.data.radius ?? 0, 0) + 3.4;
          if (previous === 'surface') ship.position.set(orbitCenter.x + orbitDistance, orbitCenter.y + 0.4, orbitCenter.z);
        }
      }
    };
    const getBody = (id: string) => id === 'sun' ? undefined : bodies.find((item) => item.data.id === id);
    const getBodyPosition = (id: string) => id === 'sun' ? sun.position : getBody(id)?.group.position;
    const getBodyRadius = (id: string) => id === 'sun' ? 2.15 : getBody(id)?.data.radius ?? 0;
    const getSafeOrbitRadius = (id: string) => id === 'sun' ? 10.2 : id === 'saturn' ? getBodyRadius(id) * 2.15 + 0.6 : getBodyRadius(id) + 1.45;
    let activeHazard = '';
    const reportHazard = (message: string) => {
      if (activeHazard === message) return;
      activeHazard = message;
      setHazardWarning(message);
    };
    const checkFlightSafety = (position: THREE.Vector3) => {
      let closestWarning = '';
      let closestMargin = Infinity;
      const solarDistance = position.distanceTo(sun.position);
      const solarBoundary = SOLAR_EXCLUSION_RADIUS;
      if (solarDistance < solarBoundary) {
        reportHazard('LÍMITE SOLAR: acercamiento bloqueado. La zona de calor extremo es inaccesible.');
        return false;
      }
      if (solarDistance < SOLAR_WARNING_RADIUS) {
        closestMargin = solarDistance - solarBoundary;
        closestWarning = 'ADVERTENCIA: calor solar alto. Mantén distancia segura del Sol.';
      }
      for (const body of bodies) {
        if (body.data.id === 'asteroid') continue;
        const distanceToBody = position.distanceTo(body.group.position);
        const hardBoundary = (body.data.id === 'saturn' ? body.data.ra