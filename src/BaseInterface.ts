export type Quat = {
  w: number;
  x: number;
  y: number;
  z: number;
};

export type Xyz = {
  x: number;
  y: number;
  z: number;
};

export type SensorSample = {
  acc: Xyz;
  gyro: Xyz;
  mag?: Xyz;
};

export type SensorPacket = {
  time: number;
  quaternion: Quat;
  accelerometer?: Xyz;
  gyroscope?: Xyz;
  magnetometer?: Xyz;
};

export interface SensorInterface {
  technology: string;
  serial?: string;
  version?: string;
  dispose(): void;
  startStreaming(): Promise<void>;
  stopStreaming(): Promise<void>;
  connected: boolean;
  streaming: boolean;
  streamStarting: boolean;
}
