import virionUrl from '../datas/SARS-COV-2_VIRION.cif?url';

import { Viewer } from 'molstar/lib/apps/viewer/app';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { Asset } from 'molstar/lib/mol-util/assets';
import { Color } from 'molstar/lib/mol-util/color';
import { Material } from 'molstar/lib/mol-util/material';
import type { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import 'molstar/lib/mol-plugin-ui/skin/light.scss';

export type VirionSceneId = 'overview' | 'surface-rock' | 'cutaway' | 'interior-window';

type EntityKey = 'lipid' | 'eProtein' | 'mProtein' | 'sProtein';

interface EntitySpec {
  key: EntityKey;
  entityId: string;
  label: string;
  color: number;
  size: number;
  sizeFactor: number;
  emissive: number;
}

const ENTITY_SPECS: EntitySpec[] = [
  {
    key: 'lipid',
    entityId: '1',
    label: 'Lipid bilayer',
    color: 0x7d8992,
    size: 7.7,
    sizeFactor: 1.03,
    emissive: 0.05
  },
  {
    key: 'eProtein',
    entityId: '2',
    label: 'E-protein pentamers',
    color: 0x21806f,
    size: 8.95,
    sizeFactor: 1.03,
    emissive: 0.04
  },
  {
    key: 'mProtein',
    entityId: '3',
    label: 'M-protein dimers',
    color: 0x2f6597,
    size: 6.65,
    sizeFactor: 1.03,
    emissive: 0.045
  },
  {
    key: 'sProtein',
    entityId: '4',
    label: 'Glycosylated S-protein trimers',
    color: 0xc96744,
    size: 9.65,
    sizeFactor: 1.02,
    emissive: 0.04
  }
];

const VIRION_CENTER = Vec3.create(0, 0, 0);
const CAMERA_UP = Vec3.create(0, 1, 0);
const CUT_PLANE_AXIS = Vec3.create(0, 0, 1);
const SphereMaterial = Material({ roughness: 0.96, metalness: 0, bumpiness: 0 });
const OVERVIEW_RADIUS = 2180;
const OVERVIEW_HEIGHT = 150;
const OVERVIEW_SPEED = 0.075;
const OVERVIEW_PHASE = 0;
const CUTAWAY_PRE_RADIUS = 1650;
const CUTAWAY_CUT_RADIUS = 1580;
const CUTAWAY_HEIGHT = 210;
const CUTAWAY_SPEED = 0.045;
const CUTAWAY_PHASE = -0.72;
const SURFACE_TARGET = Vec3.create(0, -20, 0);
const SURFACE_ROCK_RADIUS = 1580;
const SURFACE_ROCK_HEIGHT = 230;
const SURFACE_ROCK_AMPLITUDE = 0.22;
const SURFACE_ROCK_PHASE = 0.62;
const INTERIOR_TARGET = Vec3.create(-180, -120, -20);
const INTERIOR_ROCK_RADIUS = 1260;
const INTERIOR_ROCK_HEIGHT = 120;
const INTERIOR_ROCK_AMPLITUDE = 0.13;
const INTERIOR_ROCK_PHASE = -0.92;
const INTERIOR_RESTORE_START = 0.68;
const CLIP_START_X = 980;
const CLIP_END_X = -230;
const INTERIOR_WINDOW_X = CLIP_END_X;
const ENTITY_ORDER: EntityKey[] = ['sProtein', 'lipid', 'mProtein', 'eProtein'];
const AUTO_ILLUMINATION_MAX_ITERATIONS = 0;
const STATIC_ILLUMINATION_MAX_ITERATIONS = 5;

type ClipPlanes = Record<EntityKey, number | null>;

interface RepresentationRef {
  key: EntityKey;
  ref: string;
  data?: PluginStateObject.Representation3DData<any, any>;
}

export class VirionStage {
  private viewer: Viewer | null = null;
  private representationRefs: RepresentationRef[] = [];
  private clipCommit: Promise<unknown> | null = null;
  private queuedClipPlanes: ClipPlanes | null = null;
  private currentClipSignature = '';
  private activeScene: VirionSceneId = 'overview';
  private orbitStart = performance.now();
  private cameraPosition = Vec3();
  private cameraTarget = Vec3();
  private restoreEndPosition = Vec3();
  private autoAnimationRenderMode = false;

  async init(target: HTMLElement) {
    this.viewer = await Viewer.create(target, {
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      layoutShowLeftPanel: false,
      viewportShowControls: false,
      viewportShowSettings: false,
      viewportShowSelectionMode: false,
      viewportShowAnimation: false,
      viewportShowExpand: false,
      viewportShowTrajectoryControls: false,
      disableAntialiasing: false,
      pixelScale: 1,
      pickScale: 0.18
    });

    this.viewer.plugin.canvas3d?.setProps({
      renderer: {
        backgroundColor: 0xf6f8f7,
        exposure: 1.01,
        ambientColor: 0xffffff,
        ambientIntensity: 0.72,
        interiorDarkening: 0.3,
        light: [
          { inclination: 138, azimuth: 28, color: 0xffffff, intensity: 0.32 },
          { inclination: 68, azimuth: 218, color: 0xe6eef0, intensity: 0.16 }
        ]
      },
      postprocessing: {
        occlusion: {
          name: 'on',
          params: {
            samples: 8,
            radius: 7,
            bias: 1.7,
            blurKernelSize: 15,
            blurDepthBias: 2.5,
            resolutionScale: 0.55,
            color: 0xd7dddc,
            transparentThreshold: 0.4
          }
        },
        outline: {
          name: 'off',
          params: {}
        }
      },
      illumination: {
        enabled: true,
        maxIterations: STATIC_ILLUMINATION_MAX_ITERATIONS
      }
    } as never);
  }

  setAutoAnimationRenderMode(enabled: boolean) {
    const canvas3d = this.viewer?.plugin.canvas3d;
    if (!canvas3d || this.autoAnimationRenderMode === enabled) return;

    this.autoAnimationRenderMode = enabled;
    canvas3d.setProps({
      illumination: {
        enabled: true,
        maxIterations: enabled ? AUTO_ILLUMINATION_MAX_ITERATIONS : STATIC_ILLUMINATION_MAX_ITERATIONS
      }
    } as never);
    canvas3d.requestDraw();
  }

  async loadVirion() {
    const viewer = this.requireViewer();
    const plugin = viewer.plugin;
    const data = await plugin.builders.data.download(
      { url: Asset.Url(virionUrl), isBinary: false, label: 'SARS-COV-2_VIRION.cif' },
      { state: { isGhost: true } }
    );
    const trajectory = await plugin.builders.structure.parseTrajectory(data, 'mmcif');
    const model = await plugin.builders.structure.createModel(trajectory);
    const structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });

    for (const spec of ENTITY_SPECS) {
      const component = await plugin.builders.structure.tryCreateComponentFromSelection(
        structure,
        entitySelection(spec.entityId),
        spec.key,
        { label: spec.label }
      );
      if (!component) {
        console.warn(`No component was created for ${spec.label}.`);
        continue;
      }

      const representation = await plugin.builders.structure.representation.addRepresentation(
        component,
        representationProps(spec),
        { tag: `${spec.key}-story` }
      );
      this.representationRefs.push({
        key: spec.key,
        ref: representation.ref,
        data: representation.cell?.obj?.data as PluginStateObject.Representation3DData<any, any> | undefined
      });
    }

    await this.enterScene('overview', 1200);
  }

  async enterScene(scene: VirionSceneId, durationMs = 1600) {
    this.activeScene = scene;
    this.orbitStart = performance.now();
    this.queuedClipPlanes = null;
    this.setSceneCamera(scene, durationMs);

    if (scene === 'interior-window') {
      await this.setClipPlanes(allClipPlanes(INTERIOR_WINDOW_X), true);
    } else {
      await this.setClipPlanes(noClipPlanes(), true);
    }
  }

  renderScene(scene: VirionSceneId, now: number, progress: number) {
    const easedProgress = easeInOut(Math.max(0, Math.min(1, progress)));

    if (scene === 'overview') {
      this.orbit(now, OVERVIEW_RADIUS, OVERVIEW_HEIGHT, OVERVIEW_SPEED, OVERVIEW_PHASE + easedProgress * 0.1);
      return;
    }

    if (scene === 'surface-rock') {
      this.rock(
        now,
        SURFACE_ROCK_RADIUS,
        SURFACE_ROCK_HEIGHT,
        SURFACE_ROCK_AMPLITUDE,
        SURFACE_ROCK_PHASE,
        SURFACE_TARGET
      );
      return;
    }

    if (scene === 'cutaway') {
      this.renderCutaway(now, easedProgress);
      return;
    }

    this.renderInterior(now, easedProgress);
  }

  async focusCurrentScene(durationMs = 2200) {
    this.setSceneCamera(this.activeScene, durationMs);
  }

  syncOrbitToCurrentCamera() {
    const snapshot = this.viewer?.plugin.canvas3d?.camera.getSnapshot();
    if (!snapshot?.position) {
      this.orbitStart = performance.now();
      return;
    }
    const angle = Math.atan2(snapshot.position[2] - VIRION_CENTER[2], snapshot.position[0] - VIRION_CENTER[0]);
    this.orbitStart = performance.now() - (angle / 0.075) * 1000;
  }

  private renderCutaway(now: number, progress: number) {
    if (progress < 0.18) {
      void this.setClipPlanes(noClipPlanes());
      this.orbit(now, CUTAWAY_PRE_RADIUS, CUTAWAY_HEIGHT, CUTAWAY_SPEED, CUTAWAY_PHASE);
      return;
    }

    const revealProgress = Math.min(1, Math.max(0, (progress - 0.18) / 0.56));
    const orbitRadius = lerp(CUTAWAY_PRE_RADIUS, CUTAWAY_CUT_RADIUS, easeInOut(revealProgress));

    void this.setClipPlanes(cutawayPlanes(revealProgress));
    this.orbit(now, orbitRadius, CUTAWAY_HEIGHT, CUTAWAY_SPEED, CUTAWAY_PHASE);
  }

  private renderInterior(now: number, progress: number) {
    if (progress < INTERIOR_RESTORE_START) {
      void this.setClipPlanes(allClipPlanes(INTERIOR_WINDOW_X));
      this.rock(
        now,
        INTERIOR_ROCK_RADIUS,
        INTERIOR_ROCK_HEIGHT,
        INTERIOR_ROCK_AMPLITUDE,
        INTERIOR_ROCK_PHASE,
        INTERIOR_TARGET
      );
      return;
    }

    const restoreProgress = easeInOut(Math.max(0, Math.min(1, (progress - INTERIOR_RESTORE_START) / (1 - INTERIOR_RESTORE_START))));
    const clipX = lerp(INTERIOR_WINDOW_X, CLIP_START_X, restoreProgress);
    void this.setClipPlanes(restoreProgress > 0.995 ? noClipPlanes() : allClipPlanes(clipX));

    writeRockPosition(
      this.cameraPosition,
      now - this.orbitStart,
      INTERIOR_TARGET,
      INTERIOR_ROCK_RADIUS,
      INTERIOR_ROCK_HEIGHT,
      INTERIOR_ROCK_AMPLITUDE,
      INTERIOR_ROCK_PHASE
    );
    writeOrbitPosition(
      this.restoreEndPosition,
      0,
      OVERVIEW_RADIUS,
      OVERVIEW_HEIGHT,
      OVERVIEW_SPEED,
      OVERVIEW_PHASE
    );
    lerpVec3(this.cameraPosition, this.cameraPosition, this.restoreEndPosition, restoreProgress);
    lerpVec3(this.cameraTarget, INTERIOR_TARGET, VIRION_CENTER, restoreProgress);

    this.viewer?.plugin.canvas3d?.camera.setState({
      target: this.cameraTarget,
      position: this.cameraPosition,
      up: CAMERA_UP
    }, 0);
  }

  private setSceneCamera(scene: VirionSceneId, durationMs: number) {
    if (!this.viewer?.plugin.canvas3d) return;
    const camera = this.viewer.plugin.canvas3d.camera;

    if (scene === 'overview') {
      camera.setState({
        target: VIRION_CENTER,
        position: orbitPositionAt(durationMs, OVERVIEW_RADIUS, OVERVIEW_HEIGHT, OVERVIEW_SPEED, OVERVIEW_PHASE),
        up: CAMERA_UP
      }, durationMs);
      return;
    }

    if (scene === 'surface-rock') {
      camera.setState({
        target: SURFACE_TARGET,
        position: rockPositionAt(
          durationMs,
          SURFACE_TARGET,
          SURFACE_ROCK_RADIUS,
          SURFACE_ROCK_HEIGHT,
          SURFACE_ROCK_AMPLITUDE,
          SURFACE_ROCK_PHASE
        ),
        up: CAMERA_UP
      }, durationMs);
      return;
    }

    if (scene === 'cutaway') {
      camera.setState({
        target: VIRION_CENTER,
        position: orbitPositionAt(durationMs, CUTAWAY_PRE_RADIUS, CUTAWAY_HEIGHT, CUTAWAY_SPEED, CUTAWAY_PHASE),
        up: CAMERA_UP
      }, durationMs);
      return;
    }

    camera.setState({
      target: INTERIOR_TARGET,
      position: rockPositionAt(
        durationMs,
        INTERIOR_TARGET,
        INTERIOR_ROCK_RADIUS,
        INTERIOR_ROCK_HEIGHT,
        INTERIOR_ROCK_AMPLITUDE,
        INTERIOR_ROCK_PHASE
      ),
      up: CAMERA_UP
    }, durationMs);
  }

  private orbit(now: number, radius: number, height: number, speed: number, phase = 0) {
    if (!this.viewer?.plugin.canvas3d) return;
    writeOrbitPosition(this.cameraPosition, now - this.orbitStart, radius, height, speed, phase);

    this.viewer.plugin.canvas3d.camera.setState({
      target: VIRION_CENTER,
      position: this.cameraPosition,
      up: CAMERA_UP
    }, 0);
  }

  private rock(now: number, radius: number, height: number, amplitude: number, phase = 0.62, target = SURFACE_TARGET) {
    if (!this.viewer?.plugin.canvas3d) return;
    writeRockPosition(this.cameraPosition, now - this.orbitStart, target, radius, height, amplitude, phase);

    this.viewer.plugin.canvas3d.camera.setState({
      target,
      position: this.cameraPosition,
      up: CAMERA_UP
    }, 0);
  }

  private async setClipPlanes(planes: ClipPlanes, force = false) {
    if (!this.viewer || this.representationRefs.length === 0) return;
    const signature = clipSignature(planes);
    if (!force && signature === this.currentClipSignature) return;

    if (this.clipCommit) {
      this.queuedClipPlanes = planes;
      return this.clipCommit;
    }

    this.currentClipSignature = signature;
    const tasks: Promise<void>[] = [];
    for (const representation of this.representationRefs) {
      const data = representation.data ?? this.getRepresentationData(representation.ref);
      if (!data) continue;
      representation.data = data;
      tasks.push(data.repr.createOrUpdate({
        clip: {
          variant: 'pixel',
          objects: [clipPlane(planes[representation.key])]
        }
      }, data.sourceData).run());
    }

    this.clipCommit = Promise.all(tasks).then(() => {
      this.viewer?.plugin.canvas3d?.requestDraw();
    }).finally(() => {
      this.clipCommit = null;
      const queued = this.queuedClipPlanes;
      this.queuedClipPlanes = null;
      if (queued !== null && clipSignature(queued) !== this.currentClipSignature) {
        void this.setClipPlanes(queued, true);
      }
    });

    await this.clipCommit;
  }

  private getRepresentationData(ref: string) {
    return this.viewer?.plugin.state.data.cells.get(ref)?.obj?.data as PluginStateObject.Representation3DData<any, any> | undefined;
  }

  private requireViewer() {
    if (!this.viewer) throw new Error('Mol* viewer is not initialized.');
    return this.viewer;
  }
}

function representationProps(spec: EntitySpec) {
  return {
    type: 'spacefill',
    typeParams: {
      alpha: 1,
      alphaThickness: 0,
      approximate: false,
      bumpAmplitude: 0,
      bumpFrequency: 0,
      celShaded: false,
      clipPrimitive: false,
      density: 0.28,
      doubleSided: true,
      detail: 0,
      emissive: spec.emissive,
      flatShaded: false,
      ignoreHydrogens: true,
      ignoreLight: false,
      includeParent: false,
      material: SphereMaterial,
      quality: 'low',
      sizeFactor: spec.sizeFactor,
      solidInterior: true,
      stride: 1,
      transparentBackfaces: 'off',
      tryUseImpostor: true,
      visuals: ['structure-element-sphere'],
      xrayShaded: false,
      clip: {
        variant: 'pixel',
        objects: [clipPlane(null)]
      }
    },
    color: 'uniform',
    colorParams: {
      value: Color(spec.color)
    },
    size: 'uniform',
    sizeParams: {
      value: spec.size
    }
  } as never;
}

function clipPlane(x: number | null) {
  return {
    type: x === null ? 'none' : 'plane',
    invert: false,
    position: Vec3.create(x ?? 0, 0, 0),
    rotation: {
      axis: CUT_PLANE_AXIS,
      angle: -90
    },
    scale: Vec3.create(1, 1, 1),
    transform: Mat4.identity()
  };
}

function noClipPlanes(): ClipPlanes {
  return {
    lipid: null,
    eProtein: null,
    mProtein: null,
    sProtein: null
  };
}

function allClipPlanes(x: number): ClipPlanes {
  return {
    lipid: x,
    eProtein: x,
    mProtein: x,
    sProtein: x
  };
}

function cutawayPlanes(progress: number): ClipPlanes {
  const planes = noClipPlanes();
  ENTITY_ORDER.forEach((key, index) => {
    const start = index * 0.18;
    const end = start + 0.46;
    const local = easeInOut(Math.max(0, Math.min(1, (progress - start) / (end - start))));
    planes[key] = lerp(CLIP_START_X, CLIP_END_X, local);
  });
  return planes;
}

function clipSignature(planes: ClipPlanes) {
  return ENTITY_ORDER
    .map(key => `${key}:${planes[key] === null ? 'none' : Math.round(planes[key])}`)
    .join('|');
}

function entitySelection(entityId: string) {
  return StructureSelectionQuery(`Entity ${entityId}`, MS.struct.generator.atomGroups({
    'entity-test': MS.core.rel.eq([MS.ammp('label_entity_id'), entityId])
  }));
}

function lerp(start: number, end: number, value: number) {
  return start + (end - start) * value;
}

function easeInOut(value: number) {
  return value < 0.5
    ? 2 * value * value
    : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function orbitPositionAt(elapsedMs: number, radius: number, height: number, speed: number, phase: number) {
  return writeOrbitPosition(Vec3(), elapsedMs, radius, height, speed, phase);
}

function rockPositionAt(elapsedMs: number, target: Vec3, radius: number, height: number, amplitude: number, phase: number) {
  return writeRockPosition(Vec3(), elapsedMs, target, radius, height, amplitude, phase);
}

function writeOrbitPosition(out: Vec3, elapsedMs: number, radius: number, height: number, speed: number, phase: number) {
  const elapsed = elapsedMs / 1000;
  const angle = elapsed * speed + phase;
  const breath = Math.sin(elapsed * 0.36) * 48;

  return Vec3.set(
    out,
    Math.cos(angle) * (radius + breath),
    height + Math.sin(elapsed * 0.28) * 42,
    Math.sin(angle) * (radius + breath)
  );
}

function writeRockPosition(out: Vec3, elapsedMs: number, target: Vec3, radius: number, height: number, amplitude: number, phase: number) {
  const elapsed = elapsedMs / 1000;
  const angle = phase + Math.sin(elapsed * 0.52) * amplitude;

  return Vec3.set(
    out,
    target[0] + Math.cos(angle) * radius,
    target[1] + height + Math.sin(elapsed * 0.31) * 24,
    target[2] + Math.sin(angle) * radius
  );
}

function lerpVec3(out: Vec3, start: Vec3, end: Vec3, value: number) {
  return Vec3.set(
    out,
    lerp(start[0], end[0], value),
    lerp(start[1], end[1], value),
    lerp(start[2], end[2], value)
  );
}
