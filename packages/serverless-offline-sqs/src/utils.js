const extractQueueNameFromARN = arn => {
  const [, , , , , queueName] = arn.split(':');
  return queueName;
};

module.exports = extractQueueNameFromARN;
