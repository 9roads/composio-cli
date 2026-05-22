export type LocalToolsProvider = {
  isLocalToolSlug(slug: string): boolean;
  getLocalToolInputDefinition(slug: string): {
    finalSlug: string;
    toolkit: string;
    schema: Record<string, unknown>;
    version: string;
  } | null;
  executeLocalToolBySlug(slug: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
};

let testProvider: LocalToolsProvider | null = null;
let loadedProvider: LocalToolsProvider | null | undefined;

export const setLocalToolsProviderForTests = (provider: LocalToolsProvider | null): void => {
  testProvider = provider;
  loadedProvider = undefined;
};

const loadProvider = async (): Promise<LocalToolsProvider | null> => {
  if (testProvider) return testProvider;
  if (loadedProvider !== undefined) return loadedProvider;

  try {
    const packageName = '@composio/cli-local-tools';
    const mod = (await import(packageName)) as LocalToolsProvider;
    loadedProvider = mod;
    return loadedProvider;
  } catch {
    try {
      loadedProvider = (await import('./local-tools-provider/index.js')) as LocalToolsProvider;
      return loadedProvider;
    } catch {
      loadedProvider = null;
      return null;
    }
  }
};

export const isPotentialLocalToolSlug = (slug: string): boolean =>
  slug.toUpperCase().startsWith('LOCAL_');

export const isLocalToolSlug = async (slug: string): Promise<boolean> => {
  const provider = await loadProvider();
  if (!provider) return isPotentialLocalToolSlug(slug);
  return provider.isLocalToolSlug(slug);
};

export const getLocalToolInputDefinition = async (
  slug: string
): Promise<ReturnType<LocalToolsProvider['getLocalToolInputDefinition']>> => {
  const provider = await loadProvider();
  return provider?.getLocalToolInputDefinition(slug) ?? null;
};

export const executeLocalTool = async (
  slug: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown> | null> => {
  const provider = await loadProvider();
  if (!provider) return null;
  return provider.executeLocalToolBySlug(slug, args);
};
