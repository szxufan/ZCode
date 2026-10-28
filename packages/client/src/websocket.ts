import { ChannelClient, type IMessagePassingProtocol } from "@zcode/rpc";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean } = {},
): RemoteServiceAccess {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
