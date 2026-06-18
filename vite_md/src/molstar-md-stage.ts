import { Viewer } from 'molstar/lib/apps/viewer/app';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { Asset } from 'molstar/lib/mol-util/assets';
import { Color } from 'molstar/lib/mol-util/color';
import { Material } from 'molstar/lib/mol-util/material';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import 'molstar/lib/mol-plugin-ui/skin/light.scss';

import type { MdTrajectoryMetadata, Point3D } from './md-data';

const CAMERA_UP = Vec3.create(0, 1, 0);
const POLYMER_COLOR = Color(0x2d7dd2);
const SURFACE_COLOR = Color(0xb8c5cb);
const LIGAND_COLOR = Color(0xd1495b);
const ION_COLOR = Color(0xef8a17);
const SURFACE_MATERIAL = Material({ roughness: 0.74, metalness: 0, bumpiness: 0 });

export class MolstarMdStage {
  private viewer: Viewer | null = null;
  private model: StateObjectSelector | null = null;
  private structure: StateObjectSelector | null = null;
  private center = Vec3.create(0, 0, 0);
  private orbitStart = performance.now();
  private orbitPosition = Vec3();
  private orbitRadius = 62;
  private frameCount = 1;

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

    this.viewer.plugin.canvas3d?.setProps({
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

  async loadTrajectory(metadata: MdTrajectoryMetadata) {
    const viewer = this.requireViewer();
    const plugin = viewer.plugin;

    this.frameCount = Math.max(1, metadata.frameCount);
    this.setOrbitTarget(metadata.center, metadata.radius);

    const topologyData = await plugin.builders.data.download({
      url: Asset.Url(metadata.topologyUrl),
      isBinary: false,
      label: 'Water-stripped topology'
    });
    const topologyTrajectory = await plugin.builders.structure.parseTrajectory(topologyData, 'pdb' as never);
    const topologyModel = await plugin.builders.structure.createModel(topologyTrajectory, { modelIndex: 0 });

    const coordinatesData = await plugin.builders.data.download({
      url: Asset.Url(metadata.trajectoryUrl),
      isBinary: true,
      label: 'Water-stripped strided DCD'
    });
    const coordinates = await plugin.state.data.build()
      .to(coordinatesData)
      .apply(StateTransforms.Model.CoordinatesFromDcd)
      .commit({ revertOnError: true });

    const trajectory = await plugin.state.data.build()
      .toRoot()
      .apply(StateTransforms.Model.TrajectoryFromModelAndCoordinates, {
        modelRef: topologyModel.ref,
        coordinatesRef: coordinates.ref
      }, { dependsOn: [topologyModel.ref, coordinates.ref] })
      .commit({ revertOnError: true });

    this.model = await plugin.builders.structure.createModel(trajectory, { modelIndex: 0 });
    this.structure = await plugin.builders.structure.createStructure(this.model, {
      name: 'model',
      params: {}
    } as never);

    await this.createRepresentations();
    await this.focus(metadata.center, metadata.radius, 1200);
    this.syncOrbitToCurrentCamera();
  }

  async setFrame(frameIndex: number) {
    if (!this.model) return;
    const viewer = this.requireViewer();
    const safeIndex = Math.max(0, Math.min(this.frameCount - 1, Math.round(frameIndex)));
    const update = viewer.plugin.state.data.build();
    update.to(this.model).update({ modelIndex: safeIndex });
    await PluginCommands.State.Update(viewer.plugin, {
      state: viewer.plugin.state.data,
      tree: update,
      options: { doNotLogTiming: true }
    });
  }

  orbit(now: number) {
    if (!this.viewer?.plugin.canvas3d) return;

    const elapsed = (now - this.orbitStart) / 1000;
    const angle = elapsed * 0.09;
    const breath = Math.sin(elapsed * 0.34) * Math.max(1.2, this.orbitRadius * 0.03);
    const radius = this.orbitRadius + breath;
    const height = Math.max(8, this.orbitRadius * 0.16) + Math.sin(elapsed * 0.27) * 2.2;

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

  async focusCurrent(durationMs = 1200) {
    await PluginCommands.Camera.Focus(this.requireViewer().plugin, {
      center: this.center,
      radius: this.orbitRadius * 0.36,
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
    this.orbitStart = performance.now() - (angle / 0.09) * 1000;
  }

  private async createRepresentations() {
    const viewer = this.requireViewer();
    if (!this.structure) return;

    const polymer = await viewer.plugin.builders.structure.tryCreateComponentStatic(
      this.structure,
      'polymer',
      { label: 'Polymer' }
    );
    const ligand = await viewer.plugin.builders.structure.tryCreateComponentStatic(
      this.structure,
      'ligand',
      { label: 'Ligands' }
    );
    const ion = await viewer.plugin.builders.structure.tryCreateComponentStatic(
      this.structure,
      'ion',
      { label: 'Ions' }
    );

    if (polymer) {
      await viewer.plugin.builders.structure.representation.addRepresentation(polymer, {
        type: 'cartoon',
        typeParams: {
          quality: 'high',
          alpha: 1,
          ignoreHydrogens: true,
          sizeFactor: 0.36
        } as never,
        color: 'uniform',
        colorParams: { value: POLYMER_COLOR }
      } as never);

      await viewer.plugin.builders.structure.representation.addRepresentation(polymer, {
        type: 'gaussian-surface',
        typeParams: {
          alpha: 0.16,
          doubleSided: true,
          flatShaded: false,
          ignoreHydrogens: true,
          includeParent: false,
          material: SURFACE_MATERIAL,
          quality: 'custom',
          radiusOffset: 0.18,
          resolution: 0.85,
          smoothness: 1.2,
          transparentBackfaces: 'on',
          visuals: ['gaussian-surface-mesh']
        } as never,
        color: 'uniform',
        colorParams: { value: SURFACE_COLOR }
      } as never);
    }

    if (ligand) {
      await viewer.plugin.builders.structure.representation.addRepresentation(ligand, {
        type: 'ball-and-stick',
        typeParams: {
          alpha: 1,
          ignoreHydrogens: false,
          sizeFactor: 0.28,
          sizeAspectRatio: 0.6
        } as never,
        color: 'element-symbol',
        colorParams: {
          carbonColor: {
            name: 'uniform',
            params: { value: LIGAND_COLOR, saturation: 0, lightness: 0 }
          }
        }
      } as never);
    }

    if (ion) {
      await viewer.plugin.builders.structure.representation.addRepresentation(ion, {
        type: 'spacefill',
        typeParams: {
          alpha: 0.9,
          sizeFactor: 0.55
        } as never,
        color: 'uniform',
        colorParams: { value: ION_COLOR }
      } as never);
    }
  }

  private setOrbitTarget(center: Point3D, radius: number) {
    Vec3.set(this.center, center.x, center.y, center.z);
    this.orbitRadius = Math.max(28, Math.min(118, radius * 1.04));
  }

  private async focus(center: Point3D, radius: number, durationMs: number) {
    await PluginCommands.Camera.Focus(this.requireViewer().plugin, {
      center: Vec3.create(center.x, center.y, center.z),
      radius: Math.max(18, Math.min(76, radius * 0.46)),
      durationMs
    });
  }

  private requireViewer() {
    if (!this.viewer) throw new Error('Mol* viewer is not initialized.');
    return this.viewer;
  }
}
