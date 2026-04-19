import { ImapFlow, type MailboxLockObject } from 'imapflow';
import type { ImapClientConfig } from './types.js';

let config: ImapClientConfig | null = null;
let client: ImapFlow | null = null;
let connectPromise: Promise<ImapFlow> | null = null;
const uidValidityByMailbox = new Map<string, bigint>();
let signalHandlersRegistered = false;

function normalizeMailboxName(mailbox: string): string {
  return mailbox.toUpperCase() === 'INBOX' ? 'INBOX' : mailbox;
}

function sameConfig(a: ImapClientConfig, b: ImapClientConfig): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.tls === b.tls &&
    a.user === b.user &&
    a.pass === b.pass
  );
}

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) {
    return;
  }
  signalHandlersRegistered = true;

  const handleShutdown = (): void => {
    void cleanup();
  };

  process.once('SIGTERM', handleShutdown);
  process.once('SIGINT', handleShutdown);
}

/**
 * Initialize IMAP client with the given configuration.
 * If the config is the same as the current one, this is a no-op.
 * Otherwise, cleans up the existing connection before applying new config.
 */
export async function initImap(nextConfig: ImapClientConfig): Promise<void> {
  registerSignalHandlers();

  if (config && sameConfig(config, nextConfig)) {
    return;
  }

  await cleanup();
  config = { ...nextConfig };
}

async function createConnection(): Promise<ImapFlow> {
  if (!config) {
    throw new Error('IMAP client is not initialized');
  }

  const nextClient = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    logger: false,
  });

  await nextClient.connect();

  nextClient.on('close', () => {
    if (client === nextClient) {
      client = null;
    }
  });

  client = nextClient;
  return nextClient;
}

/**
 * Get an active IMAP connection, reconnecting if necessary.
 */
export async function getConnection(): Promise<ImapFlow> {
  if (connectPromise) {
    return connectPromise;
  }

  if (client && client.usable) {
    try {
      await client.noop();
      return client;
    } catch {
      try {
        client.close();
      } catch {
        // ignore close errors
      }
      client = null;
    }
  }

  connectPromise = createConnection().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

/**
 * Acquire a mailbox lock, validating UID validity hasn't changed.
 */
export async function getMailboxLock(mailbox: string): Promise<MailboxLockObject> {
  const connection = await getConnection();
  const lock = await connection.getMailboxLock(mailbox);

  try {
    const openedMailbox = connection.mailbox;
    if (openedMailbox) {
      const mailboxName = normalizeMailboxName(openedMailbox.path);
      const previousUidValidity = uidValidityByMailbox.get(mailboxName);
      const currentUidValidity = openedMailbox.uidValidity;

      if (
        previousUidValidity !== undefined &&
        previousUidValidity !== currentUidValidity
      ) {
        throw new Error('Mailbox was reorganized, please re-search');
      }

      uidValidityByMailbox.set(mailboxName, currentUidValidity);
    }

    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Clean up the IMAP connection and reset state.
 */
export async function cleanup(): Promise<void> {
  const activeClient = client;
  client = null;
  connectPromise = null;
  uidValidityByMailbox.clear();

  if (!activeClient) {
    return;
  }

  try {
    if (activeClient.usable) {
      await activeClient.logout();
    } else {
      activeClient.close();
    }
  } catch {
    try {
      activeClient.close();
    } catch {
      // ignore close errors
    }
  }
}
