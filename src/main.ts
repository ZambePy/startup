import './style.css';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import * as calibration from './calibration';
import { feedAccuracyRaw, feedAccuracyFiltered, feedAccuracyIod, isAccuracyTesting } from './accuracy';
import { logFrame, toggleSessionLog, isSessionLogging, exportSessionLog } from './sessionLog';
import { gazeFilter, setGazeFilterParams } from './oneEuroFilter';
import { blinkDetector } from './blinkDetector';
import { KeyboardUI } from './keyboard/KeyboardUI';
import { KeyboardState } from './keyboard/KeyboardState';
import { dwellManager } from './keyboard/DwellManager';
import { updateDwell, resetDwell } from './dwell';
import { extractEyeFeatures } from './extractor';

const video      = document.getElementById('webcam') as HTMLVideoElement;
const canvas     = document.getElementById('output_canvas') as HTMLCanvasElement;
const laser      = document.getElementById('laser') as HTMLDivElement;
const loadingMsg = document.getElementById('loading') as HTMLDivElement;

let faceLandmarker: FaceLandmarker;
let lastVideoTime = -1;

// Última posição válida — congelada quando suppressGaze=true (piscada)
let lastValidX = document.documentElement.clientWidth  / 2;
let lastValidY = document.documentElement.clientHeight / 2;
let currentX   = lastValidX;
let currentY   = lastValidY;

// Variáveis de log de frame
let _logFeaturesLeft: number[]               = [];
let _logFeaturesRight: number[]              = [];
let _logPredRaw: { x: number; y: number } | null = null;
let _logEar   = 0;
let _logBlink = false;

// ── FPS counter ───────────────────────────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

function tickFps(): void {
  fpsFrameCount++;
  const now     = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 1000) {
    calibration.updateFpsDisplay(Math.round(fpsFrameCount * 1000 / elapsed));
    fpsFrameCount = 0;
    fpsLastTime   = now;
  }
}

// ── Signal Quality tracker ────────────────────────────────────────────────────
const SQ_WINDOW_MS = 5000;
const signalTimestamps: { time: number; hasFace: boolean }[] = [];

function recordSignalFrame(hasFace: boolean): void {
  const now = performance.now();
  signalTimestamps.push({ time: now, hasFace });
  const cutoff = now - SQ_WINDOW_MS;
  while (signalTimestamps.length > 0 && signalTimestamps[0].time < cutoff) {
    signalTimestamps.shift();
  }
  if (signalTimestamps.length % 30 === 0) {
    const pct = signalTimestamps.filter(s => s.hasFace).length / signalTimestamps.length;
    calibration.updateSignalQuality(Math.round(pct * 100));
  }
}

// ── Verificação de iluminação ─────────────────────────────────────────────────
let lightingCheckCanvas: HTMLCanvasElement | null = null;

function checkLighting(): void {
  if (!video || video.videoWidth === 0) return;
  if (!lightingCheckCanvas) {
    lightingCheckCanvas = document.createElement('canvas');
    lightingCheckCanvas.width  = 32;
    lightingCheckCanvas.height = 18;
  }
  const ctx = lightingCheckCanvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, 32, 18);
  const data = ctx.getImageData(0, 0, 32, 18).data;
  let lum = 0;
  for (let i = 0; i < data.length; i += 4) {
    lum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  calibration.updateLightingWarning(lum / (data.length / 4) < 40);
}

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
      delegate: "GPU"
    },
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO",
    numFaces: 1
  });
  loadingMsg.style.display = 'none';
  startCamera();
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" }
    });
    video.srcObject = stream;
    video.addEventListener("loadeddata", () => {
      setInterval(checkLighting, 3000);
      predictWebcam();
    });
  } catch (err) {
    console.error("Erro ao acessar a câmera:", err);
    loadingMsg.innerText = "Erro ao acessar a câmera.";
  }
}

async function predictWebcam() {
  if (canvas.width !== video.videoWidth) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  tickFps();

  const frameTime = performance.now();

  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;

    const results = faceLandmarker.detectForVideo(video, frameTime);
    const hasFace = !!(results.faceLandmarks && results.faceLandmarks.length > 0);
    recordSignalFrame(hasFace);

    if (!hasFace) {
      calibration.feedFaceMetrics(false, 0);
    }

    if (hasFace) {
      const landmarks = results.faceLandmarks[0];

      // IOD para pré-calibração e estimativa de distância no teste de acurácia
      const rawIod = Math.sqrt(
        (landmarks[33].x - landmarks[263].x) ** 2 +
        (landmarks[33].y - landmarks[263].y) ** 2
      );
      calibration.feedFaceMetrics(true, rawIod);
      feedAccuracyIod(rawIod);

      const ext = extractEyeFeatures(landmarks);
      _logEar   = ext.ear;
      _logBlink = ext.blinkDetected;

      // Máquina de estados de piscada — roda sempre, inclusive durante blinks
      const blinkResult = blinkDetector.update(ext.ear);

      if (ext.featuresLeft.length > 0) {
        _logFeaturesLeft  = ext.featuresLeft;
        _logFeaturesRight = ext.featuresRight;

        calibration.feedRawData(ext.featuresLeft, ext.featuresRight);
        feedAccuracyRaw(ext.featuresLeft, ext.featuresRight);

        const rawGaze = calibration.mapGaze(ext.featuresLeft, ext.featuresRight);
        _logPredRaw = rawGaze;

        if (!blinkResult.suppressGaze) {
          // Olhos abertos: aplica OneEuroFilter e atualiza posição válida
          let rawX: number, rawY: number;
          if (rawGaze) {
            rawX = rawGaze.x;
            rawY = rawGaze.y;
          } else {
            // Fallback pré-calibração: nariz espelhado
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            rawX = (1.0 - landmarks[1].x) * vw;
            rawY = landmarks[1].y * vh;
          }
          const filtered = gazeFilter.filter(rawX, rawY, frameTime);
          lastValidX = filtered.x;
          lastValidY = filtered.y;
        }
        // suppressGaze=true → lastValidX/Y congelados (cursor não move durante piscada)
      }

      currentX = lastValidX;
      currentY = lastValidY;

      // Dwell e seleção por blink (somente fora da calibração)
      if (!calibration.isCalibrating) {
        updateDwell(currentX, currentY, (evt) => {
          console.debug('[IrisFlow] DwellEvent:', evt.type, evt.x.toFixed(0), evt.y.toFixed(0));
        });
        // intentionalBlink=true → dispara tecla imediatamente (sem aguardar dwell)
        dwellManager.update(currentX, currentY, blinkResult.intentionalBlink);
      } else {
        resetDwell();
        blinkDetector.reset();
        gazeFilter.reset();
      }
    }
  }

  // Alimenta posição filtrada para o teste de acurácia (raw vs filtrado)
  feedAccuracyFiltered(currentX, currentY);

  // Log de sessão frame a frame
  if (isSessionLogging() && _logFeaturesLeft.length > 0) {
    logFrame({
      featuresLeft:    _logFeaturesLeft,
      featuresRight:   _logFeaturesRight,
      predRaw:         _logPredRaw,
      predFiltered:    { x: currentX, y: currentY },
      ear:             _logEar,
      blinkDetected:   _logBlink,
      keyboardVisible: KeyboardState.getState().isVisible,
      inAccuracyTest:  isAccuracyTesting,
    });
  }

  // Cursor
  if (calibration.isCalibrating) {
    laser.style.display = 'none';
  } else {
    laser.style.display = 'block';
    laser.style.left = `${currentX}px`;
    laser.style.top  = `${currentY}px`;
  }

  window.requestAnimationFrame(predictWebcam);
}

// Inicializa o painel de calibração e carrega perfis salvos
calibration.init();

// Adiciona controles do filtro ao painel (expostos ao terapeuta)
calibration.addFilterControls(0.5, 0.007, (mc, b) => {
  setGazeFilterParams(mc, b);
  gazeFilter.reset(); // reseta estado interno ao mudar parâmetros
});

// Inicializa o teclado virtual
const app = document.getElementById('app');
if (app) {
  const keyboard = new KeyboardUI();
  keyboard.mount(app);
}

// ── Log de sessão: L para gravar, E para exportar ────────────────────────────
function setLogIndicator(active: boolean): void {
  let el = document.getElementById('log-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'log-indicator';
    el.className = 'log-indicator';
    document.body.appendChild(el);
  }
  el.textContent = '● REC';
  (el as HTMLElement).style.display = active ? 'block' : 'none';
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'KeyL') {
    const active = toggleSessionLog();
    setLogIndicator(active);
    console.info(`[IrisFlow] Log de sessão ${active ? 'iniciado' : 'pausado'}`);
  }
  if (e.code === 'KeyE') {
    exportSessionLog();
  }
});

initMediaPipe();
