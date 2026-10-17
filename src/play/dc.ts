/** The Game Boy's output has a DC offset that the hardware's capacitor removes. A one-pole high-pass at 20 Hz does
 * the same here without colouring the sound. Takes binjgb's unsigned 8-bit samples, one channel, and returns
 * samples within ±1: binjgb's full scale is 240, and centred the output stays within ±240. */
export class DcFilter {
  private readonly r: number;
  private x0: number | undefined;
  private y = 0;

  constructor(sampleRate: number) {
    this.r = Math.exp((-2 * Math.PI * 20) / sampleRate);
  }

  next(x: number): number {
    this.y = x - (this.x0 ?? x) + this.r * this.y;
    this.x0 = x;
    return this.y / 240;
  }
}
