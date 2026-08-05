import {
  GraphQLResponse,
  HubSpotApiError,
  getHubSpotClientAsync
} from '../api/hubspot-client.js';
import {
  buildHubSpotCapabilityDeniedError,
  parseHubSpotError,
  summariseHubSpotApiError,
} from '../utils/error-parser.js';
import logger from '../utils/logger.js';
import { sanitizeHubSpotResponse } from '../sanitize.js';

/**
 * Internal classification for a KB GraphQL error. GraphQL returns HTTP 200 even
 * on failure, so `handleGraphQLErrors` throws this to carry the cause across to
 * `parseKnowledgeBaseError`, which owns the user-facing copy. The message is
 * internal/log-only — these are always re-parsed, never surfaced directly.
 */
type KbGraphQLErrorKind = 'scope' | 'tier';

class KbGraphQLError extends Error {
  constructor(public readonly kind: KbGraphQLErrorKind, message: string) {
    super(message);
    this.name = 'KbGraphQLError';
  }
}

interface ListKbArticlesArgs {
  limit?: number;
  offset?: number;
}

interface SearchKbArticlesArgs {
  query: string;
  limit?: number;
}

interface GetKbArticleArgs {
  articleId: string;
}

// GraphQL response shapes for KB queries
// Only fields confirmed in HubSpot's official GraphQL KB docs are included.
// hs_slug, hs_language, hs_meta_description are unverified but commonly work;
// hs_url/hs_created/hs_updated do NOT exist — use hs_path instead.
interface KbArticleGraphQL {
  hs_id: string;
  hs_name: string;
  hs_body?: string;
  hs_path?: string;
  hs_slug?: string;
  hs_language?: string;
  hs_meta_description?: string;
}

interface KbArticleCollectionResponse {
  KB: {
    knowledge_article_collection: {
      total: number;
      items: KbArticleGraphQL[];
    };
  };
}

interface KbArticleSingleResponse {
  KB: {
    knowledge_article: KbArticleGraphQL;
  };
}

/**
 * Map GraphQL KB article fields (hs_* prefix) to user-friendly names.
 */
function mapGraphQLArticle(article: KbArticleGraphQL): Record<string, unknown> {
  return {
    id: article.hs_id,
    title: article.hs_name,
    body: article.hs_body,
    path: article.hs_path,
    slug: article.hs_slug,
    language: article.hs_language,
    metaDescription: article.hs_meta_description,
  };
}

/**
 * Check a GraphQL response for errors and throw with a user-friendly message.
 * GraphQL returns HTTP 200 even for errors — must check `response.errors` first.
 */
function handleGraphQLErrors(response: GraphQLResponse<unknown>, operation: string): void {
  if (!response.errors || response.errors.length === 0) return;

  const errorMessages = response.errors.map(e => e.message).join('; ');
  const lowerErrors = errorMessages.toLowerCase();

  // Scope-related errors. Classification only — parseKnowledgeBaseError owns the
  // user-facing copy (honest multi-cause, not reconnect-first).
  if (
    lowerErrors.includes('scope') ||
    lowerErrors.includes('permission') ||
    lowerErrors.includes('forbidden') ||
    lowerErrors.includes('unauthorized') ||
    lowerErrors.includes('oauth')
  ) {
    throw new KbGraphQLError('scope', `Knowledge Base access denied (scope) during ${operation}`);
  }

  // Schema/type not found errors — likely missing Service Hub tier
  if (
    lowerErrors.includes('type') && (lowerErrors.includes('not found') || lowerErrors.includes('unknown')) ||
    lowerErrors.includes('field') && (lowerErrors.includes('not found') || lowerErrors.includes('unknown')) ||
    lowerErrors.includes('cannot query')
  ) {
    throw new KbGraphQLError('tier', `Knowledge Base GraphQL types unavailable (tier) during ${operation}`);
  }

  // Generic GraphQL error. Do not echo HubSpot's raw GraphQL error text:
  // it can include customer-entered article content or validation echoes.
  throw new Error(`GraphQL error during ${operation}`);
}

function parseKnowledgeBaseError(
  error: unknown,
  operation: string,
  args?: unknown
): ReturnType<typeof parseHubSpotError> {
  // Handle GraphQL errors (HTTP 200) that were re-thrown as a classified KbGraphQLError.
  if (error instanceof KbGraphQLError) {
    if (error.kind === 'tier') {
      return {
        error: 'Knowledge Base feature is not available for this HubSpot account',
        errorCode: 'SERVICE_HUB_REQUIRED',
        suggestion: 'Knowledge Base requires Service Hub Professional or Enterprise.'
      };
    }
    // Scope case: honest multi-cause copy, not reconnect-first. A KB scope that is
    // absent on a healthy connection is usually a plan/permission gap, not a stale token.
    const kbDenied = buildHubSpotCapabilityDeniedError({
      objectType: 'knowledge_base_articles',
      operation,
      args,
    });
    return {
      error: kbDenied.error,
      errorCode: 'SCOPE_MISSING',
      suggestion: kbDenied.suggestion,
    };
  }

  if (error instanceof HubSpotApiError && error.statusCode === 403) {
    const errorText = JSON.stringify(error.details || error.message || '').toLowerCase();
    const hasScopeKeyword =
      errorText.includes('scope') ||
      errorText.includes('oauth');
    const hasServiceHubHint =
      errorText.includes('service hub') ||
      errorText.includes('knowledge base') ||
      errorText.includes('professional') ||
      errorText.includes('enterprise') ||
      errorText.includes('upgrade');

    // Check Service Hub tier FIRST — tier errors often contain generic words
    // like "permission" or "forbidden" that would match scope heuristics
    if (hasServiceHubHint) {
      return {
        error: 'Knowledge Base feature is not available for this HubSpot account',
        errorCode: 'SERVICE_HUB_REQUIRED',
        suggestion: 'Knowledge Base requires Service Hub Professional or Enterprise.'
      };
    }

    // Scope keyword, or a generic KB 403: honest multi-cause copy rather than
    // reconnect-first. The plan hint already names the Service Hub tier requirement.
    const kbDenied = buildHubSpotCapabilityDeniedError({
      objectType: 'knowledge_base_articles',
      operation,
      args,
    });
    return {
      error: kbDenied.error,
      errorCode: hasScopeKeyword ? 'SCOPE_MISSING' : 'KB_ACCESS_DENIED',
      suggestion: kbDenied.suggestion,
      details: summariseHubSpotApiError(error, { operation }),
    };
  }

  return parseHubSpotError(error, {
    objectType: 'knowledge_base_articles',
    operation,
    args
  });
}

export async function handleListKbArticles(args: ListKbArticlesArgs): Promise<{
  articles: Record<string, unknown>[];
  total: number;
  paging: {
    offset: number;
    limit: number;
  };
}> {
  try {
    const client = await getHubSpotClientAsync();
    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;

    const query = `{
  KB {
    knowledge_article_collection(limit: ${limit}, offset: ${offset}) {
      total
      items {
        hs_id
        hs_name
        hs_body
        hs_path
        hs_slug
        hs_language
        hs_meta_description
      }
    }
  }
}`;

    logger.debug('GraphQL KB list query', { limit, offset });
    const response = await client.graphqlQuery<KbArticleCollectionResponse>(query);

    // Log raw response shape for diagnostics
    if (response.errors) {
      logger.warn('GraphQL KB list returned errors', { errorCount: response.errors.length });
    }
    logger.debug('GraphQL KB list response', {
      hasData: !!response.data,
      hasErrors: !!response.errors,
      dataKeys: response.data ? Object.keys(response.data) : [],
    });

    // CRITICAL: GraphQL returns HTTP 200 even for errors — check errors first
    handleGraphQLErrors(response, 'list_kb_articles');

    const collection = response.data?.KB?.knowledge_article_collection;
    if (!collection) {
      logger.warn('GraphQL KB list: unexpected response shape — KB.knowledge_article_collection missing', {
        dataKeys: response.data ? Object.keys(response.data) : [],
        kbKeys: response.data?.KB ? Object.keys(response.data.KB) : [],
      });
    }
    const items = collection?.items ?? [];
    const total = collection?.total ?? 0;

    const articles = items.map(mapGraphQLArticle);

    logger.info(`Listed ${articles.length} KB articles (total: ${total}, offset: ${offset}, limit: ${limit})`);
    return {
      articles: sanitizeHubSpotResponse(articles, 'hubspot:knowledge-base'),
      total,
      paging: { offset, limit }
    };
  } catch (error) {
    const parsed = parseKnowledgeBaseError(error, 'list_kb_articles', args);
    logger.error('List KB articles failed', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetKbArticle(args: GetKbArticleArgs): Promise<Record<string, unknown>> {
  try {
    const client = await getHubSpotClientAsync();

    // Escape backslashes first, then quotes — to prevent GraphQL string-injection
    // via inputs that end in or contain a backslash (e.g. `bad\` would otherwise
    // let the trailing backslash escape the closing quote in the template literal).
    const safeArticleId = args.articleId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const query = `{
  KB {
    knowledge_article(uniqueIdentifier: "hs_id", uniqueIdentifierValue: "${safeArticleId}") {
      hs_id
      hs_name
      hs_body
      hs_path
      hs_slug
      hs_language
      hs_meta_description
    }
  }
}`;

    logger.debug('GraphQL KB get query', { articleId: args.articleId });
    const response = await client.graphqlQuery<KbArticleSingleResponse>(query);

    if (response.errors) {
      logger.warn('GraphQL KB get returned errors', { errorCount: response.errors.length });
    }
    logger.debug('GraphQL KB get response', {
      hasData: !!response.data,
      hasErrors: !!response.errors,
      dataKeys: response.data ? Object.keys(response.data) : [],
    });

    // CRITICAL: GraphQL returns HTTP 200 even for errors — check errors first
    handleGraphQLErrors(response, 'get_kb_article');

    const article = response.data?.KB?.knowledge_article;
    if (!article) {
      logger.warn('GraphQL KB get: article not found in response', {
        articleId: args.articleId,
        dataKeys: response.data ? Object.keys(response.data) : [],
        kbKeys: response.data?.KB ? Object.keys(response.data.KB) : [],
      });
      throw new Error(`KB article ${args.articleId} not found`);
    }

    logger.info(`Retrieved KB article ${args.articleId}`);
    return sanitizeHubSpotResponse(mapGraphQLArticle(article), 'hubspot:knowledge-base');
  } catch (error) {
    const parsed = parseKnowledgeBaseError(error, 'get_kb_article', args);
    logger.error('Get KB article failed', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleSearchKbArticles(args: SearchKbArticlesArgs): Promise<{
  query: string;
  results: unknown[];
  total?: number;
}> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.searchSiteContent(args.query, 'KNOWLEDGE_ARTICLE', args.limit, 0);
    logger.info(`Found ${result.results.length} KB search results for query "${args.query}"`);
    return {
      query: args.query,
      results: sanitizeHubSpotResponse(result.results, 'hubspot:knowledge-base'),
      total: result.total
    };
  } catch (error) {
    const parsed = parseKnowledgeBaseError(error, 'search_kb_articles', args);
    logger.error('Search KB articles failed', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
