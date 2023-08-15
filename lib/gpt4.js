require('dotenv').config();
const axios = require('axios');
const Gpt35 = require('./gpt35');


/**
 * Implements the LLM class against the OpenAI GPT3.5-turbo model
 *
 * 
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
 * @class Gpt35
 * @extends {Llm}
 */
class Gpt4 extends Gpt35 {
  /**
   * Creates an instance of Gpt35.
   * @memberof Gpt4
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options);
    this.gpt.model = 'gpt-4'
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW GPT4agent');
  }

}
  
module.exports = Gpt4;