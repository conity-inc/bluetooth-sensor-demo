import { makeAutoObservable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { useRef, useState } from "react";
import "./App.css";
import type { SensorInterface, SensorPacket } from "./BaseInterface";
import { QsenseSensor, type UniversalPacket } from "./QsenseInterface";
import { YostSensor } from "./YostInterface";

const App = observer(function App() {
  const [sensor, setSensor] = useState(
    undefined as SensorInterface | undefined
  );
  const sensorData = useRef(new SensorData()).current;

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
            }).then(setSensor)
          }
        >
          Connect QSense
        </button>

        <button
          onClick={() =>
            YostSensor.create({
              onReceivePacket: onReceiveYostPacket,
            }).then(setSensor)
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
            const data = JSON.stringify(
              sensorData.streamingQueue,
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
  streamingQueue: SensorPacket[];

  constructor() {
    this.streamingQueue = [];
    makeAutoObservable(this);
  }

  resetQueue() {
    runInAction(() => (this.streamingQueue = []));
  }
}

export default App;
