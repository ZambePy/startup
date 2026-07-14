// OneEuroFilter — filtro adaptativo de baixa latência para rastreamento ocular
//
// Referência: Casiez et al. 2012, "1€ Filter: A Simple Speed-based Low-pass Filter
// for Noisy Input in Interactive Systems"
//
// Parâmetros:
//   mincutoff — frequência de corte mínima (Hz). Menor = mais suave em repouso, mais lag.
//   beta      — coeficiente de velocidade. Maior = mais responsivo em movimentos rápidos.
//   dcutoff   — cutoff da derivada (mantém em 1.0 para olhar)

export class OneEuroFilter {
  private mincutoff: number;
  private beta: number;
  private readonly dcutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(mincutoff = 0.5, beta = 0.007, dcutoff = 1.0) {
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(x: number, timestamp: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestamp;
      return x;
    }

    const dt = Math.max((timestamp - this.tPrev) / 1000, 1e-6); // segundos
    this.tPrev = timestamp;

    // Derivada filtrada (estima velocidade)
    const dx = (x - this.xPrev) / dt;
    const aDx = this.alpha(this.dcutoff, dt);
    const edx = aDx * dx + (1 - aDx) * this.dxPrev;
    this.dxPrev = edx;

    // Cutoff adaptativo: aumenta com a velocidade
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    const a = this.alpha(cutoff, dt);

    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  setParams(mincutoff: number, beta: number): void {
    this.mincutoff = mincutoff;
    this.beta = beta;
  }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(mincutoff = 0.5, beta = 0.007) {
    this.fx = new OneEuroFilter(mincutoff, beta);
    this.fy = new OneEuroFilter(mincutoff, beta);
  }

  filter(x: number, y: number, timestamp: number): { x: number; y: number } {
    return {
      x: this.fx.filter(x, timestamp),
      y: this.fy.filter(y, timestamp),
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  setParams(mincutoff: number, beta: number): void {
    this.fx.setParams(mincutoff, beta);
    this.fy.setParams(mincutoff, beta);
  }
}

// Singleton usado pelo loop principal — parâmetros expostos no painel do terapeuta
export const gazeFilter = new OneEuroFilter2D(0.5, 0.007);

export function setGazeFilterParams(mincutoff: number, beta: number): void {
  gazeFilter.setParams(mincutoff, beta);
}
