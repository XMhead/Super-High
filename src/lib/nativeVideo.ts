export interface NativeVideoBounds {
  x: number
  y: number
  width: number
  height: number
  scale: number
  visible: boolean
}

export interface NativeVideoStatus {
  position: number
  duration: number
  paused: boolean
  ended: boolean
  width: number
  height: number
  ready: boolean
  volume: number
}

export type NativeVideoAction =
  | { type: 'open'; path: string; bounds: NativeVideoBounds }
  | { type: 'bounds'; bounds: NativeVideoBounds }
  | { type: 'status' }
  | { type: 'pause'; paused: boolean }
  | { type: 'seek'; seconds: number }
  | { type: 'volume'; volume: number }
  | { type: 'screenshot' }
  | { type: 'close' }
