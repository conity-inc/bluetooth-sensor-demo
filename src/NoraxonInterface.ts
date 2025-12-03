import { makeAutoObservable, runInAction } from "mobx";
import type { BluetoothSensor, SensorPacket } from "./BaseInterface";

// Ultium Motion UUIDs (hard-coded)
const UUID_MOTION_SVC = "9ddca6a5-1ba9-484c-b540-40662f3759f6";
const UUID_MOTION_NOTIFY = "a91d7db9-5cce-4c0d-a5c2-dc395e00052e"; // stream: ts(4) + n(1) + n*(ax..q3 int16 half)
const UUID_MOTION_BATT_NOTIFY = "ecbdbf91-0be3-4779-b874-b3943b878696"; // uint16 battery level
const UUID_MOTION_CMD = "6a419d08-b535-4d6f-90b8-886bc0f6e98c"; // write/cmd

// Command bytes
const BLE_MOTION_CMD_NONE = 0x00;
const BLE_MOTION_CMD_START = 0x01; // start measurement
const BLE_MOTION_CMD_STOP = 0x02; // stop measurement
const BLE_MOTION_CMD_SET_DATAMODE = 0x04; // set datamode, unused for now
const BLE_MOTION_CMD_FAST_CONVERGE_ENABLE = 0x08; // enable fast converge
const BLE_MOTION_CMD_FAST_CONVERGE_DISABLE = 0x10; // disable fast converge
const BLE_MOTION_CMD_MAG_ENABLE = 0x20; // enable magnetometers
const BLE_MOTION_CMD_MAG_DISABLE = 0x40; // disable magnetometers
const BLE_MOTION_CMD_DISABLE_40G = 0x41; // disable 40G accelerometer, unused for now
const BLE_MOTION_CMD_ENABLE_40G = 0x42; // enable 40G accelerometer (lowest noise)
type PacketHandler = (packets: SensorPacket[]) => unknown;

export class NoraxonSensor implements BluetoothSensor {
  readonly technology = "Noraxon";
  serial?: string;
  version?: string;
  /** Battery percentage. Possible values are 0, 10, 25, 50, 75. */
  battery?: number;
  onReceivePacket: PacketHandler;
  private _onDisconnect: () => unknown = () => {};
  private device: BluetoothDevice;
  private rxChar: BluetoothRemoteGATTCharacteristic;
  private txChar: BluetoothRemoteGATTCharacteristic;
  private bxChar: BluetoothRemoteGATTCharacteristic;
  _connected = false;
  _streaming = false;
  _startStreamingPromise?: {
    resolve: (value: unknown) => void;
    reject: () => void;
  };
  _fastConvergeEnabled = false;
  private onDispose: () => void;

  constructor({
    device,
    rxChar,
    txChar,
    bxChar,
    onReceivePacket,
  }: {
    device: BluetoothDevice;
    rxChar: BluetoothRemoteGATTCharacteristic;
    txChar: BluetoothRemoteGATTCharacteristic;
    bxChar: BluetoothRemoteGATTCharacteristic;
    onReceivePacket: PacketHandler;
  }) {
    this.device = device;
    this.rxChar = rxChar;
    this.txChar = txChar;
    this.bxChar = bxChar;
    this.onReceivePacket = onReceivePacket;
    const ondisconnct = () => this?.handleDisconnect();
    device.addEventListener("gattserverdisconnected", ondisconnct);
    const ondata = (e: Event) => this.handleData(e);
    txChar.addEventListener("characteristicvaluechanged", ondata);
    const onbattery = (e: Event) => this.handleBattery(e);
    bxChar.addEventListener("characteristicvaluechanged", onbattery);
    this.onDispose = () => {
      device.removeEventListener("gattserverdisconnected", ondisconnct);
      txChar.removeEventListener("characteristicvaluechanged", ondata);
      bxChar.removeEventListener("characteristicvaluechanged", onbattery);
    };
    makeAutoObservable(this, { onReceivePacket: false });
  }

  static async connect({
    allowedSerials,
    onReceivePacket,
  }: {
    allowedSerials?: string[];
    onReceivePacket: PacketHandler;
  }) {
    let sensor: NoraxonSensor | undefined = undefined;

    const { device, txChar, rxChar, bxChar } = await getDeviceAndChars({
      allowedSerials,
    });

    sensor = new NoraxonSensor({
      device,
      txChar,
      rxChar,
      bxChar,
      onReceivePacket,
    });
    Object.assign(window, { sensor });
    await sensor.init();

    return sensor;
  }

  async init() {
    const [version, serial, ..._] = this.device.name?.split(" ") ?? [];
    this.version = version;
    this.serial = serial;
    await this.txChar.startNotifications();
    await this.bxChar.startNotifications();

    this.connected = true;
  }

  get onDisconnect() {
    return this._onDisconnect;
  }

  set onDisconnect(value: () => unknown) {
    this._onDisconnect = value;
  }

  dispose() {
    this.onDisconnect();
    this.onDispose();
    this.device.gatt?.disconnect();
  }

  assertConnected() {
    if (!this.connected) {
      throw Object.assign(new Error("Sensor not connected"), {
        id: "NotConnected",
      });
    }
  }

  get connected() {
    return this._connected && !!this.device.gatt?.connected;
  }

  set connected(value) {
    this._connected = value;
  }

  assertStreaming() {
    if (!this.connected) {
      throw Object.assign(new Error("Sensor not streaming"), {
        id: "NotStreaming",
      });
    }
  }

  get streaming() {
    return this._streaming && this.connected;
  }

  set streaming(value) {
    this._streaming = value;
  }

  get streamStarting() {
    return !!this.startStreamingPromise;
  }

  get startStreamingPromise() {
    return this._startStreamingPromise;
  }

  set startStreamingPromise(value) {
    this._startStreamingPromise = value;
  }

  private handleData(e: Event) {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    this.startStreamingPromise?.resolve(undefined);
    const packet = parseData(value);
    if (packet) this.onReceivePacket(packet);
  }

  private handleBattery(e: Event) {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const battery = value.getUint16(0, true);
    this.battery = battery;
  }

  handleDisconnect() {
    console.debug("NoraxonSensor disconnected", this.onDisconnect);
    this.connected = false;
    this.onDisconnect();
  }

  async startStreaming() {
    this.assertConnected();
    await this.rxChar.writeValueWithResponse(
      new Uint8Array([BLE_MOTION_CMD_START])
    );
    await new Promise(
      (resolve, reject) => (this.startStreamingPromise = { resolve, reject })
    ).then(() => (this.streaming = true));
  }

  async stopStreaming() {
    this.assertConnected();
    await this.rxChar.writeValueWithResponse(
      new Uint8Array([BLE_MOTION_CMD_STOP])
    );
    this.streaming = false;
  }

  // ============= Fast Converge ==============

  get fastConvergeEnabled() {
    return this._fastConvergeEnabled && this.connected;
  }

  set fastConvergeEnabled(value) {
    this._fastConvergeEnabled = value;
  }

  async performFastConverge() {
    try {
      await this.enableFastConverge();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await this.disableFastConverge();
    }
  }

  async enableFastConverge() {
    this.assertStreaming();
    await this.rxChar.writeValueWithResponse(
      new Uint8Array([BLE_MOTION_CMD_FAST_CONVERGE_ENABLE])
    );
    this.fastConvergeEnabled = true;
  }

  async disableFastConverge() {
    this.assertStreaming();
    await this.rxChar.writeValueWithResponse(
      new Uint8Array([BLE_MOTION_CMD_FAST_CONVERGE_DISABLE])
    );
    this.fastConvergeEnabled = false;
  }
}

const g = 9.80665; // standard gravity in m/s^2
const deg2rad = Math.PI / 180;

function parseData(value: DataView) {
  if (value.byteLength < 5) return;
  const millis0 = value.getUint32(0, true);
  const nFrames = value.getUint8(4);
  let offset = 5;
  const frameSize = 20; // 10x 2-byte values, big-endian
  const expected = offset + nFrames * frameSize;
  if (value.byteLength < expected) {
    console.warn(
      `Motion data truncated. Expected ${expected} bytes but received ${value.byteLength}.`
    );
    return;
  }

  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    const ax = value.getFloat16(offset);
    const ay = value.getFloat16(offset + 2);
    const az = value.getFloat16(offset + 4);
    const q0 = value.getInt16(offset + 6) / -32767;
    const q1 = value.getInt16(offset + 8) / -32767;
    const q2 = value.getInt16(offset + 10) / -32767;
    const q3 = value.getInt16(offset + 12) / -32767;
    const gx = value.getFloat16(offset + 14);
    const gy = value.getFloat16(offset + 16);
    const gz = value.getFloat16(offset + 18);
    const time = (millis0 + i * 10) / 1_000;
    frames.push({
      time,
      accelerometer: { x: ax * g, y: ay * g, z: az * g },
      quaternion: { x: q0, y: q1, z: q2, w: q3 },
      gyroscope: { x: gx * deg2rad, y: gy * deg2rad, z: gz * deg2rad },
    });
    offset += frameSize;
  }
  return frames;
}

// Extend DataView type to include getFloat16
declare global {
  interface DataView {
    getFloat16(offset: number, littleEndian?: boolean): number;
  }
}

if (!DataView.prototype.getFloat16) {
  console.debug(`Float16 not supported. Polyfilling...`);
  DataView.prototype.getFloat16 = function (
    this: DataView,
    offset: number,
    littleEndian?: boolean
  ): number {
    // Read 2 bytes big-endian, convert to float16
    const bits = this.getUint16(offset, littleEndian ?? false); // big-endian by default

    // Convert uint16 bits to float32 number
    const s = (bits & 0x8000) >> 15;
    const e = (bits & 0x7c00) >> 10;
    const c = bits & 0x03ff;
    let out: number;
    if (e === 0) {
      out = (s ? -1 : 1) * Math.pow(2, -14) * (c / Math.pow(2, 10));
    } else if (e === 0x1f) {
      out = c ? NaN : (s ? -1 : 1) * Infinity;
    } else {
      out = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + c / Math.pow(2, 10));
    }
    return out;
  };
}

type DeviceAndChars = {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer;
  service: BluetoothRemoteGATTService;
  rxChar: BluetoothRemoteGATTCharacteristic;
  txChar: BluetoothRemoteGATTCharacteristic;
  bxChar: BluetoothRemoteGATTCharacteristic;
};

function getDeviceAndChars({
  allowedSerials,
  maxAttempts = 100,
  timeout = 10_000,
}: {
  allowedSerials?: string[];
  maxAttempts?: number;
  timeout?: number;
} = {}) {
  type Resolve = (value: DeviceAndChars) => void;
  let resolve: Resolve = () => {};
  let reject: (value: Error) => void = () => {};
  let settled = false;
  const promise = new Promise((resolve_: Resolve, reject_) => {
    resolve = resolve_;
    reject = reject_;
  }).finally(() => (settled = true));

  (async () => {
    // Request device
    const services = undefined; // [UUID_MOTION_SVC];
    const device = await navigator.bluetooth.requestDevice({
      // acceptAllDevices: true,
      filters: allowedSerials
        ? allowedSerials.map((serial) => ({
            services,
            namePrefix: `Ultium ${serial}`,
          }))
        : [{ services, namePrefix: "Ultium" }],
      optionalServices: [UUID_MOTION_SVC],
    });
    if (!device.gatt) throw new Error("No GATT server");
    const server = device.gatt;

    // Connect to GATT server
    const handleReject = (message: string) => {
      if (settled) return;
      reject(new Error(message));
      server.disconnect();
    };
    const timeoutHandle = setTimeout(
      () => handleReject(`Unable to connect in ${timeout / 1000} seconds`),
      timeout
    );
    let remainingAttempts = maxAttempts;
    let service, rxChar, txChar, bxChar;
    while (!settled && remainingAttempts--) {
      try {
        await server.connect();
        service ??= await server.getPrimaryService(UUID_MOTION_SVC);
        rxChar ??= await service.getCharacteristic(UUID_MOTION_CMD);
        txChar ??= await service.getCharacteristic(UUID_MOTION_NOTIFY);
        bxChar ??= await service.getCharacteristic(UUID_MOTION_BATT_NOTIFY);
        resolve?.({ device, server, service, rxChar, txChar, bxChar });
        clearTimeout(timeoutHandle);
      } catch {
        console.debug("Connection failed. Trying again in 250ms");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    handleReject(`Unable to connect in ${maxAttempts} attempts`);
  })().catch(reject);

  return promise;
}
