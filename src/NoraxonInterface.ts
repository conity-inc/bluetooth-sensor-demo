import { makeAutoObservable, runInAction } from "mobx";
import type { SensorInterface, SensorPacket } from "./BaseInterface";

// Ultium Motion UUIDs (hard-coded)
const UUID_MOTION_SVC = "9ddca6a5-1ba9-484c-b540-40662f3759f6";
const UUID_MOTION_NOTIFY = "a91d7db9-5cce-4c0d-a5c2-dc395e00052e"; // stream: ts(4) + n(1) + n*(ax..q3 int16 half)
const UUID_MOTION_BATT_NOTIFY = "ecbdbf91-0be3-4779-b874-b3943b878696"; // uint16 battery level
const UUID_MOTION_CMD = "6a419d08-b535-4d6f-90b8-886bc0f6e98c"; // write/cmd

// Command bytes
const BLE_MOTION_CMD_START = 0x01;
const BLE_MOTION_CMD_STOP = 0x02;

type PacketHandler = (packets: SensorPacket[]) => unknown;

export class NoraxonSensor implements SensorInterface {
  readonly technology = "Noraxon";
  serial?: string;
  version?: string;
  onReceivePacket: PacketHandler;
  private device: BluetoothDevice;
  private rxChar: BluetoothRemoteGATTCharacteristic;
  private txChar: BluetoothRemoteGATTCharacteristic;
  private bxChar: BluetoothRemoteGATTCharacteristic;
  _connected = false;
  _streaming = false;
  startStreamingPromise?: {
    resolve: (value: unknown) => void;
    reject: () => void;
  };
  onDispose: () => void;

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
    makeAutoObservable(this);
  }

  static async create({ onReceivePacket }: { onReceivePacket: PacketHandler }) {
    let sensor: NoraxonSensor | undefined = undefined;

    const { device, txChar, rxChar, bxChar } = await getDeviceAndChars({});

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

    runInAction(() => (this._connected = true));
  }

  dispose() {
    this.onDispose();
    this.device.gatt?.disconnect();
  }

  get connected() {
    return this._connected && !!this.device.gatt?.connected;
  }

  get streaming() {
    return this._streaming && this.connected;
  }

  get streamStarting() {
    return !!this.startStreamingPromise;
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
    console.log("Battery", value);
  }

  handleDisconnect() {
    console.debug("NoraxonSensor disconnected");
    runInAction(() => (this._connected = false));
  }

  async startStreaming() {
    await this.rxChar.writeValue(new Uint8Array([BLE_MOTION_CMD_START]));
    await new Promise((resolve, reject) =>
      runInAction(() => (this.startStreamingPromise = { resolve, reject }))
    ).then(() => runInAction(() => (this._streaming = true)));
  }

  async stopStreaming() {
    await this.rxChar.writeValue(new Uint8Array([BLE_MOTION_CMD_STOP]));
    runInAction(() => (this._streaming = false));
  }
}

function parseData(value: DataView) {
  if (value.byteLength < 5) return;
  const millis0 = value.getUint32(0, true);
  const nFrames = value.getUint8(4);
  let offset = 5;
  const frameSize = 14; // 7 half-floats (2 bytes each), big-endian halves
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
    const q0 = value.getFloat16(offset + 6);
    const q1 = value.getFloat16(offset + 8);
    const q2 = value.getFloat16(offset + 10);
    const q3 = value.getFloat16(offset + 12);
    const time = (millis0 + i * 10) / 1_000;
    frames.push({
      time,
      accelerometer: { x: ax, y: ay, z: az },
      quaternion: { x: q0, y: q1, z: q2, w: q3 },
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

export async function getDeviceAndChars({
  maxAttempts = 3,
}: {
  maxAttempts?: number;
} = {}) {
  type Resolve = (value: DeviceAndChars) => void;
  let resolve: Resolve = () => {};
  let reject: (value: Error) => void = () => {};
  let settled = false;
  const promise = new Promise((resolve_: Resolve, reject_) => {
    resolve = resolve_;
    reject = reject_;
  }).finally(() => (settled = true));

  // Request device
  const device = await navigator.bluetooth.requestDevice({
    // acceptAllDevices: true,
    filters: [{ namePrefix: "Ultium" }],

    // filters: [{ services: [UUID_MOTION_SVC], namePrefix: "Ultium" }],
    optionalServices: [UUID_MOTION_SVC],
  });
  if (!device.gatt) throw new Error("No GATT server");
  const server = device.gatt;

  // Connect to GATT server
  const timeout = 5_000;
  setTimeout(() => {
    if (settled) return;
    reject(new Error(`Unable to connect in ${timeout / 1000} seconds`));
    server.disconnect();
  }, timeout);
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
    } catch {
      console.debug("Connection failed. Trying again in 100ms");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!settled) {
    reject(new Error(`Unable to connect in ${maxAttempts} attempts`));
  }

  return promise;
}
