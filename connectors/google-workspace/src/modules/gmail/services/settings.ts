import { google } from 'googleapis';
import { describeApiError } from '../../../utils/apiError.js';
import {
  GetGmailSettingsParams,
  GetGmailSettingsResponse,
  UpdateVacationResponderParams,
  VacationResponderState,
  SendAsAlias,
  GmailError
} from '../types.js';

export class SettingsService {
  constructor(
    private gmailClient?: ReturnType<typeof google.gmail>
  ) {}

  /**
   * Updates the Gmail client instance
   * @param client - New Gmail client instance
   */
  updateClient(client: ReturnType<typeof google.gmail>) {
    this.gmailClient = client;
  }

  private ensureClient(): ReturnType<typeof google.gmail> {
    if (!this.gmailClient) {
      throw new GmailError(
        'Gmail client not initialized',
        'CLIENT_ERROR',
        'Please ensure the service is initialized'
      );
    }
    return this.gmailClient;
  }

  async getWorkspaceGmailSettings({ email }: GetGmailSettingsParams): Promise<GetGmailSettingsResponse> {
    try {
      // Get profile data
      const client = this.ensureClient();
      const { data: profile } = await client.users.getProfile({
        userId: 'me'
      });

      // Get settings data
      const [
        { data: autoForwarding },
        { data: imap },
        { data: language },
        { data: pop },
        { data: vacation }
      ] = await Promise.all([
        client.users.settings.getAutoForwarding({ userId: 'me' }),
        client.users.settings.getImap({ userId: 'me' }),
        client.users.settings.getLanguage({ userId: 'me' }),
        client.users.settings.getPop({ userId: 'me' }),
        client.users.settings.getVacation({ userId: 'me' })
      ]);

      const response: GetGmailSettingsResponse = {
        profile: {
          emailAddress: profile.emailAddress ?? '',
          messagesTotal: typeof profile.messagesTotal === 'number' ? profile.messagesTotal : 0,
          threadsTotal: typeof profile.threadsTotal === 'number' ? profile.threadsTotal : 0,
          historyId: profile.historyId ?? ''
        },
        settings: {
          ...(language?.displayLanguage && {
            language: {
              displayLanguage: language.displayLanguage
            }
          }),
          ...(autoForwarding && {
            autoForwarding: {
              enabled: Boolean(autoForwarding.enabled),
              ...(autoForwarding.emailAddress && {
                emailAddress: autoForwarding.emailAddress
              })
            }
          }),
          ...(imap && {
            imap: {
              enabled: Boolean(imap.enabled),
              ...(typeof imap.autoExpunge === 'boolean' && {
                autoExpunge: imap.autoExpunge
              }),
              ...(imap.expungeBehavior && {
                expungeBehavior: imap.expungeBehavior
              })
            }
          }),
          ...(pop && {
            pop: {
              enabled: Boolean(pop.accessWindow),
              ...(pop.accessWindow && {
                accessWindow: pop.accessWindow
              })
            }
          }),
          ...(vacation && {
            vacationResponder: {
              enabled: Boolean(vacation.enableAutoReply),
              ...(vacation.startTime && {
                startTime: vacation.startTime
              }),
              ...(vacation.endTime && {
                endTime: vacation.endTime
              }),
              ...(vacation.responseSubject && {
                responseSubject: vacation.responseSubject
              }),
              ...((vacation.responseBodyHtml || vacation.responseBodyPlainText) && {
                message: vacation.responseBodyHtml ?? vacation.responseBodyPlainText ?? ''
              })
            }
          })
        }
      };

      return response;
    } catch (error) {
      if (error instanceof GmailError) {
        throw error;
      }
      throw new GmailError(
        'Failed to get Gmail settings',
        'SETTINGS_ERROR',
        `Error: ${describeApiError(error)}`
      );
    }
  }

  /**
   * Updates the vacation (out-of-office) auto-responder. The Gmail API replaces
   * the whole vacation resource on update, so the current settings are fetched
   * first and merged — passing only `enabled` would otherwise wipe the existing
   * subject/body.
   */
  async updateVacationResponder(params: UpdateVacationResponderParams): Promise<VacationResponderState> {
    try {
      const client = this.ensureClient();

      const { data: current } = await client.users.settings.getVacation({ userId: 'me' });

      const responseSubject = params.responseSubject ?? current.responseSubject ?? undefined;

      // A caller-supplied body is sent as plain text. When omitted, preserve the
      // existing body in its own representation: an HTML body must go back as
      // responseBodyHtml, not be flattened into responseBodyPlainText (that
      // would turn the markup into literal visible text in the auto-reply).
      const hasBody = params.responseBody !== undefined
        || Boolean(current.responseBodyPlainText)
        || Boolean(current.responseBodyHtml);

      if (params.enabled && !hasBody) {
        throw new GmailError(
          'Vacation responder needs a message',
          'INVALID_PARAMS',
          'Provide response_body (the account has no existing auto-reply message to reuse)'
        );
      }

      const bodyFields = params.responseBody !== undefined
        ? { responseBodyPlainText: params.responseBody }
        : {
            ...(current.responseBodyPlainText && { responseBodyPlainText: current.responseBodyPlainText }),
            ...(current.responseBodyHtml && { responseBodyHtml: current.responseBodyHtml })
          };

      const { data: updated } = await client.users.settings.updateVacation({
        userId: 'me',
        requestBody: {
          enableAutoReply: params.enabled,
          ...(responseSubject && { responseSubject }),
          ...bodyFields,
          ...(params.startTime !== undefined
            ? { startTime: String(params.startTime) }
            : params.enabled && !current.startTime
              ? { startTime: String(Date.now()) }
              : current.startTime ? { startTime: current.startTime } : {}),
          // An omitted endTime preserves a still-pending scheduled end — the API
          // replaces the whole resource, so omitting it would silently erase it.
          // An already-past end is not inherited (Gmail requires start < end, and
          // an expired end carries no meaning); clearEndTime drops one explicitly.
          ...(params.endTime !== undefined
            ? { endTime: String(params.endTime) }
            : !params.clearEndTime && current.endTime && Number(current.endTime) > Date.now()
              ? { endTime: current.endTime } : {}),
          restrictToContacts: params.contactsOnly ?? current.restrictToContacts ?? false,
          restrictToDomain: params.domainOnly ?? current.restrictToDomain ?? false
        }
      });

      return {
        enabled: Boolean(updated.enableAutoReply),
        ...(updated.responseSubject && { responseSubject: updated.responseSubject }),
        ...((updated.responseBodyPlainText || updated.responseBodyHtml) && {
          message: updated.responseBodyPlainText ?? updated.responseBodyHtml ?? ''
        }),
        ...(updated.startTime && { startTime: updated.startTime }),
        ...(updated.endTime && { endTime: updated.endTime }),
        contactsOnly: Boolean(updated.restrictToContacts),
        domainOnly: Boolean(updated.restrictToDomain)
      };
    } catch (error) {
      if (error instanceof GmailError) {
        throw error;
      }
      throw new GmailError(
        'Failed to update vacation responder',
        'SETTINGS_ERROR',
        `Error: ${describeApiError(error)}`
      );
    }
  }

  /**
   * Lists the account's send-as aliases, including each alias's signature.
   */
  async listSendAs({ email }: GetGmailSettingsParams): Promise<{ sendAs: SendAsAlias[] }> {
    try {
      const client = this.ensureClient();
      const { data } = await client.users.settings.sendAs.list({ userId: 'me' });

      const sendAs: SendAsAlias[] = (data.sendAs ?? []).map(alias => ({
        sendAsEmail: alias.sendAsEmail ?? '',
        ...(alias.displayName && { displayName: alias.displayName }),
        ...(alias.replyToAddress && { replyToAddress: alias.replyToAddress }),
        ...(alias.signature && { signature: alias.signature }),
        ...(alias.isPrimary !== null && alias.isPrimary !== undefined && { isPrimary: alias.isPrimary }),
        ...(alias.isDefault !== null && alias.isDefault !== undefined && { isDefault: alias.isDefault }),
        ...(alias.verificationStatus && { verificationStatus: alias.verificationStatus })
      }));

      return { sendAs };
    } catch (error) {
      if (error instanceof GmailError) {
        throw error;
      }
      throw new GmailError(
        'Failed to list send-as aliases',
        'SETTINGS_ERROR',
        `Error: ${describeApiError(error)}`
      );
    }
  }
}
