import './styles.css';

import { loadMdTrajectoryMetadata, type MdTrajectoryMetadata } from './md-data';
import { MolstarMdStage } from './molstar-md-stage';

type PlaybackMode = 'playing' | 'user-control' | 'gentle-return' | 'paused';

const FRAME_INTERVAL_MS = 160;
const IDLE_DELAY_MS = 8000;
const RETURN_DURATION_MS = 1800;

const stageElement = requireElement<HTMLElement>('#molstar-stage');
const loadingScreen = requireElement<HTMLElement>('#loading-screen');
const trajectoryIndexEl = requireElement<HTMLElement>('#trajectory-index');
const trajectoryNameEl = requireElement<HTMLElement>('#trajectory-name');
const metricListEl = requireElement<HTMLElement>('#metric-list');
const prevButton = document.querySelector<HTMLButtonElement>('#prev-frame');
const nextButton = document.querySelector<HTMLButtonElement>('#next-frame');
const playButton = document.querySelector<HTMLButtonElement>('#play-toggle');

const stage = new MolstarMdStage();
let metadata: MdTrajectoryMetadata | null = null;
let activeFrame = 0;
let mode: PlaybackMode = 'playing';
let lastFrameAt = performance.now();
let idleTimer: number | undefined;
let activityVersion = 0;
let isApplyingFrame = false;

init().catch(error => {
  console.error(error);
  loadingScreen.classList.add('is-error');
  loadingScreen.innerHTML = `<div><p>Unable to prepare molecular dynamics</p><span>${String(error)}</span></div>`;
});

async function init() {
  const [loadedMetadata] = await Promise.all([
    loadMdTrajectoryMetadata(),
    stage.init(stageElement)
  ]);

  metadata = loadedMetadata;
  renderMetadata(loadedMetadata);
  await stage.loadTrajectory(loadedMetadata);
  await applyFrame(getInitialFrameIndex(), true);

  loadingScreen.classList.add('is-hidden');
  attachInteractionHandlers();
  requestAnimationFrame(tick);
}

function getInitialFrameIndex() {
  if (!metadata) return 0;
  const params = new URLSearchParams(window.location.search);
  const start = params.get('frame');
  if (!start) return 0;
  const numeric = Number.parseInt(start, 10);
  if (!Number.isFinite(numeric)) return 0;
  return clampFrame(numeric - 1);
}

function tick(now: number) {
  if (mode === 'playing' && metadata && !isApplyingFrame) {
    stage.orbit(now);
    if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
      void applyFrame((activeFrame + 1) % metadata.frameCount, false);
      lastFrameAt = now;
    }
  }

  requestAnimationFrame(tick);
}

async function applyFrame(frame: number, resetClock: boolean) {
  if (!metadata || isApplyingFrame) return;
  isApplyingFrame = true;
  try {
    activeFrame = clampFrame(frame);
    renderFrameState();
    await stage.setFrame(activeFrame);
    if (resetClock) {
      lastFrameAt = performance.now();
      stage.syncOrbitToCurrentCamera();
    }
  } finally {
    isApplyingFrame = false;
  }
}

function renderMetadata(info: MdTrajectoryMetadata) {
  trajectoryNameEl.textContent = 'TYK2: ejm47-ejm31';
  metricListEl.replaceChildren(
    createMetricRow('Temperature', '300 K'),
    createMetricRow('Pressure', '1.0 atm'),
    createMetricRow('Timestep', '2 fs'),
    createMetricRow('Tick step', '0.1 ps'),
    createMetricRow('ΔG', '-22.48 kcal/mol'),
    createMetricRow('Waters', formatInteger(info.removedWaterCount)),
    createMetricRow('Ionic strength', `${formatDecimal(info.ionStrengthMolar)} M`),
    createMetricRow('Atoms', formatInteger(info.atomCount)),
  );
  renderFrameState();
}

function renderFrameState() {
  if (!metadata) {
    trajectoryIndexEl.textContent = 'Frame -- / --';
    return;
  }
  const frameText = `${formatInteger(activeFrame + 1)} / ${formatInteger(metadata.frameCount)}`;
  trajectoryIndexEl.textContent = `Frame ${frameText}`;
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
      void stepFrame(-1);
    } else if (event.key === 'ArrowRight') {
      markUserActivity();
      void stepFrame(1);
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePlayback();
    } else {
      markUserActivity();
    }
  });

  prevButton?.addEventListener('click', () => {
    markUserActivity();
    void stepFrame(-1);
  });

  nextButton?.addEventListener('click', () => {
    markUserActivity();
    void stepFrame(1);
  });

  playButton?.addEventListener('click', () => {
    togglePlayback();
  });

  window.addEventListener('resize', () => {
    void stage.focusCurrent(600);
  }, { passive: true });
}

async function stepFrame(delta: number) {
  if (!metadata) return;
  await applyFrame((activeFrame + delta + metadata.frameCount) % metadata.frameCount, true);
}

function togglePlayback() {
  mode = mode === 'paused' ? 'playing' : 'paused';
  if (mode === 'playing') {
    lastFrameAt = performance.now();
    stage.syncOrbitToCurrentCamera();
  }
  updateModeState();
}

function markUserActivity() {
  activityVersion += 1;
  if (mode !== 'paused') mode = 'user-control';
  updateModeState();

  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  const expectedVersion = activityVersion;
  idleTimer = window.setTimeout(() => {
    if (mode === 'user-control' && activityVersion === expectedVersion) void gentleReturn(expectedVersion);
  }, IDLE_DELAY_MS);
}

async function gentleReturn(expectedVersion: number) {
  mode = 'gentle-return';
  updateModeState();
  await stage.focusCurrent(RETURN_DURATION_MS);
  await wait(RETURN_DURATION_MS);
  if (mode !== 'gentle-return' || activityVersion !== expectedVersion) return;

  mode = 'playing';
  lastFrameAt = performance.now();
  stage.syncOrbitToCurrentCamera();
  updateModeState();
}

function updateModeState() {
  document.documentElement.dataset.mode = mode;
  if (playButton) {
    const isPaused = mode === 'paused';
    playButton.textContent = isPaused ? '▶' : 'Ⅱ';
    playButton.title = isPaused ? 'Play trajectory' : 'Pause trajectory';
    playButton.setAttribute('aria-label', isPaused ? 'Play trajectory' : 'Pause trajectory');
  }
}

function clampFrame(frame: number) {
  if (!metadata) return 0;
  return Math.max(0, Math.min(metadata.frameCount - 1, Math.round(frame)));
}

function createMetricRow(label: string, value: string) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value);
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
