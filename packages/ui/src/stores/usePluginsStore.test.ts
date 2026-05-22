import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { PluginEntry, PluginFile } from './usePluginsStore';

const activeProjectPath = '/workspace/project';

const refreshAfterOpenCodeRestartMock = mock(async () => undefined);
const startConfigUpdateMock = mock(() => undefined);
const finishConfigUpdateMock = mock(() => undefined);

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
  },
}));

mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: refreshAfterOpenCodeRestartMock,
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: startConfigUpdateMock,
  finishConfigUpdate: finishConfigUpdateMock,
}));

const { usePluginsStore } = await import('./usePluginsStore');

const entry: PluginEntry = {
  id: 'config:user:plugin-a',
  spec: 'plugin-a',
  scope: 'user',
  kind: 'config',
  parsedKind: 'npm',
};

const file: PluginFile = {
  id: 'file:user:plugin.ts',
  fileName: 'plugin.ts',
  scope: 'user',
  kind: 'file',
};

const pluginListPayload = {
  entries: [entry],
  files: [file],
};

const okMutationPayload = {
  success: true,
  requiresReload: false,
  message: 'ok',
  reloadDelayMs: 800,
  reloadFailed: false,
};

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const fetchCalls: FetchCall[] = [];
let queuedResponses: Response[] = [];

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  fetchCalls.push({ input, init });
  return queuedResponses.shift() ?? jsonResponse(pluginListPayload);
});

const queueFetchResponses = (responses: Response[]) => {
  queuedResponses = [...responses];
};

const resetStore = () => {
  usePluginsStore.setState({
    entries: [],
    files: [],
    selectedId: null,
    isLoading: false,
    draft: null,
  });
};

const requestBody = (callIndex: number): unknown => {
  const init = fetchCalls[callIndex]?.init;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
};

describe('usePluginsStore', () => {
  beforeEach(() => {
    resetStore();
    fetchCalls.length = 0;
    queuedResponses = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  test('loadPlugins calls config plugins endpoint once and populates entries/files', async () => {
    const result = await usePluginsStore.getState().loadPlugins();

    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fproject');
    expect(usePluginsStore.getState().entries).toEqual([entry]);
    expect(usePluginsStore.getState().files).toEqual([file]);
    expect(usePluginsStore.getState().isLoading).toBe(false);
  });

  test('second loadPlugins within TTL reuses cached store data', async () => {
    await usePluginsStore.getState().loadPlugins();
    await usePluginsStore.getState().loadPlugins();

    expect(fetchCalls).toHaveLength(1);
  });

  test('force loadPlugins bypasses TTL cache', async () => {
    await usePluginsStore.getState().loadPlugins();
    await usePluginsStore.getState().loadPlugins({ force: true });

    expect(fetchCalls).toHaveLength(2);
  });

  test('createEntry posts spec and scope in request body', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().createEntry({ spec: 'a', scope: 'user' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/entry?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    expect(requestBody(0)).toEqual({ spec: 'a', scope: 'user' });
  });

  test('createEntry includes options when provided', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    await usePluginsStore.getState().createEntry({ spec: 'a', options: { enabled: true }, scope: 'project' });

    expect(requestBody(0)).toEqual({ spec: 'a', options: { enabled: true }, scope: 'project' });
  });

  test('updateEntry patches entry id path', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().updateEntry('entry-id', { spec: 'b' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/entry/entry-id?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('PATCH');
    expect(requestBody(0)).toEqual({ spec: 'b' });
  });

  test('deleteEntry deletes entry id, invalidates cache, reloads, and clears selected id', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse(okMutationPayload), jsonResponse({ entries: [], files: [file] })]);
    await usePluginsStore.getState().loadPlugins();
    usePluginsStore.getState().setSelected(entry.id);

    const result = await usePluginsStore.getState().deleteEntry(entry.id);

    expect(result.ok).toBe(true);
    expect(fetchCalls[1]?.input).toBe(`/api/config/plugins/entry/${encodeURIComponent(entry.id)}?directory=%2Fworkspace%2Fproject`);
    expect(fetchCalls[1]?.init?.method).toBe('DELETE');
    expect(fetchCalls[2]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fproject');
    expect(usePluginsStore.getState().entries).toEqual([]);
    expect(usePluginsStore.getState().selectedId).toBeNull();
  });

  test('createFile posts file name, content, and scope', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().createFile({ fileName: 'plugin.ts', content: 'export {}', scope: 'user' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/file?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    expect(requestBody(0)).toEqual({ fileName: 'plugin.ts', content: 'export {}', scope: 'user' });
  });

  test('failed mutation returns ok false and leaves plugins unchanged', async () => {
    usePluginsStore.setState({ entries: [entry], files: [file] });
    queueFetchResponses([jsonResponse({ error: 'boom' }, { status: 500 })]);

    const result = await usePluginsStore.getState().createEntry({ spec: 'bad', scope: 'user' });

    expect(result).toEqual({ ok: false });
    expect(usePluginsStore.getState().entries).toEqual([entry]);
    expect(usePluginsStore.getState().files).toEqual([file]);
  });

  test('getById returns entries and files by id', () => {
    usePluginsStore.setState({ entries: [entry], files: [file] });

    expect(usePluginsStore.getState().getById(entry.id)).toEqual(entry);
    expect(usePluginsStore.getState().getById(file.id)).toEqual(file);
  });

  test('readFile fetches plugin file content', async () => {
    queueFetchResponses([jsonResponse({ fileName: 'plugin.ts', scope: 'user', content: 'export {}' })]);

    const result = await usePluginsStore.getState().readFile(file.id);

    expect(fetchCalls[0]?.input).toBe(`/api/config/plugins/file/${encodeURIComponent(file.id)}?directory=%2Fworkspace%2Fproject`);
    expect(result).toEqual({ fileName: 'plugin.ts', scope: 'user', content: 'export {}' });
  });
});
