import { action, makeAutoObservable, runInAction } from "mobx";
import type { Quat, BluetoothSensor, SensorPacket, Xyz } from "./BaseInterface";
import { getUartDeviceAndChars } from "./uart";

type PacketHandler = (packet: SensorPacket) => unknown;

export class YostSensor implements BluetoothSensor {
  readonly technology = "YostLabs";
  serial?: string;
  version?: string;
  onReceivePacket: PacketHandler;
  private device: BluetoothDevice;
  private rxChar: BluetoothRemoteGATTCharacteristic;
  private txChar: BluetoothRemoteGATTCharacteristic;
  private command?: {
    resolve: (value: string) => void;
    reject: (reason: unknown) => unknown;
    property: string;
  };
  _connected = false;
  _streaming = false;
  startStreamingPromise?: {
    resolve: (value: unknown) => void;
    reject: () => void;
  };
  onDispose: () => void;
  private buffer?: DataView;

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
    let sensor: YostSensor | undefined = undefined;

    const { device, txChar, rxChar } = await getUartDeviceAndChars({
      namePrefix: "YL-TSS",
    });

    sensor = new YostSensor({
      device,
      txChar,
      rxChar,
      onReceivePacket,
    });
    Object.assign(window, { sensor });
    await sensor.init();

    return sensor;
  }

  private async init() {
    await this.txChar.startNotifications();
    await this.stopStreaming();

    this.serial = await this.getValue("serial_number");
    this.version = await this.getValue("version_firmware");

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

  async sendCommand(command: string, property: string = "") {
    this.command?.reject("Superseded");
    console.debug(command);
    await this.rxChar.writeValueWithoutResponse(
      new TextEncoder().encode(command)
    );
    return (await new Promise(
      (resolve, reject) => (this.command = { resolve, reject, property })
    ).finally(() => (this.command = undefined))) as string;
  }

  async getValue(property: string): Promise<string> {
    return this.sendCommand(`?{${property}}\n`, property);
  }

  async setValue(property: string, value: string) {
    return this.sendCommand(`!{${property}}={${value}}\n`, property);
  }

  private handleData(event: Event) {
    let value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    if (this.buffer) {
      value = joinDataViews(this.buffer, value);
    }
    const str = new TextDecoder("utf-8").decode(value);
    const messages = str.split("\r\n");
    const lastMessage = messages.pop();
    if (lastMessage) {
      // console.debug(`Extending buffer ${lastMessage?.length}`);
      this.buffer = new DataView(
        new TextEncoder().encode(`${lastMessage}`).buffer
      );
    } else if (this.buffer) {
      // console.debug("Resetting buffer");
      this.buffer = undefined;
    }

    for (const message of messages) {
      try {
        this.handleMessage(message);
      } catch (error) {
        console.warn(error);
        // Move on to next message regardless
      }
    }
  }

  private handleMessage(data: string) {
    if (data.match(PACKET_PATTERN)?.length) {
      // if (data.split(";").length === 5) {
      const packet = parsePacket(data);
      this.startStreamingPromise?.resolve(undefined);
      this.onReceivePacket(packet);
    } else if (data.match(RESPONSE_PATTERN)?.length) {
      const [error, _writes] = data.split(",").map(parseInt);
      if (error) {
        this.command?.reject(new Error(ERROR_CODES[error]));
      } else {
        this.command?.resolve(undefined as never);
      }
    } else {
      let body: Record<string, string> = {};
      if (data.includes("=")) {
        body = Object.fromEntries(data.split(";").map((kv) => kv.split("=")));
        console.debug(body);
      } else {
        console.debug(JSON.stringify(data));
      }
      if (this.command && this.command.property in body) {
        this.command?.resolve(body[this.command.property]);
      } else {
        this.command?.resolve(undefined as never);
      }
    }
  }

  handleDisconnect() {
    runInAction(() => (this._connected = false));
  }

  async startStreaming() {
    await this.sendCommand("!stream_hz=100\n");
    await this.sendCommand(
      // Time, Quat (x,y,z,w), Accel, Gyro, Mag
      `!stream_slots=94,0,39,38,40\n`
    );
    await this.rxChar.writeValue(new TextEncoder().encode(`:85\n`));
    await new Promise((resolve, reject) =>
      runInAction(() => {
        this.startStreamingPromise = { resolve, reject };
      })
    )
      .then(action(() => (this._streaming = true)))
      .finally(action(() => (this.startStreamingPromise = undefined)));
  }

  async stopStreaming() {
    await this.rxChar.writeValueWithoutResponse(
      new TextEncoder().encode(`:86\n`)
    );
    runInAction(() => (this._streaming = false));
  }
}

const RESPONSE_PATTERN = /^[0-9]+,[0-9]+$/g;

const ERROR_CODES: Record<number, string> = {
  0: "Success",
  1: "Generic Error",
  2: "Invalid Key/Readonly",
  3: "Invalid Value",
};

const PACKET_PATTERN =
  /^[0-9]+;[-0-9.]+,[-0-9.]+,[-0-9.]+,[-0-9.]+(?:;[-0-9.]+,[-0-9.]+,[-0-9.]+){3}$/g;

function parsePacket(data: string): SensorPacket {
  const [timeStr, quatStr, accStr, gyroStr, magStr] = data.split(";");
  const time = parseInt(timeStr) / 1_000_000;
  const quaternion = parseQuat(quatStr);
  const accelerometer = parseXyz(accStr);
  const gyroscope = parseXyz(gyroStr);
  const magnetometer = parseXyz(magStr);
  return { time, quaternion, accelerometer, gyroscope, magnetometer };
}

function parseQuat(value: string): Quat {
  const [x, y, z, w] = value.split(",").map(parseFloat);
  return { w, x, y, z };
}

function parseXyz(value: string): Xyz {
  const [x, y, z] = value.split(",").map(parseFloat);
  return { x, y, z };
}

function joinDataViews(buffer1: DataView, buffer2: DataView) {
  const out = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  out.set(new Uint8Array(buffer1.buffer), 0);
  out.set(new Uint8Array(buffer2.buffer), buffer1.byteLength);
  return new DataView(out.buffer);
}

class ThreespaceCommand {
  static BINARY_START_BYTE = 0xf7;
  static BINARY_START_BYTE_HEADER = 0xf9;
  info: {
    name: string;
    num: number;
    in_format: string;
    out_format: string;
  };
  // in_format: any;
  // out_format: any;
  custom_func?: (value: unknown) => unknown;

  constructor(
    name: string,
    num: number,
    in_format: string,
    out_format: string,
    custom_func?: (value: unknown) => unknown
  ) {
    this.info = { name, num, in_format, out_format };
    // this.in_format = _3space_format_to_external(self.info.in_format);
    // this.out_format = _3space_format_to_external(self.info.out_format);
    this.custom_func = custom_func;
  }
}

const COMMANDS: ThreespaceCommand[] = [
  // Tared Orientation
  new ThreespaceCommand("getTaredOrientation", 0, "", "ffff"),
  new ThreespaceCommand("getTaredOrientationAsEulerAngles", 1, "", "fff"),
  new ThreespaceCommand(
    "getTaredOrientationAsRotationMatrix",
    2,
    "",
    "fffffffff"
  ),
  new ThreespaceCommand("getTaredOrientationAsAxisAngles", 3, "", "ffff"),
  new ThreespaceCommand("getTaredOrientationAsTwoVector", 4, "", "ffffff"),

  // Weird
  new ThreespaceCommand("getDifferenceQuaternion", 5, "", "ffff"),

  // Untared Orientation
  new ThreespaceCommand("getUntaredOrientation", 6, "", "ffff"),
  new ThreespaceCommand("getUntaredOrientationAsEulerAngles", 7, "", "fff"),
  new ThreespaceCommand(
    "getUntaredOrientationAsRotationMatrix",
    8,
    "",
    "fffffffff"
  ),
  new ThreespaceCommand("getUntaredOrientationAsAxisAngles", 9, "", "ffff"),
  new ThreespaceCommand("getUntaredOrientationAsTwoVector", 10, "", "ffffff"),

  // Late orientation additions
  new ThreespaceCommand("getTaredTwoVectorInSensorFrame", 11, "", "ffffff"),
  new ThreespaceCommand("getUntaredTwoVectorInSensorFrame", 12, "", "ffffff"),

  new ThreespaceCommand("getPrimaryBarometerPressure", 13, "", "f"),
  new ThreespaceCommand("getPrimaryBarometerAltitude", 14, "", "f"),
  new ThreespaceCommand("getBarometerAltitude", 15, "b", "f"),
  new ThreespaceCommand("getBarometerPressure", 16, "b", "f"),

  new ThreespaceCommand("setOffsetWithCurrentOrientation", 19, "", ""),
  new ThreespaceCommand("resetBaseOffset", 20, "", ""),
  new ThreespaceCommand("setBaseOffsetWithCurrentOrientation", 22, "", ""),

  new ThreespaceCommand("getAllPrimaryNormalizedData", 32, "", "fffffffff"),
  new ThreespaceCommand("getPrimaryNormalizedGyroRate", 33, "", "fff"),
  new ThreespaceCommand("getPrimaryNormalizedAccelVec", 34, "", "fff"),
  new ThreespaceCommand("getPrimaryNormalizedMagVec", 35, "", "fff"),

  new ThreespaceCommand("getAllPrimaryCorrectedData", 37, "", "fffffffff"),
  new ThreespaceCommand("getPrimaryCorrectedGyroRate", 38, "", "fff"),
  new ThreespaceCommand("getPrimaryCorrectedAccelVec", 39, "", "fff"),
  new ThreespaceCommand("getPrimaryCorrectedMagVec", 40, "", "fff"),

  new ThreespaceCommand("getPrimaryGlobalLinearAccel", 41, "", "fff"),
  new ThreespaceCommand("getPrimaryLocalLinearAccel", 42, "", "fff"),

  new ThreespaceCommand("getTemperatureCelsius", 43, "", "f"),
  new ThreespaceCommand("getTemperatureFahrenheit", 44, "", "f"),

  new ThreespaceCommand("getMotionlessConfidenceFactor", 45, "", "f"),

  new ThreespaceCommand("correctRawGyroData", 48, "fffb", "fff"),
  new ThreespaceCommand("correctRawAccelData", 49, "fffb", "fff"),
  new ThreespaceCommand("correctRawMagData", 50, "fffb", "fff"),

  new ThreespaceCommand("getNormalizedGyroRate", 51, "b", "fff"),
  new ThreespaceCommand("getNormalizedAccelVec", 52, "b", "fff"),
  new ThreespaceCommand("getNormalizedMagVec", 53, "b", "fff"),

  new ThreespaceCommand("getCorrectedGyroRate", 54, "b", "fff"),
  new ThreespaceCommand("getCorrectedAccelVec", 55, "b", "fff"),
  new ThreespaceCommand("getCorrectedMagVec", 56, "b", "fff"),

  new ThreespaceCommand("enableMSC", 57, "", ""),
  new ThreespaceCommand("disableMSC", 58, "", ""),

  new ThreespaceCommand("formatSd", 59, "", ""),
  new ThreespaceCommand(
    "startDataLogging",
    60,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__startDataLogging
  ),
  new ThreespaceCommand(
    "stopDataLogging",
    61,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__stopDataLogging
  ),

  new ThreespaceCommand("setDateTime", 62, "Bbbbbb", ""),
  new ThreespaceCommand("getDateTime", 63, "", "Bbbbbb"),

  new ThreespaceCommand("getRawGyroRate", 65, "b", "fff"),
  new ThreespaceCommand("getRawAccelVec", 66, "b", "fff"),
  new ThreespaceCommand("getRawMagVec", 67, "b", "fff"),

  new ThreespaceCommand("eeptsStart", 68, "", ""),
  new ThreespaceCommand("eeptsStop", 69, "", ""),
  new ThreespaceCommand("eeptsGetOldestStep", 70, "", "uuddffffffbbff"),
  new ThreespaceCommand("eeptsGetNewestStep", 71, "", "uuddffffffbbff"),
  new ThreespaceCommand("eeptsGetNumStepsAvailable", 72, "", "b"),
  new ThreespaceCommand("eeptsInsertGPS", 73, "dd", ""),
  new ThreespaceCommand("eeptsAutoOffset", 74, "", ""),

  new ThreespaceCommand("getStreamingLabel", 83, "b", "S"),
  new ThreespaceCommand("getStreamingBatch", 84, "", "S"),
  new ThreespaceCommand(
    "startStreaming",
    85,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__startStreaming
  ),
  new ThreespaceCommand(
    "stopStreaming",
    86,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__stopStreaming
  ),
  new ThreespaceCommand("pauseLogStreaming", 87, "b", ""),

  new ThreespaceCommand("getDateTimeString", 93, "", "S"),
  new ThreespaceCommand("getTimestamp", 94, "", "U"),

  new ThreespaceCommand("tareWithCurrentOrientation", 96, "", ""),
  new ThreespaceCommand("setBaseTareWithCurrentOrientation", 97, "", ""),

  new ThreespaceCommand("resetFilter", 120, "", ""),
  new ThreespaceCommand("getNumDebugMessages", 126, "", "B"),
  new ThreespaceCommand("getOldestDebugMessage", 127, "", "S"),
  new ThreespaceCommand("selfTest", 128, "", "u"),

  new ThreespaceCommand("beginPassiveAutoCalibration", 165, "b", ""),
  new ThreespaceCommand("getActivePassiveAutoCalibration", 166, "", "b"),
  new ThreespaceCommand("beginActiveAutoCalibration", 167, "", ""),
  new ThreespaceCommand("isActiveAutoCalibrationActive", 168, "", "b"),

  new ThreespaceCommand("getLastLogCursorInfo", 170, "", "US"),
  new ThreespaceCommand("getNextDirectoryItem", 171, "", "bsU"),
  new ThreespaceCommand("changeDirectory", 172, "S", ""),
  new ThreespaceCommand("openFile", 173, "S", ""),
  new ThreespaceCommand("closeFile", 174, "", ""),
  new ThreespaceCommand("fileGetRemainingSize", 175, "", "U"),
  new ThreespaceCommand("fileReadLine", 176, "", "S"),
  new ThreespaceCommand(
    "fileReadBytes",
    177,
    "B",
    "S"
    // ThreespaceSensor._ThreespaceSensor__fileReadBytes
  ), // This has to be handled specially as the output is variable length BYTES not STRING
  new ThreespaceCommand("deleteFile", 178, "S", ""),
  new ThreespaceCommand("setCursor", 179, "U", ""),
  new ThreespaceCommand(
    "fileStartStream",
    180,
    "",
    "U"
    // ThreespaceSensor._ThreespaceSensor__fileStartStream
  ),
  new ThreespaceCommand(
    "fileStopStream",
    181,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__fileStopStream
  ),

  new ThreespaceCommand("getBatteryCurrent", 200, "", "I"),
  new ThreespaceCommand("getBatteryVoltage", 201, "", "f"),
  new ThreespaceCommand("getBatteryPercent", 202, "", "b"),
  new ThreespaceCommand("getBatteryStatus", 203, "", "b"),

  new ThreespaceCommand("getGpsCoord", 215, "", "dd"),
  new ThreespaceCommand("getGpsAltitude", 216, "", "f"),
  new ThreespaceCommand("getGpsFixState", 217, "", "b"),
  new ThreespaceCommand("getGpsHdop", 218, "", "f"),
  new ThreespaceCommand("getGpsSatellites", 219, "", "b"),

  new ThreespaceCommand("commitSettings", 225, "", ""),
  new ThreespaceCommand(
    "softwareReset",
    226,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__softwareReset
  ),
  new ThreespaceCommand(
    "enterBootloader",
    229,
    "",
    ""
    // ThreespaceSensor._ThreespaceSensor__enterBootloader
  ),

  new ThreespaceCommand("getButtonState", 250, "", "b"),
];

export const _COMMANDS_BY_NAME = Object.fromEntries(
  COMMANDS.map((c) => [c.info.name, c])
);
