export type Xyz = {
  x: number;
  y: number;
  z: number;
};

export type Packet = {
  acc: Xyz;
  gyro: Xyz;
  mag?: Xyz;
};

export type Quat = {
  w: number;
  x: number;
  y: number;
  z: number;
};
