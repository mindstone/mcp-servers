export interface StructuredError {
  ok: false;
  error: string;
  resolution: string;
  next_step: { action: string };
}

export interface ConnectionContext {
  proxyReachable?: boolean;
  handshakeCompleted?: boolean;
}

export interface SshConnectionError extends Error {
  code?: string;
  level?: string;
  proxyReachable?: boolean;
  handshakeCompleted?: boolean;
}

export function translateSshError(
  err: Error & { code?: string; level?: string },
  ctx: ConnectionContext = {},
): StructuredError {
  const code = err.code || '';
  const level = err.level || '';
  const message = err.message || '';

  if (code === 'ENOTFOUND' || message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
    return {
      ok: false,
      error: 'Cannot resolve hostname — Replit rotates hostnames when a project restarts, so the old one may no longer work.',
      resolution: 'Get a fresh SSH command from your Replit project.',
      next_step: { action: 'Open the Replit project, go to SSH > Connect > "Connect manually", copy the new Shell command, and share it.' },
    };
  }

  if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return {
      ok: false,
      error: 'Connection refused — your Replit project is not running.',
      resolution: 'Open the project in your browser at replit.com to wake it up, then try again.',
      next_step: { action: 'Open your Replit project in a browser tab to wake it up, wait 10 seconds, then retry.' },
    };
  }

  if (code === 'ETIMEDOUT' || message.includes('ETIMEDOUT') || message.includes('Timed out')) {
    if (ctx.proxyReachable && ctx.handshakeCompleted) {
      return {
        ok: false,
        error: 'The Replit SSH proxy is reachable, but the project container appears to be sleeping.',
        resolution: 'The SSH proxy connected and the handshake completed, but the project behind it is not responding. Wake it up in your browser.',
        next_step: { action: 'Open your Replit project in a browser tab, wait for it to fully load, then retry.' },
      };
    }
    if (ctx.handshakeCompleted) {
      return {
        ok: false,
        error: 'SSH handshake completed but timed out waiting for authentication to finish.',
        resolution: 'The server may be overloaded or the project is waking up. Try again in a moment.',
        next_step: { action: 'Wait 10-15 seconds and retry. If it keeps failing, open the project in your browser first.' },
      };
    }
    return {
      ok: false,
      error: 'Connection timed out — could not reach the Replit SSH server.',
      resolution: 'Either your internet connection is down, or the Replit project is sleeping. The most common cause is a sleeping project.',
      next_step: { action: 'Open your Replit project in a browser to wake it up, wait for it to load, then retry.' },
    };
  }

  if (level === 'client-authentication' || message.includes('All configured authentication methods failed')) {
    if (ctx.proxyReachable) {
      return {
        ok: false,
        error: 'SSH authentication failed — the Replit SSH proxy is reachable but rejected your key.',
        resolution: 'This is a confirmed authentication problem (not a sleeping project). Your SSH key is either not registered with Replit, was removed, or your Replit plan does not include SSH access (Core plan required).',
        next_step: { action: 'Go to replit.com → Account → SSH Keys and verify your key is listed. If not, run replit_setup_ssh and re-add it. If it is listed, try force_regenerate=true to create a fresh key.' },
      };
    }
    return {
      ok: false,
      error: 'SSH authentication failed.',
      resolution: 'The server rejected the SSH key. This could mean the key is not registered, or the project endpoint has changed.',
      next_step: { action: 'Verify the key is at replit.com → Account → SSH Keys, and get a fresh SSH command from the project.' },
    };
  }

  if (code === 'SFTP_UNAVAILABLE') {
    return {
      ok: false,
      error: 'SFTP file transfer is not available on this Replit project.',
      resolution: 'The SSH connection works, but file transfer (SFTP) is not supported. This may be a temporary issue.',
      next_step: { action: 'Wait a few seconds and retry. If it persists, the Replit project may not support SFTP.' },
    };
  }

  console.error(`[replit-ssh] SSH error: code=${code} level=${level} message=${message}`);
  return {
    ok: false,
    error: 'SSH connection failed unexpectedly.',
    resolution: 'An unexpected SSH error occurred. Check your connection details and try again.',
    next_step: { action: 'Verify the host and user are correct, ensure the Replit project is running, then retry.' },
  };
}

export function translateSftpError(
  err: Error & { code?: number | string },
  operation: string,
  filePath: string,
): StructuredError {
  const code = err.code;
  const message = err.message || '';
  const messageLower = message.toLowerCase();

  if (code === 2 || message.includes('No such file') || message.includes('ENOENT')) {
    return {
      ok: false,
      error: `File or directory not found: "${filePath}"`,
      resolution: `Check that the path "${filePath}" exists in your Replit project.`,
      next_step: { action: 'Use replit_list_files to see available files, then retry with the correct path.' },
    };
  }

  if (code === 3 || message.includes('Permission denied') || message.includes('EACCES')) {
    return {
      ok: false,
      error: `Permission denied: cannot ${operation} "${filePath}"`,
      resolution: 'The file or directory permissions prevent this operation.',
      next_step: { action: 'Check file permissions in your Replit project, or try a different path.' },
    };
  }

  if (code === 'SFTP_UNAVAILABLE' || (messageLower.includes('sftp') && messageLower.includes('timed out'))) {
    return {
      ok: false,
      error: 'SFTP subsystem is not available on this Replit project. This is usually temporary — please try again.',
      resolution: 'The project may still be waking up and the SFTP subsystem is not ready yet.',
      next_step: { action: 'Wait a few seconds and retry the same operation.' },
    };
  }

  if (code === 'RENAME_UNSUPPORTED') {
    return {
      ok: false,
      error: `Cannot overwrite "${filePath}": server does not support atomic file replacement.`,
      resolution: 'This is unusual for Replit. The file was not modified — your original file is safe.',
      next_step: { action: 'Retry the operation. If this persists, the Replit project may need to be restarted.' },
    };
  }

  console.error(`[replit-ssh] SFTP error: operation=${operation} path=${filePath} code=${code} message=${message}`);
  return {
    ok: false,
    error: `Failed to ${operation} "${filePath}".`,
    resolution: 'An unexpected error occurred during the file operation.',
    next_step: { action: 'Verify the path is correct and the Replit project is running, then retry.' },
  };
}
