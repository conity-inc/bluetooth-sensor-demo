// Nordic UART Service (NUS) (https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/libraries/bluetooth/services/nus.html)
const _bluetooth = navigator.bluetooth;
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

type UartDeviceAndChars = {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer;
  service: BluetoothRemoteGATTService;
  rxChar: BluetoothRemoteGATTCharacteristic;
  txChar: BluetoothRemoteGATTCharacteristic;
};

export async function getUartDeviceAndChars({
  name,
  namePrefix,
  maxAttempts = 10,
}: {
  name?: string;
  namePrefix?: string;
  maxAttempts?: number;
} = {}) {
  type Resolve = (value: UartDeviceAndChars) => void;
  let resolve: Resolve = () => {};
  let reject: (value: Error) => void = () => {};
  let settled = false;
  const promise = new Promise((resolve_: Resolve, reject_) => {
    resolve = resolve_;
    reject = reject_;
  }).finally(() => (settled = true));

  // Request device
  const device = await _bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID], name, namePrefix }],
  });
  if (!device.gatt) throw new Error("No GATT server");
  const server = device.gatt;
  // device.addEventListener("gattserverdisconnected", () => {
  //   console.log("disconnected");
  //   // reject(new Error("Disconnected"));
  // });

  // Connect to GATT server
  let remainingAttempts = maxAttempts;
  let service, rxChar, txChar;
  while (!settled && remainingAttempts--) {
    try {
      await server.connect();
      service ??= await server.getPrimaryService(SERVICE_UUID);
      rxChar ??= await service.getCharacteristic(RX_CHAR_UUID);
      txChar ??= await service.getCharacteristic(TX_CHAR_UUID);
      resolve?.({ device, server, service, rxChar, txChar });
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
