import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import logger from '../utils/logger.js';
import { HubSpotAuthRequiredError } from '../api/hubspot-client.js';
import { allTools } from './definitions.js';
import {
  getAccountManager,
  HubSpotConfigDirInvalidError,
} from '../modules/accounts/manager.js';
import {
  handleListAccounts,
  handleAuthenticateAccount,
  handleCompleteAuth,
  handleRemoveAccount,
  buildHubSpotAuthRequiredResponse,
  AuthenticateAccountArgs,
  CompleteAuthArgs,
  RemoveAccountArgs
} from './account-handlers.js';
import {
  handleSearchContacts,
  handleGetContact,
  handleCreateContact,
  handleUpdateContact,
  handleDeleteContact,
  handleSearchCompanies,
  handleGetCompany,
  handleCreateCompany,
  handleUpdateCompany,
  handleDeleteCompany,
  handleSearchDeals,
  handleGetDeal,
  handleCreateDeal,
  handleUpdateDeal,
  handleDeleteDeal,
  handleSearchTickets,
  handleGetTicket,
  handleCreateTicket,
  handleUpdateTicket,
  handleDeleteTicket,
  handleSearchLeads,
  handleGetLead,
  handleCreateLead,
  handleUpdateLead,
  handleDeleteLead,
  handleSearchTasks,
  handleGetTask,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
  handleCreateNote,
  handleCreateAssociation,
  handleGetAssociations,
  handleDeleteAssociation,
  handleListProperties,
  handleListOwners,
  handleGetOwner,
  handleListPipelines,
  handleGetPipeline,
  handleSearchCalls,
  handleGetCall,
  handleCreateCall,
  handleSearchMeetings,
  handleGetMeeting,
  handleCreateMeeting,
  handleGetContactEngagements,
  handleSearchProducts,
  handleGetProduct,
  handleCreateProduct,
  handleUpdateProduct,
  handleSearchLineItems,
  handleGetLineItem,
  handleCreateLineItem
} from './crm-handlers.js';
import {
  handleListForms,
  handleGetForm,
  handleGetFormSubmissions,
  handleGetAnalyticsReport,
  handleListMarketingEmails,
  handleGetMarketingEmail,
  handleGetEmailStatistics,
  handleListLists,
  handleGetList,
  handleListListMembers,
  handleBatchReadContacts
} from './marketing-handlers.js';
import {
  handleListAssociationLabels,
  handleCreateLabeledAssociation
} from './association-v4-handlers.js';
import {
  handleListWorkflows,
  handleGetWorkflow,
  handleCreateWorkflow,
  handleUpdateWorkflow,
  handleDeleteWorkflow,
  handleActivateWorkflow,
  handleDeactivateWorkflow,
  handleEnrolInWorkflow
} from './workflow-handlers.js';
import {
  handleListKbArticles,
  handleSearchKbArticles,
  handleGetKbArticle
} from './knowledge-base-handlers.js';
import {
  handleGetProperty,
  handleCreateProperty,
  handleUpdateProperty,
  handleDeleteProperty,
  handleListPropertyGroups,
  handleCreatePropertyGroup
} from './property-handlers.js';
import {
  handleUploadFile,
  handleImportFileFromUrl,
  handleGetFile,
  handleDeleteFile,
  handleAttachFileToRecord,
  UploadFileArgs,
  ImportFileFromUrlArgs,
  GetFileArgs,
  DeleteFileArgs,
  AttachFileToRecordArgs
} from './file-handlers.js';
import {
  handleListTicketThreads,
  handleListThreadMessages,
  handleGetThreadMessageOriginalContent,
  ListTicketThreadsArgs,
  ListThreadMessagesArgs,
  GetThreadMessageOriginalContentArgs
} from './conversation-handlers.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
export const SERVER_VERSION: string = pkg.version;

export class HubSpotServer {
  private server: Server;
  private toolAliases: Map<string, string>;

  constructor() {
    this.server = new Server(
      {
        name: 'HubSpot MCP Server',
        version: SERVER_VERSION
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.toolAliases = new Map();
    for (const tool of allTools) {
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          this.toolAliases.set(alias, tool.name);
        }
      }
    }

    this.setupRequestHandlers();
  }

  private async getScopeTier(): Promise<'readonly' | 'full'> {
    // Priority: env var > selected account's stored tier > default 'full'
    if (process.env.HUBSPOT_SCOPE_TIER === 'readonly' || process.env.HUBSPOT_SCOPE_TIER === 'full') {
      return process.env.HUBSPOT_SCOPE_TIER;
    }
    try {
      const accountManager = getAccountManager();
      const accounts = await accountManager.getAccounts();
      const selectedEmail = process.env.HUBSPOT_ACCOUNT_EMAIL?.trim().toLowerCase();
      const selectedAccount = selectedEmail
        ? accounts.find((account) => account.email?.trim().toLowerCase() === selectedEmail)
        : undefined;
      const storedTier = selectedAccount?.scopeTier;
      if (storedTier === 'readonly' || storedTier === 'full') {
        return storedTier;
      }
    } catch (error) {
      if (error instanceof HubSpotConfigDirInvalidError) {
        throw error;
      }

      // Fail-closed: corrupt or unreadable accounts.json must not silently expand
      // the tool surface to 'full'. Surface the failure and downgrade to 'readonly'.
      logger.error('Failed to resolve HubSpot scope tier from accounts.json; falling back to readonly', {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return 'readonly';
    }
    return 'full';
  }

  private hasOAuthClientCredentials(): boolean {
    return !!(process.env.HUBSPOT_CLIENT_ID && process.env.HUBSPOT_CLIENT_SECRET);
  }

  private async hasConfiguredAccountSelection(): Promise<boolean> {
    const accountManager = getAccountManager();
    return accountManager.hasConfiguredAccountEmail();
  }

  private buildAuthRequiredToolResult() {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(buildHubSpotAuthRequiredResponse())
      }],
      isError: true,
      _meta: {}
    };
  }

  private setupRequestHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Get scope tier from env var or stored account config
      const scopeTier = await this.getScopeTier();

      // Filter tools based on tier
      const availableTools = scopeTier === 'readonly'
        ? allTools.filter(tool => tool.annotations?.readOnlyHint === true)
        : allTools;

      return {
        tools: availableTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object' as const,
            properties: tool.inputSchema.properties as Record<string, object>,
            required: tool.inputSchema.required
          },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }))
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = request.params.arguments || {};
        let toolName = request.params.name;

        // Resolve aliases
        if (this.toolAliases.has(toolName)) {
          toolName = this.toolAliases.get(toolName)!;
        }

        const toolMetadata = allTools.find(t => t.name === toolName);
        if (!toolMetadata) {
          throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // Check if tool is available in current scope tier
        const scopeTier = await this.getScopeTier();
        if (scopeTier === 'readonly') {
          if (!toolMetadata.annotations?.readOnlyHint) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  errorCode: 'TOOL_NOT_AVAILABLE',
                  message: `${toolName} requires full access. This account is connected in read-only mode.`,
                  suggestion: 'Reconnect with full access if you need write operations.'
                })
              }],
              isError: true,
              _meta: {}
            };
          }
        }

        if (toolMetadata.requiresAuth) {
          const hasConfiguredAuth = await this.hasConfiguredAccountSelection();
          if (!hasConfiguredAuth) {
            return this.buildAuthRequiredToolResult();
          }
        }

        let result: unknown;

        switch (toolName) {
          // Account Management
          case 'list_hubspot_accounts':
            result = await handleListAccounts();
            break;
          case 'authenticate_hubspot_account':
            result = await handleAuthenticateAccount(args as AuthenticateAccountArgs);
            break;
          case 'complete_hubspot_auth':
            result = await handleCompleteAuth(args as CompleteAuthArgs);
            break;
          case 'remove_hubspot_account':
            result = await handleRemoveAccount(args as unknown as RemoveAccountArgs);
            break;

          // Contacts
          case 'search_hubspot_contacts':
            result = await handleSearchContacts(args as unknown as Parameters<typeof handleSearchContacts>[0]);
            break;
          case 'get_hubspot_contact':
            result = await handleGetContact(args as unknown as Parameters<typeof handleGetContact>[0]);
            break;
          case 'create_hubspot_contact':
            result = await handleCreateContact(args as unknown as Parameters<typeof handleCreateContact>[0]);
            break;
          case 'update_hubspot_contact':
            result = await handleUpdateContact(args as unknown as Parameters<typeof handleUpdateContact>[0]);
            break;
          case 'delete_hubspot_contact':
            result = await handleDeleteContact(args as unknown as Parameters<typeof handleDeleteContact>[0]);
            break;

          // Companies
          case 'search_hubspot_companies':
            result = await handleSearchCompanies(args as unknown as Parameters<typeof handleSearchCompanies>[0]);
            break;
          case 'get_hubspot_company':
            result = await handleGetCompany(args as unknown as Parameters<typeof handleGetCompany>[0]);
            break;
          case 'create_hubspot_company':
            result = await handleCreateCompany(args as unknown as Parameters<typeof handleCreateCompany>[0]);
            break;
          case 'update_hubspot_company':
            result = await handleUpdateCompany(args as unknown as Parameters<typeof handleUpdateCompany>[0]);
            break;
          case 'delete_hubspot_company':
            result = await handleDeleteCompany(args as unknown as Parameters<typeof handleDeleteCompany>[0]);
            break;

          // Deals
          case 'search_hubspot_deals':
            result = await handleSearchDeals(args as unknown as Parameters<typeof handleSearchDeals>[0]);
            break;
          case 'get_hubspot_deal':
            result = await handleGetDeal(args as unknown as Parameters<typeof handleGetDeal>[0]);
            break;
          case 'create_hubspot_deal':
            result = await handleCreateDeal(args as unknown as Parameters<typeof handleCreateDeal>[0]);
            break;
          case 'update_hubspot_deal':
            result = await handleUpdateDeal(args as unknown as Parameters<typeof handleUpdateDeal>[0]);
            break;
          case 'delete_hubspot_deal':
            result = await handleDeleteDeal(args as unknown as Parameters<typeof handleDeleteDeal>[0]);
            break;

          // Tickets
          case 'search_hubspot_tickets':
            result = await handleSearchTickets(args as unknown as Parameters<typeof handleSearchTickets>[0]);
            break;
          case 'get_hubspot_ticket':
            result = await handleGetTicket(args as unknown as Parameters<typeof handleGetTicket>[0]);
            break;
          case 'create_hubspot_ticket':
            result = await handleCreateTicket(args as unknown as Parameters<typeof handleCreateTicket>[0]);
            break;
          case 'update_hubspot_ticket':
            result = await handleUpdateTicket(args as unknown as Parameters<typeof handleUpdateTicket>[0]);
            break;
          case 'delete_hubspot_ticket':
            result = await handleDeleteTicket(args as unknown as Parameters<typeof handleDeleteTicket>[0]);
            break;

          // Leads
          case 'search_hubspot_leads':
            result = await handleSearchLeads(args as unknown as Parameters<typeof handleSearchLeads>[0]);
            break;
          case 'get_hubspot_lead':
            result = await handleGetLead(args as unknown as Parameters<typeof handleGetLead>[0]);
            break;
          case 'create_hubspot_lead':
            result = await handleCreateLead(args as unknown as Parameters<typeof handleCreateLead>[0]);
            break;
          case 'update_hubspot_lead':
            result = await handleUpdateLead(args as unknown as Parameters<typeof handleUpdateLead>[0]);
            break;
          case 'delete_hubspot_lead':
            result = await handleDeleteLead(args as unknown as Parameters<typeof handleDeleteLead>[0]);
            break;

          // Tasks
          case 'search_hubspot_tasks':
            result = await handleSearchTasks(args as unknown as Parameters<typeof handleSearchTasks>[0]);
            break;
          case 'get_hubspot_task':
            result = await handleGetTask(args as unknown as Parameters<typeof handleGetTask>[0]);
            break;
          case 'create_hubspot_task':
            result = await handleCreateTask(args as unknown as Parameters<typeof handleCreateTask>[0]);
            break;
          case 'update_hubspot_task':
            result = await handleUpdateTask(args as unknown as Parameters<typeof handleUpdateTask>[0]);
            break;
          case 'delete_hubspot_task':
            result = await handleDeleteTask(args as unknown as Parameters<typeof handleDeleteTask>[0]);
            break;

          // Notes
          case 'create_hubspot_note':
            result = await handleCreateNote(args as unknown as Parameters<typeof handleCreateNote>[0]);
            break;

          // Associations
          case 'create_hubspot_association':
            result = await handleCreateAssociation(args as unknown as Parameters<typeof handleCreateAssociation>[0]);
            break;
          case 'get_hubspot_associations':
            result = await handleGetAssociations(args as unknown as Parameters<typeof handleGetAssociations>[0]);
            break;
          case 'delete_hubspot_association':
            result = await handleDeleteAssociation(args as unknown as Parameters<typeof handleDeleteAssociation>[0]);
            break;

          // v4 Associations (labeled)
          case 'list_hubspot_association_labels':
            result = await handleListAssociationLabels(args as unknown as Parameters<typeof handleListAssociationLabels>[0]);
            break;
          case 'create_hubspot_labeled_association':
            result = await handleCreateLabeledAssociation(args as unknown as Parameters<typeof handleCreateLabeledAssociation>[0]);
            break;

          // Workflows (v4 BETA)
          case 'list_hubspot_workflows':
            result = await handleListWorkflows(args as unknown as Parameters<typeof handleListWorkflows>[0]);
            break;
          case 'get_hubspot_workflow':
            result = await handleGetWorkflow(args as unknown as Parameters<typeof handleGetWorkflow>[0]);
            break;
          case 'create_hubspot_workflow':
            result = await handleCreateWorkflow(args as unknown as Parameters<typeof handleCreateWorkflow>[0]);
            break;
          case 'update_hubspot_workflow':
            result = await handleUpdateWorkflow(args as unknown as Parameters<typeof handleUpdateWorkflow>[0]);
            break;
          case 'delete_hubspot_workflow':
            result = await handleDeleteWorkflow(args as unknown as Parameters<typeof handleDeleteWorkflow>[0]);
            break;
          case 'activate_hubspot_workflow':
            result = await handleActivateWorkflow(args as unknown as Parameters<typeof handleActivateWorkflow>[0]);
            break;
          case 'deactivate_hubspot_workflow':
            result = await handleDeactivateWorkflow(args as unknown as Parameters<typeof handleDeactivateWorkflow>[0]);
            break;
          case 'enrol_in_hubspot_workflow':
            result = await handleEnrolInWorkflow(args as unknown as Parameters<typeof handleEnrolInWorkflow>[0]);
            break;

          // Properties
          case 'list_hubspot_properties':
            result = await handleListProperties(args as unknown as Parameters<typeof handleListProperties>[0]);
            break;
          case 'get_hubspot_property':
            result = await handleGetProperty(args as unknown as Parameters<typeof handleGetProperty>[0]);
            break;
          case 'create_hubspot_property':
            result = await handleCreateProperty(args as unknown as Parameters<typeof handleCreateProperty>[0]);
            break;
          case 'update_hubspot_property':
            result = await handleUpdateProperty(args as unknown as Parameters<typeof handleUpdateProperty>[0]);
            break;
          case 'delete_hubspot_property':
            result = await handleDeleteProperty(args as unknown as Parameters<typeof handleDeleteProperty>[0]);
            break;
          case 'list_hubspot_property_groups':
            result = await handleListPropertyGroups(args as unknown as Parameters<typeof handleListPropertyGroups>[0]);
            break;
          case 'create_hubspot_property_group':
            result = await handleCreatePropertyGroup(args as unknown as Parameters<typeof handleCreatePropertyGroup>[0]);
            break;

          // Owners
          case 'list_hubspot_owners':
            result = await handleListOwners(args as unknown as Parameters<typeof handleListOwners>[0]);
            break;
          case 'get_hubspot_owner':
            result = await handleGetOwner(args as unknown as Parameters<typeof handleGetOwner>[0]);
            break;

          // Pipelines
          case 'list_hubspot_pipelines':
            result = await handleListPipelines(args as unknown as Parameters<typeof handleListPipelines>[0]);
            break;
          case 'get_hubspot_pipeline':
            result = await handleGetPipeline(args as unknown as Parameters<typeof handleGetPipeline>[0]);
            break;

          // Engagements - Calls
          case 'search_hubspot_calls':
            result = await handleSearchCalls(args as unknown as Parameters<typeof handleSearchCalls>[0]);
            break;
          case 'get_hubspot_call':
            result = await handleGetCall(args as unknown as Parameters<typeof handleGetCall>[0]);
            break;
          case 'create_hubspot_call':
            result = await handleCreateCall(args as unknown as Parameters<typeof handleCreateCall>[0]);
            break;

          // Engagements - Meetings
          case 'search_hubspot_meetings':
            result = await handleSearchMeetings(args as unknown as Parameters<typeof handleSearchMeetings>[0]);
            break;
          case 'get_hubspot_meeting':
            result = await handleGetMeeting(args as unknown as Parameters<typeof handleGetMeeting>[0]);
            break;
          case 'create_hubspot_meeting':
            result = await handleCreateMeeting(args as unknown as Parameters<typeof handleCreateMeeting>[0]);
            break;

          // Contact timeline
          case 'get_contact_engagements':
            result = await handleGetContactEngagements(args as unknown as Parameters<typeof handleGetContactEngagements>[0]);
            break;

          // Products
          case 'search_hubspot_products':
            result = await handleSearchProducts(args as unknown as Parameters<typeof handleSearchProducts>[0]);
            break;
          case 'get_hubspot_product':
            result = await handleGetProduct(args as unknown as Parameters<typeof handleGetProduct>[0]);
            break;
          case 'create_hubspot_product':
            result = await handleCreateProduct(args as unknown as Parameters<typeof handleCreateProduct>[0]);
            break;
          case 'update_hubspot_product':
            result = await handleUpdateProduct(args as unknown as Parameters<typeof handleUpdateProduct>[0]);
            break;

          // Line Items
          case 'search_hubspot_line_items':
            result = await handleSearchLineItems(args as unknown as Parameters<typeof handleSearchLineItems>[0]);
            break;
          case 'get_hubspot_line_item':
            result = await handleGetLineItem(args as unknown as Parameters<typeof handleGetLineItem>[0]);
            break;
          case 'create_hubspot_line_item':
            result = await handleCreateLineItem(args as unknown as Parameters<typeof handleCreateLineItem>[0]);
            break;

          // Forms
          case 'list_hubspot_forms':
            result = await handleListForms(args as unknown as Parameters<typeof handleListForms>[0]);
            break;
          case 'get_hubspot_form':
            result = await handleGetForm(args as unknown as Parameters<typeof handleGetForm>[0]);
            break;
          case 'get_hubspot_form_submissions':
            result = await handleGetFormSubmissions(args as unknown as Parameters<typeof handleGetFormSubmissions>[0]);
            break;

          // Analytics
          case 'get_hubspot_analytics_report':
            result = await handleGetAnalyticsReport(args as unknown as Parameters<typeof handleGetAnalyticsReport>[0]);
            break;

          // Marketing Emails
          case 'list_hubspot_marketing_emails':
            result = await handleListMarketingEmails(args as unknown as Parameters<typeof handleListMarketingEmails>[0]);
            break;
          case 'get_hubspot_marketing_email':
            result = await handleGetMarketingEmail(args as unknown as Parameters<typeof handleGetMarketingEmail>[0]);
            break;
          case 'get_hubspot_email_statistics':
            result = await handleGetEmailStatistics(args as unknown as Parameters<typeof handleGetEmailStatistics>[0]);
            break;

          // Lists/Segments
          case 'list_hubspot_lists':
            result = await handleListLists(args as unknown as Parameters<typeof handleListLists>[0]);
            break;
          case 'get_hubspot_list':
            result = await handleGetList(args as unknown as Parameters<typeof handleGetList>[0]);
            break;
          case 'list_hubspot_list_members':
            result = await handleListListMembers(args as unknown as Parameters<typeof handleListListMembers>[0]);
            break;
          case 'batch_read_hubspot_contacts':
            result = await handleBatchReadContacts(args as unknown as Parameters<typeof handleBatchReadContacts>[0]);
            break;

          // Knowledge Base
          case 'list_hubspot_kb_articles':
            result = await handleListKbArticles(args as unknown as Parameters<typeof handleListKbArticles>[0]);
            break;
          case 'search_hubspot_kb_articles':
            result = await handleSearchKbArticles(args as unknown as Parameters<typeof handleSearchKbArticles>[0]);
            break;
          case 'get_hubspot_kb_article':
            result = await handleGetKbArticle(args as unknown as Parameters<typeof handleGetKbArticle>[0]);
            break;

          // Conversations (read-only)
          case 'list_hubspot_ticket_threads':
            result = await handleListTicketThreads(args as unknown as ListTicketThreadsArgs);
            break;
          case 'list_hubspot_thread_messages':
            result = await handleListThreadMessages(args as unknown as ListThreadMessagesArgs);
            break;
          case 'get_hubspot_thread_message_original_content':
            result = await handleGetThreadMessageOriginalContent(args as unknown as GetThreadMessageOriginalContentArgs);
            break;

          // Files
          case 'upload_hubspot_file':
            result = await handleUploadFile(args as unknown as UploadFileArgs);
            break;
          case 'import_hubspot_file_from_url':
            result = await handleImportFileFromUrl(args as unknown as ImportFileFromUrlArgs);
            break;
          case 'get_hubspot_file':
            result = await handleGetFile(args as unknown as GetFileArgs);
            break;
          case 'delete_hubspot_file':
            result = await handleDeleteFile(args as unknown as DeleteFileArgs);
            break;
          case 'attach_file_to_record':
            result = await handleAttachFileToRecord(args as unknown as AttachFileToRecordArgs);
            break;

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // Account handlers return MCP-formatted responses with content array
        if (result && typeof result === 'object' && 'content' in result) {
          return { ...result as object, _meta: {} };
        }

        // Other handlers return raw data to be wrapped
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }],
          _meta: {}
        };
      } catch (error) {
        logger.error(`Error executing tool ${request.params.name}`, error);

        if (error instanceof HubSpotAuthRequiredError) {
          return this.buildAuthRequiredToolResult();
        }
        
        // Check if error message is already a structured JSON error from our handlers
        let errorPayload: object;
        if (error instanceof Error) {
          try {
            // Our handlers throw errors with JSON.stringify'd structured errors
            const parsed = JSON.parse(error.message);
            if (parsed.status === 'auth_required') {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify(parsed, null, 2)
                }],
                isError: true,
                _meta: {}
              };
            }
            if (parsed.errorCode && (parsed.suggestion || parsed.status === 'error' || parsed.isError === true)) {
              // This is our structured error format, use it directly
              errorPayload = parsed;
            } else {
              throw new Error('Not our format');
            }
          } catch {
            // Not a structured error, wrap it
            errorPayload = {
              error: error.message,
              errorCode: 'UNKNOWN_ERROR',
              suggestion: 'Check your HubSpot connection and try again'
            };
          }
        } else {
          errorPayload = {
            error: 'Unknown error',
            errorCode: 'UNKNOWN_ERROR', 
            suggestion: 'Check your HubSpot connection and try again'
          };
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(errorPayload, null, 2)
          }],
          isError: true,
          _meta: {}
        };
      }
    });
  }

  async run(): Promise<void> {
    try {
      logger.info(`HubSpot MCP Server v${SERVER_VERSION} starting...`);

      this.server.onerror = (error) => {
        logger.error('MCP Server error', error);
      };

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      logger.info('HubSpot MCP server running on stdio');
    } catch (error) {
      logger.error('Fatal server error', error);
      throw error;
    }
  }
}
