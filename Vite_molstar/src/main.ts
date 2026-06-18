import './styles.css';

import { MolstarStage } from './molstar-stage';
import { LigandRecord, parseSdf } from './sdf';

type DemoMode = 'demo-playing' | 'user-control' | 'gentle-return' | 'paused';

const PROTEIN_URL = '/6LU7_pure.pdb';
const LIGANDS_URL = '/moles.sdf';
const INFOS_URL = '/moles_info.csv';
const SWITCH_INTERVAL_MS = 11200;
const IDLE_DELAY_MS = 8000;
const RETURN_DURATION_MS = 3000;

const stageElement = requireElement<HTMLElement>('#molstar-stage');
const loadingScreen = requireElement<HTMLElement>('#loading-screen');
const ligandIndexEl = requireElement<HTMLElement>('#ligand-index');
const ligandNameEl = requireElement<HTMLElement>('#ligand-name');
const metricListEl = requireElement<HTMLElement>('#metric-list');
const prevButton = document.querySelector<HTMLButtonElement>('#prev-ligand');
const nextButton = document.querySelector<HTMLButtonElement>('#next-ligand');

const stage = new MolstarStage();
let ligands: LigandRecord[] = [];
let ligandInfos = new Map<string, LigandInfo>();
let activeLigandIndex = 0;
let mode: DemoMode = 'demo-playing';
let lastSwitchAt = performance.now();
let idleTimer: number | undefined;
let isSwitching = false;

type LigandInfo = {
  name: string;
  metrics: Array<[label: string, value: string]>;
};

init().catch(error => {
  console.error(error);
  loadingScreen.classList.add('is-error');
  loadingScreen.innerHTML = `<div><p>Unable to prepare review</p><span>${String(error)}</span></div>`;
});

async function init() {
  const [sdfText, infosText] = await Promise.all([
    fetch(LIGANDS_URL).then(response => {
      if (!response.ok) throw new Error(`Failed to load ${LIGANDS_URL}`);
      return response.text();
    }),
    fetch(INFOS_URL).then(response => {
      if (!response.ok) throw new Error(`Failed to load ${INFOS_URL}`);
      return response.text();
    }),
    stage.init(stageElement)
  ]);

  ligands = parseSdf(sdfText);
  if (ligands.length === 0) throw new Error('No ligand records found in SDF.');
  ligandInfos = parseLigandInfos(infosText);

  await stage.loadProtein(PROTEIN_URL);
  await stage.createPocketSurfaceFromLigand(ligands[0]);
  await stage.loadLigands(ligands);
  await setActiveLigand(getInitialLigandIndex(), false);

  loadingScreen.classList.add('is-hidden');
  attachInteractionHandlers();
  requestAnimationFrame(tick);
}

function getInitialLigandIndex() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get('start');
  if (!start) return 0;
  const numeric = Number.parseInt(start, 10);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(ligands.length - 1, numeric - 1));
  const named = ligands.findIndex(ligand => ligand.id.toLowerCase() === start.toLowerCase());
  return named >= 0 ? named : 0;
}

function tick(now: number) {
  if (mode === 'demo-playing') {
    stage.orbitPocket(now);
    if (!isSwitching && now - lastSwitchAt > SWITCH_INTERVAL_MS) {
      void setActiveLigand((activeLigandIndex + 1) % ligands.length, true);
    }
  }
  requestAnimationFrame(tick);
}

async function setActiveLigand(index: number, resetClock: boolean) {
  if (isSwitching || ligands.length === 0) return;
  isSwitching = true;
  activeLigandIndex = ((index % ligands.length) + ligands.length) % ligands.length;
  const ligand = ligands[activeLigandIndex];

  renderLigand(ligand);
  stage.showLigand(ligand);

  if (resetClock) {
    lastSwitchAt = performance.now();
  }
  isSwitching = false;
}

function renderLigand(ligand: LigandRecord) {
  ligandIndexEl.textContent = `Ligand ${String(activeLigandIndex + 1).padStart(2, '0')} / ${String(ligands.length).padStart(2, '0')}`;
  ligandNameEl.textContent = ligand.id.slice(0, 12);
  ligandNameEl.title = ligand.id;
  const info = getLigandInfo(ligand.id);
  const metrics = info?.metrics ?? [['Info', 'N/A']];

  metricListEl.replaceChildren(
    ...metrics.map(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    })
  );
}

function getLigandInfo(ligandId: string): LigandInfo | undefined {
  const exactMatch = ligandInfos.get(ligandId);
  if (exactMatch) return exactMatch;

  const normalizedLigandId = ligandId.toLowerCase();
  for (const [name, info] of ligandInfos) {
    if (normalizedLigandId.startsWith(name.toLowerCase())) return info;
  }

  return undefined;
}

function attachInteractionHandlers() {
  const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'wheel'];
  for (const eventName of activityEvents) {
    window.addEventListener(eventName, () => markUserActivity(), { passive: true, capture: true });
  }

  window.addEventListener('pointermove', event => {
    if (event.buttons !== 0) markUserActivity();
  }, { passive: true, capture: true });

  window.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      markUserActivity();
      void setActiveLigand(activeLigandIndex - 1, true);
    } else if (event.key === 'ArrowRight') {
      markUserActivity();
      void setActiveLigand(activeLigandIndex + 1, true);
    } else if (event.key === ' ') {
      event.preventDefault();
      mode = mode === 'paused' ? 'demo-playing' : 'paused';
    } else {
      markUserActivity();
    }
  });

  prevButton?.addEventListener('click', () => {
    markUserActivity();
    void setActiveLigand(activeLigandIndex - 1, true);
  });

  nextButton?.addEventListener('click', () => {
    markUserActivity();
    void setActiveLigand(activeLigandIndex + 1, true);
  });
}

function markUserActivity() {
  if (mode !== 'paused') mode = 'user-control';

  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (mode === 'user-control') void gentleReturn();
  }, IDLE_DELAY_MS);
}

async function gentleReturn() {
  mode = 'gentle-return';
  await stage.focusPocket(RETURN_DURATION_MS);
  await wait(RETURN_DURATION_MS);
  mode = 'demo-playing';
  lastSwitchAt = performance.now();
  stage.syncOrbitToCurrentCamera();
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function parseLigandInfos(text: string): Map<string, LigandInfo> {
  const rows = parseCsv(text).filter(row => row.length > 0 && row.some(cell => cell.trim()));
  const [header, ...records] = rows;
  if (!header) return new Map();

  const nameIndex = header.findIndex(label => label.trim().toLowerCase() === 'name');
  if (nameIndex < 0) throw new Error(`${INFOS_URL} is missing a name column.`);

  const infos = new Map<string, LigandInfo>();
  for (const record of records) {
    const name = record[nameIndex]?.trim();
    if (!name) continue;

    infos.set(name, {
      name,
      metrics: header
        .map((label, index): [string, string] | null => {
          if (index === nameIndex) return null;
          return [label.trim(), record[index]?.trim() || 'N/A'];
        })
        .filter((metric): metric is [string, string] => metric !== null)
    });
  }

  return infos;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required UI element is missing: ${selector}`);
  return element;
}
