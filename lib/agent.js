const uuid = require('uuid').v4;
/**
 *
 * @param {*} { progress, logger, session, llmClass, prompt, options }
 * @param {Object} params Session parameters
 * @param {string} params.path The path to this service
 * @param {Llm} params.agent LLM class instance for implementation class
 * @param {WebSocket} params.progress A websocket to write progress messages to
 * @param {Object} params.logger Pino logger instance
 * @param {Object} params.session Jambonz WebSocket session object
 * @param {Object} params.options Options object containing combined STT, TTS and model options
 */
class JambonzSession {
  constructor({ path, agent, progress, logger, session, options }) {
    Object.assign(this, {
      path,
      agent,
      progress: {
        send: (msg) => progress.send({ ...msg, call_id: session.call_sid })
      },
      logger: logger.child({ call_sid: session.call_sid }),
      session
    });
    this.options = options;
    this.waiting = {};
  }

  set prompt(newPrompt) {
    this.agent.prompt = newPrompt;
  }
  set options(newValue) {
    this._options = newValue;
    newValue.tts && (this.sayOptions = {
      // ick, better non vendor specific way of doing this needed
      id: uuid(),
      synthesizer: { vendor: "google", ...newValue.tts }
    });
    this.agent.options = this._options;
  }
  get options() {
    return this?._options;
  }


  async #waitFor(id) {
    return id ? new Promise(resolve => (this.waiting[id] = resolve)) : Promise.resolve(); 
  }

  /**
   * Handler for a Jambonz session, main wait loop that sets listeners on Jambonz and the LLM agent
   * dispatches messages between them as long as they are both responding and closes them gracefully
   * on hangup or other errors.
   * 
   * @return {Promise} Resolves to a void value when the conversation ends
   * @memberof JambonzSession
   */
  async handler() {
    let { session, progress, logger, agent } = this;
    logger.info({ handler: this }, `new incoming call`);
    progress && progress.send({ call: session?.from || 'unknown' });

    let sessionEnded = new Promise(resolve => {
      session
        .config({ notifyEvents: true })
        .on('/prompt', evt => this.#onUserPrompt(evt))
        .on('/record', evt => this.logger.info({ evt }, `recording`))
        .on('verb:status', evt => {
          this.logger.debug({ evt }, 'verb:status');
          evt.event === 'finished' && this.waiting[evt.id] && this.waiting[evt.id]() && (this.waiting[evt.id] = null);
        })
        .on('close', (code, reason) => {
          this.#onClose(code, reason);
          resolve();
        })
        .on('error', err => this.#onError(err));
    });

    // This is horrid, the following code segment duplicates much the same functionality to kick
    //   the conversation off as #sendCompletion does for the 2nd and subsequent turns.
    // Needs a re-factor to do this logic once, but the whole thing needs a refactor to become
    //  fully async streaming based so will put this off until after we have landed function calling fully.
    //  
    try {
      session.listen({
        url: this.path
      })
        .send();
      let { text, calls, error } = await agent.initial();
      logger.info({ text, function_calls: calls }, 'Got initial completion');
      text && progress && progress.send({ agent:text });
      while (calls && calls.length) {
        this.awaitingFunctionCalls = new Promise(resolve => (this.gotFunctionCalls = resolve));
        progress ? progress.send({ function_calls: calls }) : this.gotFunctionCalls(this.#functionsFailed(calls));
        let results = await this.awaitingFunctionCalls;
        logger.debug({ progress, results }, 'got function call results');
        try {
          ({ text, calls } = {});
          ({ text, calls, error } = await agent.callResult(results));
          logger.debug({ text, calls, error }, 'got bare completion from LLM');
          text && progress && progress.send({ agent:text });
        } catch (err) {
          logger.error({ err }, 'Error sending function results');
          text = 'Sorry, I am having a bit of trouble getting the data you need at the moment. Lets try again...';
        }
        this.awaitingFunctionCalls = undefined;
      }
      let completion = `<speak>${text||'Sorry I seem to be having an LLM problem at the moment'}</speak>`;
      logger.debug({
        text: completion || "Hello, how may I help you",
        ...this.sayOptions,
        id: uuid()
      }, 'saying');
      session
        .pause({ length: 0.5 })
        .say({
          text: completion || "Hello, how may I help you",
          ...this.sayOptions,
          id: uuid()
        })
        .gather({
          input: ['speech'],
          actionHook: '/prompt',
          listenDuringPrompt: true,
          timeout: 20,
          recognizer: {
            vendor: "google",
            language: "en-GB",
            hints: this.agent.voiceHints
          }
        })
        .send();
    }
    catch (err) {
      this.#onError(err);
    }
    await sessionEnded;
  }

  /**
   * Force closes a (maybe) open session, send some polite text to the caller
   * then hangup. Doesn't really do much of the cleanup, just waits for it to
   * happen
   * 
   * 
   * @return {Promise} Resolves to a void value when the conversation finally closes
   * @memberof JambonzSession
   */
  async forceClose() {
    let { session, progress, logger } = this;
    let text = 'I\'m sorry, I have to go now. Goodbye';
    progress.send({ goodbye: text });
    let closed = new Promise(resolve => session.on('close', resolve));
    await session
      .say({ text, ...this.sayOptions })
      .hangup()
      .send();
    await closed;
    logger.info({}, `force close ${session.call_sid} done`);
  };
  /**
   * Inject a phrase into the conversation via TTS. Doesn't change the AI turn in any way
   *
   * @param {string} text text to be spoken into the conversation by TTS
   * @memberof JambonzSession
   * @returns {Promise} resolves when Jambonz accepts transaction
   */
  async inject(text) {
    const { logger, session, progress } = this;
    logger.debug({ text }, `Injecting phrase`);

    progress.send({ inject: text });
    await session
      .gather({
        input: ['speech'],
        actionHook: '/prompt',
        listenDuringPrompt: true,
        timeout: 20,
        say: { text, ...this.sayOptions }
      })
      .send();

  }

  onMessage(message) {
    message.function_results && this?.gotFunctionCalls(message.function_results);
  }

  async #onUserPrompt(evt) {
    let { logger, session } = this;
    logger.debug(`got speech evt: ${JSON.stringify(evt)}`);
    switch (evt.reason) {
      case 'speechDetected':
        this.#sendCompletion(evt);
        break;
      case 'timeout':
        this.#goodbye();
        break;
      default:
        session.reply();
        break;
    }
  };

  async #sendCompletion(evt) {
    const { logger, session, progress, agent } = this;
    const { transcript, confidence } = evt.speech.alternatives[0];
    let text, hangup, data, error, calls = false;

    session
      //.play({ url: 'https://llm.aplisay.com/slight-noise.wav' })
      .reply();
    progress.send({ user: transcript });

    logger.info({ transcript }, 'sending prompt to LLM');
    try {
      ({ text, hangup, data, calls } = await agent.completion(transcript));
      logger.debug({ text, hangup, data, calls }, 'got completion from LLM');

    } catch (err) {
      logger.info({ err }, 'LLM error');
      text = 'Sorry, I am having a bit of trouble at the moment. This is a me thing, not a you thing.';
    }

    text && progress && progress.send({ agent:text });
    data && progress && progress.send({ data });
    while (calls && calls.length) {
      let waitingId;
      text && (waitingId = uuid()) && session
        .say({ text: `<speak>${text}</speak>`, ...this.sayOptions, id: waitingId })
        .send();
      this.awaitingFunctionCalls = new Promise(resolve => (this.gotFunctionCalls = resolve));
      progress ? progress.send({ function_calls: calls }) : this.gotFunctionCalls(this.#functionsFailed(calls));
      let results = await this.awaitingFunctionCalls;
      logger.debug({ progress, results }, 'got function call results');
      try {
        ({ text, hangup, data, calls, error } = {});
        ({ text, hangup, data, calls, error } = await agent.callResult(results));
        logger.info({ text, hangup, data, calls, error }, 'got function completion from LLM');
        text && progress && progress.send({ agent:text });
        error && progress && progress.send({ error});
      } catch (err) {
        logger.error({ err }, 'Error sending function results');
        text = 'Sorry, I am having a bit of trouble getting the data you need at the moment. Lets try again...';
      }
      this.awaitingFunctionCalls = undefined;
      await this.#waitFor(waitingId);
    }

    text = `<speak>${text || 'Sorry I seem to be having a problem at the moment'}</speak>`;
    if (hangup) {
      session
        .say({ text, ...this.sayOptions })
        .hangup()
        .send();
    }
    else {
      session
        .gather({
          input: ['speech'],
          actionHook: '/prompt',
          listenDuringPrompt: true,
          timeout: 20,
          say: { text, ...this.sayOptions }
        })
        .send();
    }
  };

  async #functionsFailed(calls) {
    return calls.map(call => ({ ...call, result: "Error: couldn't contact server" }));
  }


  async #goodbye() {
    let { session, progress } = this;
    let text = 'I\'m struggling to understand, please try again later';
    progress.send({ goodbye: text });
    session
      .say({ text, ...this.sayOptions })
      .hangup()
      .reply();
  };

  async #onClose(code, reason) {
    let { session, logger, progress } = this;
    progress.send({ hangup: true });
    logger.info({ session, code, reason }, `session ${session.call_sid} closed`);
  };

  #onError(err) {
    const { session, logger, progress } = this;
    logger.error({ err }, `session ${session.call_sid} received error`);
    let text = `Sorry, I\'m having some sort of internal issue, ${err.message} please try again later`;
    progress.send({ goodbye: text });
    session
      .say({ text, ...this.sayOptions })
      .hangup()
      .send();
  };
}


/**
 *
 *
 * @param {*} { name, llmClass, logger, wsServer, makeService, prompt, options, handleClose = () => (null)}
 * @param {Object} params Application creation parameters
 * @param {string} params.name supported LLM agent name, must be one of #Application.agents
 * @param {Object=} params.wsServer  An HTTP server object to attach an progress websocket to   
 * @param {Function} params.makeService  A Jambonz WS SDK makeServer Function
 * @param {Object=} params.options Options object to pass down to the underlying LLM agent
 * @param {Object} logger Pino logger instance
 * @param {string} params.name  Globally unique id for this agent instance
 * @param {string=} prompt Initial (system) prompt to the agent
 *  
 * @return {*} 
 */
class Agent {

  sessions = {};

  constructor({ implementationName, model, name, llmClass, logger, wsServer, makeService, prompt, options, functions, callbackUrl, handleClose = () => (null) }) {
    let path = `/agent/${name}`;
    let progressPath = `/progress/${name}`;
    let socket = makeService({ path });
    this.progress = { send: () => (null) };

    Object.assign(this, { name, path, socketPath: progressPath, wsServer, socket, llmClass, logger: logger.child({ name, implementationName }), prompt, functions, handleClose, callbackUrl });
    this.callbackTries = 6;
    this._options = options;


    wsServer.createEndpoint(progressPath, (ws) => {
      this.ws = ws;
      ws.send(JSON.stringify({ hello: true }));
      this.progress = {
        send: async (msg) => {
          ws.send(JSON.stringify(msg));
          callbackUrl && this.callbackTries > 0 && axios.post(callbackUrl, msg).catch((e) => {
            --this.callbackTries || this.logger.error({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback disabled');
            this.logger.info({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback failed');
          });
        }
      };
      ws.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data);
          this.sessions?.[message.call_id]?.onMessage(message);
        }
        catch (e) {
          this.logger.error({ e, message }, 'malformed WS message');
        }
      })
        .on('error', (err) => {
          this.logger.error({ err }, `received socket error ${err.message}`);
        })
        .on('close', (code, reason) => {
          this.logger.info({ code, reason }, `socket close`);
          this.handleClose();
        });
    });

    logger.info({ name, path, prompt, options, functions }, `creating agent on ${path}`);

    socket.on('session:new', async (session) => {
      let callId = session.call_sid;
      let s = new JambonzSession({
        ...this,
        session,
        agent: new llmClass({ logger, user: session.call_sid, model, prompt: this.prompt, functions, options: this.options }),
        options: this._options
      });
      this.sessions[callId] = s;
      await s.handler();
      this.sessions[callId] = undefined;
    });


  }

  set options(newValue) {
    this._options = newValue;
    Object.values(this.sessions).forEach(session => session && (session.options = newValue));
  }
  get options() {
    return this._options;
  }

  async destroy() {
    // Actively terminate any existing call sessions
    await Promise.all(Object.values(this.sessions).map(session => (session?.forceClose() || Promise.resolve())));
    // Null out the close handler, otherwise closing sockets
    //  may trigger a recursive call to our caller.
    this.handleClose = () => (null);
    this.ws?.close && this.ws.close();
    this.socket?.close && this.socket.close();
    this.wsServer.deleteEndpoint(this.socketPath);
  }

}

module.exports = Agent;
