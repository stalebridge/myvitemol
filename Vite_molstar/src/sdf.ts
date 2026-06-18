export interface AtomCoordinate {
  x: number;
  y: number;
  z: number;
  element: string;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface LigandRecord {
  id: string;
  sdf: string;
  atomCoordinates: AtomCoordinate[];
  centroid: Point3D;
  atomCount: number;
  heavyAtoms: number;
  heteroAtoms: number;
  score: number | null;
}

type AtomStats = {
  atomCount: number;
  heavyAtoms: number;
  heteroAtoms: number;
};

const HETERO_ELEMENTS = new Set(['N', 'O', 'S', 'P']);

export function parseSdf(text: string): LigandRecord[] {
  return text
    .split(/\$\$\$\$/g)
    .map(block => block.trim())
    .filter(Boolean)
    .map((block, index) => createLigandRecord(block, index));
}

function createLigandRecord(block: string, index: number): LigandRecord {
  const lines = block.split(/\r?\n/);
  const id = lines[0]?.trim() || `Ligand-${index + 1}`;
  const score = parseScoreField(block, 'r_exp_dg');
  const stats = parseAtomStats(lines);
  const atomCoordinates = parseAtomCoordinates(lines);

  return {
    id,
    sdf: `${block}\n$$$$\n`,
    atomCoordinates,
    centroid: computeCentroid(atomCoordinates),
    atomCount: stats.atomCount,
    heavyAtoms: stats.heavyAtoms,
    heteroAtoms: stats.heteroAtoms,
    score
  };
}

function computeCentroid(atoms: AtomCoordinate[]): Point3D {
  if (atoms.length === 0) return { x: 0, y: 0, z: 0 };
  const sum = atoms.reduce((acc, atom) => {
    acc.x += atom.x;
    acc.y += atom.y;
    acc.z += atom.z;
    return acc;
  }, { x: 0, y: 0, z: 0 });

  return {
    x: sum.x / atoms.length,
    y: sum.y / atoms.length,
    z: sum.z / atoms.length
  };
}

function parseAtomCoordinates(lines: string[]): AtomCoordinate[] {
  const countsLine = lines.find(line => /\s+\d+\s+\d+\s+/.test(line) && line.includes('V2000'));
  const atomCount = countsLine ? Number.parseInt(countsLine.slice(0, 3), 10) : 0;
  const countsIndex = countsLine ? lines.indexOf(countsLine) : -1;
  if (countsIndex < 0 || atomCount <= 0) return [];

  return lines
    .slice(countsIndex + 1, countsIndex + 1 + atomCount)
    .map(line => ({
      x: Number.parseFloat(line.slice(0, 10)),
      y: Number.parseFloat(line.slice(10, 20)),
      z: Number.parseFloat(line.slice(20, 30)),
      element: line.slice(31, 34).trim()
    }))
    .filter(atom => atom.element !== 'H' && Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z));
}

function parseScoreField(block: string, field: string): number | null {
  const match = block.match(new RegExp(`>\\s*<${field}>\\s*\\r?\\n([^\\r\\n]+)`, 'i'));
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseAtomStats(lines: string[]): AtomStats {
  const countsLine = lines.find(line => /\s+\d+\s+\d+\s+/.test(line) && line.includes('V2000'));
  const atomCount = countsLine ? Number.parseInt(countsLine.slice(0, 3), 10) : 0;
  const stats: AtomStats = {
    atomCount,
    heavyAtoms: 0,
    heteroAtoms: 0
  };

  const countsIndex = countsLine ? lines.indexOf(countsLine) : -1;
  if (countsIndex < 0 || atomCount <= 0) return stats;

  for (const line of lines.slice(countsIndex + 1, countsIndex + 1 + atomCount)) {
    const symbol = line.slice(31, 34).trim();
    if (!symbol || symbol === 'H') continue;
    stats.heavyAtoms += 1;
    if (HETERO_ELEMENTS.has(symbol)) stats.heteroAtoms += 1;
  }

  return stats;
}
