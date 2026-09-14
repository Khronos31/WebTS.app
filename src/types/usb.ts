/**
 * WebTS.app - USB and Diagnostic Type Definitions
 * License: GPL-2.0-only
 */

export type USBTransferDirection = 'in' | 'out';
export type USBEndpointType = 'bulk' | 'interrupt' | 'isochronous';

export interface USBEndpointLike {
  readonly endpointNumber: number;
  readonly direction: USBTransferDirection;
  readonly type: USBEndpointType;
  readonly packetSize: number;
}

export interface USBAlternateInterfaceLike {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string;
  readonly endpoints: readonly USBEndpointLike[];
}

export interface USBInterfaceLike {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterfaceLike;
  readonly alternates: readonly USBAlternateInterfaceLike[];
  readonly claimed: boolean;
}

export interface USBConfigurationLike {
  readonly configurationValue: number;
  readonly configurationName?: string;
  readonly interfaces: readonly USBInterfaceLike[];
}

export interface USBDeviceFilter {
  readonly vendorId: number;
  readonly productId?: number;
  readonly classCode?: number;
  readonly subclassCode?: number;
  readonly protocolCode?: number;
  readonly serialNumber?: string;
}

export interface USBDeviceLike {
  readonly usbVersionMajor: number;
  readonly usbVersionMinor: number;
  readonly usbVersionSubminor: number;
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
  readonly manufacturerName?: string;
  readonly productName?: string;
  // NOTE: serialNumber is deliberately excluded from access to comply with privacy requirements
  readonly configuration?: USBConfigurationLike | null;
  readonly configurations: readonly USBConfigurationLike[];
  readonly opened: boolean;

  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
}

export interface USBConnectionEventLike {
  readonly device: USBDeviceLike;
}

export interface USBLike {
  requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<USBDeviceLike>;
  getDevices?(): Promise<USBDeviceLike[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: USBConnectionEventLike) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: USBConnectionEventLike) => void,
  ): void;
}

export interface SanitizedEndpointSummary {
  readonly endpointNumber: number;
  readonly direction: USBTransferDirection;
  readonly type: USBEndpointType;
  readonly packetSize: number;
}

export interface SanitizedAlternateSummary {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceClassName: string;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string;
  readonly endpoints: readonly SanitizedEndpointSummary[];
}

export interface SanitizedInterfaceSummary {
  readonly interfaceNumber: number;
  readonly claimed: boolean;
  readonly isClaimable: boolean;
  readonly claimDisallowedReason?: string;
  readonly alternates: readonly SanitizedAlternateSummary[];
}

export interface SanitizedConfigurationSummary {
  readonly configurationValue: number;
  readonly configurationName?: string;
  readonly isSelected: boolean;
  readonly interfaces: readonly SanitizedInterfaceSummary[];
}

export interface SanitizedDeviceSummary {
  readonly knownModelLabel: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly vendorIdHex: string;
  readonly productIdHex: string;
  readonly usbVersion: string;
  readonly deviceVersion: string;
  readonly deviceClass: number;
  readonly deviceClassName: string;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly opened: boolean;
  readonly activeConfigurationValue: number | null;
  readonly configurations: readonly SanitizedConfigurationSummary[];
}

export type AdapterState =
  | 'UNSUPPORTED'
  | 'IDLE'
  | 'DEVICE_SELECTED'
  | 'OPENED_NO_CONFIG'
  | 'OPENED'
  | 'CLOSED'
  | 'DISCONNECTED';

export type DiagnosticLevel = 'info' | 'success' | 'warn' | 'error';

export type DiagnosticCode =
  | 'USER_CANCELLED'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED_BROWSER'
  | 'OPEN_FAILED'
  | 'CLOSE_FAILED'
  | 'CONFIGURATION_FAILED'
  | 'CLAIM_FAILED'
  | 'CLAIM_DISALLOWED'
  | 'RELEASE_FAILED'
  | 'DISCONNECT'
  | 'SUCCESS'
  | 'STATE_CHANGE'
  | 'BUSY_ERROR';

export interface DiagnosticEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: DiagnosticLevel;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly details?: Record<string, string | number | boolean>;
}
