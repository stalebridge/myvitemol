export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface MdTrajectoryMetadata {
  title: string;
  topologyUrl: string;
  trajectoryUrl: string;
  sourceTopology: string;
  sourceTrajectory: string;
  selection: string;
  stride: number;
  ionStrengthMolar: number;
  inputAtomCount: number;
  atomCount: number;
  removedAtomCount: number;
  removedWaterCount: number;
  removedWaterAtomCount: number;
  removedIonAtomCount: number;
  inputFrameCount: number;
  frameCount: number;
  residueCount: number;
  segmentCount: number;
  segments: string[];
  center: Point3D;
  radius: number;
}

export async function loadMdTrajectoryMetadata(url = '/datas/trajectory_metadata.json'): Promise<MdTrajectoryMetadata> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json() as Promise<MdTrajectoryMetadata>;
}
