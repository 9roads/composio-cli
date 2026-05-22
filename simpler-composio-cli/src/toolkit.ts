export const toolkitFromToolSlug = (toolSlug: string): string | undefined => {
  if (toolSlug.toUpperCase().startsWith('LOCAL_')) return undefined;
  const index = toolSlug.indexOf('_');
  if (index <= 0) return toolSlug.toLowerCase();
  const prefix = toolSlug.slice(0, index).trim().toLowerCase();
  return prefix === 'composio' ? undefined : prefix;
};
