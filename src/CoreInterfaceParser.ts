export class CoreInterfaceParser {
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
    packet[CoreInterfaceParser.PacketFieldAddress.Opcode] =
      CoreInterfaceParser.Opcode.Read;
    packet.set(
      new Uint8Array(new Uint32Array([address]).buffer),
      CoreInterfaceParser.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(new Uint16Array([length]).buffer),
      CoreInterfaceParser.PacketFieldAddress.Length
    );
    return packet;
  }

  static createDataPacket(address: number, data: Uint8Array) {
    const length = data.length;
    const packet = new Uint8Array(7 + length);
    packet[CoreInterfaceParser.PacketFieldAddress.Opcode] =
      CoreInterfaceParser.Opcode.Data;
    packet.set(
      new Uint8Array(new Uint32Array([address]).buffer),
      CoreInterfaceParser.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(new Uint16Array([length]).buffer),
      CoreInterfaceParser.PacketFieldAddress.Length
    );
    packet.set(data, CoreInterfaceParser.PacketFieldAddress.Data);
    return packet;
  }

  static createAbortPacket() {
    const packet = new Uint8Array(1);
    packet[CoreInterfaceParser.PacketFieldAddress.Opcode] =
      CoreInterfaceParser.Opcode.Abort;
    return packet;
  }

  static createStreamPacket() {
    const packet = new Uint8Array(7);
    packet[CoreInterfaceParser.PacketFieldAddress.Opcode] =
      CoreInterfaceParser.Opcode.Stream;
    packet.set(
      new Uint8Array(
        new Uint32Array([CoreInterfaceParser.STREAM_MEMORY_ADDRESS]).buffer
      ),
      CoreInterfaceParser.PacketFieldAddress.Address
    );
    packet.set(
      new Uint8Array(
        new Uint16Array([CoreInterfaceParser.STREAM_MEMORY_SIZE]).buffer
      ),
      CoreInterfaceParser.PacketFieldAddress.Length
    );
    return packet;
  }

  /**
   * @param {DataView} dataView
   */
  static parsePacket(dataView: DataView) {
    const packet = new Uint8Array(dataView.buffer); // Convert DataView to Uint8Array

    const opcode = packet[CoreInterfaceParser.PacketFieldAddress.Opcode];
    const address = dataView.getUint32(
      CoreInterfaceParser.PacketFieldAddress.Address,
      true
    );
    const length = dataView.getUint16(
      CoreInterfaceParser.PacketFieldAddress.Length,
      true
    );

    console.debug(`Opcode: ${opcode}\tAddress: ${address}\tLength: ${length}`);

    if (address + length <= CoreInterfaceParser.CONTROL_MEMORY_SIZE) {
      const data = packet.slice(
        CoreInterfaceParser.PacketFieldAddress.Data,
        CoreInterfaceParser.PacketFieldAddress.Data + length
      );
      return CoreInterfaceParser.parseControlMemory(data, address, length);
    } else if (
      address === CoreInterfaceParser.STREAM_MEMORY_ADDRESS &&
      length === CoreInterfaceParser.STREAM_MEMORY_SIZE
    ) {
      const data = packet.slice(
        CoreInterfaceParser.PacketFieldAddress.Data,
        CoreInterfaceParser.PacketFieldAddress.Data + length
      );
      return CoreInterfaceParser.parseStreamData(data);
    } else {
      throw new Error("Unknown packet type");
    }
  }

  static parseControlMemory(data: Uint8Array, address: number, length: number) {
    const dataInfo: ControlPacket & { control: true } = { control: true };

    if (
      address <= CoreInterfaceParser.MemoryAddress.WhoAmI &&
      address + length >= CoreInterfaceParser.MemoryAddress.WhoAmI + 4
    ) {
      const whoAmI = new DataView(data.buffer).getUint32(
        CoreInterfaceParser.MemoryAddress.WhoAmI - address,
        true
      );
      dataInfo[`WhoAmI`] = whoAmI;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Id &&
      address + length >= CoreInterfaceParser.MemoryAddress.Id + 8
    ) {
      const id = new DataView(data.buffer).getBigUint64(
        CoreInterfaceParser.MemoryAddress.Id - address,
        true
      );
      dataInfo[`Id`] = id;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.MacAddress &&
      address + length >= CoreInterfaceParser.MemoryAddress.MacAddress + 6
    ) {
      const macStart = CoreInterfaceParser.MemoryAddress.MacAddress - address;
      const macBytes = data.slice(macStart, macStart + 6);
      const macAddress = Array.from(macBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":");
      dataInfo[`MacAddress`] = macAddress;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Version &&
      address + length >= CoreInterfaceParser.MemoryAddress.Version + 4
    ) {
      const versionStart = CoreInterfaceParser.MemoryAddress.Version - address;
      const version = new DataView(data.buffer).getUint32(versionStart, true);
      dataInfo[`Version`] = version;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Battery &&
      address + length >= CoreInterfaceParser.MemoryAddress.Battery + 1
    ) {
      const battery = data[CoreInterfaceParser.MemoryAddress.Battery - address];
      dataInfo[`Battery: ${battery}%\n`] = battery;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.MotionLevel &&
      address + length >= CoreInterfaceParser.MemoryAddress.MotionLevel + 1
    ) {
      const motionLevel =
        data[CoreInterfaceParser.MemoryAddress.MotionLevel - address];
      dataInfo[`MotionLevel`] = motionLevel;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.OffsetCompensated &&
      address + length >=
        CoreInterfaceParser.MemoryAddress.OffsetCompensated + 1
    ) {
      const offsetCompensated =
        data[CoreInterfaceParser.MemoryAddress.OffsetCompensated - address];
      dataInfo[`OffsetCompensated`] = offsetCompensated;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.MagneticFieldMapped &&
      address + length >=
        CoreInterfaceParser.MemoryAddress.MagneticFieldMapped + 1
    ) {
      const magneticFieldMapped =
        data[CoreInterfaceParser.MemoryAddress.MagneticFieldMapped - address];
      dataInfo[`MagneticFieldMapped`] = magneticFieldMapped;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.MagneticFieldProgress &&
      address + length >=
        CoreInterfaceParser.MemoryAddress.MagneticFieldProgress + 1
    ) {
      const magneticFieldProgress =
        data[CoreInterfaceParser.MemoryAddress.MagneticFieldProgress - address];
      dataInfo[`MagneticFieldProgress`] = magneticFieldProgress;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.ConnectionInterval &&
      address + length >=
        CoreInterfaceParser.MemoryAddress.ConnectionInterval + 1
    ) {
      const connectionInterval =
        data[CoreInterfaceParser.MemoryAddress.ConnectionInterval - address];
      dataInfo[`ConnectionInterval`] = connectionInterval;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.SyncStatus &&
      address + length >= CoreInterfaceParser.MemoryAddress.SyncStatus + 1
    ) {
      const syncStatus =
        data[CoreInterfaceParser.MemoryAddress.SyncStatus - address];
      dataInfo[`SyncStatus`] = syncStatus;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Ticks100Hz &&
      address + length >= CoreInterfaceParser.MemoryAddress.Ticks100Hz + 4
    ) {
      const ticks100Hz = new DataView(data.buffer).getUint32(
        CoreInterfaceParser.MemoryAddress.Ticks100Hz - address,
        true
      );
      dataInfo[`Ticks100Hz`] = ticks100Hz;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Pin &&
      address + length >= CoreInterfaceParser.MemoryAddress.Pin + 4
    ) {
      const pin = new DataView(data.buffer).getUint32(
        CoreInterfaceParser.MemoryAddress.Pin - address,
        true
      );
      dataInfo[`Pin`] = pin;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Time &&
      address + length >= CoreInterfaceParser.MemoryAddress.Time + 4
    ) {
      const time = new DataView(data.buffer).getUint32(
        CoreInterfaceParser.MemoryAddress.Time - address,
        true
      );
      dataInfo[`Time`] = time;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Annotation &&
      address + length >= CoreInterfaceParser.MemoryAddress.Annotation + 2
    ) {
      const annotationStart =
        CoreInterfaceParser.MemoryAddress.Annotation - address;
      const annotation = new DataView(data.buffer).getUint16(
        annotationStart,
        true
      );
      dataInfo[`Annotation`] = annotation;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.DeviceState &&
      address + length >= CoreInterfaceParser.MemoryAddress.DeviceState + 2
    ) {
      const deviceStateStart =
        CoreInterfaceParser.MemoryAddress.DeviceState - address;
      const deviceState = new DataView(data.buffer).getUint16(
        deviceStateStart,
        true
      );
      dataInfo[`DeviceState`] = deviceState;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.DeviceName &&
      address + length >= CoreInterfaceParser.MemoryAddress.DeviceName + 12
    ) {
      const name = new TextDecoder().decode(
        data.slice(
          CoreInterfaceParser.MemoryAddress.DeviceName - address,
          CoreInterfaceParser.MemoryAddress.DeviceName - address + 12
        )
      );
      dataInfo[`Device Name`] = name;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.DataMode &&
      address + length >= CoreInterfaceParser.MemoryAddress.DataMode + 1
    ) {
      const dataMode =
        data[CoreInterfaceParser.MemoryAddress.DataMode - address];
      dataInfo[`DataMode`] = dataMode;
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.Timesync &&
      address + length >= CoreInterfaceParser.MemoryAddress.Timesync + 1
    ) {
      const timesyncByte =
        data[CoreInterfaceParser.MemoryAddress.Timesync - address];
      const isEnabled = (timesyncByte & 0x7f) !== 0x00;
      const isMaster = isEnabled && (timesyncByte & 0x80) !== 0x00;
      const networkKey = timesyncByte & 0x7f;

      if (!isEnabled) {
        dataInfo[`Timesync`] = { isEnabled };
      } else {
        dataInfo[`Timesync`] = { isEnabled, isMaster, networkKey };
      }
    }

    if (
      address <= CoreInterfaceParser.MemoryAddress.AlgorithmSelection &&
      address + length >=
        CoreInterfaceParser.MemoryAddress.AlgorithmSelection + 1
    ) {
      const algorithm =
        data[CoreInterfaceParser.MemoryAddress.AlgorithmSelection - address] ===
        0
          ? "9 DoF"
          : "6 DoF";
      dataInfo[`Algorithm Selection`] = algorithm;
    }

    return dataInfo;
  }

  /**
   * @param {Uint8Array} data
   */
  static parseStreamData(data: Uint8Array): DataPacket {
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
    console.debug(
      [
        `Stream Data Header:`,
        `Data Mode: ${dataModes[mode]}`,
        `Buffering: ${buffering}`,
        `Timestamp: ${timestamp.toISOString()}`,
        `Interference: ${interference}`,
        `Battery: ${battery}%`,
        `Annotation: ${annotation}`,
        `Sync. Status: ${syncStatus}`,
        `Accelerometer range: ${accRanges[accRangeIndex]}`,
        `Gyroscope range: ${gyroRanges[gyroRangeIndex]}`,
      ].join("\n")
    );

    let packet;
    switch (mode) {
      case CoreInterfaceParser.DataMode.Mixed:
        packet = CoreInterfaceParser.parseMixedPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case CoreInterfaceParser.DataMode.Raw:
        packet = CoreInterfaceParser.parseRawPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case CoreInterfaceParser.DataMode.Quat:
        packet = CoreInterfaceParser.parseQuatPacket(data, buffering);
        break;
      case CoreInterfaceParser.DataMode.Optimized:
        packet = CoreInterfaceParser.parseOptimizedPacket(
          data,
          buffering,
          accScale,
          gyrScale
        );
        break;
      case CoreInterfaceParser.DataMode.QuatMag:
        packet = CoreInterfaceParser.parseQuatMagPacket(data, buffering);
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
    console.debug("Parsing Mixed Packet", array, buffering);
    const dataView = new DataView(array.slice(10).buffer);

    // Parse quaternion data (16 bytes: 4 floats)
    const w = dataView.getFloat32(0, true);
    const x = dataView.getFloat32(4, true);
    const y = dataView.getFloat32(8, true);
    const z = dataView.getFloat32(12, true);
    const quaternionData = { w, x, y, z };

    // Parse free acceleration data (12 bytes: 3 floats)
    const freeAccX = dataView.getFloat32(16, true);
    const freeAccY = dataView.getFloat32(20, true);
    const freeAccZ = dataView.getFloat32(24, true);
    const freeAccData = { freeAccX, freeAccY, freeAccZ };

    console.debug("Parsed Quaternion Data:", quaternionData);
    console.debug("Parsed Free Acceleration Data:", freeAccData);

    const mixedData = [];

    // Iterate for each buffered sample to extract raw sensor data
    for (let i = 0; i < buffering; i++) {
      const offset = 28 + i * 18; // After the first 28 bytes, each sample is 18 bytes
      const nineDof = raw9Dof({
        dataView,
        position: offset,
        accScale,
        gyrScale,
        includeMag: true,
      });
      mixedData.push(nineDof);
    }

    console.debug("Parsed Mixed Data:", mixedData);
    return { quaternionData, freeAccData, mixedData };
  }

  static parseRawPacket(
    array: Uint8Array,
    buffering: number,
    accScale: number,
    gyrScale: number
  ) {
    console.debug("Parsing Raw Packet", array, buffering);

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

    console.debug("Parsed Raw Data:", rawData);
    return rawData;
  }

  static parseQuatPacket(array: Uint8Array, buffering: number) {
    console.debug("Parsing Quaternion Packet", array, buffering);
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

    console.debug("Parsed Quaternions:", quaternions);
    return quaternions;
  }

  static parseOptimizedPacket(
    array: Uint8Array,
    buffering: number,
    accScale: number,
    gyrScale: number
  ) {
    console.debug("Parsing Optimized Packet", array, buffering);
    // C# uses HEADER_LENGTH offset and parses quaternion and then raw data
    const HEADER_LENGTH = CoreInterfaceParser.HEADER_LENGTH;
    const dataView = new DataView(array.buffer);

    // Parse quaternion data (buffering samples, each 8 bytes: 4 x int16)
    const quaternionData = [];
    let index = HEADER_LENGTH;
    for (let j = 0; j < buffering; j++) {
      // C#: W,X,Y,Z = int16/32767.0f
      const w = dataView.getInt16(index, true) / 32767.0;
      const x = dataView.getInt16(index + 2, true) / 32767.0;
      const y = dataView.getInt16(index + 4, true) / 32767.0;
      const z = dataView.getInt16(index + 6, true) / 32767.0;
      quaternionData.push({ w, x, y, z });
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

    console.debug("Parsed Quaternion Data:", quaternionData);
    console.debug("Parsed Raw Data:", rawData);
    return { quaternionData, rawData };
  }

  static parseQuatMagPacket(array: Uint8Array, buffering: number) {
    console.debug("Parsing Quaternion+Magnetic Packet", array, buffering);
    const dataView = new DataView(array.buffer);

    const quatMagData = [];

    for (let i = 0; i < buffering; i++) {
      const offset = i * 28; // Each entry is 28 bytes (16 for quaternion, 12 for magnetometer)
      const w = dataView.getFloat32(offset, true);
      const x = dataView.getFloat32(offset + 4, true);
      const y = dataView.getFloat32(offset + 8, true);
      const z = dataView.getFloat32(offset + 12, true);

      const mag = magOnly({ dataView, position: offset + 16 });

      quatMagData.push({ w, x, y, z, ...mag });
    }

    console.debug("Parsed Quaternion+Magnetic Data:", quatMagData);
    return quatMagData;
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
 * @returns {{
 *  accX: number;
 *  accY: number;
 *  accZ: number;
 *  gyrX: number;
 *  gyrY: number;
 *  gyrZ: number;
 *  magX?: number;
 *  magY?: number;
 *  magZ?: number;
 * }} An object containing the parsed sensor data
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
}): {
  accX: number;
  accY: number;
  accZ: number;
  gyrX: number;
  gyrY: number;
  gyrZ: number;
  magX?: number;
  magY?: number;
  magZ?: number;
} {
  const accX = dataView.getInt16(position, true) * accScale;
  const accY = dataView.getInt16(position + 2, true) * accScale;
  const accZ = dataView.getInt16(position + 4, true) * accScale;
  const gyrX = dataView.getInt16(position + 6, true) * gyrScale;
  const gyrY = dataView.getInt16(position + 8, true) * gyrScale;
  const gyrZ = dataView.getInt16(position + 10, true) * gyrScale;

  const mag = includeMag ? magOnly({ dataView, position: position + 12 }) : {};

  return { accX, accY, accZ, gyrX, gyrY, gyrZ, ...mag };
}

function magOnly({
  dataView,
  position,
}: {
  dataView: DataView;
  position: number;
}) {
  const magX = dataView.getInt16(position + 0, true) * MAG_SCALE;
  const magY = dataView.getInt16(position + 2, true) * MAG_SCALE;
  const magZ = dataView.getInt16(position + 4, true) * MAG_SCALE;

  return { magX, magY, magZ };
}

type Raw9Dof = {
  accX: number;
  accY: number;
  accZ: number;
  gyrX: number;
  gyrY: number;
  gyrZ: number;
  magX?: number | undefined;
  magY?: number | undefined;
  magZ?: number | undefined;
};

type Quat = {
  w: number;
  x: number;
  y: number;
  z: number;
};

export type ControlPacket = Record<string, unknown>;

export type DataPacket = {
  timestamp: Date;
  battery: number;
  data?:
    | Raw9Dof[]
    | {
        quaternionData: Quat;
        freeAccData: {
          freeAccX: number;
          freeAccY: number;
          freeAccZ: number;
        };
        mixedData: Raw9Dof[];
      }
    | Quat[]
    | {
        quaternionData: Quat[];
        rawData: Raw9Dof[];
      };
};
