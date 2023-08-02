# llm-agent

LLM based Agent.

Interacts to Jambonz, OpenAI and Google Vertex to create, modify and manage AI agents which listen on free phone numbers in Jambonz. Routes the calls via an STT to the LLM of choice with an initial system prompt, and then takes the completions and plays them to the caller via an TTS.

## Installation

You will need a Jambonz instance or account with some free inbound telephone numbers routed from a SIP trunk provider to allow inbound calls to the agent.
Ensure the spare numbers are listed on your Jambonz dashboard and do not currently have any application associated with them. Add STT and TTS provider credentials to Jambonz for the Google provider. Add an application API key to Jambonz, and copy it into your clipboard.

Clone this repo, and add the following environment variables (the repo uses .env so you can either directly place variables in your environment or copy the [Environment Example](https://github.com/aplisay/llm-agent/blob/main/environment-example) directly to a `.env` file:

```shell
OPENAI_API_KEY=<YOUR OPENAI KEY>
OPENAI_MODEL=gpt-3.5-turbo
GOOGLE_PROJECT_ID=<YOUR GOOGLE PROJECT ID>
GOOGLE_PROJECT_LOCATION="us-central1"
GOOGLE_APPLICATION_CREDENTIALS=<PATH TO CREDENTIAL JSON FILE>
JAMBONZ_SERVER=<JAMBONZ API SERVER HOSTNAME>, usually api.server.name
JAMBONZ_API_KEY=<JAMBONZ API KEY>
SERVER_NAME=<THIS SERVER DNS NAME>
AUTHENTICATE_USERS=NO
```
Note that the last line is important. Because we run this code as a free service on our own infrastructure, it will by default attempt to authenticate clients. You probably don't want this if you are running a local test copy on your own infrastructure as it uses Firebase which has a huge number of steps and possibly some cost to get working auth.
### Install dependencies

```yarn install```

### Start server

```yarn develop```



## Running

There is a free client in source form at [llm-frontend](https://github.com/aplisay/llm-frontend) which targets the API presented by this project.
See the instructions on that application to deploy locally.

### API

Implements a REST API.

List agent type names available by `GET`ing from `/api/agents` (currently `gpt35`for GPT3.5-turbo or `palm2` for Google PaLM2)

Create an agent by `POST`ing a `prompt` and `modelName` from above to same path. The returned structure contains the unique `id` of the agent, the spare `number` that was allocated, and a Websocket path in `socket` for a progress feed. Connect to the path in `socket` to get a real-time JSON event feed of all interactions (connections, received and sent utterances, data and hangups).

The agent can be modified by issuing a `PUT` to `/api/agents/${id}` where `id` is a previously returned agent id. This will take effect from the first new call after the update.

In addtion to the prompt, the `POST` and `PUT` also allow an optional agent `options` structure to be passed to modify LLM parameters.
Currently, this supports temperature which has a value between 0 and 1 (inclusive) and is mapped directly to the same value in `PalM2` model. It is multiplied by 2 to generate this parameter to GPT3.5 which takes a value between 0-2 natively. The options structure can also be used to pass the `tts` and `stt` parameters for speech recognition.

```javascript
{
  temperature: t
  tts: {
    provider: "google",
    language: "en-GB",
    voice: "en-GB-Wavenet-A"
  },
  stt: {
    provider: "google",
    language: "en-GB"
  }
}
```

When an agent is no-longer needed, issue a `DELETE` to `/api/agents/${id}`. This is important as otherwise you will leak phone numbers and leave extraneous applications lying around on your Jambonz instance. The agent is automatically deleted when your client disconnects the progress WebSocket so this does provide an active backstop to prevent this.


See [Swagger docs](https://llm-agent.aplisay.com/swagger/), or just use the [React frontend](https://github.com/aplisay/llm-frontend) as a playground.

## Implementation

Express routes are setup directly in `index.js` which point to handlers in `/handlers/api.js`.

On receiving a `POST`, the handler instantiates a new `Application` object, then calls `Application.create()` which calls the main event handler setup in `/lib/agent.js`. This listens on a Jambonz Websocket interface for new call, connects and dispatches messages between Jambonz and the chosen LLM agent. The dispatcher also listens for client connects on the progress event Websocket.
Once the dispatcher is setup `Application.create()` creates a matching unique application on the Jambonz instance, finds a number which has no existing application linked to it and sets up routing to the new application.

When calls arrive, the event dispatcher in `/lib/agents.js` calls the LLM for an initial greeting and then emits updates on the progress websocket as the conversation turns proceed.

See [Developer Documentation](API.md) for class structure
