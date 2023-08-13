const {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  CreateQueueCommand
} = require('@aws-sdk/client-sqs');

const {
  chunk,
  find,
  get,
  isPlainObject,
  mapValues,
  matches,
  pipe,
  toString,
  values
} = require('lodash/fp');
const log = require('@serverless/utils/log').log;
const {default: PQueue} = require('p-queue');
const SQSEventDefinition = require('./sqs-event-definition');
const SQSEvent = require('./sqs-event');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

class SQS {
  constructor(lambda, resources, options) {
    this.lambda = null;
    this.resources = null;
    this.options = null;
    this.lambda = lambda;
    this.resources = resources;
    this.options = options;
    this.client = new SQSClient({
      ...this.options,
      credentials: {
        accessKeyId: 'mock',
        secretAccessKey: 'mock'
      }
    });

    this.queue = new PQueue({autoStart: false});
  }

  create(events) {
    return Promise.all(events.map(({functionKey, sqs}) => this._create(functionKey, sqs)));
  }

  start() {
    this.queue.start();
  }

  stop(timeout) {
    this.queue.pause();
  }

  _create(functionKey, rawSqsEventDefinition) {
    const sqsEvent = new SQSEventDefinition(
      rawSqsEventDefinition,
      this.options.region,
      this.options.accountId
    );

    return this._sqsEvent(functionKey, sqsEvent);
  }

  _rewriteQueueUrl(queueUrl) {
    if (!this.options.endpoint) return queueUrl;

    const {hostname, protocol, username, password, port} = new URL(this.options.endpoint);
    const rewritedQueueUrl = new URL(queueUrl);
    rewritedQueueUrl.hostname = hostname;
    rewritedQueueUrl.protocol = protocol;
    rewritedQueueUrl.username = username;
    rewritedQueueUrl.password = password;
    rewritedQueueUrl.port = port;

    return rewritedQueueUrl.href;
  }

  async _getQueueUrl(queueName) {
    try {
      return await this.client.send(
        new GetQueueUrlCommand({
          QueueName: queueName
        })
      );
    } catch (err) {
      await delay(10000);
      return this._getQueueUrl(queueName);
    }
  }

  async _sqsEvent(functionKey, sqsEvent) {
    const {enabled, arn, queueName, batchSize = 10} = sqsEvent;

    if (!enabled) return;

    if (this.options.autoCreate) await this._createQueue(sqsEvent);

    const QueueUrl = this._rewriteQueueUrl(
      (
        await this.client.send(
          new GetQueueUrlCommand({
            QueueName: queueName
          })
        )
      ).QueueUrl
    );

    const getMessages = async (size, messages = []) => {
      if (size <= 0) return messages;

      const {Messages} = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: size > 10 ? 10 : size,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
          WaitTimeSeconds: 5
        })
      );

      if (!Messages || Messages.length === 0) {
        return messages;
      }

      return getMessages(size - Messages.length, [...messages, ...Messages]);
    };

    const job = async () => {
      const messages = await getMessages(batchSize);

      if (messages.length > 0) {
        try {
          const lambdaFunction = this.lambda.get(functionKey);

          const event = new SQSEvent(messages, this.region, arn);

          lambdaFunction.setEvent(event);

          await lambdaFunction.runHandler();

          await Promise.all(
            chunk(
              10,
              (messages || []).map(({MessageId: Id, ReceiptHandle}) => ({
                Id,
                ReceiptHandle
              }))
            ).map(Entries =>
              this.client.send(
                new DeleteMessageBatchCommand({
                  Entries,
                  QueueUrl
                })
              )
            )
          );
        } catch (err) {
          log.warning(err.stack);
        }
      }

      await this.queue.add(job);
    };

    this.queue.add(job);
  }

  _getResourceProperties(queueName) {
    return pipe(
      values,
      find(matches({Properties: {QueueName: queueName}})),
      get('Properties')
    )(this.resources);
  }

  async _createQueue({queueName}, remainingTry = 5) {
    try {
      const properties = this._getResourceProperties(queueName);

      await this.client.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: mapValues(
            value => (isPlainObject(value) ? JSON.stringify(value) : toString(value)),
            properties
          )
        })
      );
    } catch (err) {
      if (remainingTry > 0 && err.name === 'AWS.SimpleQueueService.NonExistentQueue') {
        return this._createQueue({queueName}, remainingTry - 1);
      }
      throw err;
    }
  }
}

module.exports = SQS;
