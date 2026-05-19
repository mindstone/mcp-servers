import logger from './logger.js';
import { initializeAccountModule } from '../modules/accounts/index.js';
import { initializeGmailModule } from '../modules/gmail/index.js';
import { initializeCalendarModule } from '../modules/calendar/index.js';
import { initializeDriveModule } from '../modules/drive/index.js';
import { initializeDocsModule } from '../modules/docs/index.js';
import { initializeCommentsModule } from '../modules/comments/index.js';
import { initializeSlidesModule } from '../modules/slides/index.js';
import { initializeSheetsModule } from '../modules/sheets/index.js';
import { initializeContactsModule } from '../modules/contacts/index.js';
import { initializeTasksModule } from '../modules/tasks/index.js';
import { initializeFormsModule } from '../modules/forms/index.js';
import { registerGmailScopes } from '../modules/gmail/scopes.js';
import { registerCalendarScopes } from '../modules/calendar/scopes.js';
import { registerDriveScopes } from '../modules/drive/scopes.js';
import { registerDocsScopes } from '../modules/docs/scopes.js';
import { registerSlidesScopes } from '../modules/slides/scopes.js';
import { registerSheetsScopes } from '../modules/sheets/scopes.js';
import { registerTasksScopes } from '../modules/tasks/scopes.js';
import { registerFormsScopes } from '../modules/forms/scopes.js';
import { CONTACTS_SCOPES } from '../modules/contacts/scopes.js';
import { scopeRegistry } from '../modules/tools/scope-registry.js';
import { applyDefaultGoogleRequestOptions } from './request-timeout.js';

/**
 * Feature flag for Tasks and Forms APIs.
 * 
 * These features require additional OAuth scopes that need to be configured
 * in the Google Cloud Console and may require Google verification.
 * Set ENABLE_GOOGLE_TASKS_FORMS=true to enable once scopes are configured.
 * 
 * See: docs/plans/finished/260116_GoogleWorkspace_MCP_Improvements.md
 */
export const TASKS_FORMS_ENABLED = process.env.ENABLE_GOOGLE_TASKS_FORMS === 'true';

// Function to register contacts scopes
function registerContactsScopes(): void {
  scopeRegistry.registerScope("contacts", CONTACTS_SCOPES.READONLY);
  logger.info('Contacts scopes registered');
}

export async function initializeAllServices(): Promise<void> {
  try {
    applyDefaultGoogleRequestOptions();

    // Register all scopes first
    logger.info('Registering API scopes...');
    registerGmailScopes();
    registerCalendarScopes();
    registerDriveScopes();
    registerDocsScopes();
    registerSlidesScopes();
    registerSheetsScopes();
    registerContactsScopes();
    
    // Tasks and Forms require additional OAuth scopes - only register if enabled
    if (TASKS_FORMS_ENABLED) {
      registerTasksScopes();
      registerFormsScopes();
      logger.info('Tasks and Forms scopes registered (ENABLE_GOOGLE_TASKS_FORMS=true)');
    } else {
      logger.info('Tasks and Forms disabled (set ENABLE_GOOGLE_TASKS_FORMS=true to enable)');
    }

    // Initialize account module first as other services depend on it
    logger.info('Initializing account module...');
    await initializeAccountModule();

    // Initialize remaining services in parallel
    logger.info('Initializing service modules in parallel...');
    const modulePromises = [
      initializeDriveModule().then(() => logger.info('Drive module initialized')),
      initializeDocsModule().then(() => logger.info('Docs module initialized')),
      initializeCommentsModule().then(() => logger.info('Comments module initialized')),
      initializeSlidesModule().then(() => logger.info('Slides module initialized')),
      initializeSheetsModule().then(() => logger.info('Sheets module initialized')),
      initializeGmailModule().then(() => logger.info('Gmail module initialized')),
      initializeCalendarModule().then(() => logger.info('Calendar module initialized')),
      initializeContactsModule().then(() => logger.info('Contacts module initialized')),
    ];
    
    // Only initialize Tasks and Forms if enabled
    if (TASKS_FORMS_ENABLED) {
      modulePromises.push(
        initializeTasksModule().then(() => logger.info('Tasks module initialized')),
        initializeFormsModule().then(() => logger.info('Forms module initialized'))
      );
    }
    
    await Promise.all(modulePromises);

    logger.info('All services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
    throw error;
  }
}
