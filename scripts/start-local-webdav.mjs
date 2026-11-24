#!/usr/bin/env node
import { MockWebDAVServer } from '../packages/webdav-mock/dist/index.mjs';

const port = Number(process.env.PORT || 8765);
const username = process.env.WEBDAV_USER || 'admin';
const password = process.env.WEBDAV_PASS || 'sessionmesh123';

const server = new MockWebDAVServer({
  requireAuth: { username, password },
});

const running = await server.startHttpServer(port);
console.log('====================================================');
console.log(' SessionMesh Local WebDAV Test Server Started!');
console.log(` WebDAV URL : ${running.url}`);
console.log(` Username   : ${username}`);
console.log(` Password   : ${password}`);
console.log(' Root Path  : /SessionMesh');
console.log(' (在向导第 1 步勾选「允许本地回环 HTTP 调试」即可直接连接)');
console.log('====================================================');
