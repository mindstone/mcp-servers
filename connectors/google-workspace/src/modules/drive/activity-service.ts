import { google, driveactivity_v2 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import { DRIVE_SCOPES } from './scopes.js';
import { wrapUntrustedContent } from '../../utils/untrusted-content.js';

export interface QueryDriveActivityOptions {
  /** Drive item to inspect ("items/<id>" or a bare file/folder ID). */
  itemName?: string;
  /** Folder or shared drive whose subtree to inspect ("items/<id>" or bare ID). */
  ancestorName?: string;
  pageSize?: number;
  pageToken?: string;
  /** Drive Activity API filter string, passed through verbatim. */
  filter?: string;
}

export interface DriveActivitySummary {
  action: string;
  timestamp?: string;
  actors: string[];
  targets: Array<{ title?: string; name?: string; mimeType?: string }>;
}

export interface QueryDriveActivityResult {
  activities: DriveActivitySummary[];
  nextPageToken?: string;
}

const KNOWN_ACTIONS = [
  'create', 'edit', 'move', 'rename', 'delete', 'restore',
  'permissionChange', 'comment', 'dlpChange', 'reference', 'settingsChange',
] as const;

/**
 * Normalizes a user-supplied item/ancestor reference to the API's resource
 * form ("items/<id>"); accepts the resource form or a bare Drive ID.
 */
export function normalizeDriveItemName(value: string): string {
  return value.startsWith('items/') ? value : `items/${value}`;
}

function summarizeAction(detail: driveactivity_v2.Schema$ActionDetail | undefined): string {
  if (!detail) return 'unknown';
  for (const action of KNOWN_ACTIONS) {
    if (detail[action] !== undefined && detail[action] !== null) return action;
  }
  return 'unknown';
}

function summarizeActor(actor: driveactivity_v2.Schema$Actor): string {
  if (actor.user?.knownUser) {
    return actor.user.knownUser.isCurrentUser
      ? 'you'
      : actor.user.knownUser.personName || 'a known user';
  }
  if (actor.user?.deletedUser) return 'a deleted user';
  if (actor.anonymous) return 'an anonymous user';
  if (actor.system) return 'Google Workspace (system)';
  if (actor.administrator) return 'an administrator';
  return 'unknown actor';
}

function summarizeTarget(target: driveactivity_v2.Schema$Target): { title?: string; name?: string; mimeType?: string } {
  // Titles are authored in Drive (attacker-controlled) and get the envelope;
  // resource names / MIME types are structural identifiers and stay raw so the
  // caller can use them directly.
  const wrapTitle = (title: string | null | undefined): string | undefined =>
    title ? wrapUntrustedContent(title, 'google-workspace:drive:activity') : undefined;
  if (target.driveItem) {
    return {
      title: wrapTitle(target.driveItem.title),
      name: target.driveItem.name || undefined,
      mimeType: target.driveItem.mimeType || undefined,
    };
  }
  if (target.drive) {
    return { title: wrapTitle(target.drive.title), name: target.drive.name || undefined };
  }
  if (target.fileComment) {
    return { title: wrapTitle(target.fileComment.parent?.title), name: target.fileComment.parent?.name || undefined };
  }
  if (target.teamDrive) {
    return { title: wrapTitle(target.teamDrive.title), name: target.teamDrive.name || undefined };
  }
  return {};
}

/**
 * Service for the Drive Activity API v2 — answers "what changed in this
 * file/folder/shared drive". Kept separate from DriveService because
 * BaseGoogleService caches one client per email and the activity API is a
 * different client (google.driveactivity v2).
 */
export class DriveActivityService extends BaseGoogleService<driveactivity_v2.Driveactivity> {
  private initialized = false;

  constructor() {
    super({ serviceName: 'Google Drive Activity', version: 'v2' });
  }

  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Drive Activity service');
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async queryActivity(email: string, options: QueryDriveActivityOptions): Promise<QueryDriveActivityResult> {
    await this.ensureInitialized();
    await this.validateScopes(email, [DRIVE_SCOPES.ACTIVITY_READONLY]);

    const client = await this.getAuthenticatedClient(
      email,
      (auth) => google.driveactivity({ version: 'v2', auth })
    );

    const response = await client.activity.query({
      requestBody: {
        ...(options.itemName && { itemName: options.itemName }),
        ...(options.ancestorName && { ancestorName: options.ancestorName }),
        ...(options.pageSize && { pageSize: options.pageSize }),
        ...(options.pageToken && { pageToken: options.pageToken }),
        ...(options.filter && { filter: options.filter }),
      }
    });

    const activities: DriveActivitySummary[] = (response.data.activities || []).map(activity => ({
      action: summarizeAction(activity.primaryActionDetail),
      timestamp: activity.timestamp ?? activity.timeRange?.endTime ?? undefined,
      actors: (activity.actors || []).map(summarizeActor),
      targets: (activity.targets || []).map(summarizeTarget),
    }));

    return {
      activities,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  }
}
