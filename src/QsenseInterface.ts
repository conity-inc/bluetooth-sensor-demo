import { makeAutoObservable, runInAction } from "mobx";
import type { Quat, BluetoothSensor, Xyz } from "./BaseInterface";
import { getUartDeviceAndChars } from "./uart";

type PacketHandler = (packet: UniversalPacket) => unknown;

export class QsenseSensor implements BluetoothSensor {
  readonly technology = "QSense";
  serial?: string;
  version?: string;
  onReceivePacket: PacketHandler;
  private device: BluetoothDevice;
  private rxChar: BluetoothRemoteGATTCharacteristic;
  private txChar: BluetoothRemoteGATTCharacteristic;
  private command?: {
    resolve: (value: ControlPacket) => void;
    reject: (reason: unknown) => unknown;
  };
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
    onReceivePacket,
  }: {
    device: BluetoothDevice;
    rxChar: BluetoothRemoteGATTCharacteristic;
    txChar: BluetoothRemoteGATTCharacteristic;
    onReceivePacket: PacketHandler;
  }) {
    this.device = device;
    this.rxChar = rxChar;
    this.txChar = txChar;
    this.onReceivePacket = onReceivePacket;
    const ondisconnct = () => this?.handleDisconnect();
    device.addEventListener("gattserverdisconnected", ondisconnct);
    const ondata = (e: Event) => this.handleData(e);
    txChar.addEventListener("characteristicvaluechanged", ondata);
    this.onDispose = () => {
      device.removeEventListener("gattserverdisconnected", ondisconnct);
      txChar.removeEventListener("characteristicvaluechanged", ondata);
    };
    makeAutoObservable(this);
  }

  static async create({ onReceivePacket }: { onReceivePacket: PacketHandler }) {
    const { device, txChar, rxChar } = await getUartDeviceAndChars({
      name: "QSense",
    });
    device.addEventListener("gattserverdisconnected", () => {
      sensor?.handleDisconnect();
    });

    const sensor = new QsenseSensor({
      device,
      txChar,
      rxChar,
      onReceivePacket,
    });
    await sensor.init();
    Object.assign(window, { sensor });

    return sensor;
  }

  async init() {
    await this.txChar.startNotifications();
    this.txChar.addEventListener("characteristicvaluechanged", (e) =>
      this.handleData(e)
    );

    // Use pin "love" to unlock sensor
    const pinPacket = QsenseInterface.createDataPacket(
      QsenseInterface.MemoryAddress.Pin,
      new TextEncoder().encode("love")
    );
    await this.rxChar.writeValueWithoutResponse(pinPacket);
    await new Promise(
      (resolve, reject) => (this.command = { resolve, reject })
    ).finally(() => (this.command = undefined));

    const { whoAmI } = await this.getValue(
      QsenseInterface.MemoryAddress.WhoAmI,
      4
    );
    this.serial = `${(whoAmI as number).toString(16).padStart(8, "0")}`;

    const { version } = await this.getValue(
      QsenseInterface.MemoryAddress.Version,
      4
    );
    this.version = `${(version as number).toString(16).padStart(8, "0")}`;

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

  async getValue(address: number, length: number): Promise<ControlPacket> {
    const dataPacket = QsenseInterface.createReadPacket(address, length);
    const buffer = dataPacket.buffer;
    this.command?.reject("Superseded");
    await this.rxChar.writeValueWithoutResponse(buffer);
    return (await new Promise(
      (resolve, reject) => (this.command = { resolve, reject })
    ).finally(() => (this.command = undefined))) as ControlPacket;
  }

  async setValue(address: number, value: Array<number>) {
    const dataPacket = QsenseInterface.createDataPacket(
      address,
      new Uint8Array(value)
    );
    this.command?.reject("Superseded");
    await this.rxChar.writeValueWithoutResponse(dataPacket);
    return (await new Promise(
      (resolve, reject) => (this.command = { resolve, reject })
    ).finally(() => (this.command = undefined))) as ControlPacket;
  }

  private handleData(event: Event) {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const data = QsenseInterface.parsePacket(value);
    if ("control" in data) {
      this.command?.resolve(data);
    } else {
      this.startStreamingPromise?.resolve(undefined);
      this.onReceivePacket(data);
    }
  }

  handleDisconnect() {
    runInAction(() => (this._connected = false));
  }

  async startStreaming() {
    const packet = QsenseInterface.createDataPacket(
      QsenseInterface.MemoryAddress.DataMode,
      new Uint8Array([QsenseInterface.DataMode.Optimized])
    );
    await this.rxChar.writeValueWithoutResponse(packet);
    const streamPacket = QsenseInterface.createStreamPacket();
    await this.rxChar.writeValueWithoutResponse(streamPacket);
    await new Promise((resolve, reject) =>
      runInAction(() => (this.startStreamingPromise = { resolve, reject }))
    ).then(() => runInAction(() => (this._streaming = true)));
  }

  async stopStreaming() {
    const streamPacket = QsenseInterface.createAbortPacket();
    await this.rxChar.writeValueWithoutResponse(streamPacket);
    runInAction(() => (this._streaming = false));
  }
}

export class QsenseInterface {
  static Opcode = {
    Read: 1,
    Data: 2,
    Abort: 3,
    Stream: 4,
  };

  static PacketFieldAddress = {
    Opcode: 0,
    Address: 1,
    Length: 5,
    Data: 7,
  };

  static MemoryAddress = {
    WhoAmI: 0x00000000,
    Id: 0x00000004,
    MacAddress: 0x0000000c,
    Version: 0x00000014,
    Battery: 0x00000018,
    MotionLevel: 0x00000019,
    OffsetCompensated: 0x0000001a,
    MagneticFieldMapped: 0x0000001b,
    MagneticFieldProgress: 0x0000001c,
    ConnectionInterval: 0x0000001d,
    SyncStatus: 0x0000001e,
    Ticks100Hz: 0x0000001f,
    Pin: 0x00000020,
    Time: 0x00000024,
    Annotation: 0x00000028,
    DeviceState: 0x0000002a,
    UiAnimation: 0x0000002c,
    DeviceName: 0x00000030,
    DataMode: 0x0000003c,
    Timesync: 0x0000003d,
    AlgorithmSelection: 0x0000003f,
  };

  static DataMode = {
    Mixed: 0,
    Raw: 1,
    Quat: 2,
    Optimized: 3,
    QuatMag: 4,
  };

  static CONTROL_MEMORY_ADDRESS = 0x00000000;
  static CONTROL_MEMORY_SIZE = 0x00000040;
  static STREAM_MEMORY_ADDRESS = 0x00000100;
  static STREAM_MEMORY_SIZE = 237;
  static WHOAMI_VALUE = 0x324d5351; // "QSM2"
  static PIN_VALUE = 0x65766f6c;
  static HEADER_LENGTH = 10;

  static createReadPacket(address: number, length: number) {
    const packet = new Uint8Array(7); // Opcode (1B) + Address (4B) + Length (2B) = 7B
    packet[QsenseInterface.PacketFieldAddress.Opcode] =
      QsenseInterface.Opcode.Read;
    packet.set(
      new Uint8Array(new Uint32Array([address]).buffer),
      QsenseInterface.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(new Uint16Array([length]).buffer),
      QsenseInterface.PacketFieldAddress.Length
    );
    return packet;
  }

  static createDataPacket(address: number, data: Uint8Array) {
    const length = data.length;
    const packet = new Uint8Array(7 + length);
    packet[QsenseInterface.PacketFieldAddress.Opcode] =
      QsenseInterface.Opcode.Data;
    packet.set(
      new Uint8Array(new Uint32Array([address]).buffer),
      QsenseInterface.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(new Uint16Array([length]).buffer),
      QsenseInterface.PacketFieldAddress.Length
    );
    packet.set(data, QsenseInterface.PacketFieldAddress.Data);
    return packet;
  }

  static createAbortPacket() {
    const packet = new Uint8Array(1);
    packet[QsenseInterface.PacketFieldAddress.Opcode] =
      QsenseInterface.Opcode.Abort;
    return packet;
  }

  static createStreamPacket() {
    const packet = new Uint8Array(7);
    packet[QsenseInterface.PacketFieldAddress.Opcode] =
      QsenseInterface.Opcode.Stream;
    packet.set(
      new Uint8Array(
        new Uint32Array([QsenseInterface.STREAM_MEMORY_ADDRESS]).buffer
      ),
      QsenseInterface.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(
        new Uint16Array([QsenseInterface.STREAM_MEMORY_SIZE]).buffer
      ),
      QsenseInterface.PacketFieldAddress.Length
    );
    return packet;
  }

  /**
   * @param {DataView} dataView
   */
  static parsePacket(dataView: DataView) {
    const packet = new Uint8Array(dataView.buffer); // Convert DataView to Uint8Array

    const opcode = packet[QsenseInterface.PacketFieldAddress.Opcode];
    const address = dataView.getUint32(
      QsenseInterface.PacketFieldAddress.Address,
      true
    );
    const length = dataView.getUint16(
      QsenseInterface.PacketFieldAddress.Length,
      true
    );

    console.debug(`Opcode: ${opcode}\tAddress: ${address}\tLength: ${length}`);

    if (address + length <= QsenseInterface.CONTROL_MEMORY_SIZE) {
      const data = packet.slice(
        QsenseInterface.PacketFieldAddress.Data,
        QsenseInterface.PacketFieldAddress.Data + length
      );
      return QsenseInterface.parseControlMemory(data, address, length);
    } else if (
      address === QsenseInterface.STREAM_MEMORY_ADDRESS &&
      length === QsenseInterface.STREAM_MEMORY_SIZE
    ) {
      const data = packet.slice(
        QsenseInterface.PacketFieldAddress.Data,
        QsenseInterface.PacketFieldAddress.Data + length
      );
      return QsenseInterface.parseStreamData(data);
    } else {
      throw new Error("Unknown packet type");
    }
  }

  static parseControlMemory(data: Uint8Array, address: number, length: number) {
    const dataInfo: ControlPacket & { control: true } = { control: true };

    if (
      address <= QsenseInterface.MemoryAddress.WhoAmI &&
      address + length >= QsenseInterface.MemoryAddress.WhoAmI + 4
    ) {
      const whoAmI = new DataView(data.buffer).getUint32(
        QsenseInterface.MemoryAddress.WhoAmI - address,
        true
      );
      dataInfo[`whoAmI`] = whoAmI;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Id &&
      address + length >= QsenseInterface.MemoryAddress.Id + 8
    ) {
      const id = new DataView(data.buffer).getBigUint64(
        QsenseInterface.MemoryAddress.Id - address,
        true
      );
      dataInfo[`id`] = id;
    }

    if (
      address <= QsenseInterface.MemoryAddress.MacAddress &&
      address + length >= QsenseInterface.MemoryAddress.MacAddress + 6
    ) {
      const macStart = QsenseInterface.MemoryAddress.MacAddress - address;
      const macBytes = data.slice(macStart, macStart + 6);
      const macAddress = Array.from(macBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":");
      dataInfo[`macAddress`] = macAddress;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Version &&
      address + length >= QsenseInterface.MemoryAddress.Version + 4
    ) {
      const versionStart = QsenseInterface.MemoryAddress.Version - address;
      const version = new DataView(data.buffer).getUint32(versionStart, true);
      dataInfo[`version`] = version;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Battery &&
      address + length >= QsenseInterface.MemoryAddress.Battery + 1
    ) {
      const battery = data[QsenseInterface.MemoryAddress.Battery - address];
      dataInfo[`battery`] = battery;
    }

    if (
      address <= QsenseInterface.MemoryAddress.MotionLevel &&
      address + length >= QsenseInterface.MemoryAddress.MotionLevel + 1
    ) {
      const motionLevel =
        data[QsenseInterface.MemoryAddress.MotionLevel - address];
      dataInfo[`motionLevel`] = motionLevel;
    }

    if (
      address <= QsenseInterface.MemoryAddress.OffsetCompensated &&
      address + length >= QsenseInterface.MemoryAddress.OffsetCompensated + 1
    ) {
      const offsetCompensated =
        data[QsenseInterface.MemoryAddress.OffsetCompensated - address];
      dataInfo[`offsetCompensated`] = offsetCompensated;
    }

    if (
      address <= QsenseInterface.MemoryAddress.MagneticFieldMapped &&
      address + length >= QsenseInterface.MemoryAddress.MagneticFieldMapped + 1
    ) {
      const magneticFieldMapped =
        data[QsenseInterface.MemoryAddress.MagneticFieldMapped - address];
      dataInfo[`magneticFieldMapped`] = magneticFieldMapped;
    }

    if (
      address <= QsenseInterface.MemoryAddress.MagneticFieldProgress &&
      address + length >=
        QsenseInterface.MemoryAddress.MagneticFieldProgress + 1
    ) {
      const magneticFieldProgress =
        data[QsenseInterface.MemoryAddress.MagneticFieldProgress - address];
      dataInfo[`magneticFieldProgress`] = magneticFieldProgress;
    }

    if (
      address <= QsenseInterface.MemoryAddress.ConnectionInterval &&
      address + length >= QsenseInterface.MemoryAddress.ConnectionInterval + 1
    ) {
      const connectionInterval =
        data[QsenseInterface.MemoryAddress.ConnectionInterval - address];
      dataInfo[`connectionInterval`] = connectionInterval;
    }

    if (
      address <= QsenseInterface.MemoryAddress.SyncStatus &&
      address + length >= QsenseInterface.MemoryAddress.SyncStatus + 1
    ) {
      const syncStatus =
        data[QsenseInterface.MemoryAddress.SyncStatus - address];
      dataInfo[`syncStatus`] = syncStatus;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Ticks100Hz &&
      address + length >= QsenseInterface.MemoryAddress.Ticks100Hz + 4
    ) {
      const ticks100Hz = new DataView(data.buffer).getUint32(
        QsenseInterface.MemoryAddress.Ticks100Hz - address,
        true
      );
      dataInfo[`ticks100Hz`] = ticks100Hz;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Pin &&
      address + length >= QsenseInterface.MemoryAddress.Pin + 4
    ) {
      const pin = new DataView(data.buffer).getUint32(
        QsenseInterface.MemoryAddress.Pin - address,
        true
      );
      dataInfo[`pin`] = pin;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Time &&
      address + length >= QsenseInterface.MemoryAddress.Time + 4
    ) {
      const time = new DataView(data.buffer).getUint32(
        QsenseInterface.MemoryAddress.Time - address,
        true
      );
      dataInfo[`time`] = time;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Annotation &&
      address + length >= QsenseInterface.MemoryAddress.Annotation + 2
    ) {
      const annotationStart =
        QsenseInterface.MemoryAddress.Annotation - address;
      const annotation = new DataView(data.buffer).getUint16(
        annotationStart,
        true
      );
      dataInfo[`annotation`] = annotation;
    }

    if (
      address <= QsenseInterface.MemoryAddress.DeviceState &&
      address + length >= QsenseInterface.MemoryAddress.DeviceState + 2
    ) {
      const deviceStateStart =
        QsenseInterface.MemoryAddress.DeviceState - address;
      const deviceState = new DataView(data.buffer).getUint16(
        deviceStateStart,
        true
      );
      dataInfo[`deviceState`] = deviceState;
    }

    if (
      address <= QsenseInterface.MemoryAddress.DeviceName &&
      address + length >= QsenseInterface.MemoryAddress.DeviceName + 12
    ) {
      const name = new TextDecoder().decode(
        data.slice(
          QsenseInterface.MemoryAddress.DeviceName - address,
          QsenseInterface.MemoryAddress.DeviceName - address + 12
        )
      );
      dataInfo[`deviceName`] = name;
    }

    if (
      address <= QsenseInterface.MemoryAddress.DataMode &&
      address + length >= QsenseInterface.MemoryAddress.DataMode + 1
    ) {
      const dataMode = data[QsenseInterface.MemoryAddress.DataMode - address];
      dataInfo[`dataMode`] = dataMode;
    }

    if (
      address <= QsenseInterface.MemoryAddress.Timesync &&
      address + length >= QsenseInterface.MemoryAddress.Timesync + 1
    ) {
      const timesyncByte =
        data[QsenseInterface.MemoryAddress.Timesync - address];
      const isEnabled = (timesyncByte & 0x7f) !== 0x00;
      const isMaster = isEnabled && (timesyncByte & 0x80) !== 0x00;
      const networkKey = timesyncByte & 0x7f;

      if (!isEnabled) {
        dataInfo[`timesync`] = { isEnabled };
      } else {
        dataInfo[`timesync`] = { isEnabled, isMaster, networkKey };
      }
    }

    if (
      address <= QsenseInterface.MemoryAddress.AlgorithmSelection &&
      address + length >= QsenseInterface.MemoryAddress.AlgorithmSelection + 1
    ) {
      const algorithm =
        data[QsenseInterface.MemoryAddress.AlgorithmSelection - address] === 0
          ? "9 DoF"
          : "6 DoF";
      dataInfo[`AlgorithmSelection`] = algorithm;
    }

    return dataInfo;
  }

  /**
   * @param {Uint8Array} data
   */
  static parseStreamData(data: Uint8Array): UniversalPacket {
    const dataModes = ["Mixed", "Raw", "Quaternion", "Optimized", "Quat+Mag"];
    const accRanges = ["2g", "16g", "4g", "8g"];
    const gyroRanges = [
      "250dps",
      "125dps",
      "500dps",
      "",
      "1000dps",
      "",
      "2000dps",
    ];
    const accScaleFactors = [0.000061, 0.000488, 0.000122, 0.000244];
    const gyrScaleFactors = [0.00875, 0.004375, 0.0175, 0, 0.035, 0, 0.07];
    const interferenceLevels = [
      "",
      "None",
      "Soft-iron interference",
      "Hard-iron interference",
      "Change of environment detected",
    ];

    const mode = data[0] & 0x0f;
    const buffering = data[0] >> 4;
    const seconds = new DataView(data.buffer).getInt32(1, true);
    const milliseconds = new DataView(data.buffer).getInt16(5, true) * 1.25;
    const interference = interferenceLevels[data[7] & 0x07];
    // const battery = ((data[7] >> 3) & 0x1f) * 6.25; // Battery percentage
    const battery = (data[7] >> 3) * 6.25; // Battery percentage
    const annotation = data[8];
    const syncStatus = (data[9] & 0x01) == 1;
    const accRangeIndex = (data[9] & 0x30) >> 4;
    const gyroRangeIndex = (data[9] & 0x0e) >> 1;
    const timestamp = new Date(seconds * 1000 + milliseconds);
    const accScale = accScaleFactors[accRangeIndex];
    const gyrScale = gyrScaleFactors[gyroRangeIndex];
    // console.debug(
    //   [
    //     `Stream Data Header:`,
    //     `Data Mode: ${dataModes[mode]}`,
    //     `Buffering: ${buffering}`,
    //     `Timestamp: ${timestamp.toISOString()}`,
    //     `Interference: ${interference}`,
    //     `Battery: ${battery}%`,
    //     `Annotation: ${annotation}`,
    //     `Sync. Status: ${syncStatus}`,
    //     `Accelerometer range: ${accRanges[accRangeIndex]}`,
    //     `Gyroscope range: ${gyroRanges[gyroRangeIndex]}`,
    //   ].join("\n")
    // );

    let packet;
    switch (mode) {
      case QsenseInterface.DataMode.Mixed:
        packet = QsenseInterface.parseMixedPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case QsenseInterface.DataMode.Raw:
        packet = QsenseInterface.parseRawPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case QsenseInterface.DataMode.Quat:
        packet = QsenseInterface.parseQuatPacket(data, buffering);
        break;
      case QsenseInterface.DataMode.Optimized:
        packet = QsenseInterface.parseOptimizedPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case QsenseInterface.DataMode.QuatMag:
        packet = QsenseInterface.parseQuatMagPacket(data, buffering);
        break;
      default:
        console.error("Unknown data mode:", mode);
    }

    return { timestamp, battery, data: packet };
  }

  static parseMixedPacket(
    array: Uint8Array,
    buffering: number,
    accScale: number,
    gyrScale: number
  ) {
    const dataView = new DataView(array.slice(10).buffer);

    // Parse quaternion data (16 bytes: 4 floats)
    const w = dataView.getFloat32(0, true);
    const x = dataView.getFloat32(4, true);
    const y = dataView.getFloat32(8, true);
    const z = dataView.getFloat32(12, true);
    const quaternion = { w, x, y, z };

    // Parse free acceleration data (12 bytes: 3 floats)
    const freeAccX = dataView.getFloat32(16, true);
    const freeAccY = dataView.getFloat32(20, true);
    const freeAccZ = dataView.getFloat32(24, true);
    const freeAcc = { x: freeAccX, y: freeAccY, z: freeAccZ };

    // Iterate for each buffered sample to extract raw sensor data
    const rawData = [];
    for (let i = 0; i < buffering; i++) {
      const offset = 28 + i * 18; // After the first 28 bytes, each sample is 18 bytes
      const nineDof = raw9Dof({
        dataView,
        position: offset,
        accScale,
        gyrScale,
        includeMag: true,
      });
      rawData.push(nineDof);
    }

    return {
      quaternion,
      freeAcc,
      accelerometers: rawData.map((d) => d.acc),
      gyroscopes: rawData.map((d) => d.gyro),
      magnetometers: rawData.map((d) => d.mag!),
    };
  }

  static parseRawPacket(
    array: Uint8Array,
    buffering: number,
    accScale: number,
    gyrScale: number
  ) {
    const rawData = [];
    for (let i = 0; i < buffering; i++) {
      const offset = i * 18; // Each raw data entry is 18 bytes (6 floats, 3 for acc, 3 for gyr)
      const nineDof = raw9Dof({
        dataView: new DataView(array.buffer),
        position: offset,
        accScale,
        gyrScale,
        includeMag: false,
      });
      rawData.push(nineDof);
    }

    return {
      accelerometers: rawData.map((d) => d.acc),
      gyroscopes: rawData.map((d) => d.gyro),
    };
  }

  static parseQuatPacket(array: Uint8Array, buffering: number) {
    const dataView = new DataView(array.buffer);

    const quaternions = [];
    for (let i = 0; i < buffering; i++) {
      const offset = i * 16; // Each quaternion is 16 bytes (4 floats, 4 bytes each)
      const w = dataView.getFloat32(offset, true);
      const x = dataView.getFloat32(offset + 4, true);
      const y = dataView.getFloat32(offset + 8, true);
      const z = dataView.getFloat32(offset + 12, true);
      quaternions.push({ w, x, y, z });
    }

    return { quaternions };
  }

  static parseOptimizedPacket(
    array: Uint8Array,
    buffering: number,
    accScale: number,
    gyrScale: number
  ) {
    // C# uses HEADER_LENGTH offset and parses quaternion and then raw data
    const HEADER_LENGTH = QsenseInterface.HEADER_LENGTH;
    const dataView = new DataView(array.buffer);

    // Parse quaternion data (buffering samples, each 8 bytes: 4 x int16)
    const quaternions = [];
    let index = HEADER_LENGTH;
    for (let j = 0; j < buffering; j++) {
      // C#: W,X,Y,Z = int16/32767.0f
      const w = dataView.getInt16(index, true) / 32767.0;
      const x = dataView.getInt16(index + 2, true) / 32767.0;
      const y = dataView.getInt16(index + 4, true) / 32767.0;
      const z = dataView.getInt16(index + 6, true) / 32767.0;
      quaternions.push({ w, x, y, z });
      index += 8;
    }
    // Skip unused quaternion slots (C# does index += 8 * (10 - buffering))
    index += 8 * (10 - buffering);

    // Parse raw sensor data (buffering samples, each 12 bytes)
    const rawData = [];
    for (let j = 0; j < buffering; j++) {
      const nineDof = raw9Dof({
        dataView: dataView,
        position: index,
        accScale,
        gyrScale,
        includeMag: false,
      });
      rawData.push(nineDof);
      index += 12;
    }

    return {
      quaternions,
      accelerometers: rawData.map((d) => d.acc),
      gyroscopes: rawData.map((d) => d.gyro),
    };
  }

  static parseQuatMagPacket(array: Uint8Array, buffering: number) {
    const dataView = new DataView(array.buffer);

    const quaternions = [];
    const magnetometers = [];
    for (let i = 0; i < buffering; i++) {
      const offset = i * 28; // Each entry is 28 bytes (16 for quaternion, 12 for magnetometer)
      const w = dataView.getFloat32(offset, true);
      const x = dataView.getFloat32(offset + 4, true);
      const y = dataView.getFloat32(offset + 8, true);
      const z = dataView.getFloat32(offset + 12, true);
      const mag = magOnly({ dataView, position: offset + 16 });

      quaternions.push({ w, x, y, z });
      magnetometers.push(mag);
    }

    return { quaternions, magnetometers };
  }
}

const MAG_SCALE = 0.0015;

/**
 * Parses raw 9-DoF (Degrees of Freedom) sensor data from a DataView.
 *
 * @param {Object} params - The parameters object.
 * @param {DataView} params.dataView - The DataView containing the sensor data.
 * @param {number} params.position - The byte offset in the DataView to start reading from.
 * @param {number} params.accScale - The scale factor to apply to accelerometer values.
 * @param {number} params.gyrScale - The scale factor to apply to gyroscope values.
 * @param {boolean} [params.includeMag=false] - Whether to include magnetometer data.
 * @returns An object containing the parsed sensor data
 */
function raw9Dof({
  dataView,
  position,
  accScale,
  gyrScale,
  includeMag = false,
}: {
  dataView: DataView;
  position: number;
  accScale: number;
  gyrScale: number;
  includeMag: boolean;
}) {
  const accX = dataView.getInt16(position, true) * accScale;
  const accY = dataView.getInt16(position + 2, true) * accScale;
  const accZ = dataView.getInt16(position + 4, true) * accScale;
  const gyrX = dataView.getInt16(position + 6, true) * gyrScale;
  const gyrY = dataView.getInt16(position + 8, true) * gyrScale;
  const gyrZ = dataView.getInt16(position + 10, true) * gyrScale;

  const mag = includeMag
    ? magOnly({ dataView, position: position + 12 })
    : undefined;

  return {
    acc: { x: accX, y: accY, z: accZ },
    gyro: { x: gyrX, y: gyrY, z: gyrZ },
    mag,
  };
}

function magOnly({
  dataView,
  position,
}: {
  dataView: DataView;
  position: number;
}) {
  const x = dataView.getInt16(position + 0, true) * MAG_SCALE;
  const y = dataView.getInt16(position + 2, true) * MAG_SCALE;
  const z = dataView.getInt16(position + 4, true) * MAG_SCALE;

  return { x, y, z };
}

export type ControlPacket = Record<string, unknown>;

export type UniversalPacket = {
  timestamp: Date;
  battery: number;
  data?: {
    quaternion?: Quat;
    quaternions?: Quat[];
    freeAcc?: Xyz;
    accelerometer?: Xyz;
    accelerometers?: Xyz[];
    gyroscope?: Xyz;
    gyroscopes?: Xyz[];
    magnetometer?: Xyz;
    magnetometers?: Xyz[];
  };
};
