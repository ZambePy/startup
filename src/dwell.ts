// Dwell time para seleção por fixação do olhar (Sprint 2 — G1/G2)
//
// A detecção de piscada foi migrada para blinkDetector.ts (máquina de estados).
// Este módulo cuida exclusivamente do dwell: cursor parado por DWELL_TIME_MS → evento.

export interface DwellEvent {
  type: 'dwell';
  x: number;
  y: number;
}

export const DWELL_RADIUS_PX = 40;   // px — configurável pelo terapeuta
export const DWELL_TIME_MS   = 800;  // ms — configurável pelo terapeuta

let anchorX    = -1;
let anchorY    = -1;
let dwellStart = 0;
let dwellFired = false;

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function updateDwell(
  gazeX: number,
  gazeY: number,
  onEvent: (e: DwellEvent) => void
): void {
  if (anchorX < 0) {
    anchorX    = gazeX;
    anchorY    = gazeY;
    dwellStart = performance.now();
    dwellFired = false;
    return;
  }

  if (dist2(gazeX, gazeY, anchorX, anchorY) <= DWELL_RADIUS_PX) {
    if (!dwellFired && performance.now() - dwellStart >= DWELL_TIME_MS) {
      onEvent({ type: 'dwell', x: anchorX, y: anchorY });
      dwellFired = true;
    }
  } else {
    anchorX    = gazeX;
    anchorY    = gazeY;
    dwellStart = performance.now();
    dwellFired = false;
  }
}

export function resetDwell(): void {
  anchorX    = -1;
  anchorY    = -1;
  dwellFired = false;
}
