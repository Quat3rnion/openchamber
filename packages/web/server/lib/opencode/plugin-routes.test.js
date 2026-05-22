import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

import { registerPluginRoutes } from './plugin-routes.js';

let projectDir;
let userConfigPath;
let rootDir;
let plugins;
let refreshOpenCodeAfterConfigChange;
let app;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createApp() {
  const testApp = express();
  testApp.use(express.json());
  registerPluginRoutes(testApp, {
    resolveOptionalProjectDirectory: async () => ({ directory: projectDir, error: null }),
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs: 25,
    listPluginEntries: plugins.listPluginEntries,
    getPluginEntry: plugins.getPluginEntry,
    createPluginEntry: plugins.createPluginEntry,
    updatePluginEntry: plugins.updatePluginEntry,
    deletePluginEntry: plugins.deletePluginEntry,
    listPluginDirFiles: plugins.listPluginDirFiles,
    readPluginDirFile: plugins.readPluginDirFile,
    writePluginDirFile: plugins.writePluginDirFile,
    deletePluginDirFile: plugins.deletePluginDirFile,
    encodePluginId: plugins.encodePluginId,
    decodePluginId: plugins.decodePluginId,
  });
  return testApp;
}

async function createEntry(spec = 'a') {
  return request(app)
    .post('/api/config/plugins/entry')
    .send({ spec, scope: 'user' })
    .expect(200);
}

async function createFile(fileName = 'test.js', content = '//x') {
  return request(app)
    .post('/api/config/plugins/file')
    .send({ fileName, content, scope: 'user' })
    .expect(200);
}

describe('opencode plugin routes', () => {
  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-routes-'));
    userConfigPath = path.join(rootDir, 'user-opencode.json');
    process.env.OPENCODE_CONFIG = userConfigPath;
    plugins = await import('./plugins.js');
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(rootDir, 'project-'));
    fs.rmSync(userConfigPath, { force: true });
    fs.rmSync(path.join(rootDir, 'plugins'), { recursive: true, force: true });
    refreshOpenCodeAfterConfigChange = mock(async () => undefined);
    app = createApp();
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG;
  });

  test('GET /api/config/plugins empty returns entries and files arrays', async () => {
    const response = await request(app).get('/api/config/plugins').expect(200);

    expect(response.body).toEqual({ entries: [], files: [] });
  });

  test('POST /entry creates entry and requires reload', async () => {
    const response = await createEntry('a');

    expect(response.body).toMatchObject({ success: true, requiresReload: true, reloadDelayMs: 25 });
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry creation');
  });

  test('GET after POST returns created entry', async () => {
    await createEntry('a');

    const response = await request(app).get('/api/config/plugins').expect(200);

    expect(response.body.entries).toEqual([expect.objectContaining({ spec: 'a', scope: 'user' })]);
  });

  test('POST duplicate entry returns 409', async () => {
    await createEntry('a');

    const response = await request(app)
      .post('/api/config/plugins/entry')
      .send({ spec: 'a', scope: 'user' })
      .expect(409);

    expect(response.body.error).toContain('already exists');
  });

  test('PATCH /entry/:id updates entry in same array index', async () => {
    await createEntry('a');
    const before = await request(app).get('/api/config/plugins').expect(200);
    const id = before.body.entries[0].id;

    const response = await request(app)
      .patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`)
      .send({ spec: 'b' })
      .expect(200);

    expect(response.body.success).toBe(true);
    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries[0]).toEqual(expect.objectContaining({ spec: 'b', scope: 'user' }));
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry update');
  });

  test('DELETE /entry/:id removes entry and prunes plugin key', async () => {
    await createEntry('a');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.entries[0].id;

    await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(200);

    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries).toEqual([]);
    expect(readJson(userConfigPath).plugin).toBeUndefined();
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry deletion');
  });

  test('POST /file writes plugin dir file', async () => {
    const response = await createFile('test.js', '//x');

    expect(response.body).toMatchObject({ success: true, requiresReload: true });
    expect(fs.readFileSync(path.join(rootDir, 'plugins', 'test.js'), 'utf8')).toBe('//x');
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file creation');
  });

  test('POST duplicate file returns 409', async () => {
    await createFile('test.js', '//x');

    const response = await request(app)
      .post('/api/config/plugins/file')
      .send({ fileName: 'test.js', content: '//again', scope: 'user' })
      .expect(409);

    expect(response.body.error).toContain('already exists');
  });

  test('PUT /file/:id updates file content', async () => {
    await createFile('test.js', '//x');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.files[0].id;

    await request(app)
      .put(`/api/config/plugins/file/${encodeURIComponent(id)}`)
      .send({ content: '//y' })
      .expect(200);

    expect(fs.readFileSync(path.join(rootDir, 'plugins', 'test.js'), 'utf8')).toBe('//y');
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file update');
  });

  test('DELETE /file/:id unlinks file', async () => {
    await createFile('test.js', '//x');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.files[0].id;

    await request(app).delete(`/api/config/plugins/file/${encodeURIComponent(id)}`).expect(200);

    expect(fs.existsSync(path.join(rootDir, 'plugins', 'test.js'))).toBe(false);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file deletion');
  });

  test('PATCH unknown entry id returns 404', async () => {
    const id = plugins.encodePluginId('config', 'user:missing');

    const response = await request(app)
      .patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`)
      .send({ spec: 'b' })
      .expect(404);

    expect(response.body.error).toContain('not found');
  });

  test('POST invalid fileName returns 400', async () => {
    const response = await request(app)
      .post('/api/config/plugins/file')
      .send({ fileName: '../escape.js', content: '//x', scope: 'user' })
      .expect(400);

    expect(response.body.error).toContain('Plugin file name');
  });
});
