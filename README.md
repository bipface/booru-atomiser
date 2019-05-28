# Booru Atomiser
Performs a Booru gallery search and formats the results as an [Atom](https://en.wikipedia.org/wiki/Atom_%28Web_standard%29) feed.

https://app.swaggerhub.com/apis-docs/bipface/booru-atomiser/

Featuring:
- Lambda function
- CloudFormation template
- OpenAPI specification

Requires NodeJS 10 or later (Lambda must be manually configured and uploaded after deploying CloudFormation stack).

Galleries currently supported:
- gelbooru
- rule34.xxx

Dependencies:
- [stream-json](https://www.npmjs.com/package/stream-json).
