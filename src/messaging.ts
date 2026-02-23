export interface SendMediaOptions {
  /** Local file path or URL to a media file to attach */
  media?: string;
}

export type SendFn = (message: string, to?: string, options?: SendMediaOptions) => Promise<number>;

const channels = new Map<string, SendFn>();

export function registerChannel(name: string, send: SendFn): void {
  channels.set(name, send);
}

export function unregisterChannel(name: string): void {
  channels.delete(name);
}

export function getChannel(name: string): SendFn | undefined {
  return channels.get(name);
}

export function listChannels(): string[] {
  return [...channels.keys()];
}

export async function sendMessage(channel: string, message: string, to?: string, options?: SendMediaOptions): Promise<number> {
  const send = getChannel(channel);
  if (!send) {
    throw new Error(`Unknown channel: "${channel}". Available channels: ${listChannels().join(", ") || "none"}`);
  }
  return send(message, to, options);
}
