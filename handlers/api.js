const Application = require('../lib/application');

let appParameters, log;

module.exports =
  function ({ logger, wsServer, makeService }) {
    (appParameters = {
      logger,
      wsServer,
      makeService
    });
    log = logger;
    Application.cleanAll();
    return {
      agentList,
      agentCreate,
      agentUpdate,
      agentDelete
    };
  };


/**
* @swagger
* /api/agents:
*   get:
*     summary: Retrieve a list of current agent names
*     description: Get all the existing agent names known to the server
*   post:
*     summary: Create a new agent
*     description: Create a new agent on the LLM and link it to a free phone number on the Jambonz instance
*     produces:
*       - application/json
*     parameters:
*       - name: agentName
*         description: An agent name
*         in: formData
*         required: true
*         type: string
*       - name: prompt
*         description: The system prompt to use for this agent
*         in: formData
*         required: true
*         type: string
*       - name: options
*         description: Options to use for this agent
*         in: formData
*         required: false
*         type: object
*     responses:
*       200:
*         description: OK
*   put:
*     summary: Update an agent
*     description: Change the prompt or options on an existing agent
*   delete:
*     summary: Delete an agent
*     description: Delete an agent and free up the number on the underlying Jambonz instance.
*/

async function agentList(req, res) {
  res.send(Application.listAgents());
}

async function agentCreate(req, res) {
  let { agentName, prompt, options } = req.body;
  log.info({ agentName, body: req.body }, 'create');

  if (!Application.agents[agentName]) {
    res.status(405).send(`no agenty for ${agentName}`);
  }
  else {

    try {
      let application = new Application({ ...appParameters, agentName, prompt, options });
      let number = await application.create();
      log.info({ application, appParameters }, `Application created on NNnumber ${number} with id ${application.id}`);
      res.send({ number, id: application.id, socket: application.agent.socketPath });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'creating agent');
    }


  }

};


async function agentUpdate(req, res) {
  let { prompt, options } = req.body;
  let { id } = req.params;

  let application = Application.recover(id);
  if (!application) {
    res.status(404).send(`no agent ${id}`);
  }
  else {
    application.prompt = prompt;
    application.options = { ...application.options, ...options };
    res.send(application);
  }
};

async function agentDelete(req, res) {
  let { id } = req.params;
  log.info({ id }, 'delete');
  let application;

  if (!(application = Application.recover(id))) {
    res.status(404).send(`no agent for ${id}`);
  }
  else {

    try {
      await application.destroy();
      res.send({ id });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'deleting agent');
    }


  }

};