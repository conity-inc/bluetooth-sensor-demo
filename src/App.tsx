import { makeAutoObservable } from "mobx";
import { useRef, useState } from "react";
import "./App.css";
import type { Quat, Xyz } from "./BaseInterface";
import { QsenseInterface, QsenseSensor } from "./QsenseInterface";
import { observer } from "mobx-react";

const App = observer(function App() {
  const [sensor, setSensor] = useState(undefined as QsenseSensor | undefined);
  const [packet, setPacket] = useState(undefined as unknown);
  const sensorData = useRef(new SensorData()).current;

  const onReceivePacket = useRef((packet: unknown) => {
    sensorData.streamingQueue.push(packet as never);
    setPacket(packet);
  }).current;

  return (
    <>
      <div className="card">
        <button
          onClick={async () =>
            setSensor(await QsenseInterface.connect({ onReceivePacket }))
          }
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
});

class SensorData {
  streamingQueue: {
    time: number;
    quaternion: Quat;
    accelerometer?: Xyz;
    gyroscope?: Xyz;
    magnetometer?: Xyz;
  }[];

  constructor() {
    this.streamingQueue = [];
    makeAutoObservable(this);
  }
}

export default App;
