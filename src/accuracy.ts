// Teste de validação pós-calibração com Diagnóstico Visual por Ponto
//
// Sprint 1 — Instrumento de medição honesto:
//   • Bug do erro-zero corrigido: ponto sem predição = null (inválido, excluído da média)
//   • Acurácia (centroide→alvo) reportada separada da Precisão (RMS intra-ponto)
//   • Modo produção: mede saída cru (modelo) e pós-filtros lado a lado
//   • Distância estimada via IOD (em vez de constante ASSUMED_DIST_PX)
//   • Exportação JSON do relatório e do log de sessão

import { mapGaze, startPreCalibration } from './calibration';
import { exportSessionLog, isSessionLogging } from './sessionLog';

export interface AccuracyResult {
  meanError: number;
  maxError: number;
  errorPct: number;
  meanErrorDeg: number;
  score: string;
  colorClass: string;
  pointErrors: (number | null)[];       // null = ponto inválido (sem predições)
  pointPrecisions: (number | null)[];   // RMS intra-ponto; null = inválido
  meanPrecision: number;
  pointErrorsFiltered: (number | null)[];
  meanErrorFiltered: number;
  validPointCount: number;
  estimatedDistanceCm: number;
}

interface PointDiagnostic {
  groundX: number;
  groundY: number;
  predX: number;
  predY: number;
  error: number | null;
  precision: number | null;
  name: string;
  predFilteredX: number;
  predFilteredY: number;
  errorFiltered: number | null;
  sampleCount: number;
}

const VALIDATION_POINTS = [
  { name: "Superior Esq",    screenX: 0.10, screenY: 0.10 },
  { name: "Superior Centro", screenX: 0.50, screenY: 0.10 },
  { name: "Superior Dir",    screenX: 0.90, screenY: 0.10 },
  { name: "Médio Esq",       screenX: 0.10, screenY: 0.50 },
  { name: "Centro",          screenX: 0.50, screenY: 0.50 },
  { name: "Médio Dir",       screenX: 0.90, screenY: 0.50 },
  { name: "Inferior Esq",    screenX: 0.10, screenY: 0.90 },
  { name: "Inferior Centro", screenX: 0.50, screenY: 0.90 },
  { name: "Inferior Dir",    screenX: 0.90, screenY: 0.90 },
];

const COLLECTION_MS = 1000;

// IOD de referência a 60cm → distância equivalente ao antigo ASSUMED_DIST_PX (2268px a 96DPI)
// distancePx = DIST_PX_AT_REF * IOD_REF / rawIod  →  se rawIod=IOD_REF, resultado = 2268px
const IOD_REF = 0.08;
const DIST_PX_AT_REF = 2268;

let currentFeaturesLeft: number[] = [];
let currentFeaturesRight: number[] = [];
let currentFilteredX = 0;
let currentFilteredY = 0;
let currentIod = IOD_REF;

export let isAccuracyTesting = false;

export function feedAccuracyRaw(featuresLeft: number[], featuresRight: number[]): void {
  currentFeaturesLeft = featuresLeft;
  currentFeaturesRight = featuresRight;
}

export function feedAccuracyFiltered(x: number, y: number): void {
  currentFilteredX = x;
  currentFilteredY = y;
}

export function feedAccuracyIod(iod: number): void {
  if (iod > 0.01 && iod < 0.5) currentIod = iod;
}

export function startAccuracyTest(onComplete: (result: AccuracyResult) => void): void {
  isAccuracyTesting = true;
  const overlay = createAccuracyOverlay();
  let pointIndex = 0;
  const pointErrors: (number | null)[] = [];
  const pointPrecisions: (number | null)[] = [];
  const pointErrorsFiltered: (number | null)[] = [];
  const diagnostics: PointDiagnostic[] = [];
  const allIodSamples: number[] = [];

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  function runNextPoint(): void {
    if (pointIndex >= VALIDATION_POINTS.length) {
      isAccuracyTesting = false;
      finishTest(overlay, pointErrors, pointPrecisions, pointErrorsFiltered, diagnostics, allIodSamples, onComplete);
      return;
    }

    const vp = VALIDATION_POINTS[pointIndex];
    showValidationDot(overlay, vp, pointIndex);

    const startTime = performance.now();
    const rawX: number[] = [];
    const rawY: number[] = [];
    const filtX: number[] = [];
    const filtY: number[] = [];

    const targetScreenX = vp.screenX * vw;
    const targetScreenY = vp.screenY * vh;

    function collect(): void {
      const elapsed = performance.now() - startTime;

      const gaze = mapGaze(currentFeaturesLeft, currentFeaturesRight);
      if (gaze) {
        rawX.push(gaze.x);
        rawY.push(gaze.y);
      }
      filtX.push(currentFilteredX);
      filtY.push(currentFilteredY);
      if (currentIod > 0.01) allIodSamples.push(currentIod);

      if (elapsed < COLLECTION_MS) {
        requestAnimationFrame(collect);
        return;
      }

      // Acurácia e Precisão do stream cru
      let accuracy: number | null = null;
      let precision: number | null = null;
      let centroidX = targetScreenX;
      let centroidY = targetScreenY;

      if (rawX.length > 0) {
        centroidX = rawX.reduce((s, v) => s + v, 0) / rawX.length;
        centroidY = rawY.reduce((s, v) => s + v, 0) / rawY.length;
        const dx = centroidX - targetScreenX;
        const dy = centroidY - targetScreenY;
        accuracy = Math.sqrt(dx * dx + dy * dy);

        let ssq = 0;
        for (let i = 0; i < rawX.length; i++) {
          ssq += (rawX[i] - centroidX) ** 2 + (rawY[i] - centroidY) ** 2;
        }
        precision = Math.sqrt(ssq / rawX.length);
      }
      // Se rawX.length === 0: accuracy e precision ficam null (ponto inválido)

      // Acurácia do stream filtrado
      let filtAccuracy: number | null = null;
      let centroidFX = targetScreenX;
      let centroidFY = targetScreenY;
      if (filtX.length > 0) {
        centroidFX = filtX.reduce((s, v) => s + v, 0) / filtX.length;
        centroidFY = filtY.reduce((s, v) => s + v, 0) / filtY.length;
        const dx = centroidFX - targetScreenX;
        const dy = centroidFY - targetScreenY;
        filtAccuracy = Math.sqrt(dx * dx + dy * dy);
      }

      pointErrors.push(accuracy);
      pointPrecisions.push(precision);
      pointErrorsFiltered.push(filtAccuracy);
      diagnostics.push({
        groundX: targetScreenX, groundY: targetScreenY,
        predX: centroidX, predY: centroidY,
        error: accuracy, precision, name: vp.name,
        predFilteredX: centroidFX, predFilteredY: centroidFY,
        errorFiltered: filtAccuracy, sampleCount: rawX.length,
      });

      pointIndex++;
      setTimeout(runNextPoint, 300);
    }

    requestAnimationFrame(collect);
  }

  setTimeout(runNextPoint, 500);
}

function createAccuracyOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = "accuracy-overlay";
  overlay.className = "accuracy-overlay";
  overlay.innerHTML = `
    <div class="accuracy-instruction">
      Teste de Precisão — olhe para cada ponto
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showValidationDot(
  overlay: HTMLDivElement,
  vp: { name: string; screenX: number; screenY: number },
  index: number
): void {
  const old = document.getElementById("accuracy-dot");
  if (old) old.remove();

  const dot = document.createElement("div");
  dot.id = "accuracy-dot";
  dot.className = "accuracy-dot";
  dot.style.left = `${vp.screenX * 100}vw`;
  dot.style.top = `${vp.screenY * 100}vh`;
  dot.innerHTML = `<div class="dot-inner"></div>`;

  const instr = overlay.querySelector(".accuracy-instruction") as HTMLElement;
  if (instr) {
    instr.innerHTML = `Teste de Precisão &nbsp;<span class="highlight">${index + 1}/${VALIDATION_POINTS.length}</span> — olhe para o ponto`;
  }

  overlay.appendChild(dot);
}

function finishTest(
  overlay: HTMLDivElement,
  pointErrors: (number | null)[],
  pointPrecisions: (number | null)[],
  pointErrorsFiltered: (number | null)[],
  diagnostics: PointDiagnostic[],
  iodSamples: number[],
  onComplete: (result: AccuracyResult) => void
): void {
  overlay.remove();

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // Exclui pontos inválidos (null) de todas as médias
  const validErrors    = pointErrors.filter(e => e !== null) as number[];
  const validPrecisions = pointPrecisions.filter(p => p !== null) as number[];
  const validFiltered  = pointErrorsFiltered.filter(e => e !== null) as number[];

  const meanError         = avg(validErrors);
  const maxError          = validErrors.length > 0 ? Math.max(...validErrors) : 0;
  const meanPrecision     = avg(validPrecisions);
  const meanErrorFiltered = avg(validFiltered);

  const diagonal = Math.sqrt(vw ** 2 + vh ** 2);
  const errorPct = (meanError / diagonal) * 100;

  // Distância estimada via IOD em vez de constante fixa
  const avgIod = iodSamples.length > 0 ? avg(iodSamples) : IOD_REF;
  const distancePx = DIST_PX_AT_REF * IOD_REF / avgIod;
  const distanceCm = +(distancePx * 2.54 / 96).toFixed(1);
  const meanErrorDeg = +(Math.atan(meanError / distancePx) * 180 / Math.PI).toFixed(2);

  let score: string;
  let colorClass: string;
  if (meanError < 30) {
    score = "Excelente"; colorClass = "accuracy-excellent";
  } else if (meanError < 60) {
    score = "Bom";       colorClass = "accuracy-good";
  } else if (meanError < 100) {
    score = "Regular";   colorClass = "accuracy-regular";
  } else {
    score = "Ruim";      colorClass = "accuracy-poor";
  }

  const result: AccuracyResult = {
    meanError, maxError, errorPct, meanErrorDeg, score, colorClass,
    pointErrors, pointPrecisions, meanPrecision,
    pointErrorsFiltered, meanErrorFiltered,
    validPointCount: validErrors.length,
    estimatedDistanceCm: distanceCm,
  };

  try {
    localStorage.setItem("accuracyResult", JSON.stringify({
      meanError, maxError, errorPct, meanErrorDeg, score, colorClass,
      meanPrecision, meanErrorFiltered, estimatedDistanceCm: distanceCm,
    }));
  } catch (_) {}

  showDiagnosticOverlay(diagnostics, result, onComplete);
}

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function showDiagnosticOverlay(
  diagnostics: PointDiagnostic[],
  result: AccuracyResult,
  onComplete: (result: AccuracyResult) => void
): void {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const overlay = document.createElement("div");
  overlay.id = "diagnostic-overlay";
  overlay.className = "diagnostic-overlay";

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(vw));
  svg.setAttribute("height", String(vh));
  svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  svg.classList.add("diagnostic-svg");

  for (const d of diagnostics) {
    // Linha cru (verde sólida)
    const lineRaw = document.createElementNS(svgNS, "line");
    lineRaw.setAttribute("x1", String(d.groundX));
    lineRaw.setAttribute("y1", String(d.groundY));
    lineRaw.setAttribute("x2", String(d.predX));
    lineRaw.setAttribute("y2", String(d.predY));
    lineRaw.setAttribute("stroke", getErrorColor(d.error ?? 999));
    lineRaw.setAttribute("stroke-width", "2");
    lineRaw.setAttribute("stroke-opacity", "0.8");
    svg.appendChild(lineRaw);

    // Linha filtrada (âmbar tracejada)
    if (d.errorFiltered !== null) {
      const lineFilt = document.createElementNS(svgNS, "line");
      lineFilt.setAttribute("x1", String(d.groundX));
      lineFilt.setAttribute("y1", String(d.groundY));
      lineFilt.setAttribute("x2", String(d.predFilteredX));
      lineFilt.setAttribute("y2", String(d.predFilteredY));
      lineFilt.setAttribute("stroke", "#f59e0b");
      lineFilt.setAttribute("stroke-width", "1.5");
      lineFilt.setAttribute("stroke-opacity", "0.5");
      lineFilt.setAttribute("stroke-dasharray", "4,3");
      svg.appendChild(lineFilt);
    }

    // Ponto vermelho — ground truth
    const redDot = document.createElementNS(svgNS, "circle");
    redDot.setAttribute("cx", String(d.groundX));
    redDot.setAttribute("cy", String(d.groundY));
    redDot.setAttribute("r", "7");
    redDot.setAttribute("fill", "#ef4444");
    redDot.setAttribute("stroke", "#fff");
    redDot.setAttribute("stroke-width", "1.5");
    svg.appendChild(redDot);

    // Ponto verde — centroide cru
    if (d.error !== null) {
      const greenDot = document.createElementNS(svgNS, "circle");
      greenDot.setAttribute("cx", String(d.predX));
      greenDot.setAttribute("cy", String(d.predY));
      greenDot.setAttribute("r", "7");
      greenDot.setAttribute("fill", "#22c55e");
      greenDot.setAttribute("stroke", "#fff");
      greenDot.setAttribute("stroke-width", "1.5");
      svg.appendChild(greenDot);
    }

    // Ponto âmbar — centroide filtrado
    if (d.errorFiltered !== null) {
      const amberDot = document.createElementNS(svgNS, "circle");
      amberDot.setAttribute("cx", String(d.predFilteredX));
      amberDot.setAttribute("cy", String(d.predFilteredY));
      amberDot.setAttribute("r", "5");
      amberDot.setAttribute("fill", "#f59e0b");
      amberDot.setAttribute("stroke", "#fff");
      amberDot.setAttribute("stroke-width", "1");
      svg.appendChild(amberDot);
    }

    // Label com erro em pixels
    const labelX = d.groundX + 14;
    const labelY = d.groundY - 14;
    const labelText = d.error !== null ? `${Math.round(d.error)}px` : '—';

    const labelBg = document.createElementNS(svgNS, "rect");
    labelBg.setAttribute("x", String(labelX - 2));
    labelBg.setAttribute("y", String(labelY - 13));
    labelBg.setAttribute("width", String(labelText.length * 7 + 8));
    labelBg.setAttribute("height", "18");
    labelBg.setAttribute("rx", "4");
    labelBg.setAttribute("fill", "rgba(0,0,0,0.7)");
    svg.appendChild(labelBg);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", String(labelX + 2));
    text.setAttribute("y", String(labelY));
    text.setAttribute("fill", getErrorColor(d.error ?? 999));
    text.setAttribute("font-size", "12");
    text.setAttribute("font-family", "Inter, sans-serif");
    text.setAttribute("font-weight", "600");
    text.textContent = labelText;
    svg.appendChild(text);

    // Nome do ponto
    const nameText = document.createElementNS(svgNS, "text");
    nameText.setAttribute("x", String(d.groundX));
    nameText.setAttribute("y", String(d.groundY + 22));
    nameText.setAttribute("fill", "rgba(255,255,255,0.5)");
    nameText.setAttribute("font-size", "10");
    nameText.setAttribute("font-family", "Inter, sans-serif");
    nameText.setAttribute("text-anchor", "middle");
    nameText.textContent = d.name;
    svg.appendChild(nameText);
  }

  overlay.appendChild(svg);

  const footer = document.createElement("div");
  footer.className = "diagnostic-footer";

  const scoreColor = result.colorClass === 'accuracy-excellent' ? '#22c55e'
    : result.colorClass === 'accuracy-good'    ? '#00fff0'
    : result.colorClass === 'accuracy-regular' ? '#ffcc00'
    : '#ef4444';

  footer.innerHTML = `
    <div class="diagnostic-card">
      <div class="diagnostic-title">Calibração Concluída</div>

      <div class="diagnostic-legend">
        <span class="legend-item">
          <span class="legend-dot" style="background:#ef4444"></span>
          Ground truth
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background:#22c55e"></span>
          Cru (modelo)
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background:#f59e0b"></span>
          Filtrado
        </span>
      </div>

      <div class="diagnostic-metrics">
        <div class="metric-item">
          <div class="metric-value" style="color:${scoreColor}">${Math.round(result.meanError)}px</div>
          <div class="metric-label">Acurácia</div>
        </div>
        <div class="metric-divider"></div>
        <div class="metric-item">
          <div class="metric-value" style="color:#60a5fa">${Math.round(result.meanPrecision)}px</div>
          <div class="metric-label">Precisão RMS</div>
        </div>
        <div class="metric-divider"></div>
        <div class="metric-item">
          <div class="metric-value" style="color:#f59e0b">${Math.round(result.meanErrorFiltered)}px</div>
          <div class="metric-label">Filtrado</div>
        </div>
        <div class="metric-divider"></div>
        <div class="metric-item">
          <div class="metric-value" style="color:${scoreColor}">${result.meanErrorDeg}°</div>
          <div class="metric-label">Erro Angular</div>
        </div>
        <div class="metric-divider"></div>
        <div class="metric-item">
          <div class="metric-value" style="color:#a78bfa">${result.estimatedDistanceCm}cm</div>
          <div class="metric-label">Distância Est.</div>
        </div>
        <div class="metric-divider"></div>
        <div class="metric-item">
          <div class="metric-value" style="color:${scoreColor}">${result.score}
            <span style="font-size:0.65rem;opacity:0.55;font-weight:400">&nbsp;${result.validPointCount}/9</span>
          </div>
          <div class="metric-label">Classificação</div>
        </div>
      </div>

      <div class="diagnostic-point-grid">
        ${diagnostics.map(d => `
          <div class="diag-point-card ${d.error === null ? 'diag-invalid' : d.error < 60 ? 'diag-ok' : d.error < 120 ? 'diag-warn' : 'diag-bad'}">
            <div class="diag-point-name">${d.name}</div>
            <div class="diag-point-error">${d.error !== null ? Math.round(d.error) + 'px' : '—'}</div>
            ${d.precision !== null ? `<div class="diag-point-precision">±${Math.round(d.precision)}px</div>` : ''}
            <div class="diag-point-samples">${d.sampleCount}f</div>
          </div>
        `).join('')}
      </div>

      <div class="diagnostic-actions">
        <span>Pressione <kbd>Espaço</kbd> para continuar ou <kbd>R</kbd> para recalibrar</span>
        <div class="diagnostic-export-btns">
          <button class="export-btn" id="export-accuracy-btn">Salvar Relatório</button>
          ${isSessionLogging() ? `<button class="export-btn" id="export-session-btn">Exportar Log de Sessão</button>` : ''}
        </div>
      </div>
    </div>
  `;
  overlay.appendChild(footer);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add("visible"));

  // Botão de relatório de acurácia
  const exportAccBtn = document.getElementById('export-accuracy-btn');
  if (exportAccBtn) {
    exportAccBtn.addEventListener('click', () => downloadAccuracyReport(diagnostics, result));
  }

  // Botão de log de sessão (só aparece se estiver gravando)
  const exportSessBtn = document.getElementById('export-session-btn');
  if (exportSessBtn) {
    exportSessBtn.addEventListener('click', exportSessionLog);
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      e.preventDefault();
      overlay.classList.remove("visible");
      setTimeout(() => {
        overlay.remove();
        document.removeEventListener('keydown', handleKey);
        onComplete(result);
      }, 300);
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      overlay.remove();
      document.removeEventListener('keydown', handleKey);
      onComplete(result);
      startPreCalibration();
    }
  }

  document.addEventListener('keydown', handleKey);
}

function downloadAccuracyReport(diagnostics: PointDiagnostic[], result: AccuracyResult): void {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      meanAccuracy_px:      +result.meanError.toFixed(1),
      meanPrecision_px:     +result.meanPrecision.toFixed(1),
      meanAccuracyFiltered_px: +result.meanErrorFiltered.toFixed(1),
      maxError_px:          +result.maxError.toFixed(1),
      errorPct:             +result.errorPct.toFixed(2),
      meanErrorDeg:         result.meanErrorDeg,
      estimatedDistanceCm:  result.estimatedDistanceCm,
      score:                result.score,
      validPoints:          result.validPointCount,
      totalPoints:          diagnostics.length,
    },
    points: diagnostics.map(d => ({
      name:              d.name,
      groundX:           Math.round(d.groundX),
      groundY:           Math.round(d.groundY),
      rawCentroidX:      Math.round(d.predX),
      rawCentroidY:      Math.round(d.predY),
      accuracy_px:       d.error     !== null ? +d.error.toFixed(1)          : null,
      precision_px:      d.precision !== null ? +d.precision.toFixed(1)       : null,
      filtCentroidX:     Math.round(d.predFilteredX),
      filtCentroidY:     Math.round(d.predFilteredY),
      accuracyFilt_px:   d.errorFiltered !== null ? +d.errorFiltered.toFixed(1) : null,
      sampleCount:       d.sampleCount,
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `irisflow_accuracy_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getErrorColor(error: number): string {
  if (error < 50)  return '#22c55e';
  if (error < 100) return '#ffcc00';
  return '#ef4444';
}
