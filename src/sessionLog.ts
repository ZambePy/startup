export interface FrameLog {
  t: number;
  featuresLeft: number[];
  featuresRight: number[];
  predRaw: { x: number; y: number } | null;
  predFiltered: { x: number; y: number };
  ear: number;
  blinkDetected: boolean;
  keyboardVisible: boolean;
  inAccuracyTest: boolean;
}

interface SessionLog {
  sessionId: string;
  startTime: string;
  frames: FrameLog[];
}

let _log: SessionLog | null = null;
let _active = false;
const _t0 = performance.now();

export function isSessionLogging(): boolean {
  return _active;
}

export function toggleSessionLog(): boolean {
  if (!_active) {
    _log = {
      sessionId: `irisflow_${Date.now()}`,
      startTime: new Date().toISOString(),
      frames: [],
    };
    _active = true;
  } else {
    _active = false;
  }
  return _active;
}

export function logFrame(frame: Omit<FrameLog, 't'>): void {
  if (!_active || !_log) return;
  _log.frames.push({ t: +(performance.now() - _t0).toFixed(1), ...frame });
}

export function exportSessionLog(): void {
  if (!_log || _log.frames.length === 0) {
    alert('Nenhum frame gravado. Pressione L para iniciar e depois E para exportar.');
    return;
  }
  const blob = new Blob([JSON.stringify(_log)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_log.sessionId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
