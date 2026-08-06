/**
 * Fault-injection race tests for download_kling_video writes: the byte write
 * goes to a fresh mkdtemp staging dir (0700) inside the canonical root, and
 * placement is a metadata operation (hard link / atomic rename) that never
 * follows or writes through a path swapped in after validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';
const REMOTE_URL = 'https://cdn.klingai.com/clip.mp4';
const DOWNLOAD_BODY = Buffer.alloc(2048, 0xcd);

describe('download_kling_video write check-then-use hardening', () => {
  let testClient: McpTestClient;
  let downloadRoot: string;
  let outsideRoot: string;

  function bodyResponse() {
    return HttpResponse.arrayBuffer(
      DOWNLOAD_BODY.buffer.slice(
        DOWNLOAD_BODY.byteOffset,
        DOWNLOAD_BODY.byteOffset + DOWNLOAD_BODY.byteLength,
      ) as ArrayBuffer,
      { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(DOWNLOAD_BODY.length) } },
    );
  }

  async function makeClient() {
    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });
  }

  beforeEach(() => {
    downloadRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kling-dlr-')));
    outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kling-dlr-out-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    for (const dir of [downloadRoot, `${downloadRoot}-orig`, outsideRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* empty */
      }
    }
  });

  it('refuses to place the file when the parent directory is swapped for a symlink mid-download', async () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    mswServer.use(
      ...createKlingHandlers(),
      http.get(REMOTE_URL, () => {
        // Swap the validated parent dir for a symlink to an outside directory
        // AFTER path validation but BEFORE the download completes.
        fs.renameSync(downloadRoot, `${downloadRoot}-orig`);
        fs.symlinkSync(outsideRoot, downloadRoot);
        return bodyResponse();
      }),
    );
    await makeClient();

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_PARENT_CHANGED');
    // Nothing may have been written through the swapped parent.
    expect(fs.existsSync(path.join(outsideRoot, 'clip.mp4'))).toBe(false);
  });

  it('refuses overwrite when the target is swapped for a symlink mid-download', async () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges
    const victimPath = path.join(outsideRoot, 'victim.mp4');
    fs.writeFileSync(victimPath, 'victim-original-bytes');
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    fs.writeFileSync(outputPath, 'previous-download');
    mswServer.use(
      ...createKlingHandlers(),
      http.get(REMOTE_URL, () => {
        // Replace the validated regular-file target with a symlink to a
        // victim file outside the root before placement.
        fs.unlinkSync(outputPath);
        fs.symlinkSync(victimPath, outputPath);
        return bodyResponse();
      }),
    );
    await makeClient();

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
      overwrite: true,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_PATH_CHANGED');
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('victim-original-bytes');
  });

  it('overwrite via atomic rename never writes through a hardlink planted at the target', async () => {
    const victimPath = path.join(outsideRoot, 'victim.mp4');
    fs.writeFileSync(victimPath, 'victim-original-bytes');
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    // A hardlink at the target shares the victim's inode: a truncate-style
    // overwrite would clobber the victim through it. rename(2) replaces the
    // directory entry instead, leaving the victim's content untouched.
    fs.linkSync(victimPath, outputPath);
    mswServer.use(...createKlingHandlers(), http.get(REMOTE_URL, () => bodyResponse()));
    await makeClient();

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
      overwrite: true,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    // The download landed at the requested path...
    expect(fs.readFileSync(outputPath).length).toBe(DOWNLOAD_BODY.length);
    // ...and the victim's content survived.
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('victim-original-bytes');
    // No staging directories are left behind on success.
    expect(fs.readdirSync(downloadRoot).filter((n) => n.startsWith('.kling-staging-'))).toHaveLength(0);
  });
});
