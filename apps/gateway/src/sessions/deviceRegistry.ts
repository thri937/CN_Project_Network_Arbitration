import crypto from 'node:crypto';
import { BoundDevice, SliceCatalogueItem } from '@cn/shared';

export interface DeviceRecord extends BoundDevice {
  sliceName: string;
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceRecord>();
  private sliceCatalogue = new Map<string, SliceCatalogueItem>();
  private joinCodeToSlice = new Map<string, string>(); // joinCode -> sliceCode
  private timeoutMs: number;

  constructor(timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
  }

  public setCatalogue(slices: SliceCatalogueItem[]): void {
    this.sliceCatalogue.clear();
    this.joinCodeToSlice.clear();

    for (const s of slices) {
      this.sliceCatalogue.set(s.code, s);
      if (s.joinCode) {
        this.joinCodeToSlice.set(s.joinCode.toUpperCase(), s.code);
      }
    }
  }

  public getSliceByCode(sliceCode: string): SliceCatalogueItem | undefined {
    return this.sliceCatalogue.get(sliceCode);
  }

  public getAllSlices(): SliceCatalogueItem[] {
    return Array.from(this.sliceCatalogue.values());
  }

  public getSliceByJoinCode(joinCode: string): SliceCatalogueItem | undefined {
    const code = this.joinCodeToSlice.get(joinCode.trim().toUpperCase());
    if (!code) return undefined;
    return this.sliceCatalogue.get(code);
  }

  public updateJoinCode(sliceCode: string, newCode: string): void {
    const slice = this.sliceCatalogue.get(sliceCode);
    if (!slice) return;

    // remove old
    for (const [k, v] of this.joinCodeToSlice.entries()) {
      if (v === sliceCode) {
        this.joinCodeToSlice.delete(k);
      }
    }

    slice.joinCode = newCode.toUpperCase();
    this.joinCodeToSlice.set(newCode.toUpperCase(), sliceCode);
  }

  public registerDevice(
    joinCode: string,
    nickname: string,
    sourceIp: string,
    userAgent?: string
  ): { deviceId: string; slice: SliceCatalogueItem } | null {
    const slice = this.getSliceByJoinCode(joinCode);
    if (!slice) return null;

    const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
    const record: DeviceRecord = {
      deviceId,
      nickname: nickname.trim(),
      sourceIp,
      sliceCode: slice.code,
      sliceName: slice.name,
      userAgent,
      lastSeenMs: Date.now(),
      activeRateKbps: 0,
      mode: 'local',
      operatorControlEnabled: false,
    };

    this.devices.set(deviceId, record);
    return { deviceId, slice };
  }

  public touchDevice(deviceId: string): DeviceRecord | undefined {
    const dev = this.devices.get(deviceId);
    if (dev) {
      dev.lastSeenMs = Date.now();
    }
    return dev;
  }

  public getDevice(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  public getDeviceByIp(ip: string): DeviceRecord | undefined {
    const now = Date.now();
    for (const dev of this.devices.values()) {
      if (dev.sourceIp === ip && now - dev.lastSeenMs <= this.timeoutMs) {
        return dev;
      }
    }
    return undefined;
  }

  public removeDevice(deviceId: string): boolean {
    return this.devices.delete(deviceId);
  }

  public updateDeviceRate(deviceId: string, rateKbps: number, mode?: 'local' | 'internet'): void {
    const dev = this.devices.get(deviceId);
    if (dev) {
      dev.activeRateKbps = rateKbps;
      if (mode) dev.mode = mode;
      dev.lastSeenMs = Date.now();
    }
  }

  public setOperatorControl(deviceId: string, enabled: boolean): void {
    const dev = this.devices.get(deviceId);
    if (dev) {
      dev.operatorControlEnabled = enabled;
      dev.lastSeenMs = Date.now();
    }
  }

  /**
   * Returns all devices that have sent activity within timeoutMs
   */
  public getActiveDevices(now = Date.now()): DeviceRecord[] {
    const active: DeviceRecord[] = [];
    for (const dev of this.devices.values()) {
      if (now - dev.lastSeenMs <= this.timeoutMs) {
        active.push(dev);
      }
    }
    return active;
  }

  public getActiveDevicesForSlice(sliceCode: string, now = Date.now()): DeviceRecord[] {
    return this.getActiveDevices(now).filter((d) => d.sliceCode === sliceCode);
  }

  public getAllDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  /**
   * Purge devices older than 5 minutes
   */
  public sweepStale(now = Date.now()): void {
    for (const [id, dev] of this.devices.entries()) {
      if (now - dev.lastSeenMs > 300000) {
        this.devices.delete(id);
      }
    }
  }
}
