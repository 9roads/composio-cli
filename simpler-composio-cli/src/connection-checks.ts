import { CliConfig } from './config.js';
import { apiRequest } from './http.js';
import { toolkitFromToolSlug } from './toolkit.js';
import { ComposioNoActiveConnectionError } from './original-compat.js';

type SessionToolkitsResponse = {
  items?: Array<{
    slug?: string;
    is_no_auth?: boolean;
    connected_account?: {
      status?: string;
    } | null;
  }>;
};

export const runConnectedToolkitFailFastForToolkit = async (params: {
  config: CliConfig;
  sessionId: string;
  toolkit: string | undefined;
  skip: boolean;
}): Promise<void> => {
  if (params.skip) return;

  const toolkit = params.toolkit?.trim().toLowerCase();
  if (!toolkit) return;

  const response = await apiRequest<SessionToolkitsResponse>(params.config, {
    method: 'GET',
    path: `/api/v3.1/tool_router/session/${encodeURIComponent(params.sessionId)}/toolkits`,
    query: { toolkits: toolkit, limit: 50 },
  });

  const item = response.items?.find(entry => entry.slug?.toLowerCase() === toolkit);
  if (!item) return;
  if (item.is_no_auth) return;
  if (item.connected_account?.status === 'ACTIVE') return;

  throw new ComposioNoActiveConnectionError({
    details: item,
    toolkit,
  });
};

export const runConnectedToolkitFailFast = async (params: {
  config: CliConfig;
  sessionId: string;
  toolSlug: string;
  skip: boolean;
}): Promise<void> => {
  return runConnectedToolkitFailFastForToolkit({
    config: params.config,
    sessionId: params.sessionId,
    toolkit: toolkitFromToolSlug(params.toolSlug),
    skip: params.skip,
  });
};
