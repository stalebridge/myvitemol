import './styles.css';

import { MolstarStage } from './molstar-stage';
import { DiffusionTrajectory, TrajectorySeed, loadDiffusionTrajectory } from './trajectory-data';

type PlaybackMode = 'playing' | 'user-control' | 'gentle-return' | 'paused';

const TRAJECTORY_SEEDS: TrajectorySeed[] = [
  { id: 'p1', label: 'P1', url: '/datas/trajs/p1_traj.pdb', color: 0x2d7dd2 },
  { id: 'p2', label: 'P2', url: '/datas/trajs/p2_traj.pdb', color: 0xd1495b },
  { id: 'p3', label: 'P3', url: '/datas/trajs/p3_traj.pdb', color: 0x36a269 },
  { id: 'p4', label: 'P4', url: '/datas/trajs/p4_traj.pdb', color: 0xef8a17 },
  { id: 'p5', label: 'P5', url: '/datas/trajs/p5_traj.pdb', color: 0x7b5cc9 },
  { id: 'p6', label: 'P6', url: '/datas/trajs/p6_traj.pdb', color: 0x008c95 }
];

const INITIAL_HOLD_MS = 2000;
const MORPH_DURATION_MS = 8200;
const FINAL_HOLD_MS = 2600;
const FRAME_THROTTLE_MS = 125;
const IDLE_DELAY_MS = 8000;
const RETURN_DURATION_MS = 2600;

const stageElement = requireElement<HTMLElement>('#molstar-stage');
const loadingScreen = requireElement<HTMLElement>('#loading-screen');
const trajectoryIndexEl = requireElement<HTMLElement>('#trajectory-index');
const trajectoryNameEl = requireElement<HTMLElement>('#trajectory-name');
const chainLengthEl = requireElement<HTMLElement>('#chain-length');
const prevButton = document.querySelector<HTMLButtonElement>('#prev-trajectory');
const nextButton = document.querySelector<HTMLButtonElement>('#next-trajectory');

const stage = new MolstarStage();
let trajectories: DiffusionTrajectory[] = [];
let activeIndex = 0;
let mode: PlaybackMode = 'playing';
let phaseStartedAt = performance.now();
let lastFrameUpdateAt = 0;
let lastAppliedFrame = -1;
let idleTimer: number | undefined;
let activityVersion = 0;
let isSwitching = false;

init().catch(error => {
  console.error(error);
  loadingScreen.classList.add('is-error');
  loadingScreen.innerHTML = `<div><p>Unable to prepare trajectories</p><span>${String(error)}</span></div>`;
});

async function init() {
  const [loaded] = await Promise.all([
    Promise.all(TRAJECTORY_SEEDS.map(seed => loadDiffusionTrajectory(seed))),
    stage.init(stageElement)
  ]);

  trajectories = loaded;
  await stage.loadTrajectories(trajectories);
  await setActiveTrajectory(getInitialTrajectoryIndex(), false);

  loadingScreen.classList.add('is-hidden');
  attachInteractionHandlers();
  requestAnimationFrame(tick);
}

function getInitialTrajectoryIndex() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get('start');
  if (!start) return 0;

  const numeric = Number.parseInt(start, 10);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(trajectories.length - 1, numeric - 1));

  const named = trajectories.findIndex(item => item.label.toLowerCase() === start.toLowerCase() || item.id === start.toLowerCase());
  return named >= 0 ? named : 0;
}

function tick(now: number) {
  if (mode === 'playing' && trajectories.length > 0 && !isSwitching) {
    stage.orbit(now);

    const trajectory = trajectories[activeIndex];
    const elapsed = now - phaseStartedAt;
    const cycleDuration = INITIAL_HOLD_MS + MORPH_DURATION_MS + FINAL_HOLD_MS;

    if (elapsed >= cycleDuration) {
      void setActiveTrajectory(activeIndex + 1, true);
    } else if (elapsed < INITIAL_HOLD_MS) {
      void setFrameIfNeeded(trajectory, trajectory.frameCount - 1, now);
    } else if (elapsed < INITIAL_HOLD_MS + MORPH_DURATION_MS) {
      const progress = easeInOutCubic((elapsed - INITIAL_HOLD_MS) / MORPH_DURATION_MS);
      const frame = Math.round((trajectory.frameCount - 1) * (1 - progress));
      void setFrameIfNeeded(trajectory, frame, now);
    } else {
      void setFrameIfNeeded(trajectory, 0, now);
    }
  }

  requestAnimationFrame(tick);
}

async function setFrameIfNeeded(trajectory: DiffusionTrajectory, frame: number, now: number) {
  if (frame === lastAppliedFrame && now - lastFrameUpdateAt < FRAME_THROTTLE_MS) return;
  if (now - lastFrameUpdateAt < FRAME_THROTTLE_MS && frame !== 0 && frame !== trajectory.frameCount - 1) return;

  lastAppliedFrame = frame;
  lastFrameUpdateAt = now;
  await stage.setFrame(trajectory.id, frame);
}

async function setActiveTrajectory(index: number, resetClock: boolean) {
  if (isSwitching || trajectories.length === 0) return;

  isSwitching = true;
  activeIndex = ((index % trajectories.length) + trajectories.length) % trajectories.length;
  const trajectory = trajectories[activeIndex];
  const startFrame = trajectory.frameCount - 1;

  renderTrajectory(trajectory);
  await stage.showTrajectory(trajectory, startFrame);
  lastAppliedFrame = startFrame;
  lastFrameUpdateAt = performance.now();
  phaseStartedAt = performance.now();

  if (resetClock) {
    stage.syncOrbitToCurrentCamera();
  }

  isSwitching = false;
}

async function restartActiveTrajectory() {
  if (trajectories.length === 0) return;

  const trajectory = trajectories[activeIndex];
  const startFrame = trajectory.frameCount - 1;

  await stage.showTrajectory(trajectory, startFrame);
  lastAppliedFrame = startFrame;
  lastFrameUpdateAt = performance.now();
  phaseStartedAt = performance.now();
}

function renderTrajectory(trajectory: DiffusionTrajectory) {
  trajectoryIndexEl.textContent = `${trajectory.label} / P${trajectories.length}`;
  trajectoryNameEl.textContent = trajectory.label;
  chainLengthEl.textContent = `${trajectory.length} aa`;
  document.documentElement.style.setProperty('--active-chain-color', `#${trajectory.color.toString(16).padStart(6, '0')}`);
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
      void setActiveTrajectory(activeIndex - 1, true);
    } else if (event.key === 'ArrowRight') {
      markUserActivity();
      void setActiveTrajectory(activeIndex + 1, true);
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePause();
    } else {
      markUserActivity();
    }
  });

  prevButton?.addEventListener('click', () => {
    markUserActivity();
    void setActiveTrajectory(activeIndex - 1, true);
  });

  nextButton?.addEventListener('click', () => {
    markUserActivity();
    void setActiveTrajectory(activeIndex + 1, true);
  });

  window.addEventListener('resize', () => {
    void stage.focusCurrent(600);
  }, { passive: true });
}

function togglePause() {
  mode = mode === 'paused' ? 'playing' : 'paused';
  if (mode === 'playing') phaseStartedAt = performance.now();
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

  await restartActiveTrajectory();
  if (mode !== 'gentle-return' || activityVersion !== expectedVersion) return;

  mode = 'playing';
  stage.syncOrbitToCurrentCamera();
  updateModeState();
}

function updateModeState() {
  document.body.dataset.mode = mode;
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function easeInOutCubic(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required UI element is missing: ${selector}`);
  return element;
}
