export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface DiffusionTrajectory {
  id: string;
  label: string;
  url: string;
  color: number;
  pdb: string;
  frameCount: number;
  length: number;
  center: Point3D;
  radius: number;
}

export interface TrajectorySeed {
  id: string;
  label: string;
  url: string;
  color: number;
}

export async function loadDiffusionTrajectory(seed: TrajectorySeed): Promise<DiffusionTrajectory> {
  const raw = await fetch(seed.url).then(response => {
    if (!response.ok) throw new Error(`Failed to load ${seed.url}`);
    return response.text();
  });
  const pdb = ensureModelRecords(raw);
  const frameCount = countFrames(pdb);
  const residues = extractAChainResiduesFromFirstFrame(pdb);
  const bounds = computeBounds(pdb);

  return {
    ...seed,
    pdb,
    frameCount,
    length: residues.length,
    center: bounds.center,
    radius: bounds.radius
  };
}

function ensureModelRecords(pdb: string) {
  if (/^MODEL\s+/m.test(pdb)) return pdb;

  const lines = pdb.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const output: string[] = [];
  let model = 1;
  let inModel = false;

  for (const line of lines) {
    if (!inModel && (line.startsWith('ATOM  ') || line.startsWith('HETATM'))) {
      output.push(`MODEL     ${String(model).padStart(4, ' ')}`);
      inModel = true;
    }

    if (line.startsWith('ENDMDL')) {
      if (!inModel) output.push(`MODEL     ${String(model).padStart(4, ' ')}`);
      output.push(line);
      model += 1;
      inModel = false;
      continue;
    }

    if (line.length > 0) output.push(line);
  }

  if (inModel) output.push('ENDMDL');
  return `${output.join('\n')}\n`;
}

function countFrames(pdb: string) {
  const models = pdb.match(/^MODEL\s+/gm)?.length ?? 0;
  if (models > 0) return models;
  return pdb.match(/^ENDMDL/gm)?.length ?? 1;
}

function extractAChainResiduesFromFirstFrame(pdb: string) {
  const residues: string[] = [];
  const seen = new Set<string>();

  for (const line of pdb.split('\n')) {
    if (line.startsWith('ENDMDL')) break;
    if (!line.startsWith('ATOM  ') && !line.startsWith('HETATM')) continue;
    if (line.slice(21, 22) !== 'A') continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;

    const residueKey = `${line.slice(21, 22)}:${line.slice(22, 27).trim()}:${line.slice(26, 27).trim()}`;
    if (seen.has(residueKey)) continue;

    seen.add(residueKey);
    residues.push(line.slice(17, 20).trim().toUpperCase());
  }

  return residues;
}

function computeBounds(pdb: string) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM  ') && !line.startsWith('HETATM')) continue;

    const x = Number.parseFloat(line.slice(30, 38));
    const y = Number.parseFloat(line.slice(38, 46));
    const z = Number.parseFloat(line.slice(46, 54));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (!Number.isFinite(minX)) {
    return { center: { x: 0, y: 0, z: 0 }, radius: 40 };
  }

  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2
  };
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const radius = Math.max(18, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.58);

  return { center, radius };
}
