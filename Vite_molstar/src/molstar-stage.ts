import { Viewer } from 'molstar/lib/apps/viewer/app';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import type { Camera } from 'molstar/lib/mol-canvas3d/camera';
import type { StructureRef } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { Color } from 'molstar/lib/mol-util/color';
import { Material } from 'molstar/lib/mol-util/material';
import 'molstar/lib/mol-plugin-ui/skin/light.scss';

import type { Point3D, LigandRecord } from './sdf';

const POCKET_CENTER = Vec3.create(-12.2, 12.55, 69.53);
const CAMERA_UP = Vec3.create(0, 1, 0);
const POCKET_SURFACE_RADIUS = 8.5;
const CAMERA_DISTANCE_OFFSET = 3.5;
const SurfaceMaterial = Material({ roughness: 0.58, metalness: 0, bumpiness: 0 });

export class MolstarStage {
  private viewer: Viewer | null = null;
  private proteinRefs = new Set<string>();
  private ligandRefs = new Map<string, StructureRef[]>();
  private orbitStart = performance.now();
  private orbitPosition = Vec3();

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
        backgroundColor: 0xf7f2ea
      },
      postprocessing: {
        occlusion: {
          name: 'on',
          params: {
            samples: 16,
            radius: 3,
            bias: 0.8,
            blurKernelSize: 9,
            resolutionScale: 1
          }
        },
        outline: {
          name: 'on',
          params: {
            scale: 1,
            threshold: 0.25,
            color: 0xd8d0c3,
            includeTransparent: true
          }
        }
      },
      illumination: {
        enabled: true
      }
    } as never);
  }

  async loadProtein(url: string) {
    const viewer = this.requireViewer();
    await viewer.loadStructureFromUrl(url, 'pdb' as never, false, {
      label: 'SARS-CoV-2 Mpro',
      representationParams: {
        theme: {
          globalName: 'chain-id'
        }
      } as never
    });
    this.proteinRefs = new Set(this.structureRefs().map(ref => ref.cell.transform.ref));
    await this.focusPocket(1400);
    this.syncOrbitToCurrentCamera();
  }

  async createPocketSurfaceFromLigand(ligand: LigandRecord) {
    const viewer = this.requireViewer();
    const protein = this.structureRefs().find(ref => this.proteinRefs.has(ref.cell.transform.ref));
    if (!protein || ligand.atomCoordinates.length === 0) return;

    const component = await viewer.plugin.builders.structure.tryCreateComponentFromSelection(
      protein.cell,
      createPocketBallSelection(ligand.centroid),
      'pocket-surface',
      { label: 'Pocket Surface' }
    );

    if (!component) return;

    await viewer.plugin.builders.structure.representation.addRepresentation(component, {
      type: 'gaussian-surface',
      typeParams: {
        alpha: 0.24,
        doubleSided: true,
        flatShaded: false,
        ignoreHydrogens: true,
        includeParent: false,
        material: SurfaceMaterial,
        quality: 'custom',
        radiusOffset: 0.15,
        resolution: 0.35,
        smoothness: 1.35,
        transparentBackfaces: 'on',
        visuals: ['gaussian-surface-mesh']
      } as never,
      color: 'uniform',
      colorParams: {
        value: Color(0xcfd1d2)
      }
    } as never, { tag: 'pocket-surface' });
  }

  async loadLigands(ligands: LigandRecord[]) {
    const viewer = this.requireViewer();

    for (const ligand of ligands) {
      const before = new Set(this.structureRefs().map(ref => ref.cell.transform.ref));
      const cameraSnapshot = this.getCameraSnapshot();
      await viewer.loadStructureFromData(ligand.sdf, 'sdf' as never, { dataLabel: ligand.id });

      const refs = this.structureRefs().filter(ref => {
        const transformRef = ref.cell.transform.ref;
        return !before.has(transformRef) && !this.proteinRefs.has(transformRef);
      });

      this.ligandRefs.set(ligand.id, refs);
      viewer.plugin.managers.structure.hierarchy.toggleVisibility(refs, 'hide');
      if (cameraSnapshot) this.setCameraSnapshot(cameraSnapshot, 0);
    }
  }

  showLigand(ligand: LigandRecord) {
    if (!this.viewer) return;
    const hierarchy = this.viewer.plugin.managers.structure.hierarchy;
    const activeRefs = this.ligandRefs.get(ligand.id) ?? [];

    for (const [id, refs] of this.ligandRefs) {
      hierarchy.toggleVisibility(refs, id === ligand.id ? 'show' : 'hide');
    }

    if (activeRefs.length === 0) {
      console.warn(`No preloaded Mol* structure found for ligand ${ligand.id}.`);
    }
  }

  async focusPocket(durationMs = 2600) {
    const viewer = this.requireViewer();
    await PluginCommands.Camera.Focus(viewer.plugin, {
      center: POCKET_CENTER,
      radius: 13 + CAMERA_DISTANCE_OFFSET,
      durationMs
    });
  }

  orbitPocket(now: number, intensity = 1) {
    if (!this.viewer?.plugin.canvas3d) return;

    const elapsed = (now - this.orbitStart) / 1000;
    const angle = elapsed * 0.12 * intensity;
    const breath = Math.sin(elapsed * 0.42) * 1.35;
    const radius = 24 + CAMERA_DISTANCE_OFFSET + breath;
    const height = 6 + Math.sin(elapsed * 0.31) * 1.2;

    Vec3.set(
      this.orbitPosition,
      POCKET_CENTER[0] + Math.cos(angle) * radius,
      POCKET_CENTER[1] + height,
      POCKET_CENTER[2] + Math.sin(angle) * radius
    );

    this.viewer.plugin.canvas3d.camera.setState({
      target: POCKET_CENTER,
      position: this.orbitPosition,
      up: CAMERA_UP
    }, 0);
  }

  resetOrbitClock() {
    this.orbitStart = performance.now();
  }

  syncOrbitToCurrentCamera() {
    const snapshot = this.getCameraSnapshot();
    if (!snapshot?.position) {
      this.resetOrbitClock();
      return;
    }

    const dx = snapshot.position[0] - POCKET_CENTER[0];
    const dz = snapshot.position[2] - POCKET_CENTER[2];
    const angle = Math.atan2(dz, dx);
    this.orbitStart = performance.now() - (angle / 0.12) * 1000;
  }

  private getCameraSnapshot() {
    return this.viewer?.plugin.canvas3d?.camera.getSnapshot();
  }

  private setCameraSnapshot(snapshot: Camera.Snapshot, durationMs: number) {
    const viewer = this.requireViewer();
    PluginCommands.Camera.SetSnapshot(viewer.plugin, {
      snapshot,
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

function createPocketBallSelection(center: Point3D) {
  return StructureSelectionQuery('Pocket Surface Ball', MS.struct.modifier.wholeResidues([
    MS.struct.generator.atomGroups({
      'entity-test': MS.core.logic.and([
        MS.core.rel.eq([MS.ammp('entityType'), 'polymer']),
        MS.core.str.match([
          MS.re('(polypeptide|cyclic-pseudo-peptide|peptide-like)', 'i'),
          MS.ammp('entitySubtype')
        ])
      ]),
      'atom-test': MS.core.rel.lte([
        MS.core.math.sqrt([
          MS.core.math.add([
            MS.core.math.pow([MS.core.math.sub([MS.acp('x'), center.x]), 2]),
            MS.core.math.pow([MS.core.math.sub([MS.acp('y'), center.y]), 2]),
            MS.core.math.pow([MS.core.math.sub([MS.acp('z'), center.z]), 2])
          ])
        ]),
        POCKET_SURFACE_RADIUS
      ])
    })
  ]));
}
