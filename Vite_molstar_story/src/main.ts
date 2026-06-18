import './styles.css';

import { VirionStage, type VirionSceneId } from './molstar-virion-stage';

type DemoMode = 'demo-playing' | 'user-control' | 'gentle-return' | 'paused';

interface StoryScene {
  id: VirionSceneId;
  title: string;
  durationMs: number;
}

const SCENES: StoryScene[] = [
  { id: 'overview', title: 'SARS-COV-2 Virion', durationMs: 9000 },
  { id: 'surface-rock', title: 'Surface', durationMs: 8000 },
  { id: 'cutaway', title: 'Cutaway', durationMs: 10000 },
  { id: 'interior-window', title: 'Interior', durationMs: 8000 }
];

const IDLE_DELAY_MS = 8000;
const RETURN_DURATION_MS = 2600;
const SCENE_TRANSITION_MS = 2200;

const stageElement = requireElement<HTMLElement>('#molstar-stage');
const loadingScreen = requireElement<HTMLElement>('#loading-screen');
const sceneTitleEl = requireElement<HTMLElement>('#scene-title');
const sceneDotsEl = requireElement<HTMLElement>('#scene-dots');
const prevButton = requireElement<HTMLButtonElement>('#prev-scene');
const nextButton = requireElement<HTMLButtonElement>('#next-scene');
const pauseButton = requireElement<HTMLButtonElement>('#pause-scene');

const stage = new VirionStage();
let activeSceneIndex = 0;
let sceneStartedAt = performance.now();
let transitionUntil = 0;
let mode: DemoMode = 'demo-playing';
let idleTimer: number | undefined;
let isTransitioning = false;

init().catch(error => {
  console.error(error);
  loadingScreen.classList.add('is-error');
  loadingScreen.innerHTML = `<div><p>Unable to prepare virion story</p><span>${String(error)}</span></div>`;
});

async function init() {
  renderSceneDots();
  renderSceneInfo(SCENES[activeSceneIndex]);

  await stage.init(stageElement);
  setMode(mode);
  await stage.loadVirion();
  await enterScene(0, false);

  loadingScreen.classList.add('is-hidden');
  attachInteractionHandlers();
  requestAnimationFrame(tick);
}

function tick(now: number) {
  const scene = SCENES[activeSceneIndex];
  const inTransition = now < transitionUntil;
  const progress = inTransition ? 0 : Math.min(1, (now - sceneStartedAt) / scene.durationMs);

  if (mode === 'demo-playing') {
    if (!inTransition) {
      stage.renderScene(scene.id, now, progress);
    }
    if (progress >= 1 && !isTransitioning) {
      void enterScene((activeSceneIndex + 1) % SCENES.length, true);
    }
  }

  requestAnimationFrame(tick);
}

async function enterScene(index: number, resetMode: boolean) {
  if (isTransitioning) return;
  isTransitioning = true;
  const previousSceneIndex = activeSceneIndex;
  activeSceneIndex = ((index % SCENES.length) + SCENES.length) % SCENES.length;
  const scene = SCENES[activeSceneIndex];
  const transitionMs = previousSceneIndex === SCENES.length - 1 && activeSceneIndex === 0
    ? 0
    : SCENE_TRANSITION_MS;

  renderSceneInfo(scene);

  const now = performance.now();
  transitionUntil = now + transitionMs;
  sceneStartedAt = transitionUntil;
  await stage.enterScene(scene.id, transitionMs);

  if (resetMode && mode !== 'paused') {
    setMode('demo-playing');
  }

  isTransitioning = false;
}

function renderSceneInfo(scene: StoryScene) {
  sceneTitleEl.textContent = scene.title;
  sceneDotsEl.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => {
    button.classList.toggle('is-active', index === activeSceneIndex);
  });
}

function renderSceneDots() {
  sceneDotsEl.replaceChildren(
    ...SCENES.map((scene, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = scene.title;
      button.setAttribute('aria-label', scene.title);
      button.addEventListener('click', () => {
        markUserActivity();
        void enterScene(index, false);
      });
      return button;
    })
  );
}

function attachInteractionHandlers() {
  window.addEventListener('pointerdown', () => markUserActivity(), { passive: true, capture: true });
  window.addEventListener('wheel', () => markUserActivity(), { passive: true, capture: true });
  window.addEventListener('pointermove', event => {
    if (event.buttons !== 0) markUserActivity();
  }, { passive: true, capture: true });

  window.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      markUserActivity();
      void enterScene(activeSceneIndex - 1, false);
    } else if (event.key === 'ArrowRight') {
      markUserActivity();
      void enterScene(activeSceneIndex + 1, false);
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePause();
    } else {
      markUserActivity();
    }
  });

  prevButton.addEventListener('click', () => {
    markUserActivity();
    void enterScene(activeSceneIndex - 1, false);
  });

  nextButton.addEventListener('click', () => {
    markUserActivity();
    void enterScene(activeSceneIndex + 1, false);
  });

  pauseButton.addEventListener('click', () => togglePause());
}

function togglePause() {
  setMode(mode === 'paused' ? 'demo-playing' : 'paused');
  if (mode === 'demo-playing') {
    const now = performance.now();
    sceneStartedAt = Math.max(now, transitionUntil);
  }
  pauseButton.textContent = mode === 'paused' ? '▶' : 'Ⅱ';
}

function markUserActivity() {
  if (mode !== 'paused') setMode('user-control');

  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (mode === 'user-control') void gentleReturn();
  }, IDLE_DELAY_MS);
}

async function gentleReturn() {
  setMode('gentle-return');
  await stage.focusCurrentScene(RETURN_DURATION_MS);
  await wait(RETURN_DURATION_MS);
  setMode('demo-playing');
  transitionUntil = 0;
  sceneStartedAt = performance.now();
  stage.syncOrbitToCurrentCamera();
}

function setMode(nextMode: DemoMode) {
  mode = nextMode;
  document.body.dataset.mode = mode;
  stage.setAutoAnimationRenderMode(mode === 'demo-playing' || mode === 'gentle-return');
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required UI element is missing: ${selector}`);
  return element;
}
