// Relay V3 device 模块入口（P1）。main 经此装配；renderer 只经 IPC 通道交互。

export { RelayV3AccountService } from "./relayV3AccountService.js";
export type { RelayV3AccountServiceOptions, RelayV3AccountEvent } from "./relayV3AccountService.js";
export {
  loadOrGenerateRelayV3DeviceIdentity,
  persistRelayV3DeviceSid,
  resetRelayV3DeviceIdentity,
} from "./relayV3DeviceIdentity.js";
export { RelayV3DeviceTransport } from "./relayV3DeviceTransport.js";
export type { RelayV3DeviceTransportOptions } from "./relayV3DeviceTransport.js";
export { RelayV3DeviceManager } from "./relayV3DeviceManager.js";
export type {
  RelayV3DeviceManagerLogger,
  RelayV3DeviceManagerOptions,
  MessagePortLike,
} from "./relayV3DeviceManager.js";
export { RelayV3TerminalManager } from "./relayV3TerminalManager.js";
export type {
  RelayV3TerminalBridgeSession,
  RelayV3TerminalManagerOptions,
} from "./relayV3TerminalManager.js";
export { registerRelayV3DeviceIpc, registerRelayV3TerminalIpc } from "./relayV3Ipc.js";
