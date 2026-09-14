import { describe, it, expect, beforeEach } from 'vitest';
import { WebUSBAdapter } from '../src/usb/adapter';
import {
  MockUSBFacade,
  MockUSBDevice,
  createMockConfiguration,
  createMockInterface,
  createMockAlternate,
  createMockEndpoint,
} from './mocks/usb-mock';
import { SUPPORTED_DEVICE_FILTERS } from '../src/usb/filters';

describe('WebUSBAdapter State Machine and Flow', () => {
  let mockFacade: MockUSBFacade;

  beforeEach(() => {
    mockFacade = new MockUSBFacade();
  });

  it('enters UNSUPPORTED state when WebUSB is unavailable', () => {
    mockFacade.supported = false;
    const adapter = new WebUSBAdapter(mockFacade);

    expect(adapter.getState()).toBe('UNSUPPORTED');
    const diagnostics = adapter.getDiagnostics();
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_BROWSER')).toBe(true);

    adapter.destroy();
  });

  it('enters IDLE state when WebUSB is available', () => {
    mockFacade.supported = true;
    const adapter = new WebUSBAdapter(mockFacade);

    expect(adapter.getState()).toBe('IDLE');
    adapter.destroy();
  });

  it('passes exact filters to requestDevice and records USER_CANCELLED on cancel', async () => {
    const adapter = new WebUSBAdapter(mockFacade);

    const cancelError = new Error('No device selected');
    cancelError.name = 'NotFoundError';
    mockFacade.requestDeviceError = cancelError;

    const result = await adapter.requestDevice();
    expect(result).toBe(false);
    expect(adapter.getState()).toBe('IDLE');
    expect(mockFacade.lastRequestedFilters).toEqual(SUPPORTED_DEVICE_FILTERS);

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('USER_CANCELLED');

    adapter.destroy();
  });

  it('records PERMISSION_DENIED on security or permission failure', async () => {
    const adapter = new WebUSBAdapter(mockFacade);

    const secError = new Error('Permission denied');
    secError.name = 'SecurityError';
    mockFacade.requestDeviceError = secError;

    const result = await adapter.requestDevice();
    expect(result).toBe(false);
    expect(adapter.getState()).toBe('IDLE');

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('PERMISSION_DENIED');

    adapter.destroy();
  });

  it('transitions IDLE -> DEVICE_SELECTED upon device selection without opening automatically', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      opened: false,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    const result = await adapter.requestDevice();
    expect(result).toBe(true);
    expect(adapter.getState()).toBe('DEVICE_SELECTED');
    expect(mockDevice.opened).toBe(false); // Must NOT open automatically

    const summary = adapter.getSanitizedDeviceSummary();
    expect(summary?.knownModelLabel).toContain('PX-Q3U4');
    expect(summary?.opened).toBe(false);

    adapter.destroy();
  });

  it('rejects requestDevice while a current device session exists', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      opened: false,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    const first = await adapter.requestDevice();
    expect(first).toBe(true);
    expect(adapter.getState()).toBe('DEVICE_SELECTED');

    // Attempt second requestDevice without closing
    const second = await adapter.requestDevice();
    expect(second).toBe(false);
    expect(adapter.getState()).toBe('DEVICE_SELECTED');

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('OPEN_FAILED');
    expect(lastDiag.message).toContain('既存のデバイスセッションが存在します');

    adapter.destroy();
  });

  it('opens device as a separate user action and enters OPENED if configuration exists', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      opened: false,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    expect(adapter.getState()).toBe('DEVICE_SELECTED');

    const openResult = await adapter.openDevice();
    expect(openResult).toBe(true);
    expect(mockDevice.opened).toBe(true);
    expect(adapter.getState()).toBe('OPENED');

    adapter.destroy();
  });

  it('transitions to OPENED_NO_CONFIG when configuration is null, and reaches OPENED after selection', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const config1 = createMockConfiguration(1, [
      createMockInterface(0, [createMockAlternate(0, 0xff)]),
    ]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x3275,
      productId: 0x0080,
      configurations: [config1],
      configuration: null, // OS has not selected configuration
      opened: false,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    expect(adapter.getState()).toBe('OPENED_NO_CONFIG');

    // Select configuration 1
    const configResult = await adapter.selectConfiguration(1);
    expect(configResult).toBe(true);
    expect(adapter.getState()).toBe('OPENED');
    expect(mockDevice.selectConfigurationCalls).toEqual([1]);

    adapter.destroy();
  });

  it('validates configurationValue exists before calling device selectConfiguration', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const config1 = createMockConfiguration(1, [
      createMockInterface(0, [createMockAlternate(0, 0xff)]),
    ]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x3275,
      productId: 0x0080,
      configurations: [config1],
      configuration: null,
      opened: false,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    // Configuration 99 does not exist in mockDevice.configurations
    const result = await adapter.selectConfiguration(99);
    expect(result).toBe(false);
    expect(mockDevice.selectConfigurationCalls).toHaveLength(0);

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('CONFIGURATION_FAILED');
    expect(lastDiag.message).toContain('存在しません');

    adapter.destroy();
  });

  it('handles open failure gracefully and remains in DEVICE_SELECTED', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
    });
    mockDevice.failOpenWith = new Error('Device busy by kernel driver');
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    const openResult = await adapter.openDevice();

    expect(openResult).toBe(false);
    expect(adapter.getState()).toBe('DEVICE_SELECTED');

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('OPEN_FAILED');

    adapter.destroy();
  });

  it('allows claiming vendor-specific interface (0xff) and tracks session claimed interfaces', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff, [createMockEndpoint(1, 'in')])]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    expect(adapter.getClaimedInterfaces().size).toBe(0);

    const claimResult = await adapter.claimInterface(0);
    expect(claimResult).toBe(true);
    expect(adapter.getClaimedInterfaces().has(0)).toBe(true);
    expect(mockDevice.claimedInterfaces.has(0)).toBe(true);

    const summary = adapter.getSanitizedDeviceSummary();
    expect(summary?.configurations[0].interfaces[0].claimed).toBe(true);

    adapter.destroy();
  });

  it('strictly denies claiming CCID smart-card interface (0x0b)', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const ifaceCcid = createMockInterface(1, [createMockAlternate(0, 0x0b)]);
    const config = createMockConfiguration(1, [iface0, ifaceCcid]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    const claimResult = await adapter.claimInterface(1);
    expect(claimResult).toBe(false);
    expect(adapter.getClaimedInterfaces().has(1)).toBe(false);
    expect(mockDevice.claimedInterfaces.has(1)).toBe(false);

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('CLAIM_DISALLOWED');
    expect(lastDiag.message).toContain('拒否');

    adapter.destroy();
  });

  it('releases claimed interface explicitly', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);
    expect(adapter.getClaimedInterfaces().has(0)).toBe(true);

    const releaseResult = await adapter.releaseInterface(0);
    expect(releaseResult).toBe(true);
    expect(adapter.getClaimedInterfaces().has(0)).toBe(false);
    expect(mockDevice.releasedInterfaces.has(0)).toBe(true);

    adapter.destroy();
  });

  it('releaseAndClose releases all session claimed interfaces and closes device reaching CLOSED', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const iface1 = createMockInterface(1, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0, iface1]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);
    await adapter.claimInterface(1);

    expect(adapter.getClaimedInterfaces().size).toBe(2);

    const closeResult = await adapter.releaseAndClose();
    expect(closeResult).toBe(true);
    expect(adapter.getState()).toBe('CLOSED');
    expect(adapter.getClaimedInterfaces().size).toBe(0);
    expect(mockDevice.releasedInterfaces.has(0)).toBe(true);
    expect(mockDevice.releasedInterfaces.has(1)).toBe(true);
    expect(mockDevice.closeCalled).toBe(true);

    adapter.destroy();
  });

  it('simulates close failure: does not report CLOSED, preserves active handle and claimed tracking for retry', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);

    // Simulate close failure
    mockDevice.failCloseWith = new Error('USB bus busy');

    const closeResult = await adapter.releaseAndClose();
    expect(closeResult).toBe(false);
    expect(adapter.getState()).toBe('OPENED'); // Must NOT report CLOSED
    expect(adapter.getSanitizedDeviceSummary()).not.toBeNull(); // Must NOT discard handle

    const lastDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(lastDiag.code).toBe('CLOSE_FAILED');

    // Remove close failure and retry
    mockDevice.failCloseWith = null;
    const retryResult = await adapter.releaseAndClose();
    expect(retryResult).toBe(true);
    expect(adapter.getState()).toBe('CLOSED');
    expect(adapter.getSanitizedDeviceSummary()).toBeNull();

    adapter.destroy();
  });

  it('handles release failure when close succeeds: reports CLOSED but returns false and logs failure', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);

    // Interface release fails, but close will succeed
    mockDevice.failReleaseWith = new Error('Release failed');

    const result = await adapter.releaseAndClose();
    expect(result).toBe(false); // Reports failure
    expect(adapter.getState()).toBe('CLOSED'); // CLOSED is reached because device.close succeeded
    expect(adapter.getDiagnostics().some((d) => d.code === 'RELEASE_FAILED')).toBe(true);

    adapter.destroy();
  });

  it('reset() awaits cleanup and only returns to IDLE on success', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);

    // Normal reset succeeds
    const resetResult = await adapter.reset();
    expect(resetResult).toBe(true);
    expect(adapter.getState()).toBe('IDLE');
    expect(mockDevice.releasedInterfaces.has(0)).toBe(true);
    expect(mockDevice.closeCalled).toBe(true);
    expect(adapter.getSanitizedDeviceSummary()).toBeNull();

    adapter.destroy();
  });

  it('reset() when close fails preserves handle, does not enter IDLE, and emits CLOSE_FAILED state-preserved', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);

    // Simulate close failure
    mockDevice.failCloseWith = new Error('Hardware lock');

    const failedReset = await adapter.reset();
    expect(failedReset).toBe(false);
    expect(adapter.getState()).toBe('OPENED'); // State preserved
    expect(adapter.getSanitizedDeviceSummary()).not.toBeNull(); // Handle preserved

    const closeFailedDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(closeFailedDiag.code).toBe('CLOSE_FAILED');
    expect(closeFailedDiag.message).toContain('デバイス状態を維持します');

    adapter.destroy();
  });

  it('reset() after release failure but successful close cleanly returns to IDLE without emitting false CLOSE_FAILED state-preserved', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);

    // Interface release fails, but device close will succeed
    mockDevice.failReleaseWith = new Error('Release busy');
    mockDevice.failCloseWith = null;

    const resetResult = await adapter.reset();
    expect(resetResult).toBe(true);
    expect(adapter.getState()).toBe('IDLE');
    expect(adapter.getSanitizedDeviceSummary()).toBeNull(); // Device closed and discarded

    const diagnostics = adapter.getDiagnostics();
    // Must NOT have CLOSE_FAILED diagnostic stating state is preserved
    const falseCloseFailed = diagnostics.find(
      (d) => d.code === 'CLOSE_FAILED' && d.message.includes('維持します'),
    );
    expect(falseCloseFailed).toBeUndefined();

    // Must have RELEASE_FAILED diagnostic reporting partial release before closing
    expect(diagnostics.some((d) => d.code === 'RELEASE_FAILED')).toBe(true);

    adapter.destroy();
  });

  it('handles physical disconnect racing while claimInterface is pending (ends DISCONNECTED, no claimed interfaces, no success diag)', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    let resolveClaim!: () => void;
    const delayedClaim = new Promise<void>((resolve) => {
      resolveClaim = resolve;
    });

    const origClaim = mockDevice.claimInterface.bind(mockDevice);
    mockDevice.claimInterface = async (num) => {
      await delayedClaim;
      return origClaim(num);
    };

    // Start claimInterface (holds pending)
    const claimPromise = adapter.claimInterface(0);
    expect(adapter.isBusy()).toBe(true);

    // Physical disconnect occurs during await
    mockFacade.triggerDisconnect(mockDevice);
    expect(adapter.getState()).toBe('DISCONNECTED');

    // Claim resolves afterwards
    resolveClaim();
    const claimResult = await claimPromise;

    expect(claimResult).toBe(false);
    expect(adapter.getState()).toBe('DISCONNECTED');
    expect(adapter.getClaimedInterfaces().size).toBe(0);
    expect(adapter.getSanitizedDeviceSummary()).toBeNull();

    // Verify NO SUCCESS diagnostic was logged for the claim
    const claimSuccess = adapter.getDiagnostics().find(
      (d) => d.code === 'SUCCESS' && d.message.includes('claim'),
    );
    expect(claimSuccess).toBeUndefined();

    adapter.destroy();
  });

  it('handles physical disconnect racing while openDevice is pending', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();

    let resolveOpen!: () => void;
    const delayedOpen = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    const origOpen = mockDevice.open.bind(mockDevice);
    mockDevice.open = async () => {
      await delayedOpen;
      return origOpen();
    };

    const openPromise = adapter.openDevice();

    // Disconnect happens while opening
    mockFacade.triggerDisconnect(mockDevice);
    expect(adapter.getState()).toBe('DISCONNECTED');

    resolveOpen();
    const openResult = await openPromise;
    expect(openResult).toBe(false);
    expect(adapter.getState()).toBe('DISCONNECTED');

    const openSuccess = adapter.getDiagnostics().find(
      (d) => d.code === 'SUCCESS' && d.message.includes('開きました'),
    );
    expect(openSuccess).toBeUndefined();

    adapter.destroy();
  });

  it('handles physical disconnect racing while selectConfiguration is pending', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const config1 = createMockConfiguration(1, [
      createMockInterface(0, [createMockAlternate(0, 0xff)]),
    ]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config1],
      configuration: null,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();
    await adapter.openDevice();

    let resolveConfig!: () => void;
    const delayedConfig = new Promise<void>((resolve) => {
      resolveConfig = resolve;
    });

    const origSelectConfig = mockDevice.selectConfiguration.bind(mockDevice);
    mockDevice.selectConfiguration = async (val) => {
      await delayedConfig;
      return origSelectConfig(val);
    };

    const configPromise = adapter.selectConfiguration(1);

    mockFacade.triggerDisconnect(mockDevice);
    expect(adapter.getState()).toBe('DISCONNECTED');

    resolveConfig();
    const configResult = await configPromise;
    expect(configResult).toBe(false);
    expect(adapter.getState()).toBe('DISCONNECTED');

    adapter.destroy();
  });

  it('matches physical disconnect by object identity ONLY, not VID:PID', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const config = createMockConfiguration(1, [
      createMockInterface(0, [createMockAlternate(0, 0xff)]),
    ]);

    const deviceA = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    const deviceB = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });

    mockFacade.nextDeviceToReturn = deviceA;
    await adapter.requestDevice();
    await adapter.openDevice();

    expect(adapter.getState()).toBe('OPENED');

    // Trigger disconnect for deviceB (identical VID:PID, but different instance)
    mockFacade.triggerDisconnect(deviceB);

    // Must NOT disconnect active deviceA
    expect(adapter.getState()).toBe('OPENED');
    expect(adapter.getSanitizedDeviceSummary()).not.toBeNull();

    // Now trigger disconnect for deviceA
    mockFacade.triggerDisconnect(deviceA);
    expect(adapter.getState()).toBe('DISCONNECTED');
    expect(adapter.getSanitizedDeviceSummary()).toBeNull();

    adapter.destroy();
  });

  it('prevents concurrent/re-entrant operations and records BUSY_ERROR', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const config = createMockConfiguration(1, [
      createMockInterface(0, [createMockAlternate(0, 0xff)]),
    ]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    await adapter.requestDevice();

    // Hook open to delay completion so an in-flight operation can be tested
    let resolveOpen!: () => void;
    const delayedOpen = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    const originalOpen = mockDevice.open.bind(mockDevice);
    mockDevice.open = async () => {
      await delayedOpen;
      return originalOpen();
    };

    // Start openDevice (in flight)
    const openPromise = adapter.openDevice();
    expect(adapter.isBusy()).toBe(true);

    // Attempt a re-entrant operation while openDevice is pending
    const concurrentResult = await adapter.claimInterface(0);
    expect(concurrentResult).toBe(false);

    const busyDiag = adapter.getDiagnostics().slice(-1)[0];
    expect(busyDiag.code).toBe('BUSY_ERROR');

    // Finish openDevice
    resolveOpen();
    const openResult = await openPromise;
    expect(openResult).toBe(true);
    expect(adapter.isBusy()).toBe(false);

    adapter.destroy();
  });

  it('guarantees ZERO firmware upload, tuning, or transfer operations are called', async () => {
    const adapter = new WebUSBAdapter(mockFacade);
    const iface0 = createMockInterface(0, [createMockAlternate(0, 0xff)]);
    const config = createMockConfiguration(1, [iface0]);

    const mockDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
    });
    mockFacade.nextDeviceToReturn = mockDevice;

    // Perform all M0 workflow actions
    await adapter.requestDevice();
    await adapter.openDevice();
    await adapter.claimInterface(0);
    await adapter.releaseInterface(0);
    await adapter.releaseAndClose();

    // Verify forbidden calls
    expect(mockDevice.controlTransferCalls).toBe(0);
    expect(mockDevice.transferInCalls).toBe(0);
    expect(mockDevice.transferOutCalls).toBe(0);

    adapter.destroy();
  });
});
