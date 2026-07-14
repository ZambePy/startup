// BlinkDetector — máquina de estados para detecção de piscada intencional
//
// Estados: OPEN → CLOSING → CLOSED(n) → OPENING → OPEN
//
// Saídas:
//   suppressGaze    — congela a predição no último valor válido (cursor não move)
//   intentionalBlink — fechamento confirmado (≥MIN_FRAMES e ≤MAX_FRAMES) → dispara seleção
//
// O frame NUNCA é descartado do loop; apenas a atualização do cursor é suprimida.

export type BlinkState = 'OPEN' | 'CLOSING' | 'CLOSED' | 'OPENING';

export interface BlinkResult {
  suppressGaze: boolean;
  intentionalBlink: boolean;
  state: BlinkState;
  ear: number;
}

// A 30fps: MIN=3 frames≈100ms (piscada mínima), MAX=12≈400ms (piscada longa)
const MIN_CLOSING_FRAMES     = 2;   // frames consecutivos para confirmar fechamento
const MIN_INTENTIONAL_FRAMES = 3;   // fechamento total mínimo para seleção
const MAX_INTENTIONAL_FRAMES = 12;  // acima disso = involuntário (olhos fechados)
const COOLDOWN_FRAMES        = 18;  // ≈600ms entre disparos (~2 piscadas/s máximo)
const EAR_CLOSE_RATIO        = 0.75; // threshold = baseline × ratio

export class BlinkDetector {
  private state: BlinkState = 'OPEN';
  private closedCount = 0;
  private cooldown = 0;
  private earHistory: number[] = [];
  private readonly HISTORY_LEN = 60;
  private readonly MIN_HISTORY = 20;

  update(ear: number): BlinkResult {
    // Histórico adaptativo para threshold relativo
    this.earHistory.push(ear);
    if (this.earHistory.length > this.HISTORY_LEN) this.earHistory.shift();

    let threshold = 0.18; // fallback absoluto
    if (this.earHistory.length >= this.MIN_HISTORY) {
      const mean = this.earHistory.reduce((a, b) => a + b, 0) / this.earHistory.length;
      threshold = mean * EAR_CLOSE_RATIO;
    }

    const eyesClosed = ear < threshold;
    let intentionalBlink = false;

    if (this.cooldown > 0) {
      this.cooldown--;
      return { suppressGaze: this.state !== 'OPEN', intentionalBlink: false, state: this.state, ear };
    }

    switch (this.state) {
      case 'OPEN':
        if (eyesClosed) {
          this.state = 'CLOSING';
          this.closedCount = 1;
        }
        break;

      case 'CLOSING':
        if (eyesClosed) {
          this.closedCount++;
          if (this.closedCount >= MIN_CLOSING_FRAMES) {
            this.state = 'CLOSED';
          }
        } else {
          // Ruído — fechamento muito breve, volta para aberto
          this.state = 'OPEN';
          this.closedCount = 0;
        }
        break;

      case 'CLOSED':
        if (eyesClosed) {
          this.closedCount++;
          // Olhos fechados por muito tempo → não considera intencional
        } else {
          // Olhos abrindo — avalia se foi piscada intencional
          if (
            this.closedCount >= MIN_INTENTIONAL_FRAMES &&
            this.closedCount <= MAX_INTENTIONAL_FRAMES
          ) {
            intentionalBlink = true;
            this.cooldown = COOLDOWN_FRAMES;
          }
          this.state = 'OPENING';
        }
        break;

      case 'OPENING':
        if (!eyesClosed) {
          this.state = 'OPEN';
          this.closedCount = 0;
        } else {
          // Voltou a fechar antes de estabilizar
          this.state = 'CLOSED';
        }
        break;
    }

    return {
      suppressGaze: this.state !== 'OPEN',
      intentionalBlink,
      state: this.state,
      ear,
    };
  }

  reset(): void {
    this.state = 'OPEN';
    this.closedCount = 0;
    this.cooldown = 0;
    this.earHistory = [];
  }
}

// Singleton compartilhado com o loop principal
export const blinkDetector = new BlinkDetector();
