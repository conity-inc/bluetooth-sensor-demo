import { makeAutoObservable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import type { SensorInterface, SensorPacket } from "./BaseInterface";
import { LinePlot } from "./LinePlot";
import { NoraxonSensor } from "./NoraxonInterface";
import { QsenseSensor, type UniversalPacket } from "./QsenseInterface";
import { YostSensor } from "./YostInterface";

const workflows = ["Stream Synchronized Sensors", "Stream Individual Sensors"];

export function App() {
  const bluetoothSupported: boolean = !!navigator.bluetooth;
  const [bluetoothAvailable, setBluetoothAvailable] = useState(
    undefined as boolean | undefined
  );
  const [workflow, setWorkflow] = useState(workflows[0]);
  useEffect(() => {
    navigator.bluetooth
      ?.getAvailability()
      .then((a) => setBluetoothAvailable(a));
  });

  return (
    <>
      <h1>Bluetooth Sensor Demo</h1>
      {!bluetoothSupported ? (
        <p className="error-message">
          Bluetooth not supported in this browser. Try another browser (e.g.
          Chome or Edge).
        </p>
      ) : bluetoothAvailable === undefined ? (
        <p>Checking for bluetooth availability...</p>
      ) : !bluetoothAvailable ? (
        <p className="error-message">
          Bluetooth not available on this device. Turn on bluetooth or get a
          bluetooth adapter.
        </p>
      ) : (
        <div className="vbox">
          <div className="button-group">
            {workflows.map((w, i) => (
              <button
                key={i}
                onClick={() => setWorkflow(w)}
                className={w === workflow ? "selected" : undefined}
              >
                {w}
              </button>
            ))}
          </div>

          {workflow === "Stream Individual Sensors" ? (
            <StreamIndividualSensors />
          ) : (
            <StreamSynchonizedSensors />
          )}
        </div>
      )}
    </>
  );
}

const StreamSynchonizedSensors = observer(() => {
  const sensorData = useRef(
    new Array(2).fill(undefined).map((_) => new SensorData())
  ).current;
  const [startTime, setStartTime] = useState(undefined as number | undefined);
  const startStreaming = async () => {
    setStartTime(Date.now());
    await Promise.all(sensorData.map(({ sensor }) => sensor!.startStreaming()));
  };
  const stopStreaming = async () => {
    await Promise.all(sensorData.map(({ sensor }) => sensor!.stopStreaming()));
  };
  const allConnected = sensorData.every(({ sensor }) => sensor?.connected);
  const anyStreaming = sensorData.some(({ sensor }) => sensor?.streaming);
  const latestTimes = sensorData.map((d) => d.streamingQueue.at(-1)?.time);
  const maxTime = Math.max(...latestTimes.filter((t) => t != undefined));
  const onDownload = () => {
    if (!sensorData.every(({ sensor }) => sensor)) return;
    const sensors = sensorData.map((d) => {
      return {
        technology: d.sensor?.technology,
        serial: d.sensor?.serial,
        version: d.sensor?.version,
        ...formatQueue(d.streamingQueue),
      };
    });
    const data = JSON.stringify({ sensors }, undefined, 2);
    const blob = new Blob([data], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${new Date(startTime!).toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="vbox">
      <div className="card vbox">
        {allConnected ? (
          <div>
            {anyStreaming ? (
              <button onClick={async () => stopStreaming()}>
                Stop Streaming
              </button>
            ) : (
              <button onClick={async () => startStreaming()}>
                Start Streaming
              </button>
            )}
            {anyStreaming && (
              <ol>
                {sensorData.map((d, i) => {
                  const currentTime = d.streamingQueue.at(-1)?.time;
                  const latency =
                    currentTime != null ? maxTime - currentTime : NaN;
                  return (
                    <li key={i}>
                      {d.sensor!.serial} Latency: {Math.round(latency * 1000)}ms
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ) : (
          <p>Connect all sensors to begin streaming</p>
        )}
        {!anyStreaming && (
          <div className="button-group">
            <button onClick={() => sensorData.map((d) => d.resetQueue())}>
              Reset Queue
            </button>
            <button onClick={onDownload}>Download Queue</button>
          </div>
        )}
      </div>
      <div className="hbox wrap">
        {sensorData.map((d, i) => {
          return (
            <div className="card vbox" key={i}>
              <div>
                <h2>{`Sensor ${i + 1}`}</h2>
                <SensorConnection sensorData={d} />
                <SensorStatus sensor={d.sensor} />
              </div>
              {!!d.sensor?.connected && <QueueView sensorData={d} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});

const StreamIndividualSensors = () => {
  return (
    <div className="hbox wrap">
      <SensorView label="Sensor 1" />
      <SensorView label="Sensor 2" />
    </div>
  );
};

const SensorView = observer(
  ({
    label,
    sensorData: sensorData_,
  }: {
    label: string;
    sensorData?: SensorData;
  }) => {
    const sensorData = useRef(sensorData_ ?? new SensorData()).current;
    const sensor = sensorData.sensor;

    return (
      <div className="card vbox">
        <div>
          <h2>{label}</h2>
          <SensorConnection sensorData={sensorData} />
          <SensorStatus sensor={sensor} showStreamControls />
        </div>
        <QueueView sensorData={sensorData} showControls />
      </div>
    );
  }
);

const SensorConnection = observer(
  ({ sensorData }: { sensorData: SensorData }) => {
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
      <div className="vbox">
        <div>
          {sensor?.connected ? (
            <>
              <button onClick={() => sensorData.setSensor(undefined)}>
                Disconnect
              </button>
            </>
          ) : (
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
                  title="Show Other Technologies"
                >
                  {"\u{1f441}"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);

const SensorStatus = observer(
  ({
    sensor,
    showStreamControls,
  }: {
    sensor?: SensorInterface;
    showStreamControls?: boolean;
  }) => {
    return sensor?.connected ? (
      <div>
        <p>Sensor Status: Connected</p>
        <p>Technology: {sensor?.technology}</p>
        <p>Serial: {sensor?.serial}</p>
        <p>Version: {sensor?.version}</p>
        {showStreamControls && (
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
        )}
      </div>
    ) : (
      <p>Sensor Status: Disconnected</p>
    );
  }
);

const QueueView = observer(function ({
  sensorData,
  showControls,
}: {
  sensorData: SensorData;
  showControls?: boolean;
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

  const data = sensorData.streamingQueue.slice(-500);

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

      {showControls && !sensorData.sensor?.streaming && (
        <div className="button-group">
          <button onClick={() => sensorData.resetQueue()}>Reset Queue</button>
          <button onClick={onDownload}>Download Queue</button>
        </div>
      )}

      {data.length > 0 && (
        <LinePlot
          xdata={data.map((p) => p.time)}
          ydata={[
            data.map((p) => p.quaternion.x),
            data.map((p) => p.quaternion.y),
            data.map((p) => p.quaternion.z),
            data.map((p) => p.quaternion.w),
          ]}
        />
      )}

      {sensorData.streamingQueue.length > 0 && (
        <pre>
          {JSON.stringify(sensorData.streamingQueue.at(-1), undefined, 2)}
        </pre>
      )}
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
    runInAction(() => {
      this.streamingQueue = [];
    });
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
