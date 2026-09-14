/**
 * WebTS.app - Injected USB Mock for Unit Tests
 * License: GPL-2.0-only
 */

import type {
  USBDeviceLike,
  USBConfigurationLike,
  USBInterfaceLike,
  USBAlternateInterfaceLike,
  USBEndpointLike,
  USBConnectionEventLike,
  USBDeviceFilter,
} from '../../src/types/usb';
import type { USBFacade } from '../../src/usb/adapter';

export function createMockEndpoint(
  endpointNumber: number,
  direction: 'in' | 'out',
  type: 'bulk' | 'interrupt' | 'isochronous' = 'bulk',
  packetSize = 512,
): USBEndpointLike {
  return {
    endpointNumber,
    direction,
    type,
    packetSize,
  };
}

export function createMockAlternate(
  alternateSetting: number,
  interfaceClass: number,
  endpoints: USBEndpointLike[] = [],
  interfaceName?: string,
): USBAlternateInterfaceLike {
  return {
    alternateSetting,
    interfaceClass,
    interfaceSubclass: 0,
    interfaceProtocol: 0,
    interfaceName,
    endpoints,
  };
}

export function createMockInterface(
  interfaceNumber: number,
  alternates: USBAlternateInterfaceLike[],
  claimed = false,
): USBInterfaceLike {
  return {
    interfaceNumber,
    alternate: alternates[0],
    alternates,
    claimed,
  };
}

export function createMockConfiguration(
  configurationValue: number,
  interfaces: USBInterfaceLike[],
  configurationName?: string,
): USBConfigurationLike {
  return {
    configurationValue,
    configurationName,
    interfaces,
  };
}

export interface MockDeviceOptions {
  vendorId: number;
  productId: number;
  configurations?: USBConfigurationLike[];
  configuration?: USBConfigurationLike | null;
  opened?: boolean;
  manufacturerName?: string;
  productName?: string;
  serialNumber?: string; // Included in raw mock to verify privacy defense
}

export class MockUSBDevice implements USBDeviceLike {
  public usbVersionMajor = 2;
  public usbVersionMinor = 0;
  public usbVersionSubminor = 0;
  public deviceClass = 0;
  public deviceSubclass = 0;
  public deviceProtocol = 0;
  public vendorId: number;
  public productId: number;
  public deviceVersionMajor = 1;
  public deviceVersionMinor = 0;
  public deviceVersionSubminor = 0;
  public manufacturerName?: string;
  public productName?: string;
  public serialNumber?: string;

  public configuration: USBConfigurationLike | null;
  public configurations: USBConfigurationLike[];
  public opened = false;

  // Spies and flags for test verification
  public openCalled = false;
  public closeCalled = false;
  public selectConfigurationCalls: number[] = [];
  public claimedInterfaces = new Set<number>();
  public releasedInterfaces = new Set<number>();

  // Failure simulation flags
  public failOpenWith: Error | null = null;
  public failCloseWith: Error | null = null;
  public failSelectConfigWith: Error | null = null;
  public failClaimWith: Error | null = null;
  public failReleaseWith: Error | null = null;

  // Forbidden methods spies to guarantee no forbidden USB actions occur
  public controlTransferCalls = 0;
  public transferInCalls = 0;
  public transferOutCalls = 0;

  constructor(options: MockDeviceOptions) {
    this.vendorId = options.vendorId;
    this.productId = options.productId;
    this.configurations = options.configurations ?? [
      createMockConfiguration(1, [
        createMockInterface(0, [createMockAlternate(0, 0xff, [createMockEndpoint(1, 'in')])]),
      ]),
    ];
    this.configuration = options.configuration !== undefined
      ? options.configuration
      : (this.configurations[0] ?? null);
    this.opened = options.opened ?? false;
    this.manufacturerName = options.manufacturerName;
    this.productName = options.productName;
    this.serialNumber = options.serialNumber;
  }

  async open(): Promise<void> {
    if (this.failOpenWith) {
      throw this.failOpenWith;
    }
    this.openCalled = true;
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.failCloseWith) {
      throw this.failCloseWith;
    }
    this.closeCalled = true;
    this.opened = false;
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    if (this.failSelectConfigWith) {
      throw this.failSelectConfigWith;
    }
    this.selectConfigurationCalls.push(configurationValue);
    const target = this.configurations.find((c) => c.configurationValue === configurationValue);
    this.configuration = target ?? null;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    if (this.failClaimWith) {
      throw this.failClaimWith;
    }
    this.claimedInterfaces.add(interfaceNumber);
    const iface = this.configuration?.interfaces.find((i) => i.interfaceNumber === interfaceNumber);
    if (iface) {
      (iface as { claimed: boolean }).claimed = true;
    }
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    if (this.failReleaseWith) {
      throw this.failReleaseWith;
    }
    this.releasedInterfaces.add(interfaceNumber);
    this.claimedInterfaces.delete(interfaceNumber);
    const iface = this.configuration?.interfaces.find((i) => i.interfaceNumber === interfaceNumber);
    if (iface) {
      (iface as { claimed: boolean }).claimed = false;
    }
  }

  // Forbidden methods implementation that tracks violations
  async controlTransferIn(): Promise<never> {
    this.controlTransferCalls++;
    throw new Error('Forbidden M0 action: controlTransferIn');
  }

  async controlTransferOut(): Promise<never> {
    this.controlTransferCalls++;
    throw new Error('Forbidden M0 action: controlTransferOut');
  }

  async transferIn(): Promise<never> {
    this.transferInCalls++;
    throw new Error('Forbidden M0 action: transferIn');
  }

  async transferOut(): Promise<never> {
    this.transferOutCalls++;
    throw new Error('Forbidden M0 action: transferOut');
  }
}

export class MockUSBFacade implements USBFacade {
  public supported = true;
  public nextDeviceToReturn: MockUSBDevice | null = null;
  public requestDeviceError: Error | null = null;
  public lastRequestedFilters: readonly USBDeviceFilter[] | null = null;
  public disconnectListeners = new Set<(event: USBConnectionEventLike) => void>();

  isSupported(): boolean {
    return this.supported;
  }

  async requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<MockUSBDevice> {
    this.lastRequestedFilters = options.filters;
    if (this.requestDeviceError) {
      throw this.requestDeviceError;
    }
    if (!this.nextDeviceToReturn) {
      throw new Error('No device configured in mock');
    }
    return this.nextDeviceToReturn;
  }

  onDisconnect(listener: (event: USBConnectionEventLike) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  triggerDisconnect(device: USBDeviceLike): void {
    for (const listener of this.disconnectListeners) {
      listener({ device });
    }
  }
}
