import { Viewer } from 'molstar/lib/apps/viewer/app';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Color } from 'molstar/lib/mol-util/color';
import { Material } from 'molstar/lib/mol-util/material';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import type { StructureRef } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state';
import 'molstar/lib/mol-plugin-ui/skin/light.scss';

import type { DiffusionTrajectory, Point3D } from './trajectory-data';

const CAMERA_UP = Vec3.create(0, 1, 0);
const SURFACE_MATERIAL = Material({ roughness: 0.72, metalness: 0, bumpiness: 0 });
const TARGET_COLOR = Color(0x8c9299);
const SURFACE_COLOR = Color(0xbac0c6);

interface LoadedTrajectory {
  id: string;
  model: StateObjectSelector;
  structure: StructureRef | undefined;
  frameCount: number;
}

export class MolstarStage {
  private viewer: Viewer | null = null;
  private loaded = new Map<string, LoadedTrajectory>();
  private activeTrajectoryId = '';
  private center = Vec3.create(0, 0, 0);
  private orbitStart = performance.now();
  private orbitPosition = Vec3();
  private orbitRadius = 62;

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
      pickScale: 0.25
    });

    const plugin = this.viewer.plugin;
    plugin.canvas3d?.setProps({
      renderer: {
        backgroundColor: 0xf6f7f8
      },
      postprocessing: {
        occlusion: {
          name: 'on',
          params: {
            samples: 16,
            radius: 4,
            bias: 0.8,
            blurKernelSize: 9,
            resolutionScale: 1
          }
        },
        outline: {
          name: 'on',
          params: {
            scale: 1,
            threshold: 0.24,
            color: 0xd5d9dd,
            includeTransparent: true
          }
        }
      },
      illumination: {
        enabled: true
      }
    } as never);
  }

  async loadTrajectories(trajectories: DiffusionTrajectory[]) {
    for (const trajectory of trajectories) {
      await this.loadTrajectory(trajectory);
    }

    const first = trajectories[0];
    this.setOrbitTarget(first.center, first.radius);
    await this.focus(first.center, first.radius, 1400);
    this.syncOrbitToCurrentCamera();
  }

  async showTrajectory(trajectory: DiffusionTrajectory, modelIndex: number) {
    const viewer = this.requireViewer();
    const loaded = this.loaded.get(trajectory.id);
    if (!loaded) return;

    this.activeTrajectoryId = trajectory.id;
    this.setOrbitTarget(trajectory.center, trajectory.radius);

    for (const item of this.loaded.values()) {
      if (item.structure) {
        viewer.plugin.managers.structure.hierarchy.toggleVisibility(
          [item.structure],
          item.id === trajectory.id ? 'show' : 'hide'
        );
      }
    }

    await this.setFrame(trajectory.id, modelIndex);
  }

  async setFrame(trajectoryId: string, modelIndex: number) {
    const viewer = this.requireViewer();
    const loaded = this.loaded.get(trajectoryId);
    if (!loaded) return;

    const safeIndex = Math.max(0, Math.min(loaded.frameCount - 1, Math.round(modelIndex)));
    const update = viewer.plugin.state.data.build();
    update.to(loaded.model).update({ modelIndex: safeIndex });
    await PluginCommands.State.Update(viewer.plugin, {
      state: viewer.plugin.state.data,
      tree: update,
      options: { doNotLogTiming: true }
    });
  }

  orbit(now: number) {
    if (!this.viewer?.plugin.canvas3d) return;

    const elapsed = (now - this.orbitStart) / 1000;
    const angle = elapsed * 0.11;
    const breath = Math.sin(elapsed * 0.38) * Math.max(1.5, this.orbitRadius * 0.035);
    const radius = this.orbitRadius + breath;
    const height = Math.max(8, this.orbitRadius * 0.18) + Math.sin(elapsed * 0.29) * 2.2;

    Vec3.set(
      this.orbitPosition,
      this.center[0] + Math.cos(angle) * radius,
      this.center[1] + height,
      this.center[2] + Math.sin(angle) * radius
    );

    this.viewer.plugin.canvas3d.camera.setState({
      target: this.center,
      position: this.orbitPosition,
      up: CAMERA_UP
    }, 0);
  }

  async focusCurrent(durationMs = 1600) {
    const active = this.loaded.get(this.activeTrajectoryId);
    if (!active) return;
    await PluginCommands.Camera.Focus(this.requireViewer().plugin, {
      center: this.center,
      radius: this.orbitRadius * 0.42,
      durationMs
    });
  }

  syncOrbitToCurrentCamera() {
    const snapshot = this.viewer?.plugin.canvas3d?.camera.getSnapshot();
    if (!snapshot?.position) {
      this.orbitStart = performance.now();
      return;
    }

    const dx = snapshot.position[0] - this.center[0];
    const dz = snapshot.position[2] - this.center[2];
    const angle = Math.atan2(dz, dx);
    this.orbitStart = performance.now() - (angle / 0.11) * 1000;
  }

  private async loadTrajectory(trajectory: DiffusionTrajectory) {
    const viewer = this.requireViewer();
    const before = new Set(this.structureRefs().map(ref => ref.cell.transform.ref));
    const data = await viewer.plugin.builders.data.rawData({
      data: trajectory.pdb,
      label: trajectory.label
    });
    const parsed = await viewer.plugin.builders.structure.parseTrajectory(data, 'pdb' as never);
    const model = await viewer.plugin.builders.structure.createModel(parsed, {
      modelIndex: trajectory.frameCount - 1
    });
    const structure = await viewer.plugin.builders.structure.createStructure(model, {
      name: 'model',
      params: {}
    } as never);

    const aChain = await viewer.plugin.builders.structure.tryCreateComponentFromSelection(
      structure,
      createChainSelection('A'),
      `${trajectory.id}-chain-a`,
      { label: `${trajectory.label} Diffusion Chain` }
    );
    const eChain = await viewer.plugin.builders.structure.tryCreateComponentFromSelection(
      structure,
      createChainSelection('E'),
      `${trajectory.id}-chain-e`,
      { label: `${trajectory.label} Target Chain` }
    );

    if (aChain) {
      await viewer.plugin.builders.structure.representation.addRepresentation(aChain, {
        type: 'cartoon',
        typeParams: {
          quality: 'high',
          alpha: 1,
          ignoreHydrogens: true,
          sizeFactor: 0.3
        } as never,
        color: 'uniform',
        colorParams: { value: Color(trajectory.color) }
      } as never, { tag: `${trajectory.id}-cartoon-a` });
    }

    if (aChain) {
      await viewer.plugin.builders.structure.representation.addRepresentation(aChain, {
        type: 'gaussian-surface',
        typeParams: {
          alpha: 0.16,
          doubleSided: true,
          flatShaded: false,
          ignoreHydrogens: true,
          includeParent: false,
          material: SURFACE_MATERIAL,
          quality: 'custom',
          radiusOffset: 0.16,
          resolution: 0.8,
          smoothness: 1.2,
          transparentBackfaces: 'on',
          visuals: ['gaussian-surface-mesh']
        } as never,
        color: 'uniform',
        colorParams: { value: createSurfaceTint(trajectory.color) }
      } as never, { tag: `${trajectory.id}-surface-a` });
    }

    if (eChain) {
      await viewer.plugin.builders.structure.representation.addRepresentation(eChain, {
        type: 'cartoon',
        typeParams: {
          quality: 'high',
          alpha: 1,
          ignoreHydrogens: true,
          sizeFactor: 0.5
        } as never,
        color: 'uniform',
        colorParams: { value: TARGET_COLOR }
      } as never, { tag: `${trajectory.id}-cartoon-e` });
    }

    if (eChain) {
      await viewer.plugin.builders.structure.representation.addRepresentation(eChain, {
        type: 'gaussian-surface',
        typeParams: {
          alpha: 0.19,
          doubleSided: true,
          flatShaded: false,
          ignoreHydrogens: true,
          includeParent: false,
          material: SURFACE_MATERIAL,
          quality: 'custom',
          radiusOffset: 0.2,
          resolution: 0.8,
          smoothness: 1.2,
          transparentBackfaces: 'on',
          visuals: ['gaussian-surface-mesh']
        } as never,
        color: 'uniform',
        colorParams: { value: SURFACE_COLOR }
      } as never, { tag: `${trajectory.id}-surface` });
    }

    const ref = this.structureRefs().find(item => !before.has(item.cell.transform.ref));
    if (ref) viewer.plugin.managers.structure.hierarchy.toggleVisibility([ref], 'hide');

    this.loaded.set(trajectory.id, {
      id: trajectory.id,
      model,
      structure: ref,
      frameCount: trajectory.frameCount
    });
  }

  private setOrbitTarget(center: Point3D, radius: number) {
    Vec3.set(this.center, center.x, center.y, center.z);
    this.orbitRadius = Math.max(28, radius * 1.48);
  }

  private async focus(center: Point3D, radius: number, durationMs: number) {
    await PluginCommands.Camera.Focus(this.requireViewer().plugin, {
      center: Vec3.create(center.x, center.y, center.z),
      radius: Math.max(18, radius * 0.7),
      durationMs
    });
  }

  private structureRefs(): StructureRef[] {
    if (!this.viewer) return [];
    return this.viewer.plugin.managers.structure.hierarchy.current.structures;
  }

  private requireViewer() {
    if (!this.viewer) throw new Error('Mol* viewer is not initialized.');
    return this.viewer;
  }
}

function createChainSelection(chainId: string) {
  return StructureSelectionQuery(`Chain ${chainId}`, MS.struct.modifier.wholeResidues([
    MS.struct.generator.atomGroups({
      'chain-test': MS.core.logic.or([
        MS.core.rel.eq([MS.ammp('auth_asym_id'), chainId]),
        MS.core.rel.eq([MS.ammp('label_asym_id'), chainId])
      ])
    })
  ]));
}

function createSurfaceTint(color: number) {
  const base = { r: 218, g: 224, b: 230 };
  const accentWeight = 0.52;
  const source = {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff
  };
  const r = Math.round(base.r * (1 - accentWeight) + source.r * accentWeight);
  const g = Math.round(base.g * (1 - accentWeight) + source.g * accentWeight);
  const b = Math.round(base.b * (1 - accentWeight) + source.b * accentWeight);

  return Color((r << 16) | (g << 8) | b);
}
