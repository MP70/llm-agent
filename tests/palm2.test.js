const Llm = require('../lib/models/palm2');
const prompt = require('../data/defaultPrompts')['google'];
require('./lib/llm.js')(Llm, prompt);