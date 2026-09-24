const WINDOW_MS = 3_000;
type Sample = { at: number; bytes: number };

export class UploadRate {
  private samples: Sample[];

  constructor(now = performance.now()) {
    this.samples = [{ at: now, bytes: 0 }];
  }

  sample(bytes: number, now = performance.now()): number | null {
    const last = this.samples[this.samples.length - 1];
    if (now <= last.at) return null;
    this.samples.push({ at: now, bytes });
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].at <= cutoff) this.samples.shift();
    const first = this.samples[0];
    return Math.max(0, bytes - first.bytes) * 1_000 / (now - first.at);
  }
}
