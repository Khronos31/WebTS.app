/**
 * WebTS.app - USB Descriptor Sanitization and Formatting
 * License: GPL-2.0-only
 */

import type {
  USBDeviceLike,
  USBConfigurationLike,
  USBInterfaceLike,
  USBAlternateInterfaceLike,
  USBEndpointLike,
  SanitizedDeviceSummary,
  SanitizedConfigurationSummary,
  SanitizedInterfaceSummary,
  SanitizedAlternateSummary,
  SanitizedEndpointSummary,
} from '../types/usb';
import { getDeviceModelInfo } from './filters';
import { evaluateInterfaceClaimability } from './claim-policy';

export const MAX_USB_STRING_LENGTH = 128;

const UNTRUSTED_CONTROL_AND_BIDI_REGEX =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Normalizes untrusted USB string descriptors.
 * - Removes C0/C1 control characters.
 * - Removes Unicode bidi override/isolate controls.
 * - Trims leading and trailing whitespace.
 * - Caps at 128 Unicode code points.
 * - Returns undefined if empty.
 */
export function normalizeUsbString(raw?: string): string | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'string') {
    return undefined;
  }

  // 1. Remove C0/C1 control characters and Unicode bidi override/isolate controls
  const stripped = raw.replace(UNTRUSTED_CONTROL_AND_BIDI_REGEX, '');

  // 2. Trim whitespace
  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // 3. Cap at 128 Unicode code points
  const codePoints = Array.from(trimmed);
  if (codePoints.length > MAX_USB_STRING_LENGTH) {
    return codePoints.slice(0, MAX_USB_STRING_LENGTH).join('');
  }

  return trimmed;
}

export function getUsbClassName(classCode: number): string {
  switch (classCode) {
    case 0x00:
      return 'Device (Interface-defined)';
    case 0x01:
      return 'Audio';
    case 0x02:
      return 'Communications / CDC Control';
    case 0x03:
      return 'HID (Human Interface Device)';
    case 0x05:
      return 'Physical';
    case 0x06:
      return 'Image';
    case 0x07:
      return 'Printer';
    case 0x08:
      return 'Mass Storage';
    case 0x09:
      return 'Hub';
    case 0x0a:
      return 'CDC-Data';
    case 0x0b:
      return 'Smart Card / CCID';
    case 0x0e:
      return 'Video';
    case 0x0f:
      return 'Personal Healthcare';
    case 0x10:
      return 'Audio/Video';
    case 0xdc:
      return 'Diagnostic Device';
    case 0xe0:
      return 'Wireless Controller';
    case 0xef:
      return 'Miscellaneous';
    case 0xfe:
      return 'Application Specific';
    case 0xff:
      return 'Vendor Specific';
    default:
      return `Unknown (0x${classCode.toString(16).padStart(2, '0')})`;
  }
}

export function formatBcdVersion(major: number, minor: number, subminor: number): string {
  return `${major}.${minor}.${subminor}`;
}

export function sanitizeEndpoint(endpoint: USBEndpointLike): SanitizedEndpointSummary {
  return {
    endpointNumber: endpoint.endpointNumber,
    direction: endpoint.direction,
    type: endpoint.type,
    packetSize: endpoint.packetSize,
  };
}

export function sanitizeAlternate(alt: USBAlternateInterfaceLike): SanitizedAlternateSummary {
  const endpoints = (alt.endpoints ?? []).map(sanitizeEndpoint);
  return {
    alternateSetting: alt.alternateSetting,
    interfaceClass: alt.interfaceClass,
    interfaceClassName: getUsbClassName(alt.interfaceClass),
    interfaceSubclass: alt.interfaceSubclass,
    interfaceProtocol: alt.interfaceProtocol,
    interfaceName: normalizeUsbString(alt.interfaceName),
    endpoints: Object.freeze(endpoints),
  };
}

export function sanitizeInterface(iface: USBInterfaceLike): SanitizedInterfaceSummary {
  const alternatesList = iface.alternates && iface.alternates.length > 0
    ? iface.alternates
    : iface.alternate
      ? [iface.alternate]
      : [];

  const sanitizedAlternates = alternatesList.map(sanitizeAlternate);
  const claimEval = evaluateInterfaceClaimability(iface);

  return {
    interfaceNumber: iface.interfaceNumber,
    claimed: Boolean(iface.claimed),
    isClaimable: claimEval.allowed,
    claimDisallowedReason: claimEval.allowed ? undefined : claimEval.reason,
    alternates: Object.freeze(sanitizedAlternates),
  };
}

export function sanitizeConfiguration(
  config: USBConfigurationLike,
  activeConfigValue: number | null,
): SanitizedConfigurationSummary {
  const interfaces = (config.interfaces ?? []).map(sanitizeInterface);
  return {
    configurationValue: config.configurationValue,
    configurationName: normalizeUsbString(config.configurationName),
    isSelected: activeConfigValue === config.configurationValue,
    interfaces: Object.freeze(interfaces),
  };
}

/**
 * Creates a strictly sanitized summary of a USB device.
 * PRIVACY CONTRACT:
 * - Never accesses, reads, or returns device.serialNumber.
 * - Never logs or accesses raw USB payloads.
 */
export function sanitizeDeviceSummary(device: USBDeviceLike): SanitizedDeviceSummary {
  const modelInfo = getDeviceModelInfo(device.vendorId, device.productId);
  const activeConfigValue = device.configuration?.configurationValue ?? null;

  const configurations = (device.configurations ?? []).map((cfg) =>
    sanitizeConfiguration(cfg, activeConfigValue)
  );

  const summary: SanitizedDeviceSummary = {
    knownModelLabel: modelInfo.label,
    vendorId: device.vendorId,
    productId: device.productId,
    vendorIdHex: `0x${device.vendorId.toString(16).padStart(4, '0')}`,
    productIdHex: `0x${device.productId.toString(16).padStart(4, '0')}`,
    usbVersion: formatBcdVersion(device.usbVersionMajor, device.usbVersionMinor, device.usbVersionSubminor),
    deviceVersion: formatBcdVersion(device.deviceVersionMajor, device.deviceVersionMinor, device.deviceVersionSubminor),
    deviceClass: device.deviceClass,
    deviceClassName: getUsbClassName(device.deviceClass),
    deviceSubclass: device.deviceSubclass,
    deviceProtocol: device.deviceProtocol,
    manufacturerName: normalizeUsbString(device.manufacturerName),
    productName: normalizeUsbString(device.productName),
    opened: Boolean(device.opened),
    activeConfigurationValue: activeConfigValue,
    configurations: Object.freeze(configurations),
  };

  return Object.freeze(summary);
}
