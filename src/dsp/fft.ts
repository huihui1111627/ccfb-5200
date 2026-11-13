// Iterative radix-2 in-place FFT. Length must be a power of two.
// Inputs are separate real/imag arrays; callers reuse them across frames.

export class FFT {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0 || size < 2) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    const stages = Math.log2(size);
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      const angle = (-2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let s = 0; s < stages; s++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** In-place transform. re/im length === size. */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    // Bit-reversal permutation.
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        let k = 0;
        for (let j = 0; j < half; j++, k += step) {
          const wr = this.cos[k];
          const wi = this.sin[k];
          const a = start + j;
          const b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}
