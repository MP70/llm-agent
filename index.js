require('dotenv').config();
const express = require('express');
const ws = require('ws');
const server = express();
const cors = require("cors");
const morgan = require("morgan");
const logger = require('./lib/logger');
const PinoHttp = require('pino-http');
const httpServer = require('http').createServer(server);
const { createEndpoint } = require('@jambonz/node-client-ws');
const makeService = createEndpoint({ server: httpServer });
const api = require("./handlers/api")({ makeService, logger });


const Application = require('./lib/application');

const port = process.env.WS_PORT || 4000;


server.use(express.json());

server.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5001', 'https://openfollow.me', 'https://www.openfollow.me', 'https://simpler-oauth.open-follow.pages.dev'],
  allowedHeaders: ['Cookie', 'Link', 'Content-Type'],
  exposedHeaders: ['Link',],
  credentials: true,

}));

const pino = PinoHttp({
  level: process.env.LOGLEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  },
  serializers: {
    req: (req) => {
      let session = req.raw;
      //let session = res.status !== 200 && req.raw.session;
      return ({
        method: req.method,
        url: req.url,
        //session: req.raw.session,
      });
    },
  },
});

server.use(pino);

server.get("/api/agent/list", api.agentList);
server.post("/api/agent/create", api.agentCreate);
server.delete("/api/agent/:id", api.agentDelete);



appParameters = {
  logger,
  makeService
}





httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanup);
process.once('SIGTERM', function () {
  cleanup().then(() => {
    process.kill(process.pid, 'SIGKILL');
  });
});
process.on('SIGUSR2', function () {
  cleanup().then(() => {
    process.kill(process.pid, 'SIGKILL');
  });
});
async function cleanup() {
  logger.info({}, `beforeExit: applications running`);
  await Application.clean();
}

