/**
 * Runtime manifest generator for the Office Add-in.
 * Generates a manifest XML with the correct sidecar HTTPS port.
 *
 * The sidecar binds to `DEFAULT_SIDECAR_PORT` (52100) with a small fallback window.
 * Manifests are written into the state directory AND auto-installed into Office's
 * WEF folders, where Office reads them at launch time.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MANIFEST_FILE = 'manifest.xml';

/**
 * Preferred sidecar port. Chosen for:
 *   - Ephemeral range (49152–65535) → minimal collision risk with common dev tools (3000/8080/5173/etc.)
 *   - Stable across sidecar restarts → Office manifest cache stays valid, no re-install needed
 *   - Memorable
 */
export const DEFAULT_SIDECAR_PORT = 52100;

/**
 * Small fallback window in case the preferred port is briefly in use
 * (e.g., previous sidecar hasn't fully released it, or an unrelated app grabbed it).
 */
export const SIDECAR_PORT_FALLBACKS: readonly number[] = [
  DEFAULT_SIDECAR_PORT,
  DEFAULT_SIDECAR_PORT + 1,
  DEFAULT_SIDECAR_PORT + 2,
  DEFAULT_SIDECAR_PORT + 3,
  DEFAULT_SIDECAR_PORT + 4,
  DEFAULT_SIDECAR_PORT + 5,
];

/**
 * macOS per-app WEF folders where Office reads sideloaded manifests.
 * Each Office app on macOS is containerized with its own wef folder.
 */
const MAC_WEF_PATHS: Record<OfficeHost, string> = {
  word: path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef'),
  excel: path.join(os.homedir(), 'Library/Containers/com.microsoft.Excel/Data/Documents/wef'),
  powerpoint: path.join(os.homedir(), 'Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef'),
};

/**
 * Windows shared WEF folder (per-user, no admin needed).
 * Windows uses one folder for all Office apps — a combined multi-host manifest serves them all.
 */
function winWefPath(): string | null {
  const localAppData = process.env['LOCALAPPDATA'];
  return localAppData ? path.join(localAppData, 'Microsoft', 'Office', '16.0', 'Wef') : null;
}

/**
 * Generate the Office Add-in manifest XML with the actual sidecar port.
 */
export type OfficeHost = 'word' | 'excel' | 'powerpoint';

const HOST_CONFIG: Record<OfficeHost, { hostName: string; hostType: string }> = {
  word:       { hostName: 'Document',     hostType: 'Document' },
  excel:      { hostName: 'Workbook',     hostType: 'Workbook' },
  powerpoint: { hostName: 'Presentation', hostType: 'Presentation' },
};

export function generateManifest(port: number, host: OfficeHost = 'word'): string {
  const baseUrl = `https://localhost:${port}`;
  const cfg = HOST_CONFIG[host];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">

  <Id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Mindstone</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Rebel" />
  <Description DefaultValue="Connect Microsoft Office to Rebel — your AI assistant." />
  <IconUrl DefaultValue="${baseUrl}/assets/icon-80.png" />
  <HighResolutionIconUrl DefaultValue="${baseUrl}/assets/icon-80.png" />
  <SupportUrl DefaultValue="https://www.mindstone.ai" />

  <AppDomains>
    <AppDomain>${baseUrl}</AppDomain>
  </AppDomains>

  <Hosts>
    <Host Name="${cfg.hostName}" />
  </Hosts>

  <DefaultSettings>
    <SourceLocation DefaultValue="${baseUrl}/taskpane.html" />
  </DefaultSettings>

  <Permissions>ReadWriteDocument</Permissions>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="${cfg.hostType}">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="GetStarted.Title" />
            <Description resid="GetStarted.Description" />
            <LearnMoreUrl resid="GetStarted.LearnMoreUrl" />
          </GetStarted>

          <FunctionFile resid="Taskpane.Url" />

          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Rebel.CommandsGroup">
                <Label resid="CommandsGroup.Label" />
                <Icon>
                  <bt:Image size="16" resid="Icon.16x16" />
                  <bt:Image size="32" resid="Icon.32x32" />
                  <bt:Image size="80" resid="Icon.80x80" />
                </Icon>

                <Control xsi:type="Button" id="Rebel.TaskpaneButton">
                  <Label resid="TaskpaneButton.Label" />
                  <Supertip>
                    <Title resid="TaskpaneButton.Label" />
                    <Description resid="TaskpaneButton.Tooltip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16" />
                    <bt:Image size="32" resid="Icon.32x32" />
                    <bt:Image size="80" resid="Icon.80x80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>RebelTaskpane</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>

    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="${baseUrl}/assets/icon-16.png" />
        <bt:Image id="Icon.32x32" DefaultValue="${baseUrl}/assets/icon-32.png" />
        <bt:Image id="Icon.80x80" DefaultValue="${baseUrl}/assets/icon-80.png" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="GetStarted.LearnMoreUrl" DefaultValue="https://www.mindstone.ai" />
        <bt:Url id="Taskpane.Url" DefaultValue="${baseUrl}/taskpane.html" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GetStarted.Title" DefaultValue="Get started with Rebel" />
        <bt:String id="CommandsGroup.Label" DefaultValue="Rebel" />
        <bt:String id="TaskpaneButton.Label" DefaultValue="Rebel" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="GetStarted.Description" DefaultValue="Rebel is now connected to Office. Click the Rebel button to see connection status." />
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="Open the Rebel panel to see connection status." />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>`;
}

/**
 * Generate a combined manifest with all three Office hosts.
 * Used on Windows where a single shared WEF folder serves all apps.
 */
export function generateCombinedManifest(port: number): string {
  const baseUrl = `https://localhost:${port}`;
  const hosts: OfficeHost[] = ['word', 'excel', 'powerpoint'];

  const hostBlocks = hosts.map((host) => {
    const cfg = HOST_CONFIG[host];
    const groupId = `Rebel.CommandsGroup.${cfg.hostType}`;
    const buttonId = `Rebel.TaskpaneButton.${cfg.hostType}`;
    return `      <Host xsi:type="${cfg.hostType}">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="GetStarted.Title" />
            <Description resid="GetStarted.Description" />
            <LearnMoreUrl resid="GetStarted.LearnMoreUrl" />
          </GetStarted>

          <FunctionFile resid="Taskpane.Url" />

          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="${groupId}">
                <Label resid="CommandsGroup.Label" />
                <Icon>
                  <bt:Image size="16" resid="Icon.16x16" />
                  <bt:Image size="32" resid="Icon.32x32" />
                  <bt:Image size="80" resid="Icon.80x80" />
                </Icon>

                <Control xsi:type="Button" id="${buttonId}">
                  <Label resid="TaskpaneButton.Label" />
                  <Supertip>
                    <Title resid="TaskpaneButton.Label" />
                    <Description resid="TaskpaneButton.Tooltip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16" />
                    <bt:Image size="32" resid="Icon.32x32" />
                    <bt:Image size="80" resid="Icon.80x80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>RebelTaskpane</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>`;
  });

  const hostNames = hosts.map((h) => `    <Host Name="${HOST_CONFIG[h].hostName}" />`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">

  <Id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Mindstone</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Rebel" />
  <Description DefaultValue="Connect Microsoft Office to Rebel — your AI assistant for documents, spreadsheets, and presentations." />
  <IconUrl DefaultValue="${baseUrl}/assets/icon-80.png" />
  <HighResolutionIconUrl DefaultValue="${baseUrl}/assets/icon-80.png" />
  <SupportUrl DefaultValue="https://www.mindstone.ai" />

  <AppDomains>
    <AppDomain>${baseUrl}</AppDomain>
  </AppDomains>

  <Hosts>
${hostNames}
  </Hosts>

  <DefaultSettings>
    <SourceLocation DefaultValue="${baseUrl}/taskpane.html" />
  </DefaultSettings>

  <Permissions>ReadWriteDocument</Permissions>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
${hostBlocks.join('\n\n')}
    </Hosts>

    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="${baseUrl}/assets/icon-16.png" />
        <bt:Image id="Icon.32x32" DefaultValue="${baseUrl}/assets/icon-32.png" />
        <bt:Image id="Icon.80x80" DefaultValue="${baseUrl}/assets/icon-80.png" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="GetStarted.LearnMoreUrl" DefaultValue="https://www.mindstone.ai" />
        <bt:Url id="Taskpane.Url" DefaultValue="${baseUrl}/taskpane.html" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GetStarted.Title" DefaultValue="Get started with Rebel" />
        <bt:String id="CommandsGroup.Label" DefaultValue="Rebel" />
        <bt:String id="TaskpaneButton.Label" DefaultValue="Rebel" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="GetStarted.Description" DefaultValue="Rebel is now connected to Office. Click the Rebel button to see connection status." />
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="Open the Rebel panel to see connection status." />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>`;
}

/**
 * Write the generated manifest to the state directory.
 * Returns the path where the manifest was written.
 *
 * Writes:
 *   - manifest.word.xml, manifest.excel.xml, manifest.powerpoint.xml — single-host (macOS wef folders)
 *   - manifest.xml — combined multi-host manifest (Windows shared wef folder)
 */
export async function writeManifest(port: number, stateDir: string): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true });

  // Write per-app manifests for macOS sideloading (each wef folder gets one host)
  const hosts: OfficeHost[] = ['word', 'excel', 'powerpoint'];
  for (const host of hosts) {
    const content = generateManifest(port, host);
    await fs.writeFile(path.join(stateDir, `manifest.${host}.xml`), content, { encoding: 'utf8' });
  }

  // Write combined multi-host manifest for Windows (single shared wef folder)
  const manifestPath = path.join(stateDir, MANIFEST_FILE);
  await fs.writeFile(manifestPath, generateCombinedManifest(port), { encoding: 'utf8' });

  return manifestPath;
}

export type WefInstallStatus = 'installed' | 'unchanged' | 'skipped' | 'failed';

export interface WefInstallResult {
  app: OfficeHost | 'all';
  path: string;
  status: WefInstallStatus;
  error?: string;
}

/**
 * Read a file as UTF-8 text, or return null if it doesn't exist.
 * Propagates unexpected errors (e.g., permission denied) so callers can log + surface them.
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export interface WefInstallOverrides {
  /** Override the detected platform. Primarily for tests. */
  platform?: NodeJS.Platform;
  /** Override individual macOS wef folder paths. Primarily for tests. */
  macPaths?: Partial<Record<OfficeHost, string>>;
  /** Override the Windows wef folder path (or pass null to simulate missing LOCALAPPDATA). */
  winPath?: string | null;
}

/**
 * Install the generated manifests into Office's WEF folders (where Office reads sideloaded manifests).
 * Idempotent: only writes if the target is missing or differs. Safe to call on every sidecar startup.
 *
 * macOS: per-app wef folders, one single-host manifest per app.
 * Windows: one shared wef folder, the combined multi-host manifest.
 *
 * @param stateDir - directory where the generated manifests were written (by `writeManifest()`)
 * @param overrides - test-only hooks to redirect platform/paths
 */
export async function installManifestsToWefFolders(
  stateDir: string,
  overrides: WefInstallOverrides = {},
): Promise<WefInstallResult[]> {
  const results: WefInstallResult[] = [];
  const platform = overrides.platform ?? process.platform;

  if (platform === 'darwin') {
    for (const host of ['word', 'excel', 'powerpoint'] as const) {
      const source = path.join(stateDir, `manifest.${host}.xml`);
      const wefDir = overrides.macPaths?.[host] ?? MAC_WEF_PATHS[host];
      const target = path.join(wefDir, MANIFEST_FILE);

      try {
        const [newContent, existingContent] = await Promise.all([
          fs.readFile(source, 'utf8'),
          readFileOrNull(target),
        ]);

        if (existingContent === newContent) {
          results.push({ app: host, path: wefDir, status: 'unchanged' });
          continue;
        }

        await fs.mkdir(wefDir, { recursive: true });
        await fs.writeFile(target, newContent, { encoding: 'utf8' });
        results.push({ app: host, path: wefDir, status: 'installed' });
      } catch (err) {
        results.push({
          app: host,
          path: wefDir,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  if (platform === 'win32') {
    const wefDir = overrides.winPath !== undefined ? overrides.winPath : winWefPath();
    if (!wefDir) {
      results.push({
        app: 'all',
        path: '(unknown)',
        status: 'skipped',
        error: 'LOCALAPPDATA environment variable not set',
      });
      return results;
    }

    const source = path.join(stateDir, MANIFEST_FILE);
    const target = path.join(wefDir, MANIFEST_FILE);

    try {
      const [newContent, existingContent] = await Promise.all([
        fs.readFile(source, 'utf8'),
        readFileOrNull(target),
      ]);

      if (existingContent === newContent) {
        results.push({ app: 'all', path: wefDir, status: 'unchanged' });
        return results;
      }

      await fs.mkdir(wefDir, { recursive: true });
      await fs.writeFile(target, newContent, { encoding: 'utf8' });
      results.push({ app: 'all', path: wefDir, status: 'installed' });
    } catch (err) {
      results.push({
        app: 'all',
        path: wefDir,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return results;
  }

  results.push({
    app: 'all',
    path: '(unsupported)',
    status: 'skipped',
    error: `Office add-in not supported on platform: ${platform}`,
  });
  return results;
}
