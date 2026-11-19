/**
 * An error whose message this connector wrote, so it is safe to show the AI.
 * `formatError` passes on only these messages: any other Error (a TypeError,
 * a socket error, an SDK failure) becomes a fixed sentence instead.
 */
export class XeroConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroConnectorError";
  }
}
