import { Logger, createConsoleTransport } from "@crish/shared-utils";

export const logger = new Logger({
  level: 'debug',
  transports: [createConsoleTransport()],
});
