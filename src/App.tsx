import { makeAutoObservable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { useRef, useState } from "react";
import "./App.css";
import type { SensorInterface, SensorPacket } from "./BaseInterface";
import { QsenseSensor, type UniversalPacket } from "./QsenseInterface";
import { YostSensor } from "./YostInterface";
import { NoraxonSensor } from "./NoraxonInterface";

export function App() {
  const bluetoothAvailable: boolean = !!navigator.bluetooth;

  return (
    <>
      <h1>Bluetooth Sensor Demo</h1>
      {bluetoothAvailable ? (
        <div className="hbox wrap">
          <SensorConnection label="Sensor 1" />
          <SensorConnection label="Sensor 2" />
        </div>
      ) : (
        <p>Bluetooth not supported</p>
      )}
    </>
  );
}

const SensorConnection = observer(({ label }: { label: string }) => {
  const sensorData = useRef(new SensorData()).current;
  const sensor = sensorData.sensor;
  const [showOtherTechs, setShowOtherTechs] = useState(false);

  const onReceiveNoraxonPacket = useRef((p: SensorPacket[]) => {
    runInAction(() => {
      sensorData.streamingQueue.push(...p);
    });
  }).current;

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
    runInAction(() => {
      sensorData.streamingQueue.push(...packets);
    });
  }).current;

  const onReceiveYostPacket = useRef((p: SensorPacket) => {
    runInAction(() => {
      sensorData.streamingQueue.push(p);
    });
  }).current;

  return (
    <div className="card vbox">
      <div>
        <div>
          <h2>{label}</h2>
        </div>
        <div className="button-group">
          <button
            onClick={() => {
              sensorData.setSensor(undefined);
              NoraxonSensor.create({
                onReceivePacket: onReceiveNoraxonPacket,
              }).then((s) => sensorData.setSensor(s));
            }}
          >
            Connect Noraxon
          </button>

          {showOtherTechs ? (
            <>
              <button
                onClick={() => {
                  sensorData.setSensor(undefined);
                  QsenseSensor.create({
                    onReceivePacket: onReceiveQsensePacket,
                  }).then((s) => sensorData.setSensor(s));
                }}
              >
                Connect QSense
              </button>

              <button
                onClick={() => {
                  sensorData.setSensor(undefined);
                  YostSensor.create({
                    onReceivePacket: onReceiveYostPacket,
                  }).then((s) => sensorData.setSensor(s));
                }}
              >
                Connect Yost
              </button>
            </>
          ) : (
            <div
              style={{ cursor: "default", color: "#0000" }}
              onClick={() => setShowOtherTechs(!showOtherTechs)}
            >
              Show Other Technologies
            </div>
          )}
        </div>
        {sensor?.connected ? (
          <div>
            <p>Sensor Status: Connected</p>
            <p>Technology: {sensor?.technology}</p>
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
          </div>
        ) : (
          <p>Sensor Status: Disconnected</p>
        )}
      </div>
      <QueueView sensorData={sensorData} canReset={!sensor?.streaming} />
    </div>
  );
});

const QueueView = observer(function ({
  sensorData,
  canReset,
}: {
  sensorData: SensorData;
  canReset: boolean;
}) {
  const onDownload = () => {
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
  };

  return (
    <div>
      <h2>Queue</h2>
      <p>Total Packets: {sensorData.streamingQueue.length}</p>
      <p>
        Total Time:{" "}
        {sensorData.streamingQueue.length &&
          sensorData.streamingQueue.at(-1)!.time -
            sensorData.streamingQueue[0].time}
        s
      </p>
      <div className="button-group">
        {canReset && (
          <button onClick={() => sensorData.resetQueue()}>Reset Queue</button>
        )}
        {canReset && <button onClick={onDownload}>Download Queue</button>}
      </div>
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

  setSensor(sensor: SensorInterface | undefined) {
    runInAction(() => {
      this.sensor?.dispose();
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
