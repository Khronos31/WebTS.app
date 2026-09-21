// WebUSB の最小型定義。@types を増やさず、実際に使うものだけを書く。
//
// USBDevice.serialNumber は上流の grouping (px4::userland::group_q3u4_devices)
// が base_serial と dev_id を取り出すために必要なので宣言している。
// 読み取ってよいのは ABI へ渡すためだけで、表示・記録・送信はしない。

interface USBDeviceFilter {
  readonly vendorId?: number;
  readonly productId?: number;
  readonly classCode?: number;
  readonly subclassCode?: number;
  readonly protocolCode?: number;
}

interface USBDeviceRequestOptions {
  readonly filters: readonly USBDeviceFilter[];
  readonly exclusionFilters?: readonly USBDeviceFilter[];
}

interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: 'in' | 'out';
  readonly type: 'bulk' | 'interrupt' | 'isochronous';
  readonly packetSize: number;
}

interface USBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string;
  readonly endpoints: readonly USBEndpoint[];
}

interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterface;
  readonly alternates: readonly USBAlternateInterface[];
  readonly claimed: boolean;
}

interface USBConfiguration {
  readonly configurationValue: number;
  readonly configurationName?: string;
  readonly interfaces: readonly USBInterface[];
}

interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly usbVersionMajor: number;
  readonly usbVersionMinor: number;
  readonly usbVersionSubminor: number;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
  readonly manufacturerName?: string;
  readonly productName?: string;
  /** 上流 grouping へ渡す用途に限る。表示・記録・送信しない。 */
  readonly serialNumber?: string;
  readonly opened: boolean;
  readonly configuration: USBConfiguration | null;
  readonly configurations: readonly USBConfiguration[];
}

interface USBConnectionEvent extends Event {
  readonly device: USBDevice;
}

interface USB extends EventTarget {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
  onconnect: ((event: USBConnectionEvent) => void) | null;
  ondisconnect: ((event: USBConnectionEvent) => void) | null;
}

interface Navigator {
  readonly usb: USB;
}

interface WorkerNavigator {
  readonly usb: USB;
}
