import { useRef, useState } from "react";
import "./App.css";
import {
  CoreInterfaceParser,
  type ControlPacket,
  type DataPacket,
} from "./CoreInterfaceParser";

function App() {
  const [sensor, setSensor] = useState(undefined as Sensor | undefined);
  const [packet, setPacket] = useState(undefined as DataPacket | undefined);

  const onReceivePacket = useRef((packet: DataPacket) => {
    setPacket(packet);
  }).current;

  return (
    <>
      <div className="card">
        <button
          onClick={async () => setSensor(await connect({ onReceivePacket }))}
        >
          Connect
        </button>
      </div>
      {sensor ? (
        <>
          Sensor connected
          <div>
            <button onClick={async () => sensor.startStreaming()}>
              Start Streaming
            </button>
          </div>
        </>
      ) : (
        "No sensor connected"
      )}
      <pre>{JSON.stringify(packet, undefined, 2)}</pre>
    </>
  );
}

// Nordic UART Service (NUS) (https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/libraries/bluetooth/services/nus.html)
const _bluetooth = navigator.bluetooth;
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

async function connect({
  onReceivePacket,
}: {
  onReceivePacket: PacketHandler;
}) {
  // Request device
  const device = await _bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }],
  });
  device.addEventListener("gattserverdisconnected", () => {
    console.log("disconnected");
  });
  if (!device.gatt) return;

  // Connect to GATT server
  const server = await device.gatt.connect();

  // Get service
  const service = await server.getPrimaryService(SERVICE_UUID);
  // window.service = service

  // Get characteristic
  const rxChar = await service.getCharacteristic(RX_CHAR_UUID);
  const txChar = await service.getCharacteristic(TX_CHAR_UUID);
  const sensor = new Sensor({ device, txChar, rxChar, onReceivePacket });
  await sensor.init();
  Object.assign(window, { sensor });

  return sensor;
}

type PacketHandler = (packet: DataPacket) => unknown;

class Sensor {
  device: BluetoothDevice;
  rxChar: BluetoothRemoteGATTCharacteristic;
  txChar: BluetoothRemoteGATTCharacteristic;
  onReceivePacket: PacketHandler;
  command?: {
    resolve: (value: ControlPacket) => void;
    reject: (reason: unknown) => unknown;
  };

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
  }

  async init() {
    // Subscribe to notifications
    this.device.addEventListener("gattserverdisconnected", () => {
      console.log("disconnected");
    });

    await this.txChar.startNotifications();
    this.txChar.addEventListener("characteristicvaluechanged", (e) =>
      this.handleData(e)
    );

    // Use pin "love" to unlock sensor
    const pinPacket = CoreInterfaceParser.createDataPacket(
      CoreInterfaceParser.MemoryAddress.Pin,
      new TextEncoder().encode("love")
    );
    await this.rxChar.writeValueWithoutResponse(pinPacket);

    console.log("Connected");
    await this.setValue(CoreInterfaceParser.MemoryAddress.DataMode, [
      CoreInterfaceParser.DataMode.Optimized,
    ]);
    const info = await this.getValue(
      CoreInterfaceParser.MemoryAddress.DataMode,
      1
    );
    console.log(info);
    console.log(`Data mode set to ${info.DataMode}`);
  }

  async getValue(address: number, length: number): Promise<ControlPacket> {
    const dataPacket = CoreInterfaceParser.createReadPacket(address, length);
    const buffer = dataPacket.buffer;
    this.command?.reject("Superseded");
    await this.rxChar.writeValueWithoutResponse(buffer);
    return (await new Promise(
      (resolve, reject) => (this.command = { resolve, reject })
    ).finally(() => (this.command = undefined))) as ControlPacket;
  }

  async setValue(address: number, value: Array<number>) {
    const dataPacket = CoreInterfaceParser.createDataPacket(
      address,
      new Uint8Array(value)
    );
    this.command?.reject("Superseded");
    await this.rxChar.writeValueWithoutResponse(dataPacket);
    return (await new Promise(
      (resolve, reject) => (this.command = { resolve, reject })
    ).finally(() => (this.command = undefined))) as ControlPacket;
  }

  handleData(event: Event) {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const data = CoreInterfaceParser.parsePacket(value);
    if ("control" in data) {
      this.command?.resolve(data);
    } else {
      this.onReceivePacket(data);
    }
  }

  async startStreaming() {
    const packet = CoreInterfaceParser.createDataPacket(
      CoreInterfaceParser.MemoryAddress.DataMode,
      new Uint8Array([CoreInterfaceParser.DataMode.Optimized])
    );
    await this.rxChar.writeValueWithoutResponse(packet);
    const streamPacket = CoreInterfaceParser.createStreamPacket();
    await this.rxChar.writeValueWithoutResponse(streamPacket);
  }
}

export default App;
