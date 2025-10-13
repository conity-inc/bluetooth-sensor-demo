import { makeAutoObservable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { useRef } from "react";
import "./App.css";
import type { SensorInterface, SensorPacket } from "./BaseInterface";
import { QsenseSensor, type UniversalPacket } from "./QsenseInterface";
import { YostSensor } from "./YostInterface";

const App = observer(function App() {
  const sensorData = useRef(new SensorData()).current;
  const sensor = sensorData.sensor;

  const onReceiveQsensePacket = useRef((p: UniversalPacket) => {
    if (!p.data?.quaternions) return;
    const packets = p.data.quaternions.map((q, i) => {
      return {
        time: p.timestamp.getTime() / 1_000,
        quaternion: q,
        accelerometer: p.data?.accelerometers?.[i] ?? p.data?.accelerometer,
        gyroscope: p.data?.gyroscopes?.[i] ?? p.data?.gyroscope,
        magnetometer: p.data?.magnetometers?.[i] ?? p.data?.magnetometer,
      };
    });
    sensorData.streamingQueue.push(...packets);
  }).current;

  const onReceiveYostPacket = useRef((p: SensorPacket) => {
    sensorData.streamingQueue.push(p);
  }).current;

  return (
    <>
      <h1>Bluetooth Sensor Demo</h1>
      <div className="card">
        <button
          onClick={() =>
            QsenseSensor.create({
              onReceivePacket: onReceiveQsensePacket,
            }).then((s) => sensorData.setSensor(s))
          }
        >
          Connect QSense
        </button>

        <button
          onClick={() =>
            YostSensor.create({
              onReceivePacket: onReceiveYostPacket,
            }).then((s) => sensorData.setSensor(s))
          }
        >
          Connect Yost
        </button>
      </div>
      <div>
        <h2>Sensor</h2>
      </div>
      {sensor?.connected ? (
        <>
          <p>Sensor Status: Connected</p>
          <p>Serial: {sensor?.serial}</p>
          <p>Version: {sensor?.version}</p>
          <div>
            {sensor.streaming ? (
              <button onClick={async () => sensor.stopStreaming()}>
                Stop Streaming
              </button>
            ) : (
              <button onClick={async () => sensor.startStreaming()}>
                Start Streaming
              </button>
            )}
          </div>
        </>
      ) : (
        <p>Sensor Status: Disconnected</p>
      )}

      <QueueView sensorData={sensorData} canReset={!sensor?.streaming} />
    </>
  );
});

const QueueView = observer(function ({
  sensorData,
  canReset,
}: {
  sensorData: SensorData;
  canReset: boolean;
}) {
  return (
    <div>
      <h2>Queue</h2>
      <p>Total Packets: {sensorData.streamingQueue.length}</p>
      {canReset && (
        <button onClick={() => sensorData.resetQueue()}>Reset Queue</button>
      )}
      {canReset && (
        <button
          onClick={() => {
            if (!sensorData.sensor) return;
            const data = JSON.stringify(
              {
                technology: sensorData.sensor.technology,
                serial: sensorData.sensor.serial,
                version: sensorData.sensor.version,
                ...formatQueue(sensorData.streamingQueue),
              },
              undefined,
              2
            );
            const blob = new Blob([data], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `Sensor Recording ${new Date().toISOString()}.json`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download Queue
        </button>
      )}
      <pre>
        {JSON.stringify(sensorData.streamingQueue.at(-1), undefined, 2)}
      </pre>
    </div>
  );
});

class SensorData {
  sensor: SensorInterface | undefined;
  streamingQueue: SensorPacket[];

  constructor() {
    this.streamingQueue = [];
    makeAutoObservable(this);
  }

  resetQueue() {
    runInAction(() => (this.streamingQueue = []));
  }

  setSensor(sensor: SensorInterface) {
    runInAction(() => {
      this.sensor = sensor;
      this.resetQueue();
    });
  }
}

function formatQueue(packets: SensorPacket[]) {
  const time = packets.map((p) => p.time);
  let quaternion;
  {
    const w = packets.map((p) => p.quaternion.w);
    const x = packets.map((p) => p.quaternion.x);
    const y = packets.map((p) => p.quaternion.y);
    const z = packets.map((p) => p.quaternion.z);
    quaternion = { w, x, y, z };
  }
  const accelerometer = packets[0].accelerometer
    ? (() => {
        const x = packets.map((p) => p.accelerometer!.x);
        const y = packets.map((p) => p.accelerometer!.y);
        const z = packets.map((p) => p.accelerometer!.z);
        return { x, y, z };
      })()
    : undefined;
  const gyroscope = packets[0].gyroscope
    ? (() => {
        const x = packets.map((p) => p.gyroscope!.x);
        const y = packets.map((p) => p.gyroscope!.y);
        const z = packets.map((p) => p.gyroscope!.z);
        return { x, y, z };
      })()
    : undefined;
  const magnetometer = packets[0].magnetometer
    ? (() => {
        if (!packets[0].magnetometer) return undefined;
        const x = packets.map((p) => p.magnetometer!.x);
        const y = packets.map((p) => p.magnetometer!.y);
        const z = packets.map((p) => p.magnetometer!.z);
        return { x, y, z };
      })()
    : undefined;

  return { time, quaternion, accelerometer, gyroscope, magnetometer };
}

export default App;
