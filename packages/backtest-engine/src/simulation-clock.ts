import { unixMs, type UnixMs } from "@ulte/instrument-model";

export class SimulationClock {
  private time: UnixMs | undefined;

  constructor(initialTime?: UnixMs) {
    if (initialTime !== undefined) this.time = unixMs(initialTime);
  }

  get currentTime(): UnixMs | undefined {
    return this.time;
  }

  advanceTo(time: UnixMs): void {
    const next = unixMs(time);
    if (this.time !== undefined && next < this.time) {
      throw new RangeError(`Simulation time cannot move backwards from ${this.time} to ${next}`);
    }
    this.time = next;
  }
}
